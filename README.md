# Frankenstein software factory

Turn a GitHub issue into a reviewed, acceptance-tested draft PR against the branch your team chooses. The board shows the plan, changes, checks, review feedback and human approval gates. One installation serves one target repository; projects do not share run databases or credentials.

## Configure a worker

1. Use an isolated Linux worker with Git, authenticated `gh`, mise, workmux, tmux, Bash, GNU timeout, flock and tar. Install the Node and pnpm versions in `mise.toml`, your target's tools, and a managed Pi installation with working model credentials. Set `FACTORY_MODEL_PLANNER`, `FACTORY_MODEL_CODER`, `FACTORY_MODEL_REVIEW` and `FACTORY_MODEL_TESTER` to available `provider/model` IDs. The Pi runner uses `PI_MANAGED_INSTALL_ROOT` (default `~/.pi/agent/install`); see `scripts/factory-pi.mjs` for provider-specific credentials and fallback settings.
2. Fork the factory separately from the target. Edit **`factory.config.json`**: `repo` is the GitHub owner/name; `base` is the draft PR target. Clone that repo at `checkout` with `origin` pointing to it. `workspace` resolves from the factory root; `checkout`, `worktrees` and optional extra read-only `readable` directories resolve from `workspace`. Keep the factory, base checkout and task worktrees separate. Do not point a running factory at a different project.
3. Set `checks.setup` to ordered commands to prepare a fresh task worktree and `checks.gates` to the required checks, including the full test suite. Each command is an argv array, not a shell string. There is no implicit package manager, formatter, framework or test runner. `paths.tests` limits where the tester role can write; `paths.protected` stops changes and `paths.sensitive` flags changes for human review. Patterns are Node `path.matchesGlob` patterns relative to the target. Keep `skills/core` for workflow reviewers and choose optional packs or add your own ([guide](skills/README.md)). [`examples/go.factory.json`](examples/go.factory.json) is a second profile.
4. Implement the **acceptance adapter** below and commit your factory configuration and acceptance files. Install `examples/issue-forms/*.yml` in the target's `.github/ISSUE_TEMPLATE/` on its default branch and create the `factory` and `factory-stack` labels. Grant the worker only the repo rights needed for issues, branches and draft PRs. By default only the authenticated user's issues/comments are trusted; set `FACTORY_ISSUE_AUTHORS` to a comma-separated allowlist of additional logins.
5. In the factory checkout run:

   ```sh
   pnpm install --frozen-lockfile
   mkdir -p mastra/.data
   pnpm --dir mastra run dev
   ```

   Open **http://localhost:4111/board** (SSH-forward the port for a remote worker). Create an issue with the task form, then start its card. See [the workflow](WORKFLOW.md). The board is a privileged operator UI, not a public dashboard: keep it private. Agents have no shell tool, but project setup and test commands execute project code with the worker's permissions. Worktrees are not a sandbox. Use disposable or isolated workers, restrict credentials and egress, and never run untrusted projects on a developer laptop.

## Acceptance adapter

`acceptance/` belongs to the factory operator, not the task. Each run pins it to a factory commit. After the human approves and the task branch is pushed, the worker extracts only that directory from the pinned commit into a fresh run directory. It calls `bash acceptance/run.sh OWNER/REPO BRANCH SHA` there. Put all adapter scripts and fixtures under `acceptance/`. Use regular files, not symlinks. An adapter can dispatch existing CI or test a disposable, isolated checkout; it must test the **specified SHA**, not a moving branch tip. Clean up its resources on exit.

Print one JSON object to stdout, for example `{"commit":"<actually tested SHA>","pass":false,"detail":"Checkout journey failed at payment confirmation"}`. Exit zero for a completed verdict (including a failed test); use stderr for logs and exit nonzero for infrastructure failures. A wrong SHA, malformed verdict, timeout or missing adapter blocks delivery. The shipped stub intentionally refuses to approve anything. The result is recorded under `.cache/run-*/report.json`.

## Development

`pnpm --dir mastra run check` type-checks and exercises the workflow. `node --test scripts/factory-pi.test.mjs` checks the agent guard. See [mastra/README.md](mastra/README.md) for the implementation map.
