---
name: change-impact
description: Trace the downstream impact of a completed diff during cold review. Use for cross-module changes or changes to public APIs, auth, data/schema, migrations, or deployment; skip routine local edits.
---

# Change Impact Review

Review read-only. Compare the diff against the correct base, the spec, and repository evidence. Do not read implementation summaries, decisions, test reports, or chat history when acting as the cold Reviewer. Report findings in the existing review report; do not create another artefact.

1. Trace changed entry points to real callers and consumers using imports, routes, schemas, or searches. Mark unverified consumers as unknown, not defects.
2. Check whether changed contracts, data, permissions, migrations, and deployment order remain compatible; inspect rollback or recovery only where the change requires it.
3. Match affected behavior to existing tests and identify concrete missing regression evidence. Compare the actual diff to the spec for omissions and unrelated scope.
4. Report only actionable findings with `file:line`, a realistic failure path, impact, and the smallest fix. Use the Reviewer's severity scale. Do not demand an end-to-end test or additional layer unless this change needs it.

Adapted from ECC's change-impact workflow for this project's cold Reviewer role.
