import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [runDir, ref, commit] = process.argv.slice(2)
const baseline = JSON.parse(readFileSync(new URL('../lighthouse-baseline.json', import.meta.url)))
const read = name => { try { return JSON.parse(readFileSync(join(runDir, name))) } catch { return null } }
const emails = read('received-emails.json') ?? []
const specs = (read('playwright.json')?.suites ?? []).flatMap(suite => suite.specs ?? [])
// Human-owned: journey title -> reason. Only a human adds or removes entries, in a factory commit.
const knownFailures = {}
const journeys = specs.map(spec => {
  const test = spec.tests?.[0]
  const error = test?.results?.find(result => result.error)?.error?.message ?? null
  const passed = test?.status === 'expected' && test.results?.some(result => result.status === 'passed')
  const knownFailure = !passed && Object.hasOwn(knownFailures, spec.title)
  return { name: spec.title, status: passed ? 'passed' : knownFailure ? 'known-failure' : 'failed',
    reason: knownFailure ? knownFailures[spec.title] : error?.slice(0, 2000) ?? null }
})
const lighthouse = Object.entries(baseline.minimumScores).map(([path, minimum]) => {
  const name = path === '/' ? 'home' : path === '/mieten/lkw' ? 'category' : 'offer'
  const result = read(`lighthouse-${name}.json`)
  const accessibility = result ? Math.round(result.categories.accessibility.score * 100) : null
  const seo = result ? Math.round(result.categories.seo.score * 100) : null
  const crawlable = result?.audits?.['is-crawlable']?.score === 1
  return { path, accessibility, seo, minimum, crawlable,
    passed: crawlable && accessibility >= minimum.accessibility && seo >= minimum.seo }
})
const expectedNames = [
  'rent a LKW from its Google landing page',
  'buy a vehicle through the public search',
  'priced LKW schema and imageless transporter fallback',
  'customer inquiry reaches the supplier portal',
  'supplier creates, autosaves and publishes an offer',
  'supplier lead report shows deterministic September totals',
]
const covered = expectedNames.every(name => journeys.some(journey => journey.name === name))
const knownFailureNowPassing = journeys.filter(journey => Object.hasOwn(knownFailures, journey.name) && journey.status === 'passed').map(journey => `known failure now passing: ${journey.name}`)
const gatesPassed = lighthouse.every(gate => gate.passed)
const pass = covered && gatesPassed && journeys.every(journey => journey.status === 'passed')
const knownFailureOnly = covered && gatesPassed && journeys.some(journey => journey.status === 'known-failure') &&
  journeys.every(journey => journey.status === 'passed' || journey.status === 'known-failure')
process.stdout.write(JSON.stringify({ ref, commit, pass, knownFailureOnly, knownFailureNowPassing, journeys, lighthouse,
  emails: emails.map(({ to, subject }) => ({ to, subject })), baseline: baseline.measurement }, null, 2) + '\n')
