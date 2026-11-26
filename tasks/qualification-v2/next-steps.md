# Qualification v2: next steps

Living checklist for `spec.md`. Update it as each step lands.

## Done

- PR1 `qualification-v2-formula`: merged (PR #1392, 2026-11-03), including the PR-review fix for the mismatch-before-missing-company order.
- PR2 `qualification-v2-shadow-capture`: merged to staging (PR #1393, `af53ad254`, 2026-11-04). Hands-on fixes after outcome approval: declared legal form (leasing/sale `legal_form`, request-quote `company_legal_type`, GmbH & Co. KG in the name suffix), registry official name for legal form, website probe headers only and IPv4 `BlockList`, Meta urgency presence from submit, corrected addresses keep confirmed components, Meta numberless addresses reach the provider for the street-level exception, Allane requires a house number, website business-only offers pass `businessOnlyForm`.

## Now: shadow period

- [x] PR2 live in production 2026-11-05 (client `main` at `647f0ddca`, Supabase migrations pushed). Shadow period runs to 2026-11-19; shadow review due then.
- [ ] Meanwhile PR4 (supplier breakdown) and PR5 (supplier feedback) can start: they depend on PR2 only. PR3 waits for the shadow review.

## Next

- [ ] Shadow review, due 2026-11-19. Count v2 bands (≥70 / 30–69 / <30) and failed-check leads by customer type and channel; compare with the old score. Decide weights/thresholds for PR3, PR7's size, and whether website leads should be routed by score.
  - Also count rental business leads at 65–69 with no legal-form points. Rental doesn't ask `legal_form` (`company_offer_orders` has no column). If many sit there, add `legal_form` to rental via the ADR-0047 identity-columns PR, not qualification. First check whether the Meta rental forms already ask it: `mapMetaFields.ts` maps it, `rentingLead.ts` drops it.
  - Also count business leads with no house number whose registry or directory match returned an address with one (`address` / `legalAddress` on `CompanyValidationResult`). Sizes the house-number lookup below (supplier feedback: numberless leads fail today; that is the old auto-forward rule, which PR3 replaces).
- [ ] PR3 Meta routing + hard gates + `send.post.ts` refusal + derived evidence state for the Retool queue.
- [ ] Stack `qualification-v2` (PR4 + PR5 ship together): PR4 #1398 retargeted to `stack/qualification-v2`; merge it there.
- [ ] PR5 supplier feedback with the pitch's reason lists, as a stack member (`--input stack=qualification-v2`, after `sync_stack`).
- [ ] Ship the stack: `sync_stack`, UAT on `stack/qualification-v2`, `finish_stacked`, merge into staging.
- [ ] PR6 human confirmation calls + `supplier_note`. Human migration first. Must widen `customerConfirmation: z.literal(0)` in `shared/schemas/qualification.ts` to 0/15 business, 0/20 private.
- [ ] PR7 corrections and rechecks. Human migration first.
  - Suggested correction: house number from the matched registry/directory address, with source and time; keep the original captured address and rerun the address check. Confirm before applying: the matched address may be a head office, not the vehicle site. The AI-agent pitch uses the same lookup before asking in the call.

## Human-only before each PR

- Migrations go in `supabase/staging`, then types are regenerated on a branch off current staging, before the factory work item starts (PR6, PR7).
- Each PR is one factory work item, started after the previous PR merges. Point Pi at the PR's section of `spec.md`.

## Factory fixes after qualification (FEEDBACK.md)

- 20: feature level (one command plans and sequences PRs).
- 21: goldfish Stage A through the controller's `reviews`.
- 22: plan-review churn (reviewers can't see factory paths, `change-impact` in plan set, scope creep from findings, two overrides per revision).
