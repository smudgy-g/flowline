import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Besides its worktree, a Pi session may read only factory.config.json's `readable` (e.g. migrations, for schema
// context), which the factory passes as FACTORY_READABLE.
const readable = JSON.parse(process.env.FACTORY_READABLE ?? '[]')
const testPaths = JSON.parse(process.env.FACTORY_TEST_PATHS ?? '[]')

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
// deny-list, and would permit out-of-worktree writes.
// Reads stay in the worktree (and the migrations) so a session never reaches the
// VM's logins, the factory's UAT specs, or other tasks.
// `codemode` runs a script whose tool calls come back through this guard one by one (Pi's nested tool calls),
// and it can call only the role's own tools.
export function authorizeTool(worktree, role, event, readRoots = readable, tests = testPaths) {
  if (event.toolName === 'codemode') return undefined

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

  if (local.split(sep).includes('.git')) return { block: true, reason: 'Git metadata is read-only' }

  let parent = file

  while (parent !== root) {
    if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink())
      return { block: true, reason: 'Symlink in write path' }

    parent = dirname(parent)
  }

  // The work item's and the stack's history (written by the factory) are read-only to every agent.
  const records = ['factory', 'stack'].map(name => join('.agents', 'artefacts', name))

  if (records.some(dir => local === dir || local.startsWith(`${dir}${sep}`)))
    return { block: true, reason: 'Factory history is read-only' }

  if (role === 'tester' && !tests.some(pattern => matchesGlob(local, pattern)))
    return { block: true, reason: 'Tester writes tests only' }

  return undefined
}

// What the task changed: uncommitted files, and commits since the base.
function gitOptions(worktree) {
  const registration = JSON.parse(process.env.FACTORY_TASK_GIT || '{}')

  if (!registration.GIT_DIR || registration.GIT_WORK_TREE !== worktree) throw new Error('Missing trusted Git registration')

  return { cwd: worktree, encoding: 'utf8', env: { ...process.env, ...registration } }
}

function changedPaths(worktree) {
  return [...new Set([
    ...execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], gitOptions(worktree))
      .split('\n').filter(Boolean).map(line => line.slice(3)),
    ...execFileSync('git', ['diff', '--name-only', `${process.env.FACTORY_BASE}...HEAD`], gitOptions(worktree))
      .split('\n').filter(Boolean),
  ])]
}

const installRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')

// Installed, the factory is compiled JavaScript; in its own checkout it is TypeScript Node strips as it loads.
const factoryModule = name =>
  pathToFileURL(join(installRoot, existsSync(join(installRoot, 'dist/config.js')) ? `dist/${name}.js` : `src/${name}.ts`)).href

/**
 * The coder's `check`: what the factory's lint and typecheck gates would say, so it fixes them in the same call
 * instead of costing a round. ESLint and Prettier fix what they can first, as the gates' autofix does.
 */
export async function runCheck(worktree, signal) {
  signal?.throwIfAborted()
  const { projectCommands } = await import(factoryModule('project-commands'))
  const { config } = await import(factoryModule('config'))
  const files = changedPaths(worktree).filter(f => existsSync(join(worktree, f)))
  const result = await projectCommands(worktree, [...config.commands.autofix, ...config.commands.check], files)
  signal?.throwIfAborted()

  if (result.ok) {
    const tree = execFileSync('bash', [join(installRoot, 'scripts/content-tree.sh')], gitOptions(worktree))
    const records = process.env.FACTORY_ITEM_RECORDS
    mkdirSync(records, { recursive: true })
    writeFileSync(join(records, 'checked-tree'), tree.trim())
  }

  return result.ok ? 'Project checks passed' : `${result.gate}: failed\n${result.output}`
}

export function piDist() {
  const install = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), '.pi/agent/install')

  if (!process.env.PI_MANAGED_INSTALL_ROOT) {
    try {
      const global = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const dist = join(global, '@earendil-works/pi-coding-agent/dist')

      if (existsSync(join(dist, 'index.js'))) return dist
    } catch { /* Pi may use a managed installation without npm. */ }
  }

  if (!existsSync(join(install, 'current-version')))
    throw new Error('Pi SDK not found. Install @earendil-works/pi-coding-agent globally with npm, or set PI_MANAGED_INSTALL_ROOT')

  const version = readFileSync(join(install, 'current-version'), 'utf8').trim()

  if (!/^[\w.+-]+$/.test(version)) throw new Error('Invalid Pi installation')

  return join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist')
}

export async function loadFactoryResources(worktree, role = 'review') {
  const dist = piDist()

  const sdk = await import(pathToFileURL(join(dist, 'index.js')).href)

  // As the pi CLI does at start-up: honour HTTPS_PROXY (the factory VM's egress proxy). No-op without one.
  ;(await import(pathToFileURL(join(dist, 'core/http-dispatcher.js')).href)).configureHttpDispatcher()

  const loader = new sdk.DefaultResourceLoader({
    cwd: worktree, agentDir: sdk.getAgentDir(), noExtensions: true,
    extensionFactories: [sdk.createCodemodeExtension({ models: false }), (pi) => {
      pi.on('tool_call', (event) => authorizeTool(worktree, role, event))
    }],
  })

  await loader.reload()
  return { sdk, loader }
}

/**
 * Default models, overridable per role in project config. A bare id uses the Codex login.
 * `pi --list-models` shows the available choices.
 */
const DEFAULT_MODELS = { coder: 'gpt-6.1-terra', review: 'gpt-6.2-sol', planner: 'anthropic/claude-opus-5-5', tester: 'gpt-6-luna' }
export const MODELS = Object.fromEntries(['coder', 'tester', 'review', 'planner'].map(role =>
  [role, process.env[`FACTORY_MODEL_${role.toUpperCase()}`] || DEFAULT_MODELS[role]]))

/** A role's model as `[provider, id]`; a bare id is a Codex model. */
export function modelSpec(spec) {
  const slash = spec.indexOf('/')
  return slash < 0 ? ['openai-codex', spec] : [spec.slice(0, slash), spec.slice(slash + 1)]
}

/** A key here overrides Pi's stored Anthropic login for this process only. */
const anthropicKeyFile = join(homedir(), '.config/factory/anthropic-api-key')

/** Classify provider failures, never configuration/authentication failures. */
export function fallbackReason(message = '') {
  if (/usage.?limit|insufficient_quota|quota exceeded|out of budget/i.test(message)) return 'usage-limit'

  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return 'rate-limit'

  if (/\b(?:500|502|503|504)\b|service unavailable|temporarily unavailable|overloaded|connection (?:reset|refused)|ECONNRESET|fetch failed/i.test(message)) return 'unavailable'

  return undefined
}

export function modelPolicy(choice, defaultModel) {
  return typeof choice === 'string' || !choice
    ? { primary: choice || defaultModel, fallbacks: [], on: ['usage-limit', 'rate-limit', 'unavailable'] }
    : choice
}

/** Continue the same session so a fallback retains work already done by earlier models. */
export async function promptWithFallback(session, instruction, policy, selectModel) {
  let model = selectModel(policy.primary)
  const lastReply = () => session.messages.filter(message => message.role === 'assistant').at(-1)
  let failure

  try { await session.prompt(instruction) } catch (error) { failure = error }

  for (const spec of policy.fallbacks) {
    const last = lastReply()
    const reason = fallbackReason(String(failure?.message ?? last?.errorMessage ?? ''))

    if (!reason || !policy.on.includes(reason) || (!failure && last?.stopReason !== 'error')) break

    const next = selectModel(spec)

    await session.setModel(next)
    model = next
    failure = undefined

    try {
      await session.prompt('The previous model could not complete the call. Continue from where it stopped; edits so far are in the worktree.')
    } catch (error) { failure = error }
  }

  const last = lastReply()

  if (failure || !last || last.stopReason === 'error' || last.stopReason === 'aborted')
    throw new Error(`Pi did not finish successfully: ${failure?.message ?? last?.errorMessage ?? last?.stopReason ?? 'no reply'}`)

  return model
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
    instruction = withSkills(skills, "Follow AGENTS.md's testing rules.\n\n")
  }

  const runtime = await sdk.ModelRuntime.create()
  const key = existsSync(anthropicKeyFile) ? readFileSync(anthropicKeyFile, 'utf8').trim() : ''

  // A runtime key overrides the stored Anthropic login for this process only, and is never written to auth.json.
  if (key) await runtime.setRuntimeApiKey('anthropic', key)

  const policy = modelPolicy(process.env.FACTORY_MODEL_POLICY && JSON.parse(process.env.FACTORY_MODEL_POLICY), MODELS[role] ?? MODELS.coder)

  const selectModel = spec => {
    const [provider, id] = modelSpec(spec)
    const selected = runtime.getModel(provider, id)

    if (!selected || !runtime.hasConfiguredAuth(provider)) throw new Error(`Pi model/auth unavailable: ${spec}`)

    return selected
  }

  let model = selectModel(policy.primary)

  const { session } = await sdk.createAgentSession({
    cwd: worktree, model, modelRuntime: runtime, resourceLoader: loader,
    tools: role === 'review' || role === 'planner' ? ['read', 'grep', 'find', 'ls', 'codemode']
      : ['read', 'grep', 'find', 'ls', 'edit', 'write', 'codemode'],
    sessionManager: sdk.SessionManager.inMemory(),
  })

  const timer = setTimeout(() => { void session.abort() }, 30 * 60 * 1000)

  try {
    model = await promptWithFallback(session, instruction, policy, selectModel)

    // Keep the answer parseable while recording which model actually ran in the history.
    const note = `${model.provider}/${model.id}` === `${modelSpec(policy.primary).join('/')}`
      ? '' : `(Fallback model: ${model.provider}/${model.id}.)\n\n`

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
