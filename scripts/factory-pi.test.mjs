import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeTool, coderSkills, FALLBACKS, isUsageLimit, requireSkills } from './factory-pi.mjs'

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
    assert.equal(authorizeTool(root, 'coder', call('check')), undefined)
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

test('a usage limit moves a call to Claude; a passing rate limit does not', () => {
  assert.ok(isUsageLimit("You've hit your usage limit. Upgrade to Pro or try again in 3 hours."))
  assert.ok(isUsageLimit('429 {"type":"subscription_sharing_usage_limit_exceeded"}'))
  assert.ok(isUsageLimit('insufficient_quota'))
  assert.ok(!isUsageLimit('429 Too Many Requests: rate limit, retry after 2s'))
  assert.ok(!isUsageLimit(undefined))
  assert.deepEqual(FALLBACKS, { coder: 'claude-opus-5-5', review: 'claude-opus-5-5', planner: 'claude-opus-5-5', tester: 'claude-haiku-5-5' })
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
    writeFileSync(join(dir, 'a.ts'), 'two')
    const edited = tree()
    assert.notEqual(edited, base)
    writeFileSync(join(dir, 'b.ts'), 'new')
    assert.notEqual(tree(), edited)
    execFileSync('git', ['diff', '--quiet', '--cached'], { cwd: dir }) // the real index is untouched
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
