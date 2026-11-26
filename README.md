# Frankenstein software factory

Turn a GitHub issue into a reviewed, acceptance-tested draft PR against the branch your team chooses, through an agreed plan, a coder, project checks, cold review, your approval and black-box acceptance. The board shows every stage and the human gates. One installation serves one target repository.

Each work item runs in **its own Docker Sandbox** (`sbx`): a microVM with its own kernel and Docker engine. The factory itself — board, run database, git, `gh`, credentials and the Pi agents — stays on the worker host. Every command that executes project code (install, fixes, checks, tests, preview, acceptance) runs inside the item's sandbox, so agent-written code never runs on the host and one work item cannot touch another.

## Configure a worker

1. Use a worker that Docker Sandboxes supports (Ubuntu 24.04+ with KVM, Apple-silicon macOS, or Windows 11; only Ubuntu is exercised here — see [docs/sandboxes.md](docs/sandboxes.md)). Install Git, authenticated `gh`, Node and pnpm (`mise.toml`), and a managed Pi installation with model credentials. Set `FACTORY_MODEL_PLANNER`, `_CODER`, `_REVIEW` and `_TESTER` to available `provider/model` IDs. Install `sbx`, run `sbx login` once, and run `sbx policy init deny-all` on that worker; do not share its daemon with unrelated projects. You can watch the board from Linux, macOS or Windows over an SSH tunnel.
2. Fork the factory separately from the target. Edit **`factory.config.json`**: `repo` is the GitHub owner/name, `base` the draft PR target. Clone that repo at `checkout` with `origin` pointing to it. `workspace` resolves from the factory root; `checkout` and `worktrees` from `workspace`. `paths.tests` limits where the tester role may write, `paths.protected` blocks changes, `paths.sensitive` flags them for the human. Keep `skills/core` and add your own packs ([guide](skills/README.md)). [`examples/go.factory.json`](examples/go.factory.json) is a second profile.
3. Build the **sandbox kit**: an image with your project's toolchain and GNU `timeout`. Name it in `sandbox.kit` with `cpus`, `memory`, `maxConcurrent` (start at one on a small worker) and `allowlist` — the exact hosts a build sandbox may reach, normally only package registries. Never bake credentials into a kit.
4. Set `commands`: `setup` prepares a fresh worktree, `autofix` runs formatters, `check` is the coder's fast feedback, and `gates` are the required checks including the full suite. Each command is an executable plus literal arguments, never a shell string; `{changedCode}` expands to changed files matching `changedCode` globs. `commands.env` is public test configuration only. `commands.preview` is optional and backs `scripts/preview.sh WORK_ITEM`.
5. Choose a **tracker** — where work items come from and where a finished change goes ([contract](docs/tracker.md)). `trackers/local.mjs` (the default) keeps items as Markdown in the target repo under `.factory/items/<id>.md`, the file name being the id, needs no account or network, and treats a change as accepted once your base branch contains its branch. `trackers/github.mjs` uses issues labelled `factory`/`factory-stack` and draft PRs: install `examples/issue-forms/*.yml` in the target's `.github/ISSUE_TEMPLATE/`, create both labels, and give the worker only the rights it needs; only the authenticated user's issues and comments are trusted unless `FACTORY_ISSUE_AUTHORS` adds logins. Write your own for another tracker rather than changing factory code, and keep `.factory/**` in `paths.protected` so a task cannot edit its own work item.
6. Write the **acceptance adapter** (below).
7. On the worker:

   ```sh
   pnpm install --frozen-lockfile
   mkdir -p mastra/.data
   pnpm --dir mastra run dev
   ```

   Reach **http://localhost:4111/board** through an SSH tunnel. Create a work item and start its card; see [the workflow](WORKFLOW.md). The board is a privileged operator UI with no authentication: keep it on loopback. The worker still holds git, `gh` and model credentials, so treat it as trusted infrastructure.

## Acceptance adapter

`acceptance/` belongs to the factory operator, not the task. `acceptance.inputs` lists the factory paths archived from the approved factory commit; `acceptance.command` runs from those read-only inputs. Acceptance runs in a **fresh sandbox created with no network at all** — not a policy switch on the build sandbox, which [does not close existing connections](docs/sandboxes.md). The code under test arrives as `$PROJECT_ARCHIVE`, a git archive of the **pushed commit**, never the live worktree. The adapter gets `$REPO`, `$REF`, `$COMMIT`, `$INPUTS`, and `$ASSETS` when `acceptance.assets` names an operator-owned read-only directory (pre-staged images and fixtures, since there is no network). Keep the application and your test runner in separate containers, and never give the application the report directory or the Docker socket.

Print one JSON object on stdout, for example `{"commit":"<the tested SHA>","pass":false,"detail":"Checkout journey failed at payment confirmation"}`. Exit zero for a completed verdict including a failure; use stderr for logs and exit nonzero for infrastructure failures. A wrong SHA, malformed verdict, timeout or missing adapter blocks delivery; the shipped stub refuses to approve anything. The result is recorded under `.cache/run-*/report.json`.

## Development

`pnpm --dir mastra run check` type-checks and exercises the workflow with fake side effects. `node --test scripts/*.test.mjs` checks the agent guard and the content tree. See [mastra/README.md](mastra/README.md) for the implementation map and [docs/sandboxes.md](docs/sandboxes.md) for what was measured on a real worker.
