# Factory feedback log

Running record of what the factory got wrong, what was fixed, and what still needs improving.
Add an entry whenever a run surprises you. Fix the factory, not just the task (the "iterate
until you trust it" loop from Adam Jacob's *How to build a software factory* talk).

## Timeline

- **2026-10-22:** Swamp workspace created (`swamp start`, Pi). UAT factory built first: six black-box
  Playwright journeys, three production Lighthouse gates, isolated Supabase (55321+), offline
  (loopback-only namespace), fake Resend via `RESEND_BASE_URL`. Committed `28a86b1`.
- **2026-10-22:** Standard and fast-lane `@swamp/software-factory` definitions plus controller
  (`e5f6d4f`, `9a53f1b`), modelled on `client/staging/scripts/agent-task.mjs` (still in place).
- **2026-10-23:** First real task (Slack fail-fast, fast lane) → client PR #1371, merged. Clean
  staging UAT afterwards (run `97b88991…`).
- **2026-10-23:** Takeover mode built (`49eb9c4`, `10890e2`). First takeover: `remove-company-nav`.

## What UAT caught

UAT paid for itself on its first real run:

1. Slack `WebClient` defaults (10 retries over ~30 min, no timeout) hung customer inquiries.
2. After fail-fast, `sendOfferInterestToSlack` and `partners/common.ts` rethrew Slack errors,
   so customers got HTTP 500 after their lead was saved. Neither showed up in unit tests.
3. Cold review separately caught Slack's `Retry-After` sleep on 429 (bypasses `retries: 0`).

## Fixed in the factory

- **Typecheck missing from the test stage:** the push hook caught a type error after both
  approvals. Fixed: `colonia-task-tests` runs `pnpm typecheck` (`d86c141`).
- **No recovery after a failed push:** the controller refused to retry once a local commit
  existed. Fixed (`d86c141`, `bf15cd1`).
- **Rework couldn't publish to an already-pushed branch.** Fixed without force push (`bf15cd1`).
- **Formatting changed approved content:** Prettier ran after fingerprinting, forcing
  re-approval of identical logic. Fixed: format before fingerprint (`e958dab`).
- **Agent edited a UAT spec mid-task (`b5fabda`):** the integrity check only compared to `HEAD`.
  Fixed: UAT inputs frozen per work item, human-approved spec changes only, pre-commit
  hook (`7da22fe`). `b5fabda` itself was approved retroactively: the old assertion had never run.
- **Known failure hard-coded in `summarize.mjs`.** Replaced by an empty, human-owned map (`37d11ca`).
- **Takeover mode pushed on adoption,** before outcome approval and triggering a Vercel preview.
  Fixed: push only at prepare (`49eb9c4`).
- **Takeover skipped `implement`,** so review had no `change` record to bind to. Fixed: adoption is a
  no-coder pass through implement (`10890e2`).
- **Takeover UAT baseline lookup used `factory/<name>` instead of the work item,** so `draft_pr`'s verdict
  check silently failed for every adopted run. Fixed (`bef081e`).
- **First takeover shipped:** `remove-company-nav` → draft PR #1374, no gates overridden.
- **Factory agents lacked project skills (issue 0).** Start/adopt now copy a fixed skill snapshot;
  Pi validates requested skills before dispatch, loads coder test/domain skills, and resolves
  global `ponytail-review` through its resource loader (`1e510b6`).
- **UAT installed from a different pnpm store (`fix-meta-dns-leads`).** The UAT worktree was under
  `/tmp` (tmpfs), so pnpm silently used `/tmp/.pnpm-store`, which lacked `@vercel/functions@3.10.3`
  from staging #1373. The test gates passed, but UAT failed with `ERR_PNPM_NO_OFFLINE_TARBALL`.
  Fixed: the worktree is now created under `$ROOT/.cache`, the same filesystem as the main store
  (`8b5c1d7`).
- **Plan review couldn't run before provisioning (standard lane).** `reviews` needed the task
  worktree, but `provision` only ran in `implement`. Fixed: plan review provisions first and
  `provision` is idempotent for an active work item (`67368b8`).
- **Schema guard missed the generated types file.** `inspect` matched `database.types.ts`, not the
  real `shared/types/supabase/database-generated.types.ts`, so an agent edit there wouldn't stop the
  run. Fixed: the pattern covers both (`7bf6362`).
- **UAT ran an unpinned Supabase CLI and deleted its own startup log (`guenther-qualification`,
  2026-11-05).** `run-uat.sh` called a hashed npx cache path; when npx refreshed it to CLI 3.0.0,
  `supabase start` rejected the removed `[inbucket]` config section, and cleanup deleted
  `supabase.log`, so the report only said "setup failed". Fixed: UAT calls `supabase@latest` and keeps
  `supabase.log` (`df0c235`); the config moved to `[local_smtp]` in `supabase/staging` (`715cc32`).

- **UAT infrastructure failures replanned the client, and active runs blocked UAT commits (items 18, 26).**
  A pre-verdict UAT failure took `replan` back to `plan`, and the pre-commit guard refused every protected
  UAT commit while any run was `active`, so a stale run blocked spec work for everyone. Fixed: UAT reads its
  inputs from the work item's baseline commit (`git archive`), so factory HEAD moves freely and the guard,
  hook and approve/adopt pair are gone (replaced by human-only `rebaseline_uat`). The verdict records
  `failure: infrastructure|build`; the `uat` stage has a manual `retry` for infrastructure and `replan`
  only for client failures. Item 26's engine half (a cycle override not clearing its gate) is upstream
  `@swamp/software-factory` and still open.

- **Features shipped piecemeal through `staging` (item 27).** Every PR merged straight into the release
  train. Fixed: stacks. `start_stacked` creates `stack/<name>` in a workmux worktree; the plan and its
  approved `## PRs` list live in `tasks/<name>/spec.md`; member work items branch from and PR into it; `sync_stack` merges staging in; `finish_stacked` opens one PR into `staging`
  after UAT on the stack tip.

- **Interactive plan stage couldn't run goldfish Stage A (item 21).** The skill asks for fresh subagents
  ("Pi: `task`"), which interactive Pi doesn't have, so Pi refused. Fixed without a Pi extension:
  `colonia-task-runner reviews` has a `concept` phase that runs the six Stage A lenses as fresh read-only Pi
  processes with only the confirmed hypothesis, and the standard lane's plan prompt calls it.

- **Sync left the board down when the old server ignored SIGTERM (2026-11-23).** Syncing onto a new
  factory commit sent SIGTERM to the board (`mastra/dist/index.js dev`, up 19 h). It stopped answering on
  4111 but never exited, so after the 30 s wait the new `mastra dev` refused to start ("another development
  server instance is already running"), and the board showed no connection. No step was running. Fixed:
  `sync-in-vm.sh` sends SIGKILL to a server still alive after the wait.

## Open issues (rough priority)

### Trust and safety
1. **No real trust boundary.** Pi's tool guard isn't an OS sandbox, the agent's user has Docker
   (root-equivalent), `specs/` is writable, and Git hooks can be bypassed (`--no-verify`) and are only
   installed in this clone. The per-run baseline check is the real safeguard. Proper fix: run agents as a
   separate Unix user or in a container without Docker, with specs in a read-only location.
2. **Inconsistent integration-file classification.** `postMessage.ts` and `partners/common.ts`
   needed content-bound approval, but `server/api/mieten/[id]/anfrage.post.ts`, a customer-facing
   lead route, didn't. Review the classifier: lead/customer routes should count as customer-data.
3. **Local branch sanity.** `client/staging` was found with `main` checked out. Workmux and the
   factory assume it's on `staging`. The controller should refuse to start when it isn't.

### Human load (the real bottleneck)
4. **Approval fatigue.** The Slack task needed about 8 human approvals (plan ×2, fingerprints ×4,
   outcome ×2), each relayed by screenshot. Ideas: approve content-bound files once at outcome
   unless high-risk; show one consolidated diff per gate; let small re-formatting or rework
   revisions inherit approval when a reviewer confirms the logic is unchanged.
5. **Gate prompts lack the diff.** Approving well meant opening the worktree by hand. Each gate
   should show the full `git diff staging` for the change, not a summary.
6. **Nothing tracks lead time.** The talk's headline metric (issue → shipped) isn't measured. Consider the
   `swamp-software-factory-flow-metrics` extension.

### Planning and review quality
7. **Plan review adds scope.** It folded in an unrelated feature (Slack top-level `text`). The rule
   "only critical findings that block the stated outcome go into the plan; others become follow-ups"
   was proposed but **not yet applied** to the definitions.
8. **Task descriptions aren't checked.** The Slack task wrongly claimed "every caller already
   catches Slack errors". Plan stage should verify factual claims in the task (trace callers)
   before implementing, rather than finding out at UAT.
9. **Review doesn't check repo conventions.** Two misses: a Nitro route function exported only for
   tests (`sendOfferInterestToSlack`; CLAUDE.md prefers extracting to utils), and a component test
   asserting child props rather than DOM (CLAUDE.md: drive through the DOM). Load `CLAUDE.md`
   testing rules and `write-tests` into the coder and reviewers.
10. **Hand-built branches arrive without tests.** The test stage only runs *changed* tests, so a
    takeover with no test passes trivially. Takeover should require a test or explicitly add one.
10a. **Review results vary between runs on identical content (`fix-meta-dns-leads`, 2026-10-24).** The
    first review passed `512f0e9`. After the UAT infra replan, a re-review of the same SHA found
    CODE-2 (high): `validateDNS` fails open on every non-missing-record error, so all callers fail
    open and the Meta-only `allowDnsFailure` flag has no effect. A single review pass isn't a reliable
    gate. Consider running reviewers more than once, or adding a targeted "trace every caller of a changed
    shared function" check.

### UAT coverage
11. **Missing journeys:** desktop header/navigation (the nav task had no UAT signal; checked
    visually on the Vercel preview instead), leasing and sale inquiries, partner opt-in on the
    rental inquiry (deferred: offline seed support unverified).
12. **Accessibility is 92 on every gated page.** Likely one shared layout/navigation problem. Fix it,
    then raise `lighthouse-baseline.json`.
13. **Slack on portal/internal paths** (e.g. `#finance` in
    `server/api/portal/company_offer_templates/[id].put.ts`) still rethrows. Follow-up from #1371.
14. **Dev seeds are now part of UAT.** UAT reuses `supabase/staging/supabase/seeds/*`. Changing dev
    seeds (e.g. removing images from the LKW offer) can break UAT. Keep that in mind, or split
    the data if it becomes a nuisance.

### Throughput
15. **UAT is serial and takes about 5 min.** Fixed ports allow one run at a time. Fine now, but a
    bottleneck once several tasks run in parallel (allocate ports per run).
16. **Several harnesses still exist.** `agent-task.mjs`, Pi `/run-slices`, and the Claude/OpenCode
    `run-*.sh` scripts all still exist with drifted prompts. Decide on retirement criteria (e.g. N
    clean factory runs), then delete them.
17. **Standard lane is unproven.** Only the fast lane and takeover have run. Run the standard lane
    (adversarial plan review, six reviewers) on a real feature.

### Feature level
20. **No feature level: one work item is one PR.** A multi-PR feature (qualification-v2) was planned
    and split by hand in a chat session, then each PR is started as its own work item. Wanted: a
    `start_feature` that plans interactively, writes the spec and an ordered PR list for human
    approval, starts PR1, and starts each next PR from fresh staging after the human merges the
    previous one; human-only steps (migrations, shadow periods) appear as waiting steps. Must not
    repeat `/run-slices`: no shared branch across PRs. Build after qualification-v2 PR1 has run.

22. **Plan review churns on non-blocking findings (`qualification-v2-formula`, 2026-11-02).** Five review
    rounds and four cycle overrides for a pure-code PR. Causes: (a) reviewers run in the client worktree
    and couldn't see `factory/tasks/...`, wasting round 1; pass the spec and reference as part of `subject`.
    (b) `change-impact` is in the plan set and reports "no implementation" as a blocker; drop it from plan
    review. (c) Every round labels something "critical"; Pi folded an architect suggestion (validating
    points against the checks) into the plan, which beat the spec and produced the next blocker (PLAN-6).
    Fix: plan review judges blockers against the spec's stated outcome, and a finding that adds scope
    beyond the spec is a follow-up by rule, not a revision. (d) Each revision costs two human overrides
    (`plan` + `plan-review`); consider letting the human approve the plan with recorded open findings.

23. **A reviewed change is never committed, so it can't be restored.** `generalize-lead-qualification`
    (2026-11-02): the change artifact holds only a fingerprint of the uncommitted worktree. When the
    worktree changed after review, there was no reviewed version to diff against or roll back to, only
    "accept everything or undo by hand". Fix: have `record_change` (or `inspect`) commit the change to
    the task branch as a local WIP commit, never pushed, and record its SHA next to the fingerprint.
    Later drift is then a plain `git diff <sha>`, and rollback is `git reset --hard <sha>`.

24. **Nothing stops edits to a task worktree while it waits for a human gate.** Same run: an interactive Pi
    session (from `wx open`) edited four files between code review and outcome approval, adding about 190
    unreviewed lines. The factory only noticed when the fingerprint no longer matched at the rebase step,
    and it couldn't say who made the edits. Fix: at every human gate (`plan-signoff`, `outcome-signoff`),
    the controller re-checks the fingerprint before accepting the approval and names the changed files.
    `WORKFLOW.md` should say that `wx open` on a factory worktree is for reading only; if you edit there,
    tell the factory so it re-records the change.

25. **No route for PR-review fixes after the draft PR (`qualification-v2-formula`, PR #1392, 2026-11-03).**
    The run ends at the draft PR, and rework only happens for factory review or UAT findings. A finding from
    the human PR review (one check ordered wrongly, plus a regression test) had no path: Pi asked for a new
    work item, but `start_work_item` branches from staging, which lacks the unmerged PR code, and
    `adopt_work_item` creates a new `factory/<id>` branch and a second PR. The fix was done hands-on on
    the PR branch instead. Fix: a `rework_pr` step (or reopening a terminal run) that applies a small fix
    to the existing task branch, reruns tests and code review, takes a fresh outcome approval, reruns UAT
    only if the diff touches runtime paths, and pushes to the same PR.

26. **A cycle override doesn't clear the gate it was granted for (`guenther-qualification`, 2026-11-05).**
    After `cycle-override:plan` the run stayed blocked at `plan-review`. This is engine behaviour in
    upstream `@swamp/software-factory`; report it there. The rest of item 26 (stale active runs blocking
    UAT commits, infrastructure failures forcing a recovery route) is fixed; see above.

28. **Editing the controller while a run is active stalls the run (2026-11-06).** Mid-edit, `agent_task.ts`
    imported functions already removed from `uat_integrity.ts`; PR3's driver saw a rebundle failure and a
    cached bundle, and correctly stopped. Rule: change the factory in a separate worktree and merge to `main`
    only when no run is between controller calls.

27. **Stacked work, follow-ups.** Built: `start_stacked`, `start_work_item --input stack`, `sync_stack`,
    `finish_stacked` (WORKFLOW.md route 4). Not yet: adopting a hand-built branch into a stack, and item 20's
    automatic sequencing (plan the PR list, start each next member after the previous merges).

29. **Trial: the coder lints and typechecks its own work (mastra lane, 2026-11-19). Review after a few runs.**
    Hunch from Swamp: runs kept cycling because lint and type errors only surfaced in the gates, one round
    each, and lint errors then type errors cost two. Changed: the coder has a `check` tool
    (`scripts/factory-pi.mjs`: eslint `--fix` and prettier on changed files, then `pnpm typecheck` under the
    heavy lock) and is told to run it after every step until it passes. `runGates` now runs lint and
    typecheck both and returns their failures together, before any test.
    Review in `history.md`: are there still rounds "failed at lint/typecheck"? How long are coder steps now
    (each typecheck is 1–2 min, maybe several per step, and waits while a UAT build holds the lock)? If
    steps got slow without fewer rounds, run `check` only in the final whole-plan call instead of per step.
    Not tried before commit: `check` against a real worktree (only registration in Pi 1.5.2 was verified).
    First real run (#1450, 2026-11-20): `check` ran and passed, but the coder still wrote nothing; see 30.

30. **The coder gives up on big unfinished steps (#1450 correction core, 2026-11-19/20).** Round 1 left plan
    steps 3, 6 and 7 unfinished (only one of four rechecks; 6 and 7 refused without 3). Later rounds were
    only the whole-plan call, which faced all of it at once; `gpt-6.1-terra` did a small slice or nothing and
    said "Incomplete" or "Blocked". Eleven rounds (two cycle limits, about 17 hours) of passing checks and
    7–9 blocking findings on code that was never finished.
    - **Built (review after a few runs):** the whole-plan call ends with `Unfinished steps: …`, and each step
      it names gets its own coder call in the same round (`rerun` in the lane state, restart-safe). Review in
      `history.md`: do "step N of M again" entries finish those steps, or does the coder still stop?
    - **Not built: coder model.** `f72b734` moved the coder to `gpt-6.1-terra` to spare the Codex limit. If
      the re-runs don't help, try `FACTORY_MODEL_CODER=gpt-6.2-sol` (server-wide: restart the server with it)
      and compare. A per-run model override would avoid touching other runs.
    - **Not built: stop instead of looping.** A coder that says "Incomplete" while checks pass still went to
      review every round. Consider suspending for a human when the coder reports unfinished steps that its
      own re-run calls didn't finish.

31. **Feedback rounds churn on one big route spec (#1451 call results, 2026-11-20).** Twelve rounds (two
    cycle limits, 13:41–18:14). Nearly every check failure was in `tests/server/api/v1/levy/call-result.post.spec.ts`
    (2,039 lines), whose assertions pin behaviour the plan replaced (`verdict=` notes, held-type 409s, address
    recheck calls). Failures only fell (17 → 2 → 5 → 1) after a human retry note said to sort each one into
    stale test or code bug. Round 6 passed checks, but the review's one blocking finding hit the cycle limit.
    - **Feed every failure, not the tail.** "Asked to fix" is the end of the test output, so with 17 failures
      the coder saw a few and fixed those. Send the full list of `FAIL` lines (file > test name + first
      assertion line) and point to the round's section of `checks.log` for detail.
    - **Don't re-run finished steps in feedback rounds.** Answers item 30's review question: in #1451 every
      feedback round ran "step 1–5 of 5 again" after the fix call, and most replied "already done, no
      changes" at 1–10 min each, about half of each round. Re-run only steps the whole-plan call names as
      unfinished; check that `Unfinished steps:` isn't listing everything by default.
    - **A retry must clear the stop.** "Stopped after 6 rounds" was logged at 15:55, two minutes into the
      retried run, while steps 3–5 carried on. The old stop event fired late or wasn't cleared by Retry.
    - **Plan for stale assertions.** When a plan changes behaviour an existing route spec pins, the planner
      should add an early step that lists the assertions it makes stale and updates them, so the coder
      doesn't have to guess stale test vs code bug from failures.

32. **The test gate couldn't run `tests/e2e` files (#1467 blog pagination, 2026-11-20).** The plan put its
    crawl test in `tests/e2e/blog-pagination.spec.ts`. "Changed tests" ran `pnpm test <file>`, but the client's
    `vitest.config.ts` doesn't include `tests/e2e/`. Only `pnpm test:ssr` (`vitest.ssr.config.ts`) does, so
    every round failed with "No test files found". The code was finished in round 1. The coder correctly said
    the runner was the problem and wouldn't widen the default suite (a production build in every `pnpm test`).
    It then looped with no changes, partly because "Asked to fix" showed the `nuxi prepare` preamble instead
    of the error (see 31).
    - **Fixed (uncommitted):** `runGates` sends changed `tests/e2e/**` files to a "changed SSR tests" gate
      (`pnpm test:ssr <files>`, under the heavy lock and the 40-min gate timeout).
    - **Watch:** SSR tests build Nuxt for production (8–12 GB). The gate runs them offline with the test
      Supabase env, so a test that needs real Supabase (like `app-schema-org.spec.ts`) fails there whenever
      it changes.
    - **Not built:** a coder that reports a runner or gate problem and changes nothing should stop for a
      human, not loop back into another round.

33. **A run stuck on a stale UAT journey could not be moved onto the fixed one (#1444, 2026-11-23).** The
    6/8 rental-search PR made old `/search/lkw` links redirect to `/search?category=lkw`; the LKW journey
    still expected `/search/lkw`. The journey was fixed (`b84f9e9`) and synced, but the run keeps the UAT
    inputs it started with. A journey failure goes back to Plan, and only the coder's cycle-limit retry
    honoured `--baseline`, so every round failed UAT on the old journey and returned to Plan.
    - **Fixed:** approving a plan or an outcome takes `baseline` too (`fx approve <issue> --baseline SHA`).
      At either approval the board shows "… on the latest UAT journeys" when the factory's UAT inputs
      changed since the run's baseline, naming the changed files. Still forward only.

34. **`factory-ui sync` and the watchdog started the M1's VM at once (2026-11-23).** Sync stopped the VM and
    started it again; the board stopped answering meanwhile, so `reanimate.sh` started it too. The watchdog's
    proxy took the port first and sync failed ("proxy couldn't start", exit 36). The watchdog's start won and
    synced, so no harm, just a confusing error.
    - **Fixed:** `vm/vm-lock.sh`, one VM starter at a time. `factory-ui`, `wx-start` and `fx-new` wait while the
      watchdog holds it; the watchdog skips a minute while `factory-ui` does. A dead holder's lock is taken over.
    - **Open:** why that sync stopped a running VM at all. `devvm adopt --force` is the likely step (its output
      is hidden).

35. **A "changed nothing" card could only be proceeded from a shell that didn't have `fx` (#1484, 2026-11-24).**
    The coder had finished every step but kept being asked again; the card said `fx retry <issue> --proceed`,
    but `fx` is only a `mastra` package script, so in the VM it was "not found", and the board had only Retry.
    The plan also made a step wait on an owner's SQL artefacts (G1), so the coder refused to move twice.
    - **Fixed:** a "Proceed to the checks as it is" button on no-change cards (`action: proceed`), and an `fx`
      alias in the VM (`vm/bashrc-colonia.sh`).
    - **Rule:** factory issues and plans hold coding work only; no owner gates, schema artefacts or ops steps.

## How to use this file

"Open issues" here means the factory's own backlog (process defects and gaps), not GitHub issues.

- New surprise → add it under **Open issues** with what happened and a suggested fix.
- When fixed → move it to **Fixed in the factory** with the commit hash.
- Review it every few tasks; the open list is the factory's backlog.
