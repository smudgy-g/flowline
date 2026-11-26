# Triage and planning: design

Status: draft; the three decisions at the end are agreed (2026-11-18).

## Why

The front of the factory depends on the driver being in a chat with you. Plans and questions live in that
chat, nothing moves without it, and a week later nobody remembers why a question was asked (qualification-v2). No
plan is checked against the code before you approve it: #1425's plan and the offer-import design had no goldfish
pass.

Goal: the factory triages and plans by itself, checks its plans against the code with fresh reviewers, and brings
you only decisions, each with its context. The driver becomes optional.

## The flow

```
Issue ─▶ Triage ─▶ Plan ─▶ Plan review ─▶ You approve ─▶ Code ▶ Tests ▶ Review ▶ Your OK ▶ UAT ▶ Draft PR
          │  ▲                  │  ▲
          ▼  │                  ▼  │
       questions to you     revise, or questions to you
```

Board columns: Issues, **Triage** (new), Plan, Code, Tests, Review, Your OK, UAT, Draft PR. Build and later stages
are unchanged.

### 0. Provision first

Triage and planning read the code, so the worktree is created at the start (as Swamp's standard lane does), not after
plan approval. Abandoning a card removes it as today.

### 1. Triage

1. **Read.** A read-only Pi call (`triage` role, `triage` skill) reads the issue, the repo's agent instructions (`.agents/`,
   `AGENTS.md`), `CONTEXT.md`, the ADRs and the code the issue touches. It returns JSON:
   - `size`: `small` (one PR, a fix or contained change) or `large` (a feature, a new concept, data changes);
   - `hypothesis`: 2–3 sentences: the problem, who it is for, the approach, hard constraints;
   - `questions`: what it cannot decide from the issue and the code;
   - `investigate`: set when the cause can only be found by running something (the agents have no shell). The card
     then asks the driver to investigate, as today.
2. **Stage A (concept), large only.** Six fresh read-only reviewers in parallel, one per lens (YAGNI, cost and load,
   UX, migration and compatibility, observability, long-term maintenance), given only the hypothesis. Their critical
   and major findings become questions; minor ones become follow-ups.
3. **Questions to you, deduplicated, each self-contained:** what the work item is for, the finding and its evidence,
   up to three options with trade-offs, and any earlier answer it depends on. You answer on the card.
4. **Lane.** Triage proposes one from `size`: small → fast lane, large → standard. You can override it on the card.
   The issue form's Lane becomes optional, a hint.
5. Every question and answer is also posted as one comment on the GitHub issue, so the record stays with the issue,
   not the factory's database.

Small work with no questions goes straight to Plan with no stop.

### 2. Plan

A read-only Pi call (`planner` role, with `to-prd` style guidance) writes the plan from the issue, the hypothesis,
your answers and the code. Its output is the plan we use today, `summary` and `tests`, with the summary as numbered
steps (so the coder's steps need no split). Out-of-scope follow-ups are listed, never added.

You or the driver can still write or replace the plan on the card ("Save plan"); it then goes through plan review
like any other.

### 3. Plan review (Stage B)

Fresh read-only reviewers in parallel, each one Pi session with one job, given only the plan (not the issue or the
answers: the point is to expose what the plan doesn't say):

- `goldfish-codebase-details`: does the code work the way the plan says?
- `goldfish-implementation-readiness`: what does the plan leave the coder to decide?
- `architect`: data shapes, ownership, module boundaries.
- `interrogate`: security, concurrency, migrations, contracts, false-confidence tests.

All four on every lane: a small change can still break a contract. `architect` and `interrogate` scope themselves
(they skip local, low-risk changes), so on small work they return quickly.

- **Critical and major:** back to the planner with the findings. It either corrects the plan (the code contradicts
  it) or turns a finding into a question for you (a decision the plan left open). Then plan review runs again.
- **Minor:** listed on the card as notes and in the plan's follow-ups.
- **At most 3 review rounds.** After that the card asks you, showing the plan and the open findings.

Runs on every lane; it would have caught claims about the code in #1425.

### 4. You approve

As today, with the plan review's notes beside the plan. Approval starts the build.

## Code review (every lane)

Fresh read-only reviewers in parallel on the diff, replacing today's single reviewer:

- cold correctness and security, with the completeness check (each plan step done);
- `ponytail-review`: over-engineering, what to delete;
- `change-impact`: callers, contracts, deploy order, missing regression tests;
- `typescript-guidance`: boundary parsing, no `any`, derived types;
- `interrogate`: the high-risk lenses on the actual code.

Findings are deduplicated. **Critical and high block** and go back to the coder. **Medium and low** are listed at
"Your OK" and in the PR; you send it back if one matters. (Today medium blocks too; with five reviewers that would
loop on nits, as #1425's last round did on one medium finding.)

`ponytail-review` is a plugin skill today; it is copied into `.agents/skills` so every harness has it.

## The coder

Always loads `no-comments` and `typescript-guidance`, as well as today's `write-tests` and the path-based skills, so it
writes to the rules the reviewers check instead of being sent back for them.

## Stacks

- Stack intake → triage, always large (Stage A on the stack's outcome).
- The design is written by the planner (the same call, asked for a stack design: data model, shared shapes, what each
  PR reuses), then plan review on the design, then your approval. The driver can still write it.
- Members skip triage (the stack's Stage A covered them) and go to Plan with the design in their issue, then plan
  review, then your approval. Answers to a member's questions that change the design are added to the stack's design
  and to the parent issue.

## What's carried forward

A run keeps `decisions`: each question, its options, your answer and when. They go into the planner's, the coder's
and the reviewer's prompts, onto the card ("Decisions so far"), and into the PR body. This is the fix for losing track
over a long run.

## Building it (in order; each ships on its own)

1. **Reviewer fan-out.** One helper that runs N read-only Pi calls in parallel and parses goldfish findings
   (`critical | major | minor`, claim, evidence, question). The `planner` role already exists (`e1cac38`); add
   `triage` as another read-only role.
2. **Plan review and code review panels.** Plan review after "Save plan", before your approval; the code review
   panel replaces the single reviewer; the coder's extra skills. Works with plans the driver writes, so it is useful
   at once (#1426 onwards).
   Works with plans the driver writes, so it is useful at once (#1426 onwards).
3. **Planner writes the plan.** The plan stage calls the planner; review loop as above; Save plan stays.
4. **Triage.** Provision first, the triage call, Stage A for large work, questions on the card, Q&A comments on the
   issue, lane pick. New Triage column.
5. **Stacks.** Design by the planner with plan review; members skip triage.

## Out of scope for now

- Switching each stage between manual and automatic (Mastra Factory's per-stage mode). Each gate already waits in
  one place, so "auto" later means approving that one gate by itself, e.g. plan approval for small work.
- `change-impact` and `typescript-guidance` in plan review: they judge a diff and its types; on a plan they have
  nothing concrete to check. They run in code review instead.
- `architect` in code review: it settles the shape before code is written; at code review it can only ask for a
  redesign. It runs in plan review instead.

## Risks

- **Planner quality.** The planner runs on Claude (Opus), the coder on Codex. Plan review and your approval are the checks; the
  driver can still write the plan.
- **Parallel calls.** Stage A starts six Pi sessions at once, code review five, on one Codex login. If that hits a rate limit, run them
  two or three at a time.
- **Time.** Triage plus Stage A plus plan review is roughly 10–20 minutes of agent time for large work, a few minutes
  for small. It replaces hours of chat.

## Decisions for you

Agreed 2026-11-18:

1. You answer questions on the board card; each Q&A is also posted to the GitHub issue as a record.
2. Plan review runs on the fast lane too (the two goldfish reviewers).
3. Triage proposes the lane; you can override it on the card. The issue form's Lane becomes an optional hint.

Agreed 2026-11-18: every lane gets plan review (four reviewers), the code review panel (five) and `ponytail-review`;
the coder loads `no-comments` and `typescript-guidance`; the lanes differ only in Stage A.

Also agreed: `change-impact` and `typescript-guidance` stay out of plan review; at code review only critical and high
findings block, and medium and low are shown at "Your OK" and in the PR.
