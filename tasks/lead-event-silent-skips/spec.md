# Lead events that are skipped without a report

Raised from the `generalize-lead-qualification` code review (REV-8, REV-11), 2026-11-02. Fast-lane sized.

## What is true today (origin/staging `951c668bd`)

`recordLeadEvent` (`server/utils/billing/recordLeadEvent.ts`) never throws. It has returned a `RecordLeadEventResult` since before #1390, and it reports most failures itself:

- no active contract → `reportMissingLeadContract`
- pricing block → `reportPricingBlock`, returns `pricing_failed`
- unexpected error → `logBillingJobError` (Sentry), returns `internal_error`

Callers that delivered a lead to the supplier and then record it ignore the returned result:

- `server/api/leasing/[id]/anfrage.post.ts`, `server/api/sale/[id]/anfrage.post.ts`
- `server/api/mieten/[id]/anfrage.post.ts` (fire-and-forget)
- `server/api/v1/leads/[id]/send.post.ts` via `executeQualifiedLeadHandoff` (`record`/`reportRecordingError`)
- `server/utils/meta/autoForwardMetaLead.ts` via the same helper
- Levy: `server/utils/levyImmediateHandoff.ts`, `server/api/v1/levy/leads/[domain]/[id]/call-result.post.ts`

Their surrounding `try/catch` and `reportRecordingError` hooks never fire, because nothing is thrown.

Only `server/api/v1/billing/leads/events/web-form.post.ts` reads the result (503 on `internal_error`/`pricing_failed`).

## The gap

Four outcomes leave a delivered lead unrecorded with no report anywhere:

- `source_not_found`
- `not_submitted`
- `capability_mismatch`
- `no_lead_gen_contract` (the supplier has active contracts, but none is lead-gen)

After a successful supplier delivery, each one is either expected (no per-lead billing for that supplier) or a defect that should be noticed.

## Outcome

1. Decide, with the human, which of the four reasons are expected after a delivery. `no_lead_gen_contract` is likely expected (subscription suppliers); `not_submitted` after a handoff that just stamped `submitted` is not.
2. Report the unexpected ones once, in `recordLeadEvent` itself, not in each caller. Use the existing billing job error log or Slack path, whichever the billing context doc prescribes.
3. Remove the dead `try/catch` around `recordLeadEvent` in callers only if that is a pure deletion. Otherwise leave them.
4. One business-logic spec: a delivered lead whose recording returns an unexpected reason produces exactly one report; an expected reason produces none.

## Not in this task

- Pricing, budgets, voiding, partner distributions.
- Changing what is billed.
- Retrying or backfilling previously skipped events.
- Levy and Günther qualification. Their callers only change through the shared function.

## Read first

`docs/context/billing.md`, #1379 / #1389 / #1390, `server/utils/billing/recordLeadEvent.ts`.
