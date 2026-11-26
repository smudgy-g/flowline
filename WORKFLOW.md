# Running a work item

1. In the target repo create a **Factory task** issue with a concrete outcome and acceptance criteria. Choose **fast lane** or **standard**; standard adds plan and code reviewers. Use **Factory stack** instead when the work should ship as several PRs; list the members in order and mark manual members `(by hand)`.
2. Start the issue from the board. The factory creates a task worktree from the configured base branch. The planner proposes a plan; a human approves it or sends it back. A stack starts with a design decision and then works through its members.
3. The agents implement and review the approved scope. The configured project gates must pass. On the board open the card to inspect changes, logs and review findings. Resolve questions and approve the outcome only when satisfied.
4. The factory pushes the approved commit, runs the pinned acceptance adapter and opens a draft PR. A failed acceptance test sends feedback back through the lane; infrastructure failures wait for repair and retry. Review and merge on GitHub. Cleanup removes the task worktree, not the remote PR.

The CLI uses the same database: `pnpm --dir mastra fx start NUMBER` and `pnpm --dir mastra fx status NUMBER`. Don't drive the same step from both the CLI and the board. Keep one factory checkout per project and update its code only between steps.
