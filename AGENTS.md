# Software factory

This repository is the factory, not its target: it is installed (`npm i -g`) and run inside someone else's repository. Read `README.md` for installation and `WORKFLOW.md` before starting project work. Resolve base, paths, skills, sandbox, tracker and commands from the project's `.factory/config.json`; never infer a specific team or framework.

Target changes belong in a factory-created worktree, never in the project checkout, and every command that runs project code belongs in that work item's sandbox, never on the worker. Ask the human to choose the lane; plan, design and outcome approvals belong to them. A work item does not edit its factory, acceptance adapter or fixtures.

Three roots, never one: the installed package (code, skills, trackers), the project (`.factory/`), and this machine's state (`~/.local/state/flowline/<project>/`, including default task worktrees). Upgrade the factory only between workflow steps. Run `pnpm install --frozen-lockfile` and `pnpm run check` before shipping.
