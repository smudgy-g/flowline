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

## Adopting the factory

Use one factory checkout and run database per target repository. Start with `factory.config.json` (Nuxt/TypeScript), or copy [`examples/go.factory.json`](examples/go.factory.json) to `factory.config.json` for an example without Node-based project checks. Set `repo` and `base` to your GitHub repository and PR target. `workspace` is relative to the factory root; `checkout` (an existing read-only base checkout), `worktrees` and optional `readable` directories are relative to that workspace. Pick [skill packs](skills/README.md) relative to the factory root, and put project-specific conventions in the target's `AGENTS.md`.

`checks.setup` runs once when provisioning a task worktree. `checks.gates` is a nonempty, ordered list of required checks; the first failure stops the list and reports its output. Each entry is an executable followed by its arguments, **not a shell string**. Use trusted commands, provide the project toolchain in the VM, and include your full test suite. With custom checks the factory does not run the Nuxt setup, automatic ESLint/Prettier fixes or coder-side typecheck. Omit `checks` to keep the entire existing Nuxt flow.

To inspect the board in a configured factory environment, run `pnpm install` then `pnpm --dir mastra run dev` and open <http://localhost:4111/board>. The header identifies the local target; the issue list needs authenticated `gh` access. Keep the board on loopback or behind a private tunnel: its actions are not authenticated. Only connect peer factories for the same repo.

**Before running another team's first issue:** provision its GitHub issue forms and labels, adapt the Colonia VM bootstrap/sync and black-box UAT to its environment, and review the lane's test-file and sensitive-path rules for its language. Custom checks replace project build/test commands, not those deployment and acceptance policies.

## UAT

`scripts/run-uat.sh <client-ref> <factory-commit>` checks the ref out of `client/.bare` into a disposable detached worktree, starts an isolated Supabase on ports 55321–55328 with its committed configured seeds (webhooks first), applies `seeds/uat.sql` (billing only), restores `.cache/fonts` before an offline production build, and runs the black-box Playwright journeys and three production Lighthouse audits. The Nuxt server and browsers run inside a loopback-only network namespace. The fake Resend server captures actual supplier/customer email payloads through `RESEND_BASE_URL`; the test DNS fixture provides only `example.com` MX records. **Slack is not mocked**, so Slack is unreachable during every run; customer-facing requests must not depend on it. Known failures are a human-owned map in `scripts/summarize.mjs` (journey title → reason), currently empty. One run at a time owns the fixed ports (`.cache/uat.lock`). Each page must score at least accessibility 92 and SEO 100 and stay crawlable; the measured baselines are in `lighthouse-baseline.json`.

Prerequisites (all in the VM image): Docker with cached Supabase images, cached pnpm packages, Chromium, `bwrap`, `socat`, `psql`, `jq`, Node and pnpm (`mise.toml`), and the Supabase CLI pinned in `package.json` (or `SUPABASE_BIN`).

## Limits

Agents get no shell tool; the factory's own commands run with the VM user's permissions, and that user has Docker access (root-equivalent inside the VM). The tool guard and worktrees are not a sandbox: the VM is. The checked-in `specs/` are writable by the agent's Unix user, so **don't treat the factory as tamper-proof against its own operator**. The real gates are the draft PR and you merging it.
