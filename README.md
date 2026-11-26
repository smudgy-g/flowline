# Frankenstein software factory

Turn a work item into a reviewed, acceptance-tested change on the branch your team chooses, through an agreed plan, a coder, project checks, cold review, your approval and black-box acceptance. The board shows every stage and the human gates.

Install it once; run it in any repository you have checked out.

```sh
npm i -g frankenstein-factory
cd ~/code/your-project
frankenstein setup        # writes .factory/, and says what your machine is still missing
frankenstein board        # http://localhost:4111/board
```

Each work item runs in **its own Docker Sandbox** (`sbx`): a microVM with its own kernel and Docker engine. The factory itself — board, run database, git, credentials and the Pi agents — stays on your machine. Every command that executes project code (install, fixes, checks, tests, preview, acceptance) runs inside the item's sandbox, so agent-written code never runs on your host and one work item cannot touch another.

[docs/setup.md](docs/setup.md) is the full walkthrough, written from a real setup, with every failure it produced and the fix.

## What lives where

| | |
|---|---|
| **The package** | the factory's code, skill packs, tracker adapters. Installed once. |
| **`.factory/` in your repo** | `config.json`, the acceptance adapter, work items with the local tracker. Committed and reviewed like any other code. |
| **`~/.local/state/frankenstein/<project>/`** | the run database, logs and records for this checkout. Never in your repository, never inside a sandbox. |

## Configure

`.factory/config.json` is the whole of it; `frankenstein setup` writes a starting point.

- `base` is the branch work starts from and changes are aimed at; `worktrees` says where task worktrees go.
- `commands` are what the factory runs in a work item's sandbox: `setup` prepares a fresh worktree, `autofix` runs formatters, `check` is the coder's fast feedback, and `gates` are the required checks including the full suite. Each is a **list of commands**, each command an executable plus literal arguments, never a shell string. `{changedCode}` expands to changed files matching `changedCode` globs.
- `sandbox.kit` is an image carrying your toolchain and GNU `timeout`; `allowlist` is the exact hosts a build sandbox may reach, normally only package registries. Start `maxConcurrent` at 1 on a small machine. Never bake credentials into a kit.
- `paths.tests` limits where the tester role may write, `paths.protected` blocks changes (keep `.factory/**` there), `paths.sensitive` flags them for you at the approval gate.
- `tracker` names where work items come from: `local` (the default) keeps them as Markdown in your repo under `.factory/items/<id>.md` and needs no account or network; `github` uses issues and draft PRs. Write your own rather than changing factory code — [the contract](docs/tracker.md) is twelve verbs.
- `skills.packs` are copied into each worktree; a bare name is one of the factory's, a path is yours ([guide](skills/README.md)).

[`examples/go.factory.json`](examples/go.factory.json) is a worked profile.

## The acceptance adapter

`.factory/acceptance/run.sh` decides whether a change may be delivered, and the shipped stub refuses everything until you write it.

It runs in a **sandbox created with no network at all**, against `$PROJECT_ARCHIVE`, a git archive of the **pushed commit**. It is pinned to the copy on your **base branch**, so a task cannot influence its own acceptance. It gets `$REPO`, `$REF`, `$COMMIT`, `$INPUTS`, and `$ASSETS` when `acceptance.assets` names a read-only directory of pre-staged fixtures — which is how a toolchain reaches a sandbox that cannot download one.

Print one JSON object on stdout, for example `{"commit":"<the tested SHA>","pass":false,"detail":"Checkout journey failed at payment confirmation"}`. Exit zero for a completed verdict including a failure; use stderr for logs and exit nonzero for infrastructure failures. A wrong SHA, malformed verdict, timeout or missing adapter blocks delivery.

## Requirements

A machine Docker Sandboxes supports (Ubuntu 24.04+ with KVM, Apple-silicon macOS, or Windows 11; only Ubuntu is exercised here — see [docs/sandboxes.md](docs/sandboxes.md)), with `sbx` signed in and `sbx policy init deny-all` run; Node 22.18+; git; and a Pi installation with model credentials. The board is unauthenticated: keep it on loopback, and reach a remote one through an SSH tunnel.

## Development

`npm run check` type-checks and exercises the workflow with fake side effects. [docs/internals.md](docs/internals.md) is the implementation map.
