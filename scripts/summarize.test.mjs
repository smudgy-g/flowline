import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const names = [
  'rent a LKW from its Google landing page', 'buy a vehicle through the public search',
  'priced LKW schema and imageless transporter fallback',
  'customer inquiry reaches the supplier portal',
  'supplier creates, autosaves and publishes an offer',
  'supplier lead report shows deterministic September totals',
]

function verdictFor(failing) {
  const dir = mkdtempSync(join(tmpdir(), 'uat-verdict-'))
  try {
    const specs = names.map(title => failing === title
      ? { title, tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: 'expect(page).toHaveURL(/requested=1/) failed' } }] }] }
      : { title, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] })
    writeFileSync(join(dir, 'playwright.json'), JSON.stringify({ suites: [{ specs }] }))
    for (const name of ['home', 'category', 'offer'])
      writeFileSync(join(dir, `lighthouse-${name}.json`), JSON.stringify({ categories: { accessibility: { score: 0.95 }, seo: { score: 1 } }, audits: { 'is-crawlable': { score: 1 } } }))
    return JSON.parse(execFileSync('node', ['scripts/summarize.mjs', dir, 'branch', 'sha'], { encoding: 'utf8' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('all journeys passing is a clean pass', () => {
  const verdict = verdictFor(null)
  assert.equal(verdict.pass, true)
  assert.deepEqual(verdict.knownFailureNowPassing, [])
})

test('customer inquiry is no longer a known failure', () => {
  const verdict = verdictFor('customer inquiry reaches the supplier portal')
  assert.equal(verdict.pass, false)
  assert.equal(verdict.knownFailureOnly, false)
  assert.equal(verdict.journeys.find(journey => journey.name === 'customer inquiry reaches the supplier portal').status, 'failed')
})
