# Where work items come from and where results go

The lane needs sixteen things from a tracker: read an item, claim it, list what is startable, comment, create an item (a split), create a child item (a stack member), retitle one, replace one section of one, ask whether one is open, close one, and on the delivery side open or update a change proposal and ask whether it was accepted. GitHub answered all of these with `gh`. Nothing in the lane needs GitHub specifically.

## The contract

One **tracker adapter** per project, named in `.factory/config.json`. A bare name is one the factory ships
(`local`, the default, or `github`); anything else is your own command:

```jsonc
"tracker": { "command": ["github"], "env": {} }
"tracker": { "command": ["./tools/jira-tracker.py"], "env": { "JIRA_PROJECT": "AUTH" } }
```

The factory runs `<command> <verb> [args…]` from the project root with that `env`, never a shell string. Input beyond the arguments arrives on stdin; the reply is one JSON value on stdout. A nonzero exit is an infrastructure failure, and the run waits as `error` rather than guessing. The adapter is trusted factory code and runs on the host, not in a sandbox: it holds whatever credentials the tracker needs, and no agent can call it.

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

`id` is a string the adapter chooses and the factory only echoes, matching `[A-Za-z0-9._-]{1,64}` so it is safe in a branch name, a path and a run id. The factory derives the work item name, branch, worktree and sandbox from it, so an id must stay stable for the life of an item. Opaque ids are the point: `AUTH-14`, `health-endpoint` and `312` cannot be mistaken for each other, where bare numbers from two trackers would collide. The factory records its repo and tracker in `mastra/.data/owner.json` on first start and refuses to start against a different pair, so stale worktrees and sandboxes can never be matched to another tracker's ids.

Only `read` output reaches an agent, and only after the adapter has filtered by author: trust stays the adapter's job, because only it knows who its authors are.

## Shipped adapters

**`local` (the default).** Items are Markdown files in the target repo under `.factory/items/<id>.md`, with the same `### Outcome`, `### Lane`, `### PRs in order` headings the GitHub forms produce. Comments are `## comment` sections appended to the file; Ids are the file's own name — `health-endpoint.md` is item `health-endpoint` — and `create` slugs the title, suffixing `-2` on a clash. `claim` writes `.factory/claims/<id>` exclusively, and a closed item gets `<id>.closed` beside it. `deliver` pushes nothing: it writes `.factory/delivered/<id>.md` with the branch, base, title and body, returns a `file://` url, and `delivered` reports `accepted` once the base branch contains the branch tip. No network, no account, no remote. For a GitHub `origin`, the completed card also offers **Create GitHub PR…**: it opens GitHub's compare form with the pushed branch and base selected; the human chooses Draft and submits. The local tracker still checks the branch merge, not the GitHub PR's status.

**`github`.** Today's `gh` behaviour, unchanged in substance: issues labelled `factory`/`factory-stack`, `factory:<name>` claim labels, sub-issues for stack members, draft PRs, and `MERGED` as accepted.

## What changes in the factory

`ops.ts` keeps its function names and loses its `gh` calls: each is one adapter invocation. Item ids are strings throughout the lane, stack, board and CLI. The run id is `item-<id>`.

Risk worth naming: a local item file lives in the target repo, which a task's worktree can also write. The factory reads items from the base checkout, never from a task worktree, and `paths.protected` should list `.factory/**` so a task cannot edit its own work item.
