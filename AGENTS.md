# Frankenstein

The colonia software factory: a GitHub issue in `ColoniaTech/colonia_client` goes in, a tested, reviewed,
UAT-checked draft PR to `staging` comes out. It is a local [Mastra](https://mastra.ai) workflow in `mastra/`
(see `mastra/README.md`), with the black-box UAT in `scripts/run-uat.sh`, `specs/` and `seeds/`. It runs in the
factory VM (`vm/`); the board at http://localhost:4111/board is where a person watches and decides.

Packages are pnpm (one workspace: the root and `mastra/`; node and pnpm pinned in `mise.toml`). Run
`pnpm install`, and `pnpm --dir mastra run check` before you commit a change to the lane.

## Client tasks from this repository

When a user gives a coding task for `client` while you are in this repository, treat it as a **factory work
item even if they never say "factory"**, unless they explicitly choose to do it by hand. Read `WORKFLOW.md`
before touching client code.

- The work item is a GitHub issue made with the Factory task form (label `factory`), or the Factory stack form
  (`factory-stack`) for a feature that ships as several PRs. Help the user write it; ask which lane
  (`fast lane` or `standard`) if they didn't say. Never choose for them.
- Start it from the board, or with `pnpm --dir mastra fx start <issue>`. Starting is never a stopping point:
  in the same turn run `pnpm --dir mastra fx status <issue>` and do what the stage needs (a plan the planner
  couldn't write, a stack's design), stopping only at a human gate or a question only the human can answer.
- Approving a plan, a design or an outcome is the human's, on the board or with `fx approve` in their terminal.
  Never approve, and never report "done" when no run exists.

`client/staging` is the read-only base branch: **never edit, restore, commit, or run a code-changing command
there**. The factory creates each task's worktree under `client/worktrees/`; only that worktree may change. If
work already exists outside a factory run, stop and report it rather than rewriting or discarding it.

## Changing the factory

Change it in a separate checkout or worktree and merge to `main` when no run is mid-step: the VM's board moves to
`main`'s latest only when no step is running (`vm/sync-in-vm.sh`). UAT inputs (`specs/`, `seeds/`,
`lighthouse-baseline.json`, `playwright.config.mjs`, `scripts/summarize.mjs`) are human-owned and pinned per
work item; a task never edits them.
