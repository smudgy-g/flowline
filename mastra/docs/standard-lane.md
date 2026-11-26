# Plan: the standard lane, as a thorough mode of the fast lane

Status: built 2026-11-22 (both phases), with two automatic plan revisions instead of one. README.md "The standard lane" describes how it behaves; this is the plan it came from.

## Why

A technical spec and a PR list are written up front, and gaps show up later: edge cases nobody covered,
missing steps, steps too big for one coder call, PRs too big to review, and an issue that no longer matches
once the plan changes. #1450 is the example: plan steps 3, 6 and 7 were each several functions plus tests; the
coder did slices of them for eleven rounds (FEEDBACK 30).

Swamp's standard lane reviewed plans for *correctness* (six reviewers) and churned on it: five plan-review rounds
and four overrides on a pure-code PR (FEEDBACK 22), and reviewers adding scope (FEEDBACK 7). Nothing reviewed
plans for *completeness and cut*: edge cases, missing steps, step size, PR size.

So: one workflow, with a `standard` setting that adds both kinds of plan review where a wrong or badly cut plan
is expensive, applies what it finds, and keeps you the one who decides, without the loops that churned.

## How it is chosen

The issue forms already ask: `### Lane` is `fast lane` or `standard` (client `.github/ISSUE_TEMPLATE/factory.yml`,
`factory-stack.yml`). Today a single issue's lane is ignored and a `standard` stack is refused (`stack.ts:91`).

- `intake` reads `### Lane` into `state.lane: "fast" | "standard"`; anything else is fast.
- A stack accepts `standard` and writes it into each member's `### Lane` (`memberIssue`); `(by hand)` stays.
- The board tags standard cards.

## The `plan-fitness` skill (new, in `agents/.agents/skills/plan-fitness/`)

Written with the `write-a-skill` skill. A read-only reviewer that judges whether a plan (or a stack's design and
PR list) is complete and well cut, against the issue's Outcome and Out of scope. It reports findings in the
factory's JSON findings block, each with a concrete proposed change:

- **Edge cases:** inputs, states and failure paths the outcome needs handled that no step or test covers; names
  the step (or new step) and test that should cover each.
- **Missing steps:** work the outcome needs that no step does, including tests and wiring.
- **Step size:** a step bigger than one coder call (about one or two files and their tests) → its proposed split.
- **PR size:** work too big for one reviewable PR → a proposed split into PRs, in order, each with outcome and
  scope; for a stack, also PRs missing from the list.
- **Order:** a step or PR that depends on a later one.

Rules: never add scope beyond the Outcome (that's a low follow-up); critical only when the outcome can't be
met as planned; prefer the smallest change to the plan that closes the gap.

## Phase 1: review gates

### 1a. Stack gate (before any sub-issue exists)

When the design is submitted, before `design-approval`, two reviewers run in parallel on the design plus the PR
list: `plan-fitness` and `architect`.

- Their findings and any proposed PR-list changes (added, split, merged or reordered PRs) wait for you at
  `design-approval`, with the proposed list beside the current one.
- You approve the design with the list as is, or with the proposed list, or send it back.
- Approving with a changed list sets `state.members` from it and **updates the parent issue's "PRs in order"**
  (new `ops.updateIssueSection`), then `setup` creates the sub-issues from the approved list as now.
- The reviewers need the code: they run read-only in a checkout of the stack's base. `runPi` today requires a
  task worktree; read-only roles get a fresh detached worktree of `origin/staging` (never `client/staging`
  itself), removed afterwards.

### 1b. Plan gate (standard tasks and stack members, after each planner draft)

Four reviewers run in parallel on the drafted plan:

| Reviewer | Catches |
|---|---|
| `plan-fitness` | edge cases, missing steps, oversized steps, an oversized PR |
| `goldfish-implementation-readiness` | decisions the plan leaves to the coder (#1450's four open questions) |
| `goldfish-codebase-details` | claims about the code that are wrong |
| `architect` | a design that won't hold (ownership, layering, data shape) |

`change-impact` stays out of plan review: it reported "not implemented yet" as a blocker (FEEDBACK 22).

Flow:

1. Findings with proposed changes to the plan (edge cases, missing steps, step splits, critical issues) → the
   planner revises **once, automatically**, with them as notes; the revision is reviewed once more.
2. Then it waits at `plan-approval` as now, with the plan, its open questions and the remaining findings. You
   approve with findings open, or send it back. No further automatic rounds; no override needed.
3. A proposed **PR split** is never applied automatically. In phase 1 it is shown at `plan-approval` as a
   finding; you decide (approve as one PR, or send back narrower). Phase 2 makes it a button.

### 1c. Wider code review (standard, each round)

The current reviewer (correctness, security, plan completeness, over-engineering) plus `architect`, `interrogate`,
`change-impact` and `typescript-guidance` in parallel (Swamp standard's set). Same rules: judged against the
plan and your decisions; critical and high block; the rest become PR notes; each finding tagged with its
reviewer. An extra reviewer with unparseable findings (even when asked again) is recorded and skipped; only the
main reviewer's failure waits for `fx findings`, as now.

## Phase 2: splitting PRs after planning starts

### 2a. A stack member that should be more than one PR

1. At `plan-approval`, a proposed split shows as **Split into N PRs**, with each new PR's outcome and scope, next
   to Approve and Send back. You can edit the list before splitting.
2. Splitting: the member's plan is re-drafted for the first part only; the rest are recorded in the member's
   state (`split`), and the member carries on as a normal run.
3. When the member finishes (its card is cleaned up), the stack's `members` step reads the member's `split`
   (`members.splitOf(number)`, via `laneState`), inserts the new PRs **right after it** in `state.members`,
   creates their sub-issues (`memberIssue`, with the stack's design and lane), moves them to the right place in
   the parent's sub-issue order (GitHub's sub-issue priority API, `after_id`), updates the parent's "PRs in
   order", and records it in the stack history. Then the next member starts as usual.

Doing the insert when the member finishes, inside the stack's own step, keeps every change to the stack in the
stack workflow, and a restart mid-insert is safe the same way `setup` is (saved one sub-issue at a time).

### 2b. A single issue that should be more than one PR

The same button; splitting re-drafts the plan for the first part and creates one new `factory` issue per
remaining part (Outcome, Why, Lane copied, "Split from #N"), linked from the original. They appear in the
Issues column to start when you choose. The original issue's body gets a "Split into" line.

## Where it goes in the code

- `agents` repo: `.agents/skills/plan-fitness/SKILL.md`.
- `fast-lane.ts`: `lane` in `LaneState`/`initialState`; `intake` sets it; `plan` runs plan review for standard
  before `plan-approval` (findings in the wait payload and history); `review` runs extra reviewers with
  `Promise.all`. Phase 2: `split` in `LaneState`, `split` resume action.
- `rules.ts`: `planReviewPrompt(issue, plan, skill)`, `designReviewPrompt(design, members, skill)`,
  `laneOf(body)`, an optional skill for `reviewPrompt`, `memberIssue` writing the lane; parse proposed PR lists.
- `stack.ts`: accept `standard`; design review before `design-approval`; apply an approved list (and update the
  parent issue). Phase 2: insert split members in `members`.
- `ops.ts`: `updateIssueSection`, a read-only review checkout, a skills check at provision for standard runs.
  Phase 2: create issues, sub-issue reordering.
- `board.ts` / `board.html`: lane tag; findings and proposed list on `plan-approval` and `design-approval`.
  Phase 2: the Split button and its editable list.
- `README.md`, and a FEEDBACK item to review after a few standard runs.

## Tests (fake world)

Phase 1:
- A fast-lane issue makes no plan-review calls and one code-review call (unchanged).
- Standard: four plan reviewers; findings with proposed changes → one automatic revision and one more review,
  then `plan-approval` carries plan and remaining findings; approving with an open finding goes on to coding.
- Standard code review: five reviewers; an extra reviewer's blocking finding goes to the coder; an unparseable
  extra reviewer doesn't stop the round.
- Stack: design review runs before `design-approval`; approving with a proposed list sets the members, updates
  the parent issue, and the sub-issues follow the new list; a `standard` stack's members say `standard`.

Phase 2:
- A member split: the member goes on with the first part; when it finishes, the new PRs are inserted after it
  with sub-issues in order and the parent's list updated; a restart mid-insert creates no duplicate.
- A single-issue split creates the new issues once.

## Cost

Per standard run, on the review model (`gpt-6.2-sol`, or Opus on the Claude fallback, billed per token):
4 calls per plan draft (8 with the automatic revision), 4 extra per code-review round, and 2 per stack design.
Reviewers run in parallel, so wall clock grows by about one review each time.

## Decided

- `plan-fitness` lives in the `agents` repo.
- Phase 2 (PR splits after planning starts) is part of this plan.

## To confirm

1. One automatic plan revision, then you decide.
2. The reviewer sets: stack gate (`plan-fitness`, `architect`), plan gate (the four above), code review (the
   four extras above).
