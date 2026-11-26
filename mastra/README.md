# Factory engine

`src/config.ts` validates `../factory.config.json`. `src/fast-lane.ts` drives planning, implementation, checks, reviews, approval, acceptance and delivery; `src/stack.ts` coordinates features with multiple PRs. `src/ops.ts` owns side effects (Git, GitHub, task worktrees, Pi, checks and the pinned acceptance adapter). `src/rules.ts` contains prompts and decision rules.

`src/runs.ts` is the common interface for the CLI (`src/cli.ts`) and board (`src/board.ts`, `src/board.html`). State lives under `.data/` in this package. Run the board with `pnpm --dir mastra run dev` after following [setup](../README.md). Use a private tunnel rather than exposing the worker.
