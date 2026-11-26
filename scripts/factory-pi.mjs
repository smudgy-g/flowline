import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Besides its worktree, a Pi session may read only factory.config.json's `readable` (e.g. migrations, for schema
// context), which the factory passes as FACTORY_READABLE.
const readable = JSON.parse(process.env.FACTORY_READABLE ?? '[]')

// A tool's path as Pi resolves it: a leading '@' is dropped and '~' is the home folder.
function toolPath(root, path = '.') {
  let p = path.startsWith('@') ? path.slice(1) : path
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1)
  return resolve(root, p)
}
// The path with every symlink in its existing part followed.
function realish(file) {
  let p = file, rest = ''
  while (!existsSync(p)) { rest = join(basename(p), rest); p = dirname(p) }
  return join(realpathSync(p), rest)
}
const inside = (dir, file) => file === dir || file.startsWith(`${dir}${sep}`)

// Shell is deliberately unavailable: shell grammar cannot be reliably guarded by a
// deny-list, and would permit out-of-worktree writes. The coder's one custom tool,
// `check`, takes no input and runs fixed commands.
// Reads stay in the worktree (and the migrations) so a session never reaches the
// VM's logins, the factory's UAT specs, or other tasks.
// `codemode` runs a script whose tool calls come back through this guard one by one (Pi's nested tool calls),
// and it can call only the role's own tools.
export function authorizeTool(worktree, role, event, readRoots = readable) {
  if (event.toolName === 'codemode') return undefined
  if (event.toolName === 'check') return role === 'coder' ? undefined : { block: true, reason: 'Unapproved tool' }
  if (event.toolName === 'bash' || !['read', 'grep', 'find', 'ls', 'edit', 'write'].includes(event.toolName))
    return { block: true, reason: 'Unapproved tool' }
  const root = realpathSync(worktree)
  if (!['edit', 'write'].includes(event.toolName)) {
    const target = realish(toolPath(root, event.input.path))
    const roots = [root, ...readRoots.filter(existsSync).map(dir => realpathSync(dir))]
    return roots.some(dir => inside(dir, target)) ? undefined : { block: true, reason: 'Outside worktree' }
  }
  if (role === 'review' || role === 'planner') return { block: true, reason: 'Read-only role' }
  const file = toolPath(root, event.input.path)
  const local = relative(root, file)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || file.startsWith(`${root}${sep}`) === false)
    return { block: true, reason: 'Outside worktree' }
  let parent = file
  while (parent !== root) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      return { block: true, reason: 'Symlink in write path' }
    parent = dirname(parent)
  }
  // The work item's and the stack's history (written by the factory) are read-only to every agent.
  const records = ['factory', 'stack'].map(name => join('.agents', 'artefacts', name))
  if (records.some(dir => local === dir || local.startsWith(`${dir}${sep}`)))
    return { block: true, reason: 'Factory history is read-only' }
  if (role === 'tester' && !/(?:^|\/)(?:tests\/|[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$)/.test(local))
    return { block: true, reason: 'Tester writes tests only' }
  return undefined
}

// What the task changed: uncommitted files, and commits since the base.
function changedPaths(worktree) {
  return [...new Set([
    ...execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8' })
      .split('\n').filter(Boolean).map(line => line.slice(3)),
    ...execFileSync('git', ['diff', '--name-only', `${process.env.FACTORY_BASE}...HEAD`], { cwd: worktree, encoding: 'utf8' })
      .split('\n').filter(Boolean),
  ])]
}

// Runs in the worktree with its own toolchain (mise.toml), as the factory's gates do.
const sh = (worktree, args, signal) => new Promise(done =>
  execFile('mise', ['exec', '--', ...args], {
    cwd: worktree, signal, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000,
    env: { ...process.env, CI: 'true', NUXT_TELEMETRY_DISABLED: '1' },
  }, (error, stdout, stderr) => done({ ok: !error, out: `${stdout}${stderr}`.trim() })))

const factoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
// Gates and the UAT build take turns on this lock (ops.ts): together they run the VM out of memory.
const heavyLock = `${factoryRoot}/.cache/heavy.lock`

/**
 * The coder's `check`: what the factory's lint and typecheck gates would say, so it fixes them in the same call
 * instead of costing a round. ESLint and Prettier fix what they can first, as the gates' autofix does.
 */
export async function runCheck(worktree, signal) {
  const files = changedPaths(worktree).filter(f => /\.([cm]?[jt]sx?|vue)$/.test(f) && existsSync(join(worktree, f)))
  const lint = files.length
    ? await sh(worktree, ['pnpm', 'exec', 'eslint', '--fix', '--no-warn-ignored', '--', ...files], signal)
    : { ok: true, out: '' }
  if (files.length) await sh(worktree, ['pnpm', 'exec', 'prettier', '--write', '--ignore-unknown', '--', ...files], signal)
  const types = await sh(worktree, ['flock', heavyLock, 'pnpm', 'typecheck'], signal)
  const tail = text => text.slice(-6000)
  // Passed: record the exact code it passed on, so the lint and typecheck gates can skip a repeat (ops.ts runGates).
  if (lint.ok && types.ok) {
    const tree = execFileSync('bash', [join(factoryRoot, 'scripts/content-tree.sh')], { cwd: worktree, encoding: 'utf8' })
    mkdirSync(join(worktree, '.agents/artefacts/factory'), { recursive: true })
    writeFileSync(join(worktree, '.agents/artefacts/factory/checked-tree'), tree.trim())
  }
  return [
    lint.ok ? 'lint: passed' : `lint: failed\n${tail(lint.out)}`,
    types.ok ? 'typecheck: passed' : `typecheck: failed\n${tail(types.out)}`,
  ].join('\n\n')
}

const hasCoderCheck = role => role === 'coder' && process.env.FACTORY_CUSTOM_CHECKS !== '1'

export async function loadFactoryResources(worktree, role = 'review') {
  const install = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), '.pi/agent/install')
  const version = readFileSync(join(install, 'current-version'), 'utf8').trim()
  if (!/^[\w.+-]+$/.test(version)) throw new Error('Invalid Pi installation')
  const dist = join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist')
  const sdk = await import(pathToFileURL(join(dist, 'index.js')).href)
  // As the pi CLI does at start-up: honour HTTPS_PROXY (the factory VM's egress proxy). No-op without one.
  ;(await import(pathToFileURL(join(dist, 'core/http-dispatcher.js')).href)).configureHttpDispatcher()
  const { Type } = await import(pathToFileURL(join(install, 'releases', version, 'node_modules/typebox/build/index.mjs')).href)
  const loader = new sdk.DefaultResourceLoader({
    cwd: worktree, agentDir: sdk.getAgentDir(), noExtensions: true,
    extensionFactories: [sdk.createCodemodeExtension({ models: false }), (pi) => {
      pi.on('tool_call', (event) => authorizeTool(worktree, role, event))
      if (hasCoderCheck(role)) pi.registerTool({
        name: 'check', label: 'Check',
        description: "Lint (auto-fixing what it can) and typecheck the worktree, as the factory's gates will. Takes a minute or two.",
        parameters: Type.Object({}),
        async execute(_id, _params, signal) {
          return { content: [{ type: 'text', text: await runCheck(worktree, signal) }], details: {} }
        },
      })
    }],
  })
  await loader.reload()
  return { sdk, loader }
}

/**
 * The model each role runs on, as `provider/id`; a bare id is on the Codex login (no per-use cost; bigger models use
 * the subscription's limits faster). The planner runs on Claude through the factory's Anthropic API key (billed per
 * token). FACTORY_MODEL_<ROLE> overrides one, e.g. FACTORY_MODEL_PLANNER=gpt-6.2-sol; `pi --list-models` shows the choices.
 */
const DEFAULT_MODELS = { coder: 'gpt-6.1-terra', review: 'gpt-6.2-sol', planner: 'anthropic/claude-opus-5-5', tester: 'gpt-6-luna' }
export const MODELS = Object.fromEntries(['coder', 'tester', 'review', 'planner'].map(role =>
  [role, process.env[`FACTORY_MODEL_${role.toUpperCase()}`] || DEFAULT_MODELS[role]]))

/** A role's model as `[provider, id]`; a bare id is a Codex model. */
export function modelSpec(spec) {
  const slash = spec.indexOf('/')
  return slash < 0 ? ['openai-codex', spec] : [spec.slice(0, slash), spec.slice(slash + 1)]
}

/**
 * When the Codex subscription hits its usage limit, a Codex call moves to Claude on the factory's own API key (billed per
 * token; a dedicated key with a spend limit). FACTORY_FALLBACK_<ROLE> overrides one. The key is a VM-only file the
 * laptop sync never touches; without it there is no fallback and the call fails as before.
 */
const FALLBACK_MODELS = { coder: 'claude-opus-5-5', review: 'claude-opus-5-5', planner: 'claude-opus-5-5', tester: 'claude-haiku-5-5' }
export const FALLBACKS = Object.fromEntries(Object.keys(FALLBACK_MODELS).map(role =>
  [role, process.env[`FACTORY_FALLBACK_${role.toUpperCase()}`] || FALLBACK_MODELS[role]]))
const fallbackKeyFile = join(homedir(), '.config/factory/anthropic-api-key')

/** A subscription's usage limit (it resets after hours), as against a transient rate limit Pi retries itself. */
export const isUsageLimit = (message = '') => /usage.?limit|insufficient_quota|quota exceeded|out of budget/i.test(message)

// Once Codex is out, later calls go straight to the fallback until the limit should have reset.
const limitFile = `${factoryRoot}/.cache/pi-limits/openai-codex`
const LIMIT_HOURS = 1 // ponytail: fixed wait; read the reset time from the error if Codex sends one we can rely on
const codexOut = () => { try { return Date.now() < Date.parse(readFileSync(limitFile, 'utf8')) } catch { return false } }
function markCodexOut() {
  mkdirSync(dirname(limitFile), { recursive: true })
  writeFileSync(limitFile, new Date(Date.now() + LIMIT_HOURS * 3600_000).toISOString())
}

export function requireSkills(loader, names) {
  const skills = loader.getSkills().skills
  return names.map(name => {
    const skill = skills.find(skill => skill.name === name)
    if (!skill) throw new Error(`Missing /skill:${name} in factory worktree`)
    return skill
  })
}

// factory.config.json's skills.coder, which the factory passes as FACTORY_CODER_SKILLS.
const coderConfig = JSON.parse(process.env.FACTORY_CODER_SKILLS ?? '{"always":[],"areas":{}}')

/** The coder's skills: the ones it always gets, and each area's whose paths (globs) match a path it touches. */
export function coderSkills(paths, { always, areas } = coderConfig) {
  const touched = Object.values(areas).filter(area => paths.some(path => area.paths.some(glob => matchesGlob(path, glob))))
  return [...new Set([...always, ...touched.flatMap(area => area.skills)])]
}

async function main() {
  const [worktree, role, prompt] = process.argv.slice(2)
  if (!worktree || !['coder', 'tester', 'review', 'planner', 'check'].includes(role) || !prompt) throw new Error('Invalid Pi invocation')
  if (existsSync(join(worktree, '.env'))) throw new Error('Worktree .env is present')
  const { sdk, loader } = await loadFactoryResources(worktree, role)
  if (role === 'check') { requireSkills(loader, JSON.parse(prompt)); return }
  const named = [...prompt.matchAll(/\/skill:([a-z0-9-]+)/g)].map(match => match[1])
  const withSkills = (skills, rules = '') =>
    `${skills.map(skill => readFileSync(skill.filePath, 'utf8')).join('\n\n')}\n\n${rules}${prompt.replace(/\/skill:([a-z0-9-]+)/g, '$1')}`
  let instruction = named.length ? withSkills(requireSkills(loader, named)) : prompt
  if (role === 'coder') {
    const paths = changedPaths(worktree)
    // Paths the prompt names (e.g. the plan's step), so a step gets its area's skills before it touches the file.
    const planned = prompt.match(/[\w@.()[\]-]+(?:\/[\w@.()[\]-]+)+/g) ?? []
    const skills = requireSkills(loader, [...new Set([...named, ...coderSkills([...paths, ...planned])])])
    instruction = withSkills(skills, "Follow AGENTS.md's testing rules.\nTo delete a file, write it empty: the factory removes empty files.\n\n")
  }
  const runtime = await sdk.ModelRuntime.create()
  const key = existsSync(fallbackKeyFile) ? readFileSync(fallbackKeyFile, 'utf8').trim() : ''
  // A runtime key overrides the stored Anthropic login for this process only, and is never written to auth.json.
  if (key) await runtime.setRuntimeApiKey('anthropic', key)
  const [provider, id] = modelSpec(MODELS[role] ?? MODELS.coder)
  // Claude is billed to the factory's key, never the stored Anthropic login.
  if (provider === 'anthropic' && !key) throw new Error(`The ${role} runs on Claude and needs ${fallbackKeyFile}`)
  const fallback = key && provider === 'openai-codex' ? runtime.getModel('anthropic', FALLBACKS[role] ?? FALLBACKS.coder) : undefined
  let model = fallback && codexOut() ? fallback : runtime.getModel(provider, id)
  if (!model || !runtime.hasConfiguredAuth(model.provider)) throw new Error('Pi model/auth unavailable')
  const { session } = await sdk.createAgentSession({
    cwd: worktree, model, modelRuntime: runtime, resourceLoader: loader,
    tools: role === 'review' || role === 'planner' ? ['read', 'grep', 'find', 'ls', 'codemode']
      : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'codemode', ...(hasCoderCheck(role) ? ['check'] : [])],
    sessionManager: sdk.SessionManager.inMemory(),
  })
  const timer = setTimeout(() => { void session.abort() }, 30 * 60 * 1000)
  try {
    const lastReply = () => session.messages.filter(message => message.role === 'assistant').at(-1)
    await session.prompt(instruction)
    // Codex ran out mid-call: the same session goes on with Claude, keeping what it read and wrote so far.
    if (fallback && model !== fallback && lastReply()?.stopReason === 'error' && isUsageLimit(lastReply().errorMessage)) {
      markCodexOut()
      model = fallback
      await session.setModel(fallback)
      await session.prompt('Your model hit its usage limit and you were switched to another. Carry on with the task from where you stopped; your edits so far are in the worktree.')
    }
    const last = lastReply()
    if (!last || last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error(`Pi did not finish successfully: ${last?.errorMessage ?? last?.stopReason ?? 'no reply'}`)
    // Said first, so the history shows it; the factory reads JSON blocks and the "Unfinished steps" line from the end.
    const note = model !== fallback ? '' : `(Codex is at its usage limit: this ran on ${model.id}.)\n\n`
    process.stdout.write(note + (session.getLastAssistantText() || ''))
  } finally { clearTimeout(timer); session.dispose() }
}

/**
 * Pi 1.5.2's `read` streams its file with the call's abort signal. Cancelling a read mid-stream (a codemode script
 * that ends before its reads finish, a session abort) makes the stream emit an AbortError after the reader has
 * stopped listening, and Node turns that into an uncaught exception that ends this process. The read was cancelled on
 * purpose, so only that error is ignored; anything else still ends the process as before.
 * ponytail: drop once Pi's read handles its own aborted stream.
 */
export function ignoreCancelledStreams() {
  process.on('uncaughtException', (error) => {
    if (error?.code === 'ABORT_ERR') return
    console.error(error)
    process.exit(1)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  ignoreCancelledStreams()
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
