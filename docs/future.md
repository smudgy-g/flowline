# Future improvements

Ideas, not supported features or a delivery schedule. Flowline currently uses **Pi** for agents and supports **local files or GitHub Issues** for work items.

- **Simpler Pi installation:** load Pi from a standard installation instead of requiring the managed-install symlink and `current-version` file. Keep the current tool restrictions and credential isolation.
- **Other agent harnesses (such as OpenCode):** explore only after defining how a harness would preserve Flowline's role permissions, tool restrictions and sandbox boundaries. Pi remains the supported default.
- **Linear and Jira trackers:** add adapters for issues/tickets and delivery once their claim, status and completion behavior is mapped to the [tracker contract](tracker.md). Until then, projects can supply their own tracker adapter.
