# Working with the factory

The factory adds gates around how you already work: an agreed plan, cold code review, your approval of the change, black-box UAT and a draft PR you merge. Every task still lives in a workmux worktree under `client/worktrees/`, and `wx open <name>` drops you into it.

**Where it runs:** on a worker host (Ubuntu 24.04+ for local Docker Sandboxes). Each work item gets its own sandbox microVM; agent-written code never executes on the worker host or your laptop. The board is tunnelled to your machine, so you can watch and decide from Linux, macOS or Windows.

| On your machine | Does |
|---|---|
| `ssh -L 4111:127.0.0.1:4111 <worker>` | Opens the board at http://localhost:4111/board. |
| `pnpm --dir mastra fx <args>` (on the worker) | The factory CLI: `fx status 1484`, `fx retry 1484 --proceed`. |
| `scripts/preview.sh <work item>` (on the worker) | Runs the project's preview command inside that item's sandbox. |

Each card shows its sandbox state (running, stopped, missing); an error wait offers **Recreate sandbox**, which rebuilds the VM and reruns setup without touching the worktree. Clean up and Abandon remove the sandbox with the worktree, and orphaned `fx-*` sandboxes are pruned at startup.

## A task

1. **File an issue** in `colonia_client` with the **Factory task** form (label `factory`). Describe the outcome, not the implementation ("inquiries must not hang when Slack is down", not "set retries to 0"). Pick the lane:
   - **fast lane** for small, well-understood changes;
   - **standard** where a wrong or badly cut plan is expensive: reviewers check every plan (edge cases, missing steps, step and PR size, wrong claims about the code, decisions left to the coder, design), the planner revises up to twice on what they find, and four more reviewers check each round of code.
2. **Start it** from the board's Issues column (or ask a driver: `pnpm --dir mastra fx start <issue>`).
3. **Plan.** The planner reads the issue and the code and drafts numbered steps with tests and open questions. **You approve it**, send it back with what to change, or **split it into PRs** (this card keeps the first part; the rest become new issues).
4. **Code, checks, review.** The coder works step by step; lint, typecheck, changed tests and the full suite run; a cold reviewer (more in standard) reads the diff. Failures and blocking findings go back to the coder, at most 6 rounds before it asks you.
5. **Your OK.** Read the diff on the card (or `wx open <work item>`) and **approve**, or send it back with what's wrong.
6. **UAT** runs on the pushed branch. A journey failure goes back to plan; a setup failure waits for a factory fix and Retry.
7. **Draft PR** to `staging`. You merge. Then **Clean up** on the card removes the worktree and branch and closes the issue.

## A stacked feature

`staging` is the release train: anything merged there goes out with your next `staging` → `main` merge. When a feature must not ship until it's all ready, stack it: file the **Factory stack** form (label `factory-stack`) with its "PRs in order" and lane.

1. **Design.** Starting it asks for one technical design for the whole stack (write it with a driver, or on the card). In a standard stack, reviewers read the design and the PR list first and may propose a different list. **You approve** the design, with the current list or the proposed one.
2. **Setup** creates `stack/<number>-<slug>` from staging and one sub-issue per PR.
3. **Members** run in order as ordinary cards whose draft PRs target the stack branch. Merge each there and Clean up its card; the next starts. A "(by hand)" PR waits for your **Done**. A member split at its plan approval gets its other parts inserted right after it.
4. **Finish.** After the last member, one draft PR from the stack branch into staging. Merge it, then Clean up the stack card.

Migrations still land in `supabase/staging` first, so keep them additive.

## Rules worth knowing

- **Factory worktrees have no `.env`.** To look at one, use `scripts/preview.sh` on the worker; never link the real `.env` into agent-written code. The factory refuses to run with `.env` present.
- **Migrations stop the factory.** They belong in `~/Projects/colonia/supabase/staging`.
- **Each UAT runs in its own sandbox.** Its ports are private to that microVM, and nothing on the worker is touched.
- **Known UAT failures are human-owned** (`scripts/summarize.mjs`). When a task makes one pass, the PR says so; remove the entry yourself.
- **UAT inputs are human-owned and pinned per work item.** `specs/`, `seeds/`, `lighthouse-baseline.json`, `playwright.config.mjs` and `scripts/summarize.mjs` are read from the factory commit recorded when the work item started. Commit spec changes whenever you like; running items keep the inputs they started with. To move an item onto a fixed journey, approve its plan or change with **… on the latest UAT journeys** (the board offers it when the journeys changed since it started), or `fx approve <issue> --baseline <sha>`; a coder stuck at its round limit takes `fx retry <issue> --baseline <sha>`. Only forward along factory history.
- **The VM's folder stays empty and root-owned.** On Linux devvm can't protect a shared `.git`, so anything the VM wrote into a shared folder could run on the laptop. Never share `~/Projects/colonia` into it, and keep `--ports none`.
- **Change the factory in a separate worktree** and merge to `main` when no run is mid-step (FEEDBACK 28).
