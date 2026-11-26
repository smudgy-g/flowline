# The lane on Mastra

Frankenstein's lane as a local [Mastra](https://mastra.ai) workflow: a GitHub issue in `ColoniaTech/colonia_client` goes in, a draft PR to `staging` comes out. It started as a port of the Swamp fast lane (FEEDBACK 16), which it has replaced.

Nothing here is paid or hosted: Mastra runs in-process, and run state is a SQLite file in `.data/`.

## Files

| File | What it is |
|---|---|
| `src/fast-lane.ts` | The workflow: stages, loops and the gates where it waits |
| `src/stack.ts` | The stack workflow: design gate, sub-issues, members run as fast-lane tasks on one branch |
| `src/config.ts` | Reads `../factory.config.json`: the GitHub repo, base branch, checkout and worktree paths, what agents may read outside a worktree, and the skills (`../skills/README.md`) |
| `src/rules.ts` | Pure rules: naming, path policy, prompts, review parsing, UAT verdicts, PR body |
| `src/ops.ts` | Side effects: git, workmux, Pi (`../scripts/factory-pi.mjs`), UAT (`../scripts/run-uat.sh`), `gh` |
| `src/runs.ts` | Start, read and resume runs (used by the CLI and the tests) |
| `src/board.ts`, `src/board.html` | The board: cards, actions, and the page |
| `src/cli.ts` | `fx`, the command-line driver |
| `src/mastra/index.ts` | Entry point for `pnpm run dev` (Studio) |

## Use

The board is where you watch and decide (both factories' cards, with a second one: WORKFLOW.md "A second factory"): a column per stage (Plan, Code, Tests, Review, Your OK, UAT, Draft PR), a card per issue. Amber cards need you, blue ones are running, red ones are stuck. Click a card for what it's doing or what it needs: the plan, the diff, sensitive files, review notes, why it stopped, with Approve, Send back and Retry buttons. It runs in the factory VM inside the `mastra dev` server, so a run carries on by itself after you click.

1. In the VM, once: `cd ~/Projects/colonia/frankenstein && pnpm install` (`vm/bootstrap.sh` does it).
2. On the laptop: `factory-ui` syncs the VM (`vm/sync.sh`: your Pi login and settings, skills, configs and fonts go over; the VM fetches GitHub and moves the board to this branch's latest when no step is running), starts the server, tunnels it here (not exposed on the network) and opens http://localhost:4111/board. `factory-ui sync` only syncs. The board's sidebar has New issue (the GitHub form) and Sync (the VM half). Pi itself updates on each side on its own. A work item always branches from GitHub's latest `staging` and fetches new packages first. Studio, for looking inside a run, is at http://localhost:4111.
3. Issues labelled `factory` in the client repo appear in the Issues column; click one to start it.
4. Once you merge a PR, its card says Merged: **Clean up** removes the worktree, tmux window and local branch, closes the issue and takes the card off. **Abandon** does the same for a task you've given up on (after a confirmation; uncommitted changes are lost).

5. **Stacks.** A bigger feature filed with the Factory stack form (label `factory-stack`; the sidebar's New stack) shows in Issues as a stack. Start it, and its card moves to the Stacks column:
   - **Design.** It waits for one technical design for the whole stack. You or Claude write it on the card, then you approve it.
   - **Setup.** Approving creates `stack/<number>-<slug>` from staging, and one sub-issue per line of "PRs in order", linked to the parent. Each sub-issue carries the design, so every member's plan and coder see it. Sub-issues get no `factory` label, so nobody starts one on staging by mistake.
   - **Members.** They run in order. A "(by hand)" line waits for your **Done**. Any other line runs as an ordinary fast-lane card whose draft PR targets the stack branch. When you merge it there and **Clean up** its card, the next member starts.
   - **Finish.** After the last member, the stack opens one draft PR from its branch into staging. Merge it, then Clean up the stack card to close the issue.

The driver (Claude or Pi) starts runs and records plans with the CLI, which uses the same run database:

```sh
node src/cli.ts start 1412                                # issue number
node src/cli.ts status [1412]
node src/cli.ts plan 1412 --summary "…" --tests "…"
node src/cli.ts findings 1412 findings.json
```

The CLI also has `approve`, `reject`, `retry` and `restart` for use without Studio. Don't resume a run from the CLI while the board is working on it.

## The standard lane

An issue (or stack) whose form says **Lane: standard** runs the same workflow with more review; its card is tagged `standard`. Plan in `docs/standard-lane.md`.

- **Plan review.** Every plan the planner drafts goes to four read-only reviewers in parallel: `plan-fitness` (edge cases, missing steps, oversized steps, an oversized PR), `goldfish-implementation-readiness` (decisions left to the coder), `goldfish-codebase-details` (wrong claims about the code) and `architect`. Anything above low goes back to the planner, at most **2** automatic revisions (`MAX_PLAN_REVISIONS`), each reviewed again. Then the plan waits for you with what is still open; approving with findings open is fine.
- **Wider code review.** Each round adds `architect`, `interrogate`, `change-impact` and `typescript-guidance` beside the usual reviewer, findings tagged with who made them. Critical and high block as before. An extra reviewer with no readable findings is recorded and skipped.
- **Stack design review.** A standard stack's design and PR list go to `plan-fitness` and `architect` before you approve. If they propose a different PR list, the card shows it next to the current one: **Approve with the proposed list** rewrites the parent issue's "PRs in order" and the sub-issues follow it.
- **Splitting a PR** (any lane). At plan approval, **Split into PRs** takes one PR per line (prefilled with the reviewers' proposal, if any). The card keeps the first part and replans for it alone. On staging the other parts become new `factory` issues straight away (the original gets a comment linking them). In a stack they become sub-issues right after this member once it finishes, and the parent's list and later sub-issues' `n/total` titles follow.
- A standard run checks its reviewer skills load before planning (`checkSkills`). The skills come from the packs in `skills/` that `factory.config.json` names (`skills/README.md`).
- Cost: up to 12 review calls per plan draft (4 per review, 3 reviews), 4 extra per code-review round, 2 per stack design.

## How it works

- **Input is a GitHub issue.** Only issues (and comments) by the GitHub token's owner, or logins in `FACTORY_ISSUE_AUTHORS`, reach an agent. The branch is `<number>-<title slug>`.
- **Implement, test and review run by themselves.** The driver only agrees the plan with you. A failed test or a blocking finding goes back to the coder as feedback, at most 6 cycles before it asks you.
- **Every work item keeps a written history** in its worktree: `.agents/artefacts/factory/history.md` (the approved plan, each round's coder reply, check result and review, your approvals and send-backs with why, UAT, the PR) and `checks.log` (every round's full check output). The card shows the history, newest first. Agents can read it, never write it. Clean up keeps `history.md` in `mastra/.data/history/<work item>/`; `checks.log` (about 500 KB per round) goes with the worktree.
- **A stack's record** lives in `mastra/.data/stacks/<stack>/` (it has no worktree: nobody edits its branch directly): `design.md`, the approved design, and `history.md` (design approved or sent back, sub-issues, each member started and finished, the stack PR). Each member's worktree gets a read copy in `.agents/artefacts/stack/` when it starts, so later PRs see what earlier ones decided.
- **Short names.** A work item is `<issue>-<first meaningful title words>`, at most about 30 characters (e.g. `1425-read-offers-uploaded`); runs started before keep their names.
- **The planner writes the plan.** Starting a card creates its worktree, then a read-only planner reads the issue and the code and drafts the plan as numbered steps with tests and open questions (each with the default it chose). You approve it, or send it back with what to change and it revises. You or the driver can still write the plan by hand; if the planner gives nothing usable, the card asks for one.
- **Models per role:** `scripts/factory-pi.mjs` `MODELS`, as `provider/id` (a bare id is Codex): planner `anthropic/claude-opus-5-5` on the factory's Anthropic API key below (billed per token; without the key the planner fails), coder `gpt-6.1-terra`, reviewer `gpt-6.2-sol`, tester `gpt-6-luna`; `FACTORY_MODEL_PLANNER` (or `_CODER`, `_REVIEW`, `_TESTER`) overrides one, e.g. `FACTORY_MODEL_PLANNER=gpt-6.1-terra` puts it back on Codex.
- **Every role has Pi's codemode.** Besides its own tools (read-only for planner and reviewer, plus edit and write for coder and tester, plus `check` for the coder; never a shell), each role can run a codemode script that batches those same tools in one turn. Each call the script makes goes through the same path guard (`authorizeTool`) as a direct call. Codemode's paid `models` global (classifiers, image models) is off.
- **When Codex runs out, Claude takes over.** A Codex call that hits the Codex usage limit carries on in the same session on Claude: coder and reviewer `claude-opus-5-5`, planner too when it runs on Codex, tester `claude-haiku-5-5` (`FALLBACKS`; `FACTORY_FALLBACK_<ROLE>` overrides one). Later calls go straight to Claude for an hour. It uses a factory-only Anthropic API key (billed per token; give it a spend limit) in the VM at `~/.config/factory/anthropic-api-key`, which no sync touches; without that file there is no fallback. Its replies start "(Codex is at its usage limit: this ran on …)", so the history shows it.
- **The coder works step by step.** It does one bounded piece per call and stops, so an approved plan goes to it one step per call, then once whole. A plan with numbered steps (`1. …`) uses them; any other plan or spec is split by a read-only planner call that reads the code first. The card shows the steps and which have been given. Later rounds are one call with the feedback; it ends by naming any steps still unfinished, and each of those gets its own call in the same round (FEEDBACK 30). Each coder call lints and typechecks its work with the `check` tool before it stops (FEEDBACK 29). When `check` passes, it records a hash of the worktree (`scripts/content-tree.sh`) in the factory's history folder; if the code reaching the gates still has that hash, the lint and typecheck gates are skipped (the log says so) and the tests run straight away. Any change after the check, or a check that wasn't run or failed, runs both gates as before.
- **One approval covers the outcome.** Sensitive files (dependencies, customer data, integrations) are listed at the outcome gate instead of needing a separate exact-content approval earlier (FEEDBACK 4). The approval is bound to the fingerprint of the files that were tested. If anything changes while the gate waits, it asks again (FEEDBACK 24).
- **Reviewers return JSON findings.** If a reply has no parseable block, the run waits for `fx findings`.
- **Pause and resume.** Pause on a card (or Pause all in the sidebar, `fx pause <issue|all>`) lets the step running finish, then the run waits as `paused`; the coder step also stops between coder calls. A person's answer to a wait still goes through and the run pauses after it. Resume (`fx resume <issue|all>`) carries on from where it stopped, on whatever code is synced by then. Pauses are files in `mastra/.data/paused/`, so they survive a restart.
- **Errors wait instead of failing.** Any step that throws waits as `error`. Fix the cause, then `fx retry`. UAT infrastructure failures do the same; a client failure goes back to plan with the failure. If UAT stops before writing a report, the card shows the script's error.
- **One UAT at a time.** UATs share isolated ports, so `scripts/run-uat.sh` holds `.cache/uat.lock`; a second approval waits for the running UAT to finish instead of failing.

## Limits

- **Approving is not a security boundary.** An agent with a shell in the VM could resume a run itself. The real gates are the draft PR and you merging it.
- **Stacks don't merge staging into their branch** between members, and the whole stack gets no UAT of its own; each member is UAT'd on its own branch. Conflicts with staging show on the stack's PR.

## Check

```sh
pnpm run check   # type check plus tests: the whole lane with fake side effects, resumed in a fresh process per command
```
