# Qualification v2

Implements `pitch.md` (copied from the archived branch, 2026-10-26); "Departures from the pitch" lists every deliberate difference. Replaces the 334-line planning spec on `refactor-qualification-signals`. That branch is archived, not merged; files listed under "Reuse" are carried into the PRs below.

`reference/` is a frozen copy of the reusable files from that branch (HEAD `89740e2` plus its uncommitted changes, 2026-11-02), at their client-repo paths. Port from it; do not copy it wholesale: it still contains evidence-state, correction and recheck code that is out of scope.

## Outcome

1. Each qualification signal is written to its own column.
2. A new 0–100 score (formula v2) replaces the old one, with the points stored per signal.
3. Leads route by score and hard gates: ≥70 with no failed check is sent automatically; everything else is held for the team, who may send a held lead unless a check failed. Nothing is rejected automatically.
4. Suppliers see the plain-language signals breakdown on their leads, never the score.
5. Suppliers give won/lost/open feedback per lead.

## Not in this feature

- Billing. Nothing about invoicing changes.
- Levy, Günther and every supplier in `MANUAL_QUALIFICATION_COMPANY_IDS` (`server/utils/manualQualification.ts`). Their leads keep their own flow; they are scored and get check columns, but routing below does not apply.
- `orders` (request-quote). Scored and checked, never routed by score.
- The AI agent and `call_notes`. Human confirmation calls and `supplier_note` come in PR6; until then nothing writes `customer_confirmation_check`.
- Staff corrections and rechecks before PR7. Until then checks run once at capture.
- Score-based routing for website leads. Website leads get checks and the v2 score in shadow; their delivery stays as today.
- Rescoring or rerouting leads captured before v2.

## Schema (PR0, hand-applied)

On `orders`, `company_offer_orders`, `leasing_offer_leads`, `sale_offer_leads`, nullable JSONB:
`email_check`, `phone_check`, `address_check`, `offer_eligibility_check`, `business_check`, `customer_confirmation_check`, `qualification_score_breakdown` (must contain `"version": 2`).

New table `supplier_lead_feedback` with supplier RLS (unchanged from the applied migration).

Dropped from the applied migration: `qualification_corrections`, `qualification_evidence_state`, `supplier_note`, `qualification_check_state`, `qualification_check_started_at`, and the attempt-timestamp trigger migration.

`qualification_score` is reused. `qualification_signals` is no longer written for v2 rows; old rows keep theirs.

## Check shape

Every check column holds:

```ts
type Verdict = 'passed' | 'passed_with_limitations' | 'pending' | 'failed'
type Check<T> =
  | { status: 'checked' | 'not_checked' | 'unavailable'; verdict: Verdict; reason: string | null; breakdown?: T }
  | { status: 'not_applicable'; verdict: null; reason: null }
```

Zod schemas in `shared/schemas/qualification.ts`; generated DB types stay `Json`. Parse at the server boundary. Breakdown holds factual evidence only: no raw provider payloads, no customer contact values.

| Check | passed | passed_with_limitations | pending | failed |
| --- | --- | --- | --- | --- |
| Email | MX present and Bouncer deliverable | Bouncer risky | Bouncer unknown, timeout or provider down | No MX or Bouncer undeliverable |
| Phone | Valid, line active or reachable | Valid, line status unknown or not returned | Lookup unavailable, or line `unreachable` | Invalid or inactive |
| Address | Full address verified (or corrected by customer) | Street-level confirmed, house number missing (non-Allane Meta only) | Provider down, or unconfirmed/overridden input | Not used in v2 |
| Offer eligibility | Customer type allowed by the offer | — | Customer type missing, or a non-answer company value (`Keine Angabe`, `Keine Firma`, `N/A`, `None`) | Customer type not allowed (e.g. private on business-only), including a whole-value private company answer (`Privatkunde`, `Privatkunden`, `Privatperson`, `Privat`, `Private`) on a business-only offer |
| Business (business leads only) | Active name-matching registry record, or directory listing matching name and address | — | No positive lookup | Not used in v2 |

Allane Meta leads get no street-level exception: a missing house number stays pending. It never blocks handoff.

`not_applicable`: offer eligibility with no selected offer; business check for private leads. Absence of a lookup match never means fraud.

Private-answer matching is whole-value only: `Privatbrauerei Müller` is not private, and a company answer equal to the contact's name does not fail (sole traders).

The pitch's evidence state (`check_failed`, `core_requirements_unresolved`, `business_unconfirmed`, `checks_satisfied`) is derived from the check columns by a pure function when first needed (Retool queue, PR3). It is never stored.

One bounded Bouncer request after confirmed MX, at submit, for web and Meta. No retries, no background worker.

## Formula v2

Additive points, no deductions. A check that did not run, or found nothing, scores 0 and keeps its real verdict. Separate scales; the call row is reserved for the AI-agent PR, so the maximum today is 85 business / 80 private.

Business: valid phone 10 · email deliverable/risky 10/5 · address full/street-level 10/5 · urgency urgent/concrete/information 10/7/0 · best single business lookup: registry 25, directory name+address 20, name only 12, address only 5 · corporate email domain 10 · reachable website 5 · corporate legal form 5 (registry, matching directory name, company-name suffix GmbH / GmbH & Co. KG / UG / AG / SE / KGaA / eG, or a declared legal form: `Körperschaft` on a leasing/sale form, or GmbH, GmbH & Co. KG, AG or UG on request-quote; `Gewerbetreibend/Freiberufler`, Einzelkaufmann, Andere and no trade registration earn 0. Rental forms don't ask) · (call 15).

Private: valid phone 15 · email deliverable/risky 10/5 · address full/street-level 35/17 · urgency 20/15/0 · (call 20).

`qualification_score_breakdown`: `{ version: 2, customerType, points: { phone, email, address, urgency, businessLookup, corporateDomain, website, corporationLegalForm, customerConfirmation } }` with all keys present (0 where not earned), plus `businessLookupBasis`, `legalFormBasis`, `websiteBasis` when the matching points are non-zero. `qualification_score` = sum of points.

## Routing

Applies to Meta leads on `company_offer_orders`, `leasing_offer_leads`, `sale_offer_leads`, excluding the suppliers listed under "Not in this feature". Website leads are not routed by score (see "Not in this feature").

- **Score ≥70 and no failed check:** sent automatically. Pending (unresolved) evidence does not stop it.
- **Below 70:** held for the team in Retool (existing held/manual path). 30–69 and <30 are queue priority bands only; nothing is rejected automatically.
- **Any failed check (hard gate):** never sent, at any score and by any route. Hard failures: invalid or inactive phone, undeliverable email or absent MX, known offer-type mismatch.
- **Manual send from Retool** sends a held lead below 70 without changing its score or checks, and refuses a lead with a failed check. `server/api/v1/leads/[id]/send.post.ts` must enforce the refusal, not only Retool.

Meta: replace the `> 50` / `>= 47` rule in `server/utils/meta/autoForwardDecision.ts` with the rule above.

Preserve recipient, supplier-specific and one-time-delivery guards (`autoForwardMetaLead.ts` claim pattern). Allane keeps its manual external portal entry.

Website (later decision, not this feature): today rental leads go to the supplier at submit, and leasing/sale leads go unless `held` (`anfrage.post.ts`). Decide from shadow data whether to route them by score.

## PRs

Each merges to staging on its own. Until PR3, no delivery behaviour and no stored score changes.

**Stack (decided 2026-11-06):** PR4 and PR5 are members of the `qualification-v2` stack (`stack/qualification-v2`, WORKFLOW.md route 4) and reach staging together as one supplier release: suppliers get the breakdown and feedback at once. Start PR5 with `--input stack=qualification-v2`. PR3, PR6 and PR7 still merge to staging on their own (PR3 needs new UAT journeys that would fail staging work if they only passed on the stack).

- **PR0 (hand):** trimmed migration pushed, types regenerated, this spec committed.
- **PR1: formula v2 + check derivation (pure).** Zod schemas, check derivation, points, breakdown. Unit tests only. Reuse: `qualificationPoints.ts`, `businessEvidence.ts`, `captureQualificationChecks.ts`, `qualificationAssessment.ts` (trim the evidence-state and recheck parts), their tests.
- **PR2: write checks and v2 breakdown at capture (shadow).** Website (rental, leasing, sale, request-quote) and Meta capture write the check columns and the v2 breakdown. Do not write `customer_confirmation_check` (PR6 owns it). `qualification_score` and `qualification_signals` keep their old values, because today's Meta auto-forward reads `qualification_score`. Bouncer email check. Routing unchanged. Reuse: `bouncerValidation.ts`, `websiteReachability.ts`, address gate changes.
- **Shadow review (no code):** after about two weeks, compare v2 scores against old ones and count leads per band (≥70 / 30–69 / <30), plus leads blocked by a failed check, by customer type and channel. Adjust weights or thresholds before PR3 if the held queue is too large.
- **PR3: switch score and Meta routing together.** `qualification_score` becomes the v2 sum for all channels; stop writing `qualification_signals`; the routing rules above for Meta. `send.post.ts` refuses a lead with a failed check. Derived evidence state for the Retool queue. Highest risk; UAT must cover a held, a sent and a hard-gated Meta lead, and a website inquiry whose delivery is unchanged.
- **PR4: supplier display.** The plain-language signals breakdown in the supplier portal lead slideover. Suppliers never see the score, points, bands, score colours, internal notes, raw reasons or provider payloads. Leads without v2 checks show "Qualification breakdown unavailable". The handoff email links to that lead in the portal, behind normal login; opening it checks the supplier is entitled to the lead. The email itself shows no breakdown.
- **PR5: supplier feedback.** Won / Lost / Still open in the same slideover, under the existing RLS. Won and Lost need one primary reason plus optional free text; Other needs text; Still open needs nothing. Reason lists as in `pitch.md` ("Supplier view and feedback"), including "reason unknown" and a split between supplier-side fulfilment failures and lead-quality issues. Feedback never changes score, checks, routing or billing.
- **PR6: human confirmation calls (needs a migration for `supplier_note`).** One internal API that Retool uses now and the AI agent later. Records `customer_confirmation_check` per `pitch.md`: confirmed person and inquiry passes; a confirmed business inquiry without a lookup match makes `business_check` `passed_with_limitations` (`customer_confirmed`) and earns the call points; nobody reached stays pending and earns nothing; a denial, wrong person or no longer interested fails and blocks handoff. Writes `supplier_note` with source and time; the note never changes checks, score or routing.
- **PR7: corrections and rechecks (needs a migration for `qualification_corrections`).** Allowlisted correction of contact, company, address, customer type or VAT ID with who and when; the original captured identity is kept. Affected checks and score rerun before any new handoff attempt; never send or bill twice. Size it from the shadow review's count of failed-check leads.

PR4 and PR5 depend on PR2 only, so they can run in parallel with PR3. PR6 and PR7 follow PR3.

## Departures from the pitch

- Evidence state is derived, not stored (no column).
- Website leads are scored and checked but not routed by score; the pitch only changes Meta.
- Corrections (PR7) and call recording (PR6) are later PRs inside this feature, not part of the first rollout.
