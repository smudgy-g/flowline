# Working with the factory

The factory adds gates around how you already work: an agreed plan, cold code review, your approval of the change, black-box UAT and a draft PR you merge. Every task still lives in a workmux worktree under `client/worktrees/`, and `wx open <name>` drops you into it.

**Where it runs:** in a devvm VM, so agents and the code they write never touch the laptop. The colonia tree there is the VM's own clone, at the same path as the laptop's; work leaves it only through GitHub.

| On the laptop | Does |
|---|---|
| `factory-ui` | Syncs the VM (your Pi login, skills, configs and fonts go over; the VM fetches GitHub and moves the board to `main`'s latest when no step runs), tunnels the board here and opens http://localhost:4111/board. `factory-ui sync` only syncs; `factory-ui stop` closes the tunnel. |
| `wx-start` | Opens (or reattaches) the `colonia` tmux session inside the VM; `wx`, `fx-new`, `nv`, `lz` work there. |
| `fx-new` | Opens Pi in the factory checkout inside the VM, as a driver. |
| `fx <args>` | The factory CLI in the VM: `fx status 1484`, `fx retry 1484 --proceed`, `fx retry 1484 --note "…"`. |
| `fx-shell` | A shell in the VM's factory checkout (`fx` works there too). |
| `monster [command]` | Runs any of these on the M1 instead: `monster` opens a shell in its VM, `monster fx retry 1484 --proceed`, `monster wx-start`. Needs `FACTORY_PEER`. |
| `wx-preview <worktree>` | Runs that worktree's dev server in the VM against its own seeded Supabase (log in as `supplier@cloud-city.test` / `password123`), no real secrets, at `http://127.0.0.2:3300` until Ctrl-C. |

The laptop commands live in `vm/factory.zsh`; `~/.zshrc` sources it. `vm/bootstrap.sh` creates or refills the VM; `vm/colonia.sh` and `vm/colonia.policy` are its image layer and network allowlist (`devvm network log --blocked` shows what it refused).

## A second factory (the M1)

Two laptops, two VMs, one board. The laptop's factory is the **doctor**, the M1's the **monster**. Each runs its own lane and keeps its own runs; the board on this laptop shows both, and each card's buttons go to the factory that runs it. Starting an issue labels it `factory:<name>` on GitHub, so the other factory won't start it too (Abandon removes the label).

1. On this laptop: `vm/seed-peer.sh <ssh host of the M1>` (needs Remote Login on the Mac). It sends what exists only here: the VM's Pi (arm64 builds), the factory's Anthropic key, your Pi settings, skills, terminal configs, the client's local workmux files and the UAT fonts; anything the Mac already has stays. It prints the rest.
2. On the M1 (devvm and Homebrew `rsync` installed): clone this repo to `~/Projects/colonia/frankenstein`, `devvm secret set github`, make the empty root-owned folder, then `FACTORY_NAME=monster vm/bootstrap.sh`. Its VM gets 6 CPUs and 10 GB (the Mac keeps the rest), and Playwright's Chromium, since Google has no Linux Chrome for arm64. Source `vm/factory.zsh` in its `~/.zshrc` and run `factory-ui` there once; it keeps that board on the Mac's localhost:4111.
3. On this laptop, in `~/.zshrc` above the source line: `FACTORY_PEER=<ssh host of the M1>`. `factory-ui` then also tunnels the M1's board to localhost:4112 and opens the board with both. Cards and the Start button say which factory; Pause all pauses both. Sync stays per factory (run `factory-ui sync` on each laptop).

**Leaving the M1 unattended:** `vm/reanimate.sh install` on the Mac adds a login item that checks the board every minute and, when it doesn't answer, starts the VM, the board and the tunnel again (log: `~/Library/Logs/frankenstein-reanimate.log`). With automatic login, never-sleep on power (`sudo pmset -c sleep 0`), restart after power failure (`sudo pmset -a autorestart 1`), automatic macOS update installs off, and Tailscale key expiry disabled, a restart heals itself. Keep the lid open: a closed MacBook sleeps regardless.

**Getting into the M1:** `monster` from the laptop (see the table). Over SSH the Mac's login keychain is locked, and devvm needs it to start the VM; the commands ask for the Mac's password then, once per login. On the Mac itself the same commands work without the `monster` prefix.

Both factories share one Codex login, so two run through its limit twice as fast before falling back to the per-token Anthropic key.

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

- **Factory worktrees have no `.env`.** To look at one, use `wx-preview`; never link the real `.env` into agent-written code. The factory refuses to run with `.env` present.
- **Migrations stop the factory.** They belong in `~/Projects/colonia/supabase/staging`.
- **One UAT run at a time.** It owns ports 55321–55328, and your dev Supabase on 54321+ is never touched.
- **Known UAT failures are human-owned** (`scripts/summarize.mjs`). When a task makes one pass, the PR says so; remove the entry yourself.
- **UAT inputs are human-owned and pinned per work item.** `specs/`, `seeds/`, `lighthouse-baseline.json`, `playwright.config.mjs` and `scripts/summarize.mjs` are read from the factory commit recorded when the work item started. Commit spec changes whenever you like; running items keep the inputs they started with. To move an item onto a fixed journey, approve its plan or change with **… on the latest UAT journeys** (the board offers it when the journeys changed since it started), or `fx approve <issue> --baseline <sha>`; a coder stuck at its round limit takes `fx retry <issue> --baseline <sha>`. Only forward along factory history.
- **The VM's folder stays empty and root-owned.** On Linux devvm can't protect a shared `.git`, so anything the VM wrote into a shared folder could run on the laptop. Never share `~/Projects/colonia` into it, and keep `--ports none`.
- **Change the factory in a separate worktree** and merge to `main` when no run is mid-step (FEEDBACK 28).
