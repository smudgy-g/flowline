# Where work items come from and where results go

The lane needs sixteen things from a tracker: read an item, claim it, list what is startable, comment, create an item (a split), create a child item (a stack member), retitle one, replace one section of one, ask whether one is open, close one, and on the delivery side open or update a change proposal and ask whether it was accepted. GitHub answered all of these with `gh`. Nothing in the lane needs GitHub specifically.

## The contract

One **tracker adapter** per factory, named in `factory.config.json`:

```jsonc
"tracker": { "command": ["node", "trackers/local.mjs"], "env": {} }
```

The factory runs `<command> <verb> [args…]` from the factory root with that `env`, never a shell string. Input beyond the arguments arrives on stdin; the reply is one JSON value on stdout. A nonzero exit is an infrastructure failure, and the run waits as `error` rather than guessing. The adapter is trusted factory code and runs on the host, not in a sandbox: it holds whatever credentials the tracker needs, and no agent can call it.

| Verb | Arguments | Stdin | Stdout |
|---|---|---|---|
| `list` | — | — | `[{ "id", "title", "url", "stack": bool }]`, only unclaimed, startable items |
| `read` | `id` | — | `{ "id", "title", "body", "url", "author", "comments": [string] }` |
| `claim` | `id` `owner` | — | `{ "ok": true }`, or exit nonzero if another owner holds it |
| `release` | `id` | — | `{ "ok": true }` |
| `comment` | `id` | text | `{ "ok": true }` |
| `create` | `kind` (`task`\|`child`) | `{ "title", "body", "parent"?, "after"? }` | `{ "id" }` |
| `retitle` | `id` | title | `{ "ok": true }` |
| `section` | `id` `name` | text | `{ "ok": true }` |
| `state` | `id` | — | `{ "open": bool }` |
| `close` | `id` | text | `{ "ok": true }` |
| `deliver` | `branch` `base` | `{ "title", "body" }` | `{ "url" }` — opens or updates the proposal, idempotent |
| `delivered` | `url` | — | `{ "state": "open" \| "accepted" \| "rejected" }` |

`id` is a string the adapter chooses and the factory only echoes; it must be safe in a branch name (`[A-Za-z0-9._-]{1,64}`). The factory still derives the work item name, branch, worktree and sandbox from it, so an id stays stable for the life of an item.

Only `read` output reaches an agent, and only after the adapter has filtered by author: trust stays the adapter's job, because only it knows who its authors are.

## Shipped adapters

**`trackers/local.mjs` (default).** Items are Markdown files in the target repo under `.factory/items/<id>.md`, with the same `### Outcome`, `### Lane`, `### PRs in order` headings the GitHub forms produce. Comments are `## comment` sections appended to the file; `claim` writes `.factory/claims/<id>` with the owner, `state` reads a `Status:` line. `deliver` pushes nothing: it writes `.factory/delivered/<id>.md` with the branch, base, title and body, returns a `file://` url, and `delivered` reports `accepted` once the base branch contains the branch tip. No network, no account, no remote.

**`trackers/github.mjs`.** Today's `gh` behaviour, unchanged in substance: issues labelled `factory`/`factory-stack`, `factory:<name>` claim labels, sub-issues for stack members, draft PRs, and `MERGED` as accepted.

## What changes in the factory

`ops.ts` keeps its function names and loses its `gh` calls: each becomes one adapter invocation. `fast-lane.ts`, `stack.ts` and `board.ts` change only where they assume a number (`issue: number` becomes `id: string`) or say "issue"/"PR" in text the human reads, which becomes "item"/"proposal". The run id stays `issue-<id>`, so existing state keeps working only if ids stay numeric; a factory that switches tracker starts fresh runs.

Risk worth naming: a local item file lives in the target repo, which a task's worktree can also write. The factory reads items from the base checkout, never from a task worktree, and `paths.protected` should list `.factory/**` so a task cannot edit its own work item.
