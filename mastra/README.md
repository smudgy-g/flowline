# Factory engine

`src/config.ts` validates `../factory.config.json`. `src/fast-lane.ts` drives planning, implementation, checks, reviews, approval, acceptance and delivery; `src/stack.ts` coordinates features that ship as several PRs. `src/ops.ts` owns side effects (git, GitHub, task worktrees, Pi, and dispatching project work to sandboxes). `src/sandbox.ts` wraps the `sbx` CLI; `src/project-commands.ts` runs the configured commands inside an item's sandbox; `src/worktree-git.ts` pins host-side git to the checkout's own registration. `src/rules.ts` holds the pure rules: naming, prompts, review parsing, PR body.

`src/runs.ts` is the common interface for the CLI (`src/cli.ts`) and the board (`src/board.ts`, `src/board.html`). State lives under `.data/`: the run database, each item's records in `.data/items/<work item>/` (history, check log, the coder's checked-tree hash) and each stack's in `.data/stacks/`. Those sit outside the sandbox mount, so code running in a check cannot rewrite them; agents get them read-only. Nothing here is paid or hosted: Mastra runs in-process.

Run the board with `pnpm --dir mastra run dev` after following [setup](../README.md), and reach it through a private tunnel rather than exposing the worker. Studio, for looking inside a run, is on the same port.

## How it works

- **Input is a GitHub issue.** Only issues and comments by the token's owner, or logins in `FACTORY_ISSUE_AUTHORS`, reach an agent. The branch and work item are `<number>-<title slug>`, and the item's sandbox is `fx-<work item>`.
- **The planner writes the plan;** you approve it, send it back, or split it into PRs. The coder then works one bounded step per call, and calls its `check` tool (the configured `commands.check`, after `autofix`) before it stops. When that passes it records a hash of the worktree, and the gates skip the same checks if the code still matches.
- **Checks, gates and acceptance all run in sandboxes.** `commands.*` run in the item's own sandbox; acceptance runs in a fresh one created with no network, against the pushed commit and the adapter pinned from the approved factory commit. `sandbox.maxConcurrent` caps how many run at once, which replaces the old shared locks.
- **Reviewers return JSON findings;** critical and high block, and an unparseable reply waits for `fx findings`. The standard lane adds plan reviewers and `skills.codeReviewers`.
- **One approval covers the outcome,** bound to a fingerprint of the tested files computed on the host; if anything changes while the gate waits, it asks again. Sensitive files (`paths.sensitive`) are listed there.
- **Errors wait instead of failing.** A step that throws waits as `error`: fix the cause and `fx retry`, or use **Recreate sandbox** on the card when the sandbox is the problem. Pauses are files in `.data/paused/`, so they survive a restart.
- **Models per role** come from `scripts/factory-pi.mjs` (`MODELS`, `FALLBACKS`, `FACTORY_MODEL_<ROLE>`), and run on the host: a sandbox never holds credentials.

## Limits

- **Approving is not a security boundary.** An agent that reached the worker could resume a run itself; keeping agents in sandboxes is what stops that. The real gates are the draft PR and you merging it.
- **Stacks don't merge the base branch into their branch** between members, and the stack as a whole gets no acceptance run of its own; each member is tested on its own branch.

## Check

```sh
pnpm run check   # type check plus tests: the whole lane with fake side effects, resumed in a fresh process per command
```
