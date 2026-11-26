# Frankenstein

The colonia software factory: a GitHub issue goes in, a draft PR to `staging` comes out, through an agreed plan,
a coder, checks, cold review, your approval and black-box UAT. **[WORKFLOW.md](WORKFLOW.md)** is how to use it;
**[mastra/README.md](mastra/README.md)** is how it works.

| Path | What it is |
|---|---|
| `mastra/` | The lane (fast and standard), stacks, the board and the `fx` CLI |
| `scripts/run-uat.sh`, `scripts/sandbox.sh` | Black-box UAT of a branch: isolated Supabase, production build, Playwright journeys, Lighthouse |
| `specs/`, `seeds/`, `lighthouse-baseline.json`, `playwright.config.mjs`, `scripts/summarize.mjs` | UAT inputs (human-owned, pinned per work item) |
| `scripts/factory-pi.mjs` | Runs one Pi agent (planner, coder, reviewer) with its tools guarded to the task worktree |
| `scripts/preview.sh` | A worktree's dev server against its own seeded Supabase (`wx-preview` on the laptop) |
| `vm/` | The factory VM: `bootstrap.sh` creates it, `sync.sh` keeps it current, `factory.zsh` has the laptop commands (`factory-ui`, `wx-start`, …), `seed-peer.sh` readies a second laptop |
| `FEEDBACK.md` | What runs taught us, and what changed because of it |

## UAT

`scripts/run-uat.sh <client-ref> <factory-commit>` checks the ref out of `client/.bare` into a disposable detached worktree, starts an isolated Supabase on ports 55321–55328 with its committed configured seeds (webhooks first), applies `seeds/uat.sql` (billing only), restores `.cache/fonts` before an offline production build, and runs the black-box Playwright journeys and three production Lighthouse audits. The Nuxt server and browsers run inside a loopback-only network namespace. The fake Resend server captures actual supplier/customer email payloads through `RESEND_BASE_URL`; the test DNS fixture provides only `example.com` MX records. **Slack is not mocked**, so Slack is unreachable during every run; customer-facing requests must not depend on it. Known failures are a human-owned map in `scripts/summarize.mjs` (journey title → reason), currently empty. One run at a time owns the fixed ports (`.cache/uat.lock`). Each page must score at least accessibility 92 and SEO 100 and stay crawlable; the measured baselines are in `lighthouse-baseline.json`.

Prerequisites (all in the VM image): Docker with cached Supabase images, cached pnpm packages, Chromium, `bwrap`, `socat`, `psql`, `jq`, Node and pnpm (`mise.toml`), and the Supabase CLI pinned in `package.json` (or `SUPABASE_BIN`).

## Limits

Agents get no shell tool; the factory's own commands run with the VM user's permissions, and that user has Docker access (root-equivalent inside the VM). The tool guard and worktrees are not a sandbox: the VM is. The checked-in `specs/` are writable by the agent's Unix user, so **don't treat the factory as tamper-proof against its own operator**. The real gates are the draft PR and you merging it.
