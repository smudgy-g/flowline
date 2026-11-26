# Setting up a factory

What one person actually did to bring a factory up from nothing, in the order it worked. The worker here is
Ubuntu 24.04 in a VM with nested KVM; the target is a throwaway repository with the local tracker, so no GitHub
account, token or network is involved.

Every step ends in a command whose output tells you it worked. If one fails, [Troubleshooting](#troubleshooting)
lists the failures this setup actually produced.

## 1. A worker that can run sandboxes

Docker Sandboxes needs Ubuntu 24.04+ with KVM, Apple-silicon macOS, or Windows 11. Only Ubuntu is exercised
here ([what was measured](sandboxes.md)).

```sh
grep -c vmx /proc/cpuinfo                 # not zero
cat /sys/module/kvm_intel/parameters/nested   # Y, inside a VM
sbx --version
sbx policy init deny-all                  # the factory refuses to run without this
```

`sbx` must be signed in once (`sbx login`) by a person at a terminal. Afterwards the factory drives it headless.
Give the worker its own machine or VM: the factory asserts the global deny-all policy before every sandbox, so a
daemon shared with unrelated projects will fight it.

## 2. Node, pnpm and Pi on the worker

```sh
curl -fsSL https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o /tmp/node.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
corepack enable && corepack prepare pnpm@11.22.0 --activate
sudo npm i -g @earendil-works/pi-coding-agent
```

Sign Pi in on the worker (`pi` once interactively), or copy `~/.pi/agent/auth.json` from a machine that is already
signed in. `pi --list-models` must list models.

The factory loads Pi as a library from a **managed install layout**, not from `$PATH`. A plain global install has
no such layout, so point one at it:

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
put the key in `~/.config/factory/anthropic-api-key`; it is used for the process only and never written to
`auth.json`.

## 3. The factory checkout

**Clone it — do not copy the files.** The factory reads its own git history to pin acceptance inputs, so a
directory without `.git` fails at intake.

```sh
git clone -b main <your factory fork> ~/factory
cd ~/factory && pnpm install --frozen-lockfile && mkdir -p mastra/.data
```

## 4. The target repository

The factory needs a checkout whose `origin` it can push branches to. `origin` can be a bare repository on the same
machine; nothing here needs GitHub.

```sh
git init --bare ~/project/origin.git
git clone ~/project/origin.git ~/project/main      # or add the remote to an existing clone
```

`workspace` in the config resolves from the factory root, and `checkout`/`worktrees` from `workspace`. With
`workspace: ".."`, `checkout: "project/main"` and the factory at `~/factory`, the checkout is `~/project/main` and
each work item gets `~/project/worktrees/<name>`.

## 5. The sandbox kit

A kit is the image every sandbox for this project starts from. It must carry your project's toolchain and GNU
`timeout`, because a **build sandbox reaches only the hosts in `sandbox.allowlist`, and the acceptance sandbox has
no network at all**.

The built-in `shell` kit ships bash, git, curl, make, jq, python and a Docker engine — but no Node and no other
language runtime. In `sbx` 0.54.1 a kit may only name an image; `sandbox.build` with a Dockerfile validates but is
**not implemented**, and `sbx` silently uses `sandbox.image` instead. Until that lands there are two honest options:

- **Publish an image** your team builds elsewhere, and name it in a kit's `sandbox.image`.
- **Install the toolchain in `commands.setup`**, allowlisting the host it comes from. That is what this walkthrough
  does: a `tools/setup.sh` in the target repo fetches Node into `$HOME/node`, `sandbox.allowlist` holds
  `nodejs.org`, and `commands.env.PATH` puts it first. It costs a few seconds per sandbox, and an offline
  acceptance run must get the same toolchain from `acceptance.assets` instead, since it cannot download anything.

## 6. The configuration

`factory.config.json` is the whole of the project-specific setup. The profile used here:

```json
{
  "repo": "local/widget",
  "base": "main",
  "workspace": "..",
  "checkout": "project/main",
  "worktrees": "project/worktrees",
  "paths": { "tests": ["tests/**"], "protected": [".factory/**"], "sensitive": [] },
  "sandbox": { "kit": "shell", "cpus": 2, "memory": "2g", "allowlist": ["nodejs.org"], "maxConcurrent": 1 },
  "tracker": { "command": ["node", "trackers/local.mjs"], "env": {} },
  "commands": {
    "changedCode": ["**/*.js"],
    "setup": [["bash", "tools/setup.sh"]],
    "autofix": [],
    "check": [["npm", "test"]],
    "gates": [["npm", "test"]],
    "env": { "CI": "true", "PATH": "/home/agent/node/bin:/usr/local/bin:/usr/bin:/bin" }
  },
  "acceptance": { "inputs": ["acceptance"], "command": ["bash", "acceptance/run.sh"], "env": {} },
  "skills": { "packs": ["skills/core"], "coder": { "always": ["ponytail"] },
              "codeReviewers": ["architect", "interrogate", "change-impact"] }
}
```

`setup`, `autofix`, `check` and `gates` are **lists of commands**, each command an argv array — `[["npm", "test"]]`,
never `["npm", "test"]` and never a shell string. `repo` is only a label with the local tracker. Start
`maxConcurrent` at 1: a 2 GiB sandbox on a 4 GiB worker leaves no room for a second.

## 7. A work item

With the local tracker a work item is a Markdown file in the **target** repo. Its first `# ` heading is the title;
without one the factory shows "Work item". The id is the file name, so `.factory/items/basket-discount.md` is item
`basket-discount`.

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

Commit and push it, then check the factory can see it:

```sh
cd ~/factory && node trackers/local.mjs list     # needs FACTORY_CHECKOUT and FACTORY_BASE when run by hand
```

Keep `.factory/**` in `paths.protected` so a task cannot edit its own work item.

## 8. Run it

```sh
cd ~/factory && node mastra/src/cli.ts start basket-discount
node mastra/src/cli.ts status basket-discount
```

or `pnpm --dir mastra run dev` and open **http://localhost:4111/board** through an SSH tunnel:

```sh
ssh -N -L 4111:127.0.0.1:4111 worker@<worker-host>
```

The board is unauthenticated: keep it on loopback and reach it only through the tunnel.

## Troubleshooting

Every one of these came up during this setup.

| What you see | Why | Fix |
|---|---|---|
| `expected tuple, received string` on `commands.check` | A command list given one argv instead of a list of them | `[["npm", "test"]]` |
| `intake failed: git rev-parse failed: not a git repository` | The factory directory was copied, not cloned | Clone the factory; it reads its own history |
| `provision failed: Invalid task branch` | The branch name has characters the factory refuses | Check the item id: `[A-Za-z0-9._-]`, no `..` |
| `Invalid sandbox work item` | Same, for the sandbox name | Same |
| `ENOENT … .pi/agent/install/current-version` | Pi is installed but not as a managed install | Step 2's symlink and `current-version` |
| `The planner runs on Claude and needs …/anthropic-api-key` | Older factory build demanded a key file | Update; any provider Pi is signed in to now works |
| `Worker needs an exclusive deny-all network policy` | `sbx policy init deny-all` was never run, or another project widened it | Re-run it; give the worker its own daemon |
| `node: command not found` inside a sandbox | The kit has no Node | Step 5: install it in `setup`, or publish an image that has it |
| `tar … xz: Cannot exec` inside a sandbox | The kit has no `xz` | Fetch the `.tar.gz` build |
| `Work item X already has a run` | A run exists, including a failed one | `fx status X`, then `fx retry X`; clean up to start over |
| `This state belongs to <repo> via <tracker>` | `mastra/.data` was built against a different repo or tracker | Use a separate factory checkout, or clear `mastra/.data` |
| Nothing listed, title shows "Work item" | The item file has no `# ` heading | Add one |
