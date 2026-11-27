import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeTool, coderSkills, fallbackReason, modelPolicy, piDist, promptWithFallback, requireSkills } from './factory-pi.mjs'

test('Pi SDK resolves a normal global install, then a managed install', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-pi-install-'))
  const bin = join(root, 'bin')
  const globalRoot = join(root, 'global')
  const dist = join(globalRoot, '@earendil-works/pi-coding-agent/dist')
  const managed = join(root, 'managed')
  const oldPath = process.env.PATH
  const oldManaged = process.env.PI_MANAGED_INSTALL_ROOT

  try {
    mkdirSync(bin)
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.js'), '')
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho '${globalRoot}'\n`)
    chmodSync(join(bin, 'npm'), 0o755)
    process.env.PATH = `${bin}:${oldPath}`
    delete process.env.PI_MANAGED_INSTALL_ROOT
    assert.equal(piDist(), dist)

    process.env.PI_MANAGED_INSTALL_ROOT = managed
    assert.throws(() => piDist(), /Pi SDK not found/)

    mkdirSync(managed)
    writeFileSync(join(managed, 'current-version'), '1.6.1\n')
    assert.equal(piDist(), join(managed, 'releases/1.6.1/node_modules/@earendil-works/pi-coding-agent/dist'))
  } finally {
    process.env.PATH = oldPath

    if (oldManaged === undefined) delete process.env.PI_MANAGED_INSTALL_ROOT
    else process.env.PI_MANAGED_INSTALL_ROOT = oldManaged

    rmSync(root, { recursive: true, force: true })
  }
})

test('coder selects test and domain skills by changed path; missing skills stop dispatch', () => {
  const coder = {
    always: ['ponytail', 'write-tests'],
    areas: {
      components: { paths: ['components/**', 'app/components/**'], skills: ['write-component'] },
      composables: { paths: ['app/composables/**'], skills: ['write-composable'] },
      server: { paths: ['server/api/**', 'server/middleware/**'], skills: ['write-server-route'] },
    },
  }

  assert.deepEqual(coderSkills(['app/components/Card.vue', 'app/composables/useCard.ts', 'server/api/card.get.ts'], coder),
    ['ponytail', 'write-tests', 'write-component', 'write-composable', 'write-server-route'])
  assert.deepEqual(coderSkills(['shared/utils/card.ts'], coder), ['ponytail', 'write-tests'])
  assert.deepEqual(coderSkills(['server/middleware/auth.ts', 'components/A.vue'], coder), ['ponytail', 'write-tests', 'write-component', 'write-server-route'])
  assert.deepEqual(coderSkills(['app/components/A.vue']), [])
  assert.throws(() => requireSkills({ getSkills: () => ({ skills: [] }) }, ['architect']), /Missing \/skill:architect/)
})

test('Pi tool guard restricts writes, symlinks, shell, and review roles', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-guard-'))

  try {
    mkdirSync(join(root, 'tests'))
    symlinkSync(tmpdir(), join(root, 'escape'))
    const call = (toolName, path) => ({ toolName, input: { path, command: 'touch /tmp/exposed' } })
    assert.equal(authorizeTool(root, 'coder', call('write', 'tests/new.test.ts')), undefined)
    assert.match(authorizeTool(root, 'coder', call('edit', '../outside'))?.reason, /Outside/)
    assert.match(authorizeTool(root, 'coder', call('write', join(tmpdir(), 'outside')))?.reason, /Outside/)
    assert.match(authorizeTool(root, 'coder', call('write', 'escape/other'))?.reason, /Symlink/)
    assert.match(authorizeTool(root, 'coder', call('bash', 'x'))?.reason, /Unapproved/)
    assert.match(authorizeTool(root, 'coder', call('check'))?.reason, /Unapproved/)
    assert.equal(authorizeTool(root, 'tester', call('write', 'main_test.go'), [], ['**/*_test.go']), undefined)
    assert.equal(authorizeTool(root, 'review', call('codemode')), undefined) // its calls are guarded one by one
    assert.match(authorizeTool(root, 'review', call('check'))?.reason, /Unapproved/)
    assert.match(authorizeTool(root, 'tester', call('check'))?.reason, /Unapproved/)
    assert.match(authorizeTool(root, 'review', call('write', 'tests/new.test.ts'))?.reason, /Read-only/)
    assert.match(authorizeTool(root, 'tester', call('write', 'app.vue'))?.reason, /Tester/)
    assert.match(authorizeTool(root, 'coder', call('edit', '.agents/artefacts/factory/history.md'))?.reason, /history is read-only/)
    assert.match(authorizeTool(root, 'coder', call('write', '.agents/artefacts/factory'))?.reason, /history is read-only/)
    assert.match(authorizeTool(root, 'coder', call('edit', '.agents/artefacts/stack/design.md'))?.reason, /history is read-only/)
    assert.equal(authorizeTool(root, 'coder', call('write', '.agents/artefacts/notes.md')), undefined)
    // Pi drops a leading '@' and expands '~', so these are the home folder and /etc, not the worktree.
    assert.match(authorizeTool(root, 'coder', call('write', '~/.bashrc'))?.reason, /Outside/)
    assert.match(authorizeTool(root, 'coder', call('write', '@/etc/hosts'))?.reason, /Outside/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Pi tool guard confines reads to the worktree and the migrations repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-guard-'))
  const schema = mkdtempSync(join(tmpdir(), 'factory-schema-'))

  try {
    mkdirSync(join(root, 'app'))
    symlinkSync(tmpdir(), join(root, 'escape'))
    const call = (toolName, path) => ({ toolName, input: path === undefined ? { pattern: 'x' } : { path, pattern: 'x' } })

    for (const role of ['coder', 'tester', 'review']) {
      assert.equal(authorizeTool(root, role, call('read', 'app/page.vue'), [schema]), undefined)
      assert.equal(authorizeTool(root, role, call('grep', undefined), [schema]), undefined) // defaults to the worktree
      assert.equal(authorizeTool(root, role, call('read', join(schema, 'migrations/1.sql')), [schema]), undefined)
      for (const path of ['~/.pi/agent/auth.json', '@/etc/passwd', '../other-task/app.vue', 'escape/secret', join(schema, '..')])
        assert.match(authorizeTool(root, role, call('read', path), [schema])?.reason ?? '', /Outside/, `${role} read ${path}`)
      assert.match(authorizeTool(root, role, call('find', '/'), [schema])?.reason ?? '', /Outside/)
      assert.match(authorizeTool(root, role, call('ls', '~'), [schema])?.reason ?? '', /Outside/)
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(schema, { recursive: true, force: true }) }
})

test('provider limits and outages are classified without treating bad credentials as failover', () => {
  assert.equal(fallbackReason('insufficient_quota'), 'usage-limit')
  assert.equal(fallbackReason('429 Too Many Requests: rate limit'), 'rate-limit')
  assert.equal(fallbackReason('503 service unavailable'), 'unavailable')
  assert.equal(fallbackReason('401 invalid api key'), undefined)
  assert.equal(fallbackReason('model not found'), undefined)
  assert.deepEqual(modelPolicy('provider/model', 'default'), {
    primary: 'provider/model', fallbacks: [], on: ['usage-limit', 'rate-limit', 'unavailable'],
  })
})

test('fallback walks configured models only for selected provider errors and keeps the session', async () => {
  const used = []

  const session = {
    messages: [],
    async setModel(model) { used.push(model.id) },
    async prompt() {
      this.messages.push(used.length < 2
        ? { role: 'assistant', stopReason: 'error', errorMessage: used.length ? '503 unavailable' : '429 rate limit' }
        : { role: 'assistant', stopReason: 'end_turn' })
    },
  }

  const choice = { primary: 'first', fallbacks: ['second', 'third'], on: ['rate-limit', 'unavailable'] }
  const chosen = await promptWithFallback(session, 'work', choice, id => ({ id }))
  assert.equal(chosen.id, 'third')
  assert.deepEqual(used, ['second', 'third'])
  used.length = 0
  session.messages = []
  await assert.rejects(promptWithFallback(session, 'work', { ...choice, on: ['usage-limit'] }, id => ({ id })), /429 rate limit/)
  assert.deepEqual(used, [])
  session.messages = []

  session.prompt = async function () { this.messages.push({ role: 'assistant', stopReason: 'error', errorMessage: '401 invalid key' }) }

  await assert.rejects(promptWithFallback(session, 'work', choice, id => ({ id })), /401 invalid key/)
  assert.deepEqual(used, [])
})

test('content tree changes with any tracked or untracked edit, not with ignored files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-'))
  const tree = () => execFileSync('bash', [join(import.meta.dirname, 'content-tree.sh')], { cwd: dir, encoding: 'utf8' }).trim()
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })

  try {
    git('init', '-q')
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
    writeFileSync(join(dir, 'a.ts'), 'one')
    git('add', '-A'); git('commit', '-qm', 'base')
    const base = tree()
    assert.equal(tree(), base)
    mkdirSync(join(dir, 'ignored'))
    writeFileSync(join(dir, 'ignored/checks.log'), 'log')
    assert.equal(tree(), base)
    writeFileSync(join(dir, 'a.ts'), 'two, of a different length') // same size within the same second looks unchanged to git
    const edited = tree()
    assert.notEqual(edited, base)
    writeFileSync(join(dir, 'b.ts'), 'new')
    assert.notEqual(tree(), edited)
    execFileSync('git', ['diff', '--quiet', '--cached'], { cwd: dir }) // the real index is untouched
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
