import assert from "node:assert/strict";
import { test } from "node:test";
import {
  laneOf,
  memberIssue,
  memberOf,
  parseProposedPrs,
  replaceSection,
  blockingFindings,
  type Finding,
  describeUatFailure,
  isMigrationPath,
  journeySource,
  planSteps,
  isSensitivePath,
  parseFindings,
  uatOutcome,
  workItemName,
} from "../src/rules.ts";

test("work item names are short: number and meaningful title words", () => {
  assert.equal(
    workItemName({ number: 1412, title: "Inquiries hang when Slack is down!" }),
    "1412-inquiries-hang-slack-down",
  );
  assert.equal(
    workItemName({
      number: 1425,
      title:
        "2/6 Read offers from an uploaded document in the background (#1423)",
    }),
    "1425-read-offers-uploaded",
  );
  assert.equal(
    workItemName({
      number: 1423,
      title: "Suppliers can import leasing and sale offers from a PDF or CSV",
    }),
    "1423-suppliers-import-leasing",
  );

  const long = workItemName({
    number: 9,
    title: "Supercalifragilisticexpialidocious-ness everywhere",
  });

  assert.ok(long.length <= 30 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(long), long);
});

test("reviewer findings come from the last json block, or not at all", () => {
  const reply =
    'Draft:\n```json\n{"findings":[]}\n```\nFinal:\n```json\n{"findings":[{"severity":"high","file":"a.ts","line":2,"description":"x"}]}\n```';
  assert.equal(parseFindings(reply)?.[0].severity, "high");
  assert.equal(parseFindings("no block"), null);
  assert.equal(
    parseFindings(
      '```json\n{"findings":[{"severity":"blocker","description":"x"}]}\n```',
    ),
    null,
  );
});

test("path policy and UAT verdicts", () => {
  assert.ok(
    isMigrationPath("supabase/migrations/1_x.sql") &&
      isMigrationPath("shared/types/supabase/database-generated.types.ts"),
  );
  assert.ok(
    isSensitivePath("package.json") &&
      isSensitivePath("server/services/x.ts") &&
      !isSensitivePath("server/api/x.ts"),
  );
  assert.equal(
    uatOutcome({ ref: "b", commit: "c", pass: false, knownFailureOnly: true }),
    "passed",
  );
  assert.equal(
    uatOutcome({
      ref: "b",
      commit: "c",
      pass: false,
      failure: "infrastructure",
    }),
    "infrastructure",
  );
  assert.equal(
    uatOutcome({ ref: "b", commit: "c", pass: false, failure: "build" }),
    "client",
  );
  const journey = { name: "j", status: "failed", reason: "timeout" };
  assert.equal(
    uatOutcome({ ref: "b", commit: "c", pass: false, journeys: [journey] }),
    "client",
  );
  assert.equal(
    uatOutcome({ ref: "b", commit: "c", pass: false, journeys: [] }),
    "infrastructure",
  );
  assert.equal(
    uatOutcome({
      ref: "b",
      commit: "c",
      pass: false,
      journeys: [journey],
      lighthouse: [
        { path: "/", accessibility: null, seo: null, passed: false },
      ],
    }),
    "infrastructure",
  );
});

test("parseStack reads the Factory stack form", async () => {
  const { parseStack, formSection } = await import("../src/rules.ts");
  const body =
    "### Outcome\n\nImport offers\n\n### PRs in order\n\n1. Database (by hand)\n2. Read offers\n3) Review them\nnot a PR line\n\n### Lane\n\nfast lane\n\n---\n\n## Design\n### Lane\n\nstandard";
  assert.deepEqual(parseStack(body), {
    members: [
      { title: "Database", byHand: true },
      { title: "Read offers", byHand: false },
      { title: "Review them", byHand: false },
    ],
    lane: "fast lane",
  });
  assert.equal(formSection(body, "Missing"), "");
});

test("planSteps splits on numbered lines and keeps each step's lines; an unnumbered plan is one step", () => {
  assert.deepEqual(
    planSteps("Intro.\n\n1. Move it.\n- a\n2. Add b.\n\nNote."),
    ["1. Move it.\n- a", "2. Add b.\n\nNote."],
  );
  assert.deepEqual(planSteps("Just fix it."), []);
  assert.deepEqual(planSteps("1. Only one step."), []);
});

test("only critical and high findings block", () => {
  const finding = (severity: Finding["severity"]) => ({
    severity,
    file: "a.ts",
    line: 1,
    description: severity,
  });

  assert.deepEqual(
    blockingFindings(
      ["critical", "high", "medium", "low"].map((s) =>
        finding(s as Finding["severity"]),
      ),
    ).map((f) => f.severity),
    ["critical", "high"],
  );
});

test("a failed journey's code goes into the UAT failure, up to the next journey", () => {
  const spec = "import x\n\ntest('customer inquiry', async ({ page }) => {\n  await page.goto('/a')\n})\n\ntest('other', () => {})\n";
  const source = journeySource(spec, "customer inquiry");
  assert.equal(source, "test('customer inquiry', async ({ page }) => {\n  await page.goto('/a')\n})");
  assert.equal(journeySource(spec, "missing"), undefined);
  assert.equal(journeySource(spec, "other"), "test('other', () => {})");
  const text = describeUatFailure({ ref: "b", commit: "c", pass: false, journeys: [{ name: "customer inquiry", status: "failed", reason: "timeout", source }] });
  assert.ok(text.includes("page.goto('/a')"));
});

test('standard lane rules: lane, proposed PRs, section replace', () => {
  assert.equal(laneOf('### Outcome\n\nX\n\n### Lane\n\nstandard'), 'standard')
  assert.equal(laneOf('### Lane\n\nfast lane'), 'fast')
  assert.equal(laneOf('no form'), 'fast')
  assert.deepEqual(parseProposedPrs('findings…\n\nProposed PRs:\n\n1. A: x\n2) B (by hand)\n\nWhy: because'), ['A: x', 'B (by hand)'])
  assert.deepEqual(parseProposedPrs('```json\n{}\n```'), [])
  assert.deepEqual(memberOf('B (by hand)'), { title: 'B', byHand: true })
  assert.equal(replaceSection('### Outcome\n\nX\n\n### PRs in order\n\n1. A\n\n### Lane\n\nstandard', 'PRs in order', '1. A\n2. B'),
    '### Outcome\n\nX\n\n### PRs in order\n\n1. A\n2. B\n\n### Lane\n\nstandard')
  assert.equal(replaceSection('### Outcome\n\nX', 'Lane', 'standard'), '### Outcome\n\nX\n\n### Lane\n\nstandard\n')
  assert.match(memberIssue({ parent: { number: 1, title: 'T', body: '', url: '', author: '', comments: [] }, branch: 'stack/x', design: 'd', index: 0, total: 1, member: { title: 'A', byHand: false }, lane: 'standard' }).body, /### Lane\n\nstandard$/)
})
