# Setting up a factory

What one person actually did, in the order it worked, on Ubuntu 24.04 with nested KVM. Every step ends in a command whose output tells you it worked; [Troubleshooting](#troubleshooting) lists the failures this produced.

The factory is installed once and run inside your repository. Three directories matter, and keeping them apart is the whole design:

|  |  |
| --- | --- |
| the installed package | the factory's code, skills and tracker adapters |
| `.factory/` in your repo | config, the acceptance adapter, and work items with the local tracker |
| `~/.local/state/frankenstein/<project>/` | the run database, logs and records for this checkout |

## 1. A machine that can run sandboxes

Docker Sandboxes needs Ubuntu 24.04+ with KVM, Apple-silicon macOS, or Windows 11. Only Ubuntu is exercised here ([what was measured](sandboxes.md)).

```sh
cat /sys/module/kvm_intel/parameters/nested   # Y, if you are inside a VM
sbx --version
sbx policy init deny-all                      # the factory refuses to run without this
```

`sbx` must be signed in once (`sbx login`) by a person at a terminal; afterwards the factory drives it headless. Give it its own machine or VM: the factory asserts the global deny-all policy before every sandbox, so a daemon shared with unrelated projects will fight it.

## 2. Node, the factory, and Pi

```sh
curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o /tmp/node.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
sudo npm i -g frankenstein-factory @earendil-works/pi-coding-agent
frankenstein --help
```

Sign Pi in (`pi` once interactively), or copy `~/.pi/agent/auth.json` from a machine that is already signed in. `pi --list-models` must list models.

The factory loads Pi as a library from a **managed install layout**, which a plain global install does not have. Point one at it:

```sh
pkg=$(npm root -g)/@earendil-works/pi-coding-agent
ver=$(node -p "require('$pkg/package.json').version")
mkdir -p ~/.pi/agent/install/releases/$ver/node_modules/@earendil-works
ln -sfn $pkg ~/.pi/agent/install/releases/$ver/node_modules/@earendil-works/pi-coding-agent
echo $ver > ~/.pi/agent/install/current-version
```

`PI_MANAGED_INSTALL_ROOT` overrides the location. Choose each role's model, as `provider/id` from `pi --list-models`; a bare id means the Codex login:

```sh
export FACTORY_MODEL_PLANNER=anthropic/claude-opus-5-5
export FACTORY_MODEL_CODER=anthropic/claude-sonnet-5-5
export FACTORY_MODEL_REVIEW=anthropic/claude-sonnet-5-5
export FACTORY_MODEL_TESTER=anthropic/claude-haiku-5-5
```

Calls are billed to whatever Pi is signed in to. To bill Claude to a separate API key instead of a stored login, put the key in `~/.config/factory/anthropic-api-key`; it is used for that process only and never written to `auth.json`. **That file takes precedence over a newly signed-in Anthropic account**: remove or move it first if switching accounts. Never paste keys or the contents of `auth.json` into a work item.

### Switching model accounts while a run waits

A provider returning `429 rate_limit_error` means it is refusing requests _now_; signing in again may not reset its limit. You can wait for the limit to reset, sign in with another account, or choose another model/provider. The run remains at its error gate until you press **Retry**; changing models does not approve anything.

To switch the model for one role **while the board is still running**:

```sh
pi --list-models                                 # choose a model your account can use
frankenstein model planner openai-codex/gpt-6.2-sol
# The project now has "models": { "planner": "openai-codex/gpt-6.2-sol" } in .factory/config.json.
# Return to the board and press Retry on the paused card. No board restart or new run.
```

Use `coder`, `review`, or `tester` in place of `planner` at their respective steps. Only the `models` section is re-read at each agent call; other config changes still need a board restart. Models are ordinary project config, not credentials: choose a provider you have already signed into. An uncommitted change here affects the host's next agent call without changing the pinned acceptance inputs. Commit the config later if the new model should be the team's default.

```sh
pi auth check --provider anthropic       # checks credentials, not remaining quota
pi auth logout anthropic                  # only if you want to switch accounts
pi auth login anthropic                   # interactive, stored only on the host
```

To use a different provider, sign in via `pi auth login <provider>` and set the role with `frankenstein model`. The planner defaults to `anthropic/claude-opus-5-5`; coder, review and tester each have separate defaults. `FACTORY_MODEL_<ROLE>` environment variables are still available, but changing one requires a board restart; a model set in `.factory/config.json` takes precedence. Logging into another account for the _same_ provider is read afresh at the next Pi call. Neither change requires clearing run state.

### Git over SSH from the board

A terminal `git push` can ask for an SSH-key passphrase. The board cannot: its git commands fail promptly when no unlocked key is available rather than repeatedly prompting. In the terminal from which you start the board:

```sh
ssh-add ~/.ssh/id_personal      # enter the passphrase once, locally; use your own key path
ssh-add -l                      # confirms the agent holds it
frankenstein board start        # inherits SSH_AUTH_SOCK from this shell
```

If `ssh-add` says there is no agent, start one with `eval "$(ssh-agent -s)"` in that shell, then `ssh-add` and start the board there. Check `git ls-remote origin HEAD` before starting a run. This access is host-only; no key or agent socket is mounted into a sandbox.

## 3. Set your repository up

```sh
cd ~/code/your-project
frankenstein setup
```

It writes `.factory/config.json`, `.factory/items/`, an acceptance stub and `.factory/.gitignore`, then reports what your machine is still missing. It never touches anything outside `.factory/`, and never overwrites what is already there. The nested ignore file excludes only `assets/` (downloaded acceptance inputs that are rebuilt locally) and `claims/` (temporary work-item locks that must not be shared across clones). An existing `.factory/.gitignore` is left alone: add those two patterns yourself if they are absent. If your assets live elsewhere, ignore that path in your project's own `.gitignore`.

**Do not ignore `.factory/` itself.** Version the config, acceptance adapter, setup scripts, work items and the nested ignore file. For the local tracker, `.factory/items/*.closed` records completed items; delivery notes under `.factory/delivered/` can be kept for an audit trail, but review them before committing since they may contain machine-local paths.

Your repository needs an `origin` remote: the factory pushes each task branch to it, and acceptance tests the **pushed** commit. `origin` may be a bare repository on the same machine — nothing here needs a forge.

**Commit `.factory/` and push it to your base branch.** Every work item is built in a fresh worktree of `origin/<base>`, and that worktree is what the sandbox sees. Anything a sandbox runs — the acceptance adapter, a toolchain script — must be on the branch, not only in your working copy. `config.json` is the exception, read from your checkout, but it belongs in git too so your team reviews gates and sandbox limits like any other code. A run refuses to start otherwise, naming the file it cannot find.

## 4. The sandbox kit

A kit is the image every sandbox for this project starts from. It must carry your project's toolchain and GNU `timeout`, because a **build sandbox reaches only the hosts in `sandbox.allowlist`, and the acceptance sandbox has no network at all**.

The built-in `shell` kit ships bash, git, curl, make, jq, python and a Docker engine — but no language runtime. In `sbx` 0.54.1 a kit may only name an image; `sandbox.build` with a Dockerfile validates but is **not implemented**, and `sbx` silently uses `sandbox.image` instead. Until that lands there are two honest options:

- **Publish an image** your team builds elsewhere, and name it in `sandbox.kit`.
- **Install the toolchain in `commands.setup`**, allowlisting the host it comes from. This walkthrough does that: a `tools/setup.sh` in the repository fetches Node into `$HOME/node`, `sandbox.allowlist` holds `nodejs.org`, and `commands.env.PATH` puts it first. It costs a few seconds per sandbox, and an offline acceptance run must get the same toolchain from `acceptance.assets` instead, since it cannot download anything.

## 5. The configuration

If the setup prompts are unfamiliar, start with the [field-by-field config and work-item guide](config.md). This walkthrough's `.factory/config.json` looks like:

```json
{
  "base": "main",
  "paths": {
    "tests": ["tests/**"],
    "protected": [".factory/**"],
    "sensitive": []
  },
  "sandbox": {
    "kit": "shell",
    "cpus": 2,
    "memory": "2g",
    "allowlist": ["nodejs.org"],
    "maxConcurrent": 1
  },
  "commands": {
    "changedCode": ["**/*.js"],
    "setup": [["bash", "tools/setup.sh"]],
    "check": [["npm", "test"]],
    "gates": [["npm", "test"]],
    "env": {
      "CI": "true",
      "PATH": "/home/agent/node/bin:/usr/local/bin:/usr/bin:/bin"
    }
  },
  "acceptance": { "assets": ".factory/assets" }
}
```

`setup`, `autofix`, `check` and `gates` are **lists of commands**, each command an argv array — `[["npm", "test"]]`, never `["npm", "test"]` and never a shell string. Start `maxConcurrent` at 1: a 2 GiB sandbox on a 4 GiB machine leaves no room for a second. `worktrees` defaults to a sibling directory of your repository.

Everything else has a default: `base` is your current branch at setup, `tracker` is the local one, and skills are the factory's `core` pack.

## 6. A work item

With the local tracker a work item is a Markdown file in your repository. Its first `# ` heading is the title; the id is the file name, so `.factory/items/basket-discount.md` is item `basket-discount`.

```markdown
# Apply a percentage discount to the basket total

### Outcome

`total` accepts an optional percentage discount and applies it to the basket total.

### Acceptance

- `total(items, 10)` returns the sum minus ten percent.
- Discounts below zero or above 100 are rejected with an error.

### Lane

fast lane
```

**New item** on the board writes one for you, through whichever tracker you configured. See the [work-item examples](config.md#write-a-first-work-item) for the local and GitHub trackers. Keep `.factory/**` in `paths.protected` so a task cannot edit its own work item.

## 7. Run it

```sh
frankenstein board start  # prints the URL, e.g. http://localhost:4111/board
frankenstein status
```

`board start` runs in the background and chooses the first free port from 4111–4130 (or the explicit `PORT` you set). In another project, run the same command: it gets a separate board URL, state directory and process. `frankenstein board stop` stops **only the background board of your current project**. Run it from that project's directory; it verifies the local server's identity before signalling its PID. `frankenstein board` without a subcommand remains the foreground, Ctrl-C version, and is not managed by `board stop`. Startup logs are in the project's machine-local state directory as `board.log`. The board is bound to loopback and unauthenticated. Start it from a shell with your SSH agent set up so Git can use the unlocked key. If an older foreground board is already running, stop that one with Ctrl-C before switching to `board start`.

For a remote machine, put it in `~/.ssh/config` once, with the board's tunnel built in:

```
Host factory-worker
  HostName <host>
  User worker
  IdentityFile ~/.ssh/factory_worker
  LocalForward 4111 127.0.0.1:4111
```

Start that remote board with `PORT=4111 frankenstein board start` to match this fixed tunnel (or update both `LocalForward` ports to the board's printed port). Then `ssh factory-worker` gives you a shell **and** the tunnel, `ssh -fN factory-worker` the tunnel alone, and `ssh factory-worker 'cd ~/code/your-project && frankenstein status'` runs one command. The board is unauthenticated: keep it on loopback and reach it only through the tunnel.

The board remembers other factories you have tunnelled in, in the browser's local storage, and shows a red banner for any it cannot reach. **`/board?peers=`** forgets them; `?peers=worker2:4112` sets them.

## 8. The acceptance adapter

The stub in `.factory/acceptance/run.sh` refuses to pass anything, so the first run stops at UAT with _"Acceptance is not configured"_. That is the design: nothing ships until you write a real one.

The adapter runs in a **sandbox created with no network**, against `$PROJECT_ARCHIVE`, a git archive of the pushed commit. It therefore cannot install its toolchain the way `commands.setup` does. Stage what it needs in a directory and name it in `acceptance.assets`; the factory mounts it read-only as `$ASSETS`:

```sh
mkdir -p .factory/assets
curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.gz -o .factory/assets/node-linux-x64.tar.gz
# setup already ignored .factory/assets/ via .factory/.gitignore; no root .gitignore change needed
```

The adapter gets `$REPO`, `$REF`, `$COMMIT`, `$INPUTS` (its own directory, read-only, as the working directory), `$PROJECT_ARCHIVE` and `$ASSETS`. It prints **one JSON object on stdout** and nothing else; logs go to stderr:

```json
{
  "commit": "<the SHA from $COMMIT>",
  "pass": true,
  "detail": "what was checked, or what failed"
}
```

[`examples/acceptance/node-project.sh`](../examples/acceptance/node-project.sh) is the adapter this walkthrough used: it unpacks Node from `$ASSETS`, unpacks the commit, and asserts the item's acceptance criteria against the published function.

Exit zero for any completed verdict, including a failure. Exit nonzero only for an infrastructure problem — then the run waits for you to fix it rather than recording a verdict. A verdict naming the wrong commit is rejected.

**The adapter is pinned to your base branch.** A run judges itself against `.factory/acceptance/` as it stood on `base` when the item started, so a task branch can edit those files in its worktree and change nothing about how it is judged — and editing them on your checkout does not affect a running item either. Commit the fix to `base`, then point the run forward at it:

```sh
git commit -m "Acceptance for …" .factory/acceptance/run.sh && git push origin main
frankenstein retry <item> --baseline $(git rev-parse origin/main)
```

Baselines only move forward, and only along the base branch.

## Troubleshooting

Every one of these came up during a real setup.

| What you see | Why | Fix |
| --- | --- | --- |
| `No .factory/config.json here or above` | You are outside a set-up repository | `cd` into it, or `frankenstein setup` |
| `.factory/… is not on <base>` | A sandbox would not see it: worktrees come from `origin/<base>` | Commit `.factory` and push |
| `node: error while loading shared libraries: libatomic.so.1` | Node 26 needs a library the `shell` kit lacks | Install Node 24 in `setup`, or use a kit that has it |
| `corepack: command not found` | Current Node no longer ships corepack | `npm install -g --prefix "$HOME/node" pnpm@<version>` |
| A tool installs but is `command not found` in a gate | It landed outside `commands.env.PATH` | Install with `--prefix` into a directory that PATH names |
| `expected tuple, received string` on `commands.check` | A command list given one argv instead of a list of them | `[["npm", "test"]]` |
| `Not inside a git repository` | `setup` needs a checkout with an `origin` remote | `git init` and add `origin` |
| `provision failed: Invalid task branch` | The branch name has characters the factory refuses | Check the item id: `[A-Za-z0-9._-]`, no `..` |
| `Invalid sandbox work item` | Same, for the sandbox name | Same |
| `ENOENT … .pi/agent/install/current-version` | Pi is installed but not as a managed install | Step 2's symlink and `current-version` |
| `Worker needs an exclusive deny-all network policy` | `sbx policy init deny-all` was never run, or another project widened it | Re-run it; give the machine its own daemon |
| `node: command not found` inside a sandbox | The kit has no Node | Step 4: install it in `setup`, or publish an image that has it |
| `tar … xz: Cannot exec` inside a sandbox | The kit has no `xz` | Fetch the `.tar.gz` build |
| `Work item X already has a run` | A run exists, including a failed one | `frankenstein status X`, then `retry`; clean up to start over |
| `This state belongs to <repo> via <tracker>` | The state directory was built against a different repo or tracker | Clear `~/.local/state/frankenstein/<project>/` |
| Nothing listed, title shows "Work item" | The item file has no `# ` heading | Add one |
| `Can't reach the <name> factory` banner | A peer factory remembered from an earlier session | Open `/board?peers=` to forget it |
| `Acceptance adapter failed (2): Acceptance is not configured` | The shipped stub, which never passes | Step 8 |
| A fixed adapter still fails the same way | The run is pinned to the base-branch commit it started at | `frankenstein retry <item> --baseline $(git rev-parse origin/main)` |
| `Acceptance inputs must be on <base>` | The baseline commit is not on the base branch | Push the fix to `base` first |
| `UAT tested <sha>, expected <sha>` | The adapter reported a commit other than `$COMMIT` | Echo `$COMMIT` in the verdict |
| `Sandbox: missing` on a card | The sandbox was removed under a running item | **Recreate sandbox** on the card, then **Retry** |
| `plan failed … 429 rate_limit_error` | The selected provider is throttling the account, not necessarily an expired login | Wait, change accounts with `pi auth login`, or `frankenstein model planner provider/model`; then **Retry** |
| SSH key passphrase prompts, or `Permission denied (publickey)` from a board run | The board process has no unlocked key in its SSH agent | `ssh-add` before `frankenstein board start`; test `git ls-remote origin HEAD` in the same shell |
