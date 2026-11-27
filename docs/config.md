# Fill in `.factory/config.json`

Run `frankenstein setup` **inside the repository you want to change**. It writes a starting config, not a working
acceptance test. Edit the generated file, commit `.factory/` to your base branch, and push it before starting an
item: each task starts in a fresh worktree from `origin/<base>`. Don't ignore all of `.factory/`; setup only ignores
local `assets/` (downloaded dependencies) and `claims/` (temporary locks).

## The five choices you must make

1. **Base and tracker.** `base` is the branch tasks start from and target (often `main` or `staging`). The default
   tracker is `local`: items are Markdown files under `.factory/items/`, and a completed card can open a GitHub
   draft PR if `origin` is on GitHub. If you want GitHub *issues* as your queue instead, set
   `"tracker": { "command": ["github"] }` **before the first run**, sign into `gh` on the host, and use the
   [GitHub issue forms](../examples/issue-forms/) (copy them into `.github/ISSUE_TEMPLATE/`). Do not switch a
   tracker on a live run; its claim and delivery belong to the original tracker.
2. **Sandbox kit.** `sandbox.kit` is the image used for each work item. It needs your language runtime, package
   manager and GNU `timeout`. If you already publish a kit with these tools, use its image name. The default
   `shell` kit has bash and curl but **no Node, pnpm, Go or other language runtime**. With `shell`, put a script
   such as `.factory/sandbox-setup.sh` in the repository that installs your toolchain, then list that script in
   `commands.setup`. Commit it to the base branch. [Kit and installation options](setup.md#4-the-sandbox-kit).
3. **Commands.** Copy the checks you actually run in this project, *not* the factory's placeholder `echo` gate.
   `setup` runs first in a fresh worktree (install dependencies, generate files); `check` is quick feedback for
   the coder; `gates` are **required** before review and should include your test suite. `autofix` is optional.
   Each is a list of argv arrays: `[["pnpm", "run", "check"], ["pnpm", "test"]]`, never a shell command string.
   These run **inside the sandbox**, not with tools installed only on your laptop. If a check fails there, fix
   the kit or setup rather than weakening the gate.
4. **Network.** `sandbox.allowlist` names only the hosts needed by `commands.setup` (for example `nodejs.org`
   and `registry.npmjs.org`); it accepts hostnames, not URLs or wildcards. Leave it empty if the kit and project
   need no downloads. Start `maxConcurrent` at 1. There is no network during acceptance, regardless of this list.
   Never put secrets in `commands.env` or a kit: these values are public project config.
5. **Acceptance.** `.factory/acceptance/run.sh` starts as a stub that **always fails**. Replace it with a
   project-specific check of `$PROJECT_ARCHIVE` (the exact pushed commit) before treating setup as complete.
   The adapter is taken from the **base branch**, not the task branch; commit and push changes to it before
   retrying UAT. If it needs a toolchain or fixtures offline, stage them locally and set
   `"acceptance": { "assets": ".factory/assets" }`; that directory is mounted read-only as `$ASSETS`.
   The script must print a single JSON verdict on stdout. [Adapter walkthrough and example](setup.md#8-the-acceptance-adapter).

## Example: a pnpm project

This is a *shape to adapt*, not a drop-in config: it assumes your sandbox kit already has Node, your pinned pnpm,
GNU `timeout`, and that your repository has `check` and `test` scripts. If using `shell` instead, first supply and
commit a toolchain script, set `kit` to `shell`, and add it to `commands.setup`.

```json
{
  "base": "main",
  "paths": {
    "tests": ["src/**/*.test.ts", "src/**/*.spec.ts"],
    "protected": [".factory/**"],
    "sensitive": ["package.json", "pnpm-lock.yaml"]
  },
  "sandbox": {
    "kit": "ghcr.io/your-team/your-node-kit:version",
    "cpus": 2,
    "memory": "2g",
    "allowlist": ["registry.npmjs.org"],
    "maxConcurrent": 1
  },
  "commands": {
    "changedCode": ["**/*.ts", "**/*.js", "**/*.svelte"],
    "setup": [["pnpm", "install", "--frozen-lockfile"]],
    "autofix": [],
    "check": [["pnpm", "run", "check"]],
    "gates": [["pnpm", "run", "check"], ["pnpm", "test"]],
    "env": { "CI": "true" }
  },
  "acceptance": { "assets": ".factory/assets" }
}
```

Only set `acceptance.assets` if you actually stage files there; declaring it does not download anything.
`paths.tests` is where the **tester agent may edit** tests, not a command to run them. `paths.protected` blocks
agent edits; keep `.factory/**` in it so a task cannot change its own exam. `paths.sensitive` flags code for
human inspection. `changedCode` chooses files passed to formatters using `{changedCode}`; it does not restrict
what the coder can change. The example's `setup` needs access to `registry.npmjs.org`; if your lockfile uses other
hosts, add only those hosts.

For other languages, see the [Go-shaped example](../examples/go.factory.json), but replace its example kit image
with one you actually have. Leave optional settings alone at first: `worktrees` chooses the sibling directory for
task checkouts; `readable` allows agent reads outside the worktree; `skills` selects agent skill packs; `models`
chooses provider/model per role; `commands.preview` starts a sandbox preview; `acceptance.inputs` lists files
archived from the base branch for UAT, and `acceptance.command` replaces the default adapter command. `repo`
overrides the project name inferred from `origin`. `tracker.env`, `commands.env` and `acceptance.env` contain
**public** settings, never credentials. To switch a role model mid-run, use
`frankenstein model <role> <provider/model>` and press Retry; other config changes require a board restart.

## Write a first work item

With the default local tracker, click **New item** on the board or create `.factory/items/first-task.md`:

```markdown
# Add a health endpoint

### Outcome

GET /health returns 200 with a small JSON response. No authentication required.

### Acceptance

- Anonymous requests get 200 and the documented response body.
- Other routes and authenticated requests keep working.

### Lane

fast lane
```

Choose `standard` for a wider plan and code review, or `fast lane` for the shorter path. Be specific about what a
human can observe; the planner turns this into an implementation plan for your approval. With the GitHub tracker,
use the [Factory task form](../examples/issue-forms/factory.yml), label it `factory`, and choose the lane there.
The [stack form](../examples/issue-forms/factory-stack.yml) is for a feature intentionally shipped as several PRs.
Never approve a plan or outcome just to get past a failing gate; fix the setup and retry.
