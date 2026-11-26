# Setting up a factory

What one person actually did, in the order it worked, on Ubuntu 24.04 with nested KVM. Every step ends in a
command whose output tells you it worked; [Troubleshooting](#troubleshooting) lists the failures this produced.

The factory is installed once and run inside your repository. Three directories matter, and keeping them apart is
the whole design:

| | |
|---|---|
| the installed package | the factory's code, skills and tracker adapters |
| `.factory/` in your repo | config, the acceptance adapter, and work items with the local tracker |
| `~/.local/state/frankenstein/<project>/` | the run database, logs and records for this checkout |

## 1. A machine that can run sandboxes

Docker Sandboxes needs Ubuntu 24.04+ with KVM, Apple-silicon macOS, or Windows 11. Only Ubuntu is exercised here
([what was measured](sandboxes.md)).

```sh
cat /sys/module/kvm_intel/parameters/nested   # Y, if you are inside a VM
sbx --version
sbx policy init deny-all                      # the factory refuses to run without this
```

`sbx` must be signed in once (`sbx login`) by a person at a terminal; afterwards the factory drives it headless.
Give it its own machine or VM: the factory asserts the global deny-all policy before every sandbox, so a daemon
shared with unrelated projects will fight it.

## 2. Node, the factory, and Pi

```sh
curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o /tmp/node.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
sudo npm i -g frankenstein-factory @earendil-works/pi-coding-agent
frankenstein --help
```

Sign Pi in (`pi` once interactively), or copy `~/.pi/agent/auth.json` from a machine that is already signed in.
`pi --list-models` must list models.

The factory loads Pi as a library from a **managed install layout**, which a plain global install does not have.
Point one at it:

```sh
pkg=$(npm root -g)/@earendil-works/pi-coding-agent
ver=$(node -p "require('$pkg/package.json').version")
mkdir -p ~/.pi/agent/install/releases/$ver/node_modules/@earendil-works
ln -sfn $pkg ~/.pi/agent/install/releases/$ver/node_modules/@earendil-works/pi-coding-agent
echo $ver > ~/.pi/agent/install/current-version
```

`PI_MANAGED_INSTALL_ROOT` overrides the location. Choose each role's model, as `provider/id` from
`pi --list-models`; a bare id means the Codex login:

```sh
export FACTORY_MODEL_PLANNER=anthropic/claude-opus-5-5
export FACTORY_MODEL_CODER=anthropic/claude-sonnet-5-5
export FACTORY_MODEL_REVIEW=anthropic/claude-sonnet-5-5
export FACTORY_MODEL_TESTER=anthropic/claude-haiku-5-5
```

Calls are billed to whatever Pi is signed in to. To bill Claude to a separate API key instead of a stored login,
put the key in `~/.config/factory/anthropic-api-key`; it is used for that process only and never written to
`auth.json`.

## 3. Set your repository up

```sh
cd ~/code/your-project
frankenstein setup
```

It writes `.factory/config.json`, `.factory/items/`, and an acceptance stub, then reports what your machine is
still missing. It never touches anything outside `.factory/`, and never overwrites what is already there.

Your repository needs an `origin` remote: the factory pushes each task branch to it, and acceptance tests the
**pushed** commit. `origin` may be a bare repository on the same machine — nothing here needs a forge.

## 4. The sandbox kit

A kit is the image every sandbox for this project starts from. It must carry your project's toolchain and GNU
`timeout`, because a **build sandbox reaches only the hosts in `sandbox.allowlist`, and the acceptance sandbox has
no network at all**.

The built-in `shell` kit ships bash, git, curl, make, jq, python and a Docker engine — but no language runtime. In
`sbx` 0.54.1 a kit may only name an image; `sandbox.build` with a Dockerfile validates but is **not implemented**,
and `sbx` silently uses `sandbox.image` instead. Until that lands there are two honest options:

- **Publish an image** your team builds elsewhere, and name it in `sandbox.kit`.
- **Install the toolchain in `commands.setup`**, allowlisting the host it comes from. This walkthrough does that: a
  `tools/setup.sh` in the repository fetches Node into `$HOME/node`, `sandbox.allowlist` holds `nodejs.org`, and
  `commands.env.PATH` puts it first. It costs a few seconds per sandbox, and an offline acceptance run must get the
  same toolchain from `acceptance.assets` instead, since it cannot download anything.

## 5. The configuration

`.factory/config.json`, as used here:

```json
{
  "base": "main",
  "paths": { "tests": ["tests/**"], "protected": [".factory/**"], "sensitive": [] },
  "sandbox": { "kit": "shell", "cpus": 2, "memory": "2g", "allowlist": ["nodejs.org"], "maxConcurrent": 1 },
  "commands": {
    "changedCode": ["**/*.js"],
    "setup": [["bash", "tools/setup.sh"]],
    "check": [["npm", "test"]],
    "gates": [["npm", "test"]],
    "env": { "CI": "true", "PATH": "/home/agent/node/bin:/usr/local/bin:/usr/bin:/bin" }
  },
  "acceptance": { "assets": ".factory/assets" }
}
```

`setup`, `autofix`, `check` and `gates` are **lists of commands**, each command an argv array — `[["npm", "test"]]`,
never `["npm", "test"]` and never a shell string. Start `maxConcurrent` at 1: a 2 GiB sandbox on a 4 GiB machine
leaves no room for a second. `worktrees` defaults to a sibling directory of your repository.

Everything else has a default: `base` is your current branch at setup, `tracker` is the local one, and skills are
the factory's `core` pack.

## 6. A work item

With the local tracker a work item is a Markdown file in your repository. Its first `# ` heading is the title;
the id is the file name, so `.factory/items/basket-discount.md` is item `basket-discount`.

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

**New item** on the board writes one for you, through whichever tracker you configured. Keep `.factory/**` in
`paths.protected` so a task cannot edit its own work item.

## 7. Run it

```sh
frankenstein board      # http://localhost:4111/board
frankenstein status
```

For a remote machine, put it in `~/.ssh/config` once, with the board's tunnel built in:

```
Host factory-worker
  HostName <host>
  User worker
  IdentityFile ~/.ssh/factory_worker
  LocalForward 4111 127.0.0.1:4111
```

Then `ssh factory-worker` gives you a shell **and** the tunnel, `ssh -fN factory-worker` the tunnel alone, and
`ssh factory-worker 'cd ~/code/your-project && frankenstein status'` runs one command. The board is
unauthenticated: keep it on loopback and reach it only through the tunnel.

The board remembers other factories you have tunnelled in, in the browser's local storage, and shows a red banner
for any it cannot reach. **`/board?peers=`** forgets them; `?peers=worker2:4112` sets them.

## 8. The acceptance adapter

The stub in `.factory/acceptance/run.sh` refuses to pass anything, so the first run stops at UAT with *"Acceptance
is not configured"*. That is the design: nothing ships until you write a real one.

The adapter runs in a **sandbox created with no network**, against `$PROJECT_ARCHIVE`, a git archive of the pushed
commit. It therefore cannot install its toolchain the way `commands.setup` does. Stage what it needs in a
directory and name it in `acceptance.assets`; the factory mounts it read-only as `$ASSETS`:

```sh
mkdir -p .factory/assets
curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.gz -o .factory/assets/node-linux-x64.tar.gz
echo '.factory/assets/' >> .gitignore      # assets are big; keep them out of git
```

The adapter gets `$REPO`, `$REF`, `$COMMIT`, `$INPUTS` (its own directory, read-only, as the working directory),
`$PROJECT_ARCHIVE` and `$ASSETS`. It prints **one JSON object on stdout** and nothing else; logs go to stderr:

```json
{"commit": "<the SHA from $COMMIT>", "pass": true, "detail": "what was checked, or what failed"}
```

[`examples/acceptance/node-project.sh`](../examples/acceptance/node-project.sh) is the adapter this walkthrough
used: it unpacks Node from `$ASSETS`, unpacks the commit, and asserts the item's acceptance criteria against the
published function.

Exit zero for any completed verdict, including a failure. Exit nonzero only for an infrastructure problem — then
the run waits for you to fix it rather than recording a verdict. A verdict naming the wrong commit is rejected.

**The adapter is pinned to your base branch.** A run judges itself against `.factory/acceptance/` as it stood on
`base` when the item started, so a task branch can edit those files in its worktree and change nothing about how
it is judged — and editing them on your checkout does not affect a running item either. Commit the fix to `base`,
then point the run forward at it:

```sh
git commit -m "Acceptance for …" .factory/acceptance/run.sh && git push origin main
frankenstein retry <item> --baseline $(git rev-parse origin/main)
```

Baselines only move forward, and only along the base branch.

## Troubleshooting

Every one of these came up during a real setup.

| What you see | Why | Fix |
|---|---|---|
| `No .factory/config.json here or above` | You are outside a set-up repository | `cd` into it, or `frankenstein setup` |
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
