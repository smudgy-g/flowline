// Pure rules of the fast lane: naming, path policy, prompts, review parsing, UAT verdicts and the PR body.
// Everything here is side-effect free so it can be tested without git, Pi or GitHub.
import { createHash } from "node:crypto";

export type Issue = {
  number: string;
  title: string;
  body: string;
  url: string;
  author: string;
  comments: string[];
};
export type Plan = { summary: string; tests: string };
export type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  description: string;
};
export type UatReport = { ref: string; commit: string; pass: boolean; detail: string };

export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Branch and worktree name for an issue: `<number>-<title slug>`, at most about 30 characters. */
/** Words that carry no meaning in a short name. */
const FILLER = new Set(
  "a an the and or of to in on at by for from with into is are be can when".split(
    " ",
  ),
);

/**
 * A short name for the branch, worktree and tmux window: the issue number and the first meaningful words of its
 * title, cut at a word, at most about 30 characters. A stack member's "2/6 " prefix and "(#1423)" suffix are dropped.
 * e.g. "2/6 Read offers from an uploaded document in the background (#1423)" → "1425-read-offers-uploaded".
 */
export function workItemName(issue: { number: string; title: string }): string {
  const words = issue.title
    .replace(/^\s*\d+\/\d+\s+/, "")
    .replace(/\s*\(#\d+\)\s*$/, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !FILLER.has(word));

  let name = issue.number;

  for (const word of words) {
    if (name.length + 1 + word.length > 30) break;

    name += `-${word}`;
  }

  // A first word too long to fit is cut rather than left out.
  if (name === issue.number && words.length) {
    name = `${name}-${words[0]}`.slice(0, 30);
  }

  return name;
}

/** The plan's numbered steps ("1. ...", each with the lines under it). Fewer than two: the plan is one step. */
export function planSteps(summary: string): string[] {
  const parts = summary
    .split(/\n(?=\d+\.\s)/)
    .filter((part) => /^\d+\.\s/.test(part));
  return parts.length > 1 ? parts.map((part) => part.trim()) : [];
}

/** A read-only Pi call that splits a plan or spec that has no numbered steps into coder-sized steps. */
export function breakdownPrompt(plan: Plan): string {
  return [
    "Split this approved plan into the steps a coder will do, one coder call each. Read-only: read the code it touches first.",
    "Each step: one coherent piece (about one or two files and their tests), in dependency order, naming the files and what changes in them, with the details from the plan it needs. Usually 2 to 8 steps. Cover the whole plan and its tests; add nothing it does not ask for.",
    `## Plan\n${plan.summary}\n\n## Tests to add or change\n${plan.tests}`,
    'End your reply with exactly one ```json block: {"steps":["...","..."]}',
  ].join("\n\n");
}

/**
 * The planner writes the plan itself from the issue and the code (read-only), so a complete issue needs no chat
 * with the driver. `revise` carries its previous draft and what the human said about it.
 */
export function planPrompt(
  issue: Issue,
  revise?: { draft?: Plan; notes: string; findings?: string },
  scope?: string,
): string {
  return [
    `Write the implementation plan for work item ${issue.number}: ${issue.title}`,
    "Read-only. First read AGENTS.md, CONTEXT.md and docs/ where relevant, any stack design in .agents/artefacts/stack/, and the code the issue touches; trace the real flow. Then plan the narrowest change that meets the issue.",
    `## Issue\n${issue.body}`,
    scope &&
      `## This PR is only part of the issue\nThe issue was split into several PRs. Plan only this part; the other parts are separate PRs, so leave them out (name them under \`Not changed:\`).\n${scope}`,
    revise?.draft &&
      `## Your previous draft\n${revise.draft.summary}\n\nTests:\n${revise.draft.tests}`,
    revise?.notes &&
      `## What the human said (it overrides your draft and your defaults)\n${revise.notes}`,
    revise?.findings &&
      `## What the plan reviewers found\nRevise the draft to close these gaps: add the missing steps, tests and edge cases, split oversized steps, fix wrong claims and order. Apply each finding that fits the issue; skip one that would grow scope or contradict the human, and say which and why in questions. Never split the PR yourself: a proposed PR split is the human's call.\n${revise.findings}`,
    [
      "## What to write",
      "- summary: one short line on scope, then numbered steps (`1. `, `2. `, …) in dependency order, one coherent piece each, naming the files and exactly what changes there. Finish with a `Not changed:` line for related things you deliberately leave alone.",
      "- tests: the tests to add or change, by spec file, following AGENTS.md's Testing rules. Only tests the coder can write; checking the running app in a browser is UAT's job, not a test.",
      "- questions: only decisions the issue leaves open that would change the plan. For each, say the default you planned and why. An empty list when there are none.",
      "Respect the issue's Out of scope. Never grow scope; put extras in `Not changed:`.",
      "- The coder can only edit files in this worktree. It can't run commands, read git history, or see UAT runs or their logs, and UAT journeys are human-owned and outside the worktree. Never plan a step that asks it to investigate a run, compare branches, or change a journey. After a UAT failure, read the failed journey (it is in the failure) against the code. If the journey no longer matches what the issue asks for (say it skips a field the issue makes required), plan no code for it; put it in questions with the exact journey change the human must make.",
    ].join("\n"),
    'End your reply with exactly one ```json block: {"summary":"...","tests":"...","questions":["..."]}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The plan from the planner's last ```json block, or null when it has none or it is unusable. */
export function parsePlan(
  text: string,
): { plan: Plan; questions: string[] } | null {
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];

  try {
    const { summary, tests, questions } = JSON.parse(block ?? "");

    if (typeof summary !== "string" || !summary.trim()) return null;
    if (typeof tests !== "string" || !tests.trim()) return null;

    return {
      plan: { summary: summary.trim(), tests: tests.trim() },
      questions: Array.isArray(questions)
        ? questions.filter((q) => typeof q === "string" && q.trim())
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * The plan steps the coder's whole-plan call says are not yet in the code, from its last "Unfinished steps:" line
 * (1-based, within the plan). None, or no such line: [].
 */
export function parseUnfinished(reply: string, total: number): number[] {
  const line = [...reply.matchAll(/^\W*Unfinished steps:(.*)$/gim)].at(-1)?.[1] ?? "";
  const numbers = [...line.matchAll(/\d+/g)].map(Number);
  return [...new Set(numbers)].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
}

/** The steps from the planner's last ```json block, or null when it has none or it is malformed. */
export function parseSteps(text: string): string[] | null {
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  try {
    const { steps } = JSON.parse(block ?? "");
    return Array.isArray(steps) &&
      steps.length &&
      steps.every((s) => typeof s === "string" && s.trim())
      ? steps.map((s, i) => `${i + 1}. ${s.trim().replace(/^\d+\.\s*/, "")}`)
      : null;
  } catch {
    return null;
  }
}

/**
 * The coder does one bounded piece per call and stops (it did so under Swamp too, whose controller re-prompted it
 * step by step). So a first round gives it one plan step per call, then a whole-plan call that finishes what's left.
 */
export function coderPrompt(
  issue: Issue,
  plan: Plan,
  feedback: string,
  decisions: string[] = [],
  step?: { index: number; total: number; text: string },
): string {
  return [
    `Implement the approved plan for work item ${issue.number}: ${issue.title}`,
    `## Plan\n${plan.summary}\n\n## Tests to add or change\n${plan.tests}`,
    decisionsText(decisions),
    feedback && `## Fix this first\n${feedback}`,
    `## Issue\n${issue.body}`,
    step
      ? `## This call: step ${step.index + 1} of ${step.total} only\n${step.text}\n\nEarlier steps are already in the worktree; read them, don't redo them. Part of this step may be there too; finish what is missing. Leave later steps to later calls. Write this step's tests from the list above. You can't run tests; the factory runs them after the last step. Stop when this step is done, or when you are blocked; then say which, and why.`
      : "## When you are done\nThe worktree may already hold part of this plan. Check every numbered plan step and every listed test against the files, and finish whatever is missing before you stop. You can't run tests; the factory runs them afterwards. Stop only when the whole plan is in the code, or when you are blocked; then say which, and why. A step too big to finish here can wait: each step you name as unfinished gets its own call next.\n\nEnd your reply with one line naming the plan steps not fully in the code, such as `Unfinished steps: 3, 6`, or `Unfinished steps: none`.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The human's decisions since the plan was approved, as a prompt section; empty when there are none. */
const decisionsText = (decisions: string[]) =>
  decisions.length
    ? `## The human's decisions since the plan was approved (they override the plan where they differ)\n${decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
    : "";

/** The fast lane's one cold reviewer. It must end with a JSON findings block the controller can parse. */
export function reviewPrompt(
  base: string,
  plan: Plan,
  decisions: string[] = [],
  skill?: string,
): string {
  return [
    skill
      ? `Cold review of a change with /skill:${skill}: report only what that skill looks for.`
      : "Cold correctness and security review.",
    "Report actionable findings by severity. Read-only. Give file:line and a precise correction.",
    `The change is \`git diff ${base}...HEAD\` plus uncommitted files; anything else on the branch is already reviewed.`,
    `The approved plan:\n${plan.summary}`,
    `The tests it lists:\n${plan.tests}`,
    decisionsText(decisions) &&
      `${decisionsText(decisions)}\nWhere a decision changes the plan, judge the change against the decision; following it is never a finding.`,
    !skill &&
      "Also check completeness: each plan step or listed test that the change does not implement is a high finding naming the step.",
    !skill &&
      "Also review for over-engineering with /skill:ponytail-review: each thing to cut or simplify is a low finding saying what replaces it, unless it hides a bug.",
    "Judge the change against the plan. Critical and high are for defects in what the plan asks for: it breaks, loses or leaks data, or a step is missing. Anything the plan does not ask for (a new feature, limit, quota, hardening or work in another repository) is at most medium, as a follow-up.",
    "The coder cannot run commands. Black-box acceptance checks run after review, so a check only a running app can do is never a finding.",
    'End your reply with exactly one ```json block: {"findings":[{"severity":"critical|high|medium|low","file":"path","line":1,"description":"..."}]} (an empty array when there are none).',
  ]
    .filter(Boolean)
    .join("\n");
}

/** When a reviewer forgets its findings block: a second call that turns its own reply into one. */
export function findingsFormatPrompt(reply: string): string {
  return [
    "A code reviewer wrote the findings below but left out the machine-readable block. Convert them exactly; add, drop or re-judge nothing. No findings means an empty array.",
    `## The review\n${reply.slice(-12000)}`,
    'Reply with exactly one ```json block: {"findings":[{"severity":"critical|high|medium|low","file":"path","line":1,"description":"..."}]}',
  ].join("\n\n");
}

/** The last ```json block in a reviewer's reply, or null when it has none or it is malformed. */
export function parseFindings(text: string): Finding[] | null {
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  if (!block) return null;
  try {
    const { findings } = JSON.parse(block);
    if (!Array.isArray(findings)) return null;
    const severities = ["critical", "high", "medium", "low"];
    return findings.every(
      (f) =>
        severities.includes(f?.severity) && typeof f.description === "string",
    )
      ? findings
      : null;
  } catch {
    return null;
  }
}

/** Only critical and high go back to the coder; medium and low are shown at "Your OK" for you to judge. */
export const blockingFindings = (findings: Finding[]) =>
  findings.filter((f) => f.severity === "critical" || f.severity === "high");
export const describeFindings = (findings: Finding[]) =>
  findings
    .map((f) => `- ${f.severity} ${f.file}:${f.line}: ${f.description}`)
    .join("\n");

export function draftPrBody(args: {
  issue: Issue;
  plan: Plan;
  report: UatReport;
  uatRun: string;
  lowNotes: string[];
}): string {
  const { report } = args;
  return [
    `## Summary\n${args.plan.summary}`,
    `## Why\nRefs ${args.issue.number}: ${args.issue.title}`,
    `## Verification\n- Acceptance: ${report.pass ? "pass" : "fail"} (run ${args.uatRun}, commit ${report.commit})\n${report.detail}`,
    `## Low review notes\n${args.lowNotes.join("\n") || "None"}`,
    "Human review required; no auto-merge.",
  ].join("\n\n");
}

export type StackMember = { title: string; byHand: boolean; number?: string };

/** A section of an issue-form body: the text under `### <name>` up to the next heading. */
export function formSection(body: string, name: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `### ${name.toLowerCase()}`,
  );
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/** The Factory stack form's "PRs in order": one numbered line per PR, "(by hand)" marking steps the factory must not do. */
export function parseStack(body: string): {
  members: StackMember[];
  lane: string;
} {
  const members = formSection(body, "PRs in order")
    .split("\n")
    .map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l)?.[1].trim())
    .filter((t): t is string => !!t)
    .map((t) => ({
      title: t.replace(/\s*\(by hand\)\s*/i, " ").trim(),
      byHand: /\(by hand\)/i.test(t),
    }));
  return {
    members,
    lane: formSection(body, "Lane").split("\n")[0].trim().toLowerCase(),
  };
}

/** A member's sub-issue: the Factory task form's shape, plus the approved design every member's plan follows. */
export function memberIssue(args: {
  parent: Issue;
  branch: string;
  design: string;
  index: number;
  total: number;
  member: StackMember;
  lane?: Lane;
}) {
  const { parent, member, index, total } = args;
  // No "(#parent)": the title becomes the PR's, and the sub-issue link already ties it to the stack.
  const title = `${index + 1}/${total} ${member.title}`.slice(0, 250);
  const body = [
    `### Outcome\n\n${member.title}\n\nPR ${index + 1} of ${total} in the stack #${parent.number} (${parent.title}). It builds on what earlier PRs merged into \`${args.branch}\`, and must follow the technical design below.`,
    `### Why\n\nPart of #${parent.number}; see its Why.`,
    `### Technical design (approved for the whole stack)\n\n${args.design}`,
    `### Lane\n\n${member.byHand ? "by hand" : laneName(args.lane ?? "fast")}`,
  ].join("\n\n");
  return { title, body };
}

/** The issue form's lane. `standard` adds plan review and a wider code review; anything else is the fast lane. */
export type Lane = "fast" | "standard";
export const laneOf = (body: string): Lane =>
  formSection(body, "Lane").split("\n")[0].trim().toLowerCase() === "standard"
    ? "standard"
    : "fast";
export const laneName = (lane: Lane) =>
  lane === "standard" ? "standard" : "fast lane";

/** Who reviews what in the standard lane, one fresh read-only Pi call each, in parallel. */
export const PLAN_REVIEWERS = [
  "plan-fitness",
  "goldfish-implementation-readiness",
  "goldfish-codebase-details",
  "architect",
];
export const DESIGN_REVIEWERS = ["plan-fitness", "architect"];
/** Automatic planner revisions on reviewer findings before the plan waits for the human. */
export const MAX_PLAN_REVISIONS = 2;

const FINDINGS_FORMAT =
  'End your reply with exactly one ```json block: {"findings":[{"severity":"critical|high|medium|low","file":"path","line":1,"description":"..."}]} (an empty array when there are none).';
const PLAN_SEVERITIES =
  "Critical only when the outcome can't be met as planned; high for a gap the outcome needs closed; medium for a likely gap worth closing now; low for follow-ups and anything beyond the issue's Outcome or inside its Out of scope. Never add scope. Each finding: the gap, the evidence (file:line, or the plan or issue quoted), and the exact change to the plan. A plan with no file yet: the file the step names, or file \"issue\", line 0.";

/** One standard-lane reviewer of a drafted plan, before the human sees it. */
export function planReviewPrompt(
  issue: Issue,
  plan: Plan,
  questions: string[],
  skill: string,
  scope?: string,
): string {
  return [
    `Review the drafted plan for work item ${issue.number}: ${issue.title} with /skill:${skill}, before any code is written.`,
    "Read-only. Read the code the plan touches before judging it.",
    `## Issue\n${issue.body}`,
    scope && `## This PR covers only this part of the issue\n${scope}`,
    `## The plan\n${plan.summary}\n\nTests:\n${plan.tests}`,
    questions.length &&
      `## Its open questions (each with the default it chose)\n${questions.map((q) => `- ${q}`).join("\n")}`,
    PLAN_SEVERITIES,
    "When the work is clearly more than one reviewable PR, don't make that a finding: give the split at the end, under `Proposed PRs:`, one numbered line each, as `N. <outcome>: <scope>`. The first PR is what this plan keeps. Whether to split is the human's call.",
    FINDINGS_FORMAT,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One reviewer of a standard stack's design and PR list, before the human approves it. */
export function designReviewPrompt(
  issue: Issue,
  design: string,
  members: StackMember[],
  skill: string,
): string {
  return [
    `Review the technical design and PR list for the stacked feature ${issue.number}: ${issue.title} with /skill:${skill}, before any PR starts.`,
    "Read-only. The checkout is the current base branch; read the code the design touches before judging it.",
    `## Issue\n${issue.body}`,
    `## The design (one for every PR)\n${design}`,
    `## PRs in order\n${members.map((m, i) => `${i + 1}. ${m.title}${m.byHand ? " (by hand)" : ""}`).join("\n")}`,
    PLAN_SEVERITIES,
    'When the PR list should change (a PR missing, too big, to merge, or out of order), say so in findings and also give the whole new list at the end, under `Proposed PRs:`, one numbered line each, keeping "(by hand)" on PRs a person does.',
    FINDINGS_FORMAT,
  ].join("\n\n");
}

/** The numbered lines under a reviewer's last `Proposed PRs:` heading; [] when it has none. */
export function parseProposedPrs(text: string): string[] {
  const at = text.lastIndexOf("Proposed PRs:");
  if (at < 0) return [];
  const lines: string[] = [];
  for (const line of text.slice(at + "Proposed PRs:".length).split("\n")) {
    const item = /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1]?.trim();
    if (item) lines.push(item);
    else if (line.trim().startsWith("```") || (lines.length && line.trim()))
      break;
  }
  return lines;
}

/** A proposed PR line as a stack member: "(by hand)" marks one the factory must not do. */
export const memberOf = (line: string): StackMember => ({
  title: line.replace(/\s*\(by hand\)\s*/i, " ").trim(),
  byHand: /\(by hand\)/i.test(line),
});

/** A finding tagged with the reviewer that made it. */
export const tagged = (skill: string, findings: Finding[]): Finding[] =>
  findings.map((f) => ({ ...f, description: `[${skill}] ${f.description}` }));

/** The issue body with one form section's text replaced (added at the end when missing). */
export function replaceSection(body: string, name: string, text: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `### ${name.toLowerCase()}`,
  );
  if (start < 0) return `${body.trimEnd()}\n\n### ${name}\n\n${text}\n`;
  const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
  return [
    ...lines.slice(0, start + 1),
    "",
    text,
    "",
    ...(end < 0 ? [] : lines.slice(end)),
  ].join("\n");
}

/** A PR list as the stack form writes it. */
export const membersText = (members: StackMember[]) =>
  members
    .map((m, i) => `${i + 1}. ${m.title}${m.byHand ? " (by hand)" : ""}`)
    .join("\n");

/** A new Factory task issue for one part of a split issue. */
export function splitIssue(parent: Issue, part: string, lane: Lane) {
  return {
    title: part.split(":")[0].trim().slice(0, 250) || part.slice(0, 250),
    body: [
      `### Outcome\n\n${part}`,
      `### Why\n\nSplit from #${parent.number} (${parent.title}); see its Why.`,
      `### Out of scope\n\nThe other parts of #${parent.number}.`,
      `### Lane\n\n${laneName(lane)}`,
    ].join("\n\n"),
  };
}
