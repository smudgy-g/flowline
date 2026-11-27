# Running a work item

**Where it runs:** on a machine with Docker Sandboxes, in the repository you ran `flowline setup` in. Each work item gets its own sandbox microVM, so agent-written code never executes on your host. For a remote machine, tunnel the board (`ssh -L 4111:127.0.0.1:4111 <host>`) and watch it from Linux, macOS or Windows.

1. Create a work item with a concrete outcome and acceptance criteria — a Markdown file under `.factory/items/` with the local tracker, an issue with the GitHub one — or **New item** on the board, which asks the tracker whichever it is. Describe the outcome, not the implementation. Choose **fast lane** or **standard**; standard adds plan reviewers (edge cases, missing steps, decisions left to the coder, wrong claims about the code) and more code reviewers. Mark it a stack (a `### PRs in order` section) when the work should ship as several changes; list the members in order and mark manual ones `(by hand)`.
2. Start it from the board. The factory creates a task worktree from the configured base branch and its sandbox, then runs `commands.setup` inside it. The planner proposes a plan; you approve it, send it back, or split it into several changes. A stack starts with a design you approve.
3. The agents implement and review the approved scope. `commands.autofix`, `check` and `gates` run in the sandbox; failures and blocking findings go back to the coder, at most six rounds before it asks you. Open the card for the diff, logs, sensitive files and review findings, then approve the outcome or send it back.
4. The factory commits the approved change, runs the pinned acceptance adapter in a fresh network-less sandbox, and hands the result to the tracker: a draft PR on GitHub, or a delivery note and branch locally. A failed verdict goes back through the lane; an infrastructure failure waits for a fix and Retry. You merge, then **Clean up** removes the worktree, branch and sandbox and closes the item. **Abandon** does the same for work you give up on.

Each card shows its sandbox state (running, stopped, missing). An error wait offers **Recreate sandbox**, which rebuilds the sandbox and reruns setup without touching the worktree; orphaned `fx-*` sandboxes are pruned at startup.

## Rules worth knowing

- **Factory worktrees have no `.env`.** The factory refuses to run with one present. To look at a running app, use `scripts/preview.sh <work item>`.
- **Each acceptance run gets its own sandbox,** created with no network; its ports are private to that microVM.
- **Acceptance inputs are pinned to your base branch,** at the commit recorded when the item started: a task branch can edit `.factory/acceptance/` in its worktree and change nothing about how it is judged. Commit adapter changes whenever you like; running items keep what they started with, and `flowline approve|retry <item> --baseline <sha>` moves one forward onto newer inputs.
- **A sandbox can write anything in its worktree.** The host's git calls use the checkout's private registration with hooks and fsmonitor off, and factory records live outside the mount, so a planted `.git` or hook never runs on the host.
- The CLI uses the same database: `flowline start <item>`, `flowline status <item>`. Don't drive the same step from both the CLI and the board, and upgrade the factory only between steps.
