# Software factory

This repository is the factory, not its target. Read `README.md` for installation and `WORKFLOW.md` before starting project work. Resolve target repo, base, paths, skills, sandbox and commands from `factory.config.json`; never infer a specific team or framework.

Target changes belong in a factory-created worktree, never in the base checkout, and every command that runs project code belongs in that work item's sandbox, never on the worker. Ask the human to choose the lane; plan, design and outcome approvals belong to them. A work item does not edit its factory, acceptance adapter or fixtures.

Develop factory changes in a separate checkout, and deploy only between workflow steps. Run `pnpm install --frozen-lockfile`, `pnpm --dir mastra run check` and `node --test scripts/*.test.mjs` before shipping.
