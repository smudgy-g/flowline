# Running a work item

**Where it runs:** on a worker host with Docker Sandboxes. Each work item gets its own sandbox microVM, so agent-written code never executes on the worker or your machine. Tunnel the board (`ssh -L 4111:127.0.0.1:4111 <worker>`) and watch it from Linux, macOS or Windows.

1. In the target repo create a **Factory task** issue with a concrete outcome and acceptance criteria. Describe the outcome, not the implementation. Choose **fast lane** or **standard**; standard adds plan reviewers (edge cases, missing steps, decisions left to the coder, wrong claims about the code) and more code reviewers. Use **Factory stack** when the work should ship as several PRs; list the members in order and mark manual ones `(by hand)`.
2. Start the issue from the board. The factory creates a task worktree from the configured base branch and its sandbox, then runs `commands.setup` inside it. The planner proposes a plan; you approve it, send it back, or split it into PRs. A stack starts with a design you approve.
3. The agents implement and review the approved scope. `commands.autofix`, `check` and `gates` run in the sandbox; failures and blocking findings go back to the coder, at most six rounds before it asks you. Open the card for the diff, logs, sensitive files and review findings, then approve the outcome or send it back.
4. The factory pushes the approved commit, runs the pinned acceptance adapter in a fresh network-less sandbox, and opens a draft PR. A failed verdict goes back through the lane; an infrastructure failure waits for a fix and Retry. You merge on GitHub, then **Clean up** removes the worktree, branch and sandbox and closes the issue. **Abandon** does the same for work you give up on.

Each card shows its sandbox state (running, stopped, missing). An error wait offers **Recreate sandbox**, which rebuilds the sandbox and reruns setup without touching the worktree; orphaned `fx-*` sandboxes are pruned at startup.

## Rules worth knowing

- **Factory worktrees have no `.env`.** The factory refuses to run with one present. To look at a running app, use `scripts/preview.sh <work item>` on the worker.
- **Each acceptance run gets its own sandbox,** created with no network; its ports are private to that microVM.
- **Acceptance inputs are human-owned and pinned per work item,** read from the factory commit recorded when the item started. Commit adapter changes whenever you like; running items keep what they started with. `fx approve <issue> --baseline <sha>` moves an item forward onto newer inputs.
- **A sandbox can write anything in its worktree.** The worker's git calls use the checkout's private registration with hooks and fsmonitor off, and factory records live outside the mount, so a planted `.git` or hook never runs on the host.
- The CLI uses the same database: `pnpm --dir mastra fx start NUMBER`, `fx status NUMBER`. Don't drive the same step from both the CLI and the board, and update the factory checkout only between steps.
