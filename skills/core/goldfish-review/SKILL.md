---
name: goldfish-review
description: Fresh-context (goldfish) reviews during planning. Stage A stress-tests the agreed idea before a spec is written; Stage B checks a written spec against the code and for decisions left open. Use from a planner after the interview (A) and after writing the PRD (B).
---

Adapted from Google's Elephant-Goldfish Model (github.com/google/elephant-goldfish-model, Apache-2.0).

A goldfish is a fresh subagent with no conversation history. It sees only what you pass it plus what it reads itself. A review in your own context is not a goldfish review: if you cannot spawn fresh subagents, stop and tell the user.

## Dispatch

- Spawn one fresh read-only subagent per reviewer, all in parallel (Claude Code: `Agent`; Pi: `task`; Codex: `spawn_agent`).
- Pass the reviewer's instructions verbatim plus the stage input. Pass nothing from the interview: the point is to expose what the input does not say.
- Reviewers may read `CLAUDE.md`/`AGENTS.md`, `CONTEXT.md`, `docs/adr/` and source to check claims.
- Each returns findings only: severity (`critical` | `major` | `minor`), the claim or gap, evidence, and the question the owner must answer.

## Handling findings

- Deduplicate across reviewers.
- Critical/major findings that stop the stated outcome: put each to the user as a decision (up to three options, unranked, each with mechanism, trade-offs and when it fails). Apply the choice.
- Everything else: record as a follow-up under *Out of Scope*. Never grow scope from review.
- Record each rejected option under *Alternatives Considered* (spec) or *Options Considered* (decisions log).

## Stage A — Concept review

First state the anchored hypothesis in 2–3 sentences (problem, who it is for, proposed approach, hard constraints) and get the user's confirmation. That hypothesis is the only input. One subagent per lens:

- **Contrarian / YAGNI:** Why does this need to exist? What in the codebase, an installed dependency or the platform already covers most of it? What is the smallest version that solves the stated problem?
- **Cost & load:** What queries, writes, external API calls, messages or LLM tokens does this add per user action and at peak? Does anything loop, fan out, or hit a rate limit or quota?
- **UX & ergonomics:** Is the flow obvious to the actual user? Are error states and messages actionable? Does it match how comparable flows in this product already behave?
- **Migration & compatibility:** What existing data, links, messages or integrations does this change? Does it alter a schema, enum, API contract or URL something else depends on? How is it rolled back after a partial deploy?
- **Observability:** When this fails in production, how would anyone notice and find out why? Which failures are silent (fail-open, swallowed errors, lost records)?
- **Long-term maintenance:** Does this add coupling, a state machine or special cases that will hurt later? Does it duplicate a concept `CONTEXT.md` already names differently?

## Stage B — Spec review

Input: the spec file path. Two subagents, each told to load and follow its skill:

- `goldfish-codebase-details`
- `goldfish-implementation-readiness`

Apply resolved findings to the spec before slicing.
