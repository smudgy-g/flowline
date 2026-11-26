# Qualified inquiries: score leads, show the evidence, protect hard gates

## Problem

We sell “qualified leads.” Suppliers value stronger contact and business signals, so an internal score is useful for ranking and automatic handoff. But points alone cannot say what was actually verified: suppliers and staff also need the individual checks, limitations, and hard failures.

This creates three concrete problems:

- **Private leads cluster at 50%.** Registry, directory, and corporate-domain signals apply to businesses, not private customers. A 50% private lead is not necessarily half as good as a business lead scoring 100%.
- **The score is not calibrated to outcomes.** Its assessment drew on 19 internal notes among 516 leads, not supplier outcomes. We cannot claim that a score band predicts conversion.
- **A number alone hides limitations.** A high-scoring lead may have only a directory name match, not independent confirmation of its business identity. Show factual evidence alongside points.

The new scales distinguish private from business, strong from partial lookup evidence, and declared urgency from verified facts. A score measures weighted signals and supplier preference, **not** a calibrated chance of conversion, customer solvency, or proof that every check passed.

## Appetite

**Medium: two weeks.** Deliver the score, explicit checks, supplier-visible explanation, and feedback flow within this boundary. This is an appetite, not a delivery guarantee: if integration work exceeds it, narrow the rollout rather than weaken hard gates, supplier access control, or one-time handoff.

## Solution

Use **two separate 0–100 point scales**, business and private, with an internal contribution breakdown alongside explicit checks. **≥70 permits automatic handoff today without a call**, including a business with only partial lookup evidence; it never overrides an invalid phone, undeliverable email, known offer-type mismatch, or a recorded negative customer call. Lower bands are 30–69 and <30 for internal prioritisation: they do not auto-send, but a team member can manually approve and hand off a below-70 lead through today's guarded delivery path. Approval does not turn pending checks into passes or override a known hard failure. Do not attach red/yellow/green bands to score: any interface colour should describe the evidence state, not the number. Preserve check results and limitations separately, never claim that points prove business identity. Existing score/`qualification_signals` are historical for older rows; do not backfill or reclassify them. Replace Meta's old business `>50` / private `≥47` gate with the new rule without losing recipient, supplier-specific, and one-time-delivery guards. AI calling remains a separate pitch.

### How this works in practice

Imagine a business inquiry with valid phone, deliverable email, verified address, urgent request, corporate domain, reachable website, a submitted company name with an unambiguous corporate legal suffix, and a directory **name-only** match. It scores **72**: 10 + 10 + 10 + 10 + 10 + 5 + 5 + 12. The directory address did not match, so `business_check` and `qualification_evidence_state: business_unconfirmed` remain honest. Nevertheless **72 ≥70 permits handoff without a call** (unless a hard gate applies). Its delivery `status` becomes `submitted` only when actual handoff succeeds. The supplier sees the name-only limitation, not a claim of registry verification.

A lower-scoring, unsent business inquiry can instead appear in a confirmation-call queue. A team member who reaches the customer can record a customer-confirmed business inquiry with its own limitations, not fabricate a lookup match; an unanswered call establishes nothing. Manual approval can still send a below-70 lead through today's delivery path without changing its checks. Private leads need no business lookup or call today. A genuine correction triggers relevant rechecks before a new handoff attempt; no call waives a hard failure. Allane still requires manual external entry when its own handoff path applies.

Store **one JSONB column per check**—`email_check`, `phone_check`, `address_check`, `offer_eligibility_check`, `business_check`, and `customer_confirmation_check`—plus a separate `qualification_evidence_state` column. Calculate a new score and contribution breakdown from current signals; do not recalculate historical scores or misread historical `qualification_signals` as evidence under this standard. Every applicable check has the same outer shape: `status`, `verdict`, `reason`, and optional `breakdown`. `status` says whether evidence was obtained; `verdict` is the decision for that check, not a provider response; `reason` explains a limitation or non-pass; `breakdown` holds factual evidence. Checks use the same categorical verdicts: `passed`, `passed_with_limitations`, `pending`, or `failed` (`null` if not applicable). A provider outage is pending, not failed; `passed_with_limitations` meets the defined standard but discloses what was not established. For business inquiries, `business_check` is `passed` on a positive registry or directory match, `passed_with_limitations` when the customer confirms their business inquiry by phone without an independent match, `pending` while neither route confirms it, and `failed` if the contact explicitly denies making the inquiry; a denial is not overridden by an earlier lookup match. Registry and directory findings remain separate **facts within its breakdown** (`match`, `no_match`, or unassessed), not competing check verdicts; a completed no-match does not assert that a business is nonexistent. `business_check` is not applicable to private inquiries. `customer_confirmation_check` records a confirmation call and its result, for private and business leads alike: `status` (`not_checked`, `checked`, `not_applicable`), a categorical `verdict`, a `reason`, and a `breakdown` holding at least the caller `source` (`human` now, `ai_agent` once that pitch ships), whether the contact was reached, and what they confirmed. Its verdicts follow the same categorical set as every other check: `passed` when the contact confirms both the person and the inquiry, `passed_with_limitations` when that confirmation also stands in for an absent business lookup, `pending` when nobody was reached, and `failed` for a decisive negative — the contact denies making the inquiry, the number reaches the wrong person, or they state they are no longer interested. The `reason` distinguishes those cases — `customer_denies_inquiry`, `wrong_person`, `no_longer_interested` — and they must not be collapsed into one. **Absence never blocks, but a recorded failure does.** It is written today when a team member confirms a lead by phone; while it is `not_checked`, the only routing it drives is `business_check` for a business inquiry with no positive lookup, and every other lead can qualify with it left `not_checked`. A `failed` verdict blocks handoff for **private and business inquiries alike**: someone who says they never inquired, or no longer wants the vehicle, is not a qualified lead whatever the provider checks established. Create the column now so manual qualification and the later AI agent write the same shape without rework, and so an unwritten value never silently reads as a failure. A call does not by itself turn an invalid email, address, or offer fit into a pass; corrections go through the update-and-recheck path. Preserve the original captured customer identity snapshot; the technical representation of corrected qualification inputs must not silently rewrite that snapshot. Separately from the checks, a lead may carry a short **`supplier_note`** — customer-stated context such as wanting a different vehicle or a preferred callback time — with its own provenance (source, whether a human or the later AI agent wrote it, and when). It lives outside the check columns because it is human-authored text written for the supplier, must survive re-derivation when checks rerun, and will not always come from a call. `offer_eligibility_check` has `status: not_applicable` and `verdict: null` when there is no selected offer. Urgency already has its own lead column, so derive its required passed/pending decision from that value rather than copying the answer into another JSONB column.

For example, a business non-Allane Meta inquiry with a directory match may have these column values (shown together for readability; each `_check` is its **own JSONB column**, and `urgency` and `qualification_evidence_state` are separate columns; score is calculated separately):

```json
{
  "email_check": {
    "status": "checked",
    "verdict": "passed_with_limitations",
    "reason": "risky_mailbox",
    "breakdown": { "mxStatus": "present", "deliveryVerdict": "risky", "deliveryStatus": "completed" }
  },
  "phone_check": {
    "status": "checked",
    "verdict": "passed_with_limitations",
    "reason": "line_status_not_returned",
    "breakdown": { "valid": true, "lineStatus": null, "lookupStatus": "completed" }
  },
  "address_check": {
    "status": "checked",
    "verdict": "passed_with_limitations",
    "reason": "street_level_exception",
    "breakdown": {
      "level": "street_level",
      "route": "confirmed",
      "postal_code": "confirmed",
      "locality": "confirmed",
      "street_number": "missing"
    }
  },
  "offer_eligibility_check": { "status": "checked", "verdict": "passed" },
  "business_check": {
    "status": "checked",
    "verdict": "passed",
    "reason": "directory_match",
    "breakdown": {
      "registry": { "status": "not_checked", "result": null, "reason": "no_identifier" },
      "directory": { "status": "checked", "result": "match", "nameMatched": true, "addressMatched": true, "operational": true }
    }
  },
  "urgency": "information",
  "qualification_evidence_state": "checks_satisfied"
}
```

Here `risky` email, valid phone without confirmed line status, and street-level address retain their limitations; the street-level exception applies only to non-Allane Meta inquiries. A directory match adds evidence and points, but handoff follows the ≥70 threshold or below-70 manual approval, plus hard gates—not this state alone. It does not establish who submitted the form. Without a lookup match, the business check remains pending even if score permits handoff:

```json
{
  "business_check": {
    "status": "checked",
    "verdict": "pending",
    "reason": "customer_confirmation_needed",
    "breakdown": {
      "registry": { "status": "checked", "result": "no_match", "reason": "no_record" },
      "directory": { "status": "checked", "result": "no_match", "reason": "no_listing" }
    }
  },
  "qualification_evidence_state": "business_unconfirmed"
}
```

A completed confirming call changes the business result without rewriting either lookup:

```json
{
  "business_check": {
    "status": "checked",
    "verdict": "passed_with_limitations",
    "reason": "customer_confirmed",
    "breakdown": {
      "registry": { "status": "checked", "result": "no_match", "reason": "no_record" },
      "directory": { "status": "checked", "result": "no_match", "reason": "no_listing" },
      "confirmation": { "basis": "customer_confirmed", "source": "human_call", "result": "confirmed_business_inquiry" }
    }
  },
  "customer_confirmation_check": {
    "status": "checked",
    "verdict": "passed_with_limitations",
    "reason": "customer_self_report",
    "breakdown": { "source": "human", "reached": true, "confirmedInquiry": true, "confirmedBusiness": true }
  },
  "qualification_evidence_state": "checks_satisfied"
}
```

This evidence state assumes other core checks are resolved; no answer leaves the business check pending but does not reverse an already completed handoff. These illustrative evidence fields are not a general call-log schema. On a **private** inquiry, `business_check` is `{"status":"not_applicable","verdict":null}`; a call clarifying customer type or offer fit updates the qualification inputs and reruns `offer_eligibility_check` instead.

Derive `qualification_evidence_state` from the applicable checks, **independently of the score and delivery status**:

- **`check_failed`:** an applicable check is `failed`, even if another remains pending; a negative recorded customer call counts for either customer type. Explicit hard failures block handoff at any score.
- **`core_requirements_unresolved`:** absent a failure, email, phone, address, or applicable offer evidence remains pending/missing, or urgency lacks a valid answer. This takes precedence over business evidence still missing.
- **`business_unconfirmed`:** core requirements have no unresolved checks, but the business check is pending; a directory name-only or address-only hit is not a full match. This state can coexist with `status: submitted` after ≥70 handoff or below-70 manual approval.
- **`checks_satisfied`:** applicable checks pass or pass with limitations and urgency has a valid answer. This does not itself imply a score of ≥70 or delivery.

`qualification_evidence_state` says what evidence established, not whether the supplier has received the lead. Calculate a distinct business or private score from the current signal breakdown. Score **≥70** and absence of explicit hard failures permit automatic handoff even when core or business evidence remains pending; never describe unresolved evidence as passed. Below 70, manual approval can hand off the lead through the existing guarded route without changing its score or evidence state. If a call later records a denial, never send/re-send on the basis of an earlier score. Existing delivery `status` distinguishes `new`, `submitting`, and `submitted`; its historical Retool `qualified` value is not this evidence state. Preserve supplier-specific routes and one-time-delivery guards; Allane retains manual external portal entry. For rare corrections, preserve the original captured identity and store only latest corrected name, email, phone, company, address, applicable customer type or VAT ID in sparse `qualification_corrections` JSONB with who and when. Do not change the selected offer on this lead. An internal API accepts an explicit allowlist of correctable fields, not edits to the deduplicated `customers` record. Checks, scoring, supplier handoff and applicable billing/dedup use consistent effective corrected values; mark dependent evidence and score stale and re-evaluate before a new handoff attempt. Never send twice or bill twice after retry, correction, or a later call.

The evidence state and actual supplier handoff can differ:

| Evidence/change | Evidence state | Handoff |
| --- | --- | --- |
| Score ≥70; only directory name matches; no hard failure | `business_unconfirmed` | Send through normal guarded route; disclose name-only evidence |
| Score <70; business not confirmed; no other unresolved checks | `business_unconfirmed` | Unsent lead can enter confirmation-call queue; after team approval, hand off through the existing guarded route even if score stays <70 |
| Score ≥70; unresolved non-hard evidence | `core_requirements_unresolved` | Send through normal guarded route; disclose pending evidence, never mark it passed |
| Score <70; manually approved, no hard failure | Evidence state unchanged | Hand off through existing guarded route; `submitted` only after actual delivery |
| Customer confirms business inquiry | Business check becomes `passed_with_limitations` | Recalculate evidence and points; evaluate handoff without pretending lookup matched |
| Call unanswered | No new confirmation | Never count call-confirmation points; existing delivery state does not rewind |
| Any explicit hard gate fails, including denial or wrong person | `check_failed` | No handoff, regardless of score; genuine correction/recheck may reopen an unsent lead |

A team member records a confirmation result in Retool through the same internal API the AI agent will later call, so manual and automated confirmation share one mechanism and one shape. They may also correct data and request a re-check, or manually approve an unsent below-70 lead for delivery through the existing route; approval does not rewrite check results. They cannot declare a failed provider check passed by fiat. Human business confirmation supplies explicitly limited evidence for `business_check`, not a registry or directory match. Allane remains the exception that requires manual entry through its external portal **after** qualification.

### Deliverability: email

Confirm MX, then check the mailbox with Bouncer. Per [Bouncer's status and reason terminology](https://docs.usebouncer.com/terminology), `deliverable` is `passed`. `risky` is `passed_with_limitations`, and stays visibly risky: the claim is **“screened; not definitively undeliverable,”** not “confirmed inbox.” `undeliverable` fails. Confirmed absent MX also fails; the mailbox lookup is not attempted in that case. An unknown verdict or provider outage, including a DNS outage, remains pending; make one bounded Bouncer attempt after confirmed MX on both web and Meta capture, then retain the unresolved result without claiming deliverability. Keep this in existing submit-time validation, not a separate retry worker; do not require a customer to resubmit after a provider outage. Log validation-provider outages (including DNS, Bouncer and Google) without customer contact details, credentials or raw provider responses. A score ≥70 permits handoff with this pending, non-hard evidence; retain the unresolved email verdict and do not claim deliverability. Do not confuse confirmed absent MX with a DNS outage.

Store the email check's `status` (`checked`, `unavailable`, or `not_checked`) and gate `verdict` (`passed`, `passed_with_limitations`, `pending`, or `failed`) separately from its factual `breakdown`: `mxStatus` is `present`, `absent`, or `unavailable`; `deliveryVerdict` is `deliverable`, `risky`, `undeliverable`, `unknown`, or absent if no verdict was obtained; `deliveryReason` retains the checker’s reason where supplied (notably `low_deliverability` versus `low_quality`, often disposable, under `risky`); Bouncer's numerical score does not drive qualification; and `deliveryStatus` distinguishes `completed`, `unavailable`, and `not_checked`. The field names do not embed the provider name. In particular, a completed check returning `unknown` differs from a failed check and from one never attempted because MX was absent. Neither MX nor a mailbox check proves mailbox ownership or customer identity. No confirmation-link step is added.

### Contactability: phone and address

Keep phone-number validity and Twilio line status as **separate facts**. A validated number meets the current phone threshold if line status is `active`, `reachable`, unknown, or not returned by a successful lookup. Only an actual `active` or `reachable` response supports that stronger description. An explicit `unreachable` result stays pending; `inactive` or `valid: false` fails. If number validity cannot be established because the provider is unavailable, the check stays pending and receives up to three attempts total; an already established invalid number does not become pending just because a lookup was not attempted. Give the phone check its own `status` (`checked`, `unavailable`, or `not_checked`) and gate `verdict` (`passed`, `passed_with_limitations`, `pending`, or `failed`). A validated number without confirmed active/reachable line status is `passed_with_limitations`, not a confirmed conversation. Keep `valid` (`true`, `false`, or `null` when validity was not established), `lineStatus` (Twilio’s line-status value or `null`), and `lookupStatus` (`completed`, `unavailable`, or `not_attempted`) as distinct facts in its breakdown. `valid` means overall number validity, including local format rejection. A completed lookup with no line status is not a provider failure; neither should be described as reachable. “Number validated” does not mean “we spoke to the customer.”

Record address evidence at the level actually checked:

- **Website inquiries:** retain the existing house-number requirement and full-address check. A customer can correct an address at submission; do not keep the form waiting through background retries. `verified` or `corrected` passes. An override or unconfirmed address is not silently labelled verified.
- **Allane Meta inquiries:** the address check passes only with a house number and full-address verification. A missing number stays pending until corrected internally, but does not veto ≥70 handoff eligibility; Allane’s external portal entry still has to succeed before marking the lead `submitted`.
- **Other Meta inquiries:** a missing house number may still allow an address-check pass with limitations **if** Google confirms route, postcode, and locality, with the missing street number as the relevant limitation. Label this **street-level checked**, not “full address verified” or “postal delivery confirmed.” A generic `FIX` result is not a pass.

Store a concise address check with `status` (`checked`, `unavailable`, `not_checked`), gate `verdict` (`passed`, `passed_with_limitations`, `pending`, `failed`), and a short `reason` where needed. Keep the evidence level (`full`, `full_corrected`, `street_level`, `not_verified`, or `unknown`) in its breakdown: `full_corrected` distinguishes an accepted website correction from an unchanged full match; an internal edit triggers a fresh check. An optional shallow component breakdown maps Google component types to confirmation levels—for example, `route: confirmed`, `postal_code: confirmed`, `locality: confirmed`, `street_number: missing`. Derive `missing` only from Google’s explicit missing-component types; do not assume an omitted component is confirmed or missing. Retain the component evidence required to substantiate a street-level `passed_with_limitations` without copying address values into the breakdown. The current address mapper does not retain individual confirmation levels, so the target check needs richer evidence than today’s stored outcome.

Meta’s submitted form cannot prompt the customer to correct it afterwards. Make one bounded Google address check during ingestion. On a transient provider error, persist pending/unavailable evidence and log the outage safely; do not add an asynchronous retry or require the customer to resubmit. Do not repeat an unchanged, substantive rejection and call it recovery. **An address check that did not pass is not necessarily a fake address.** `unavailable` means the provider could not check it, so the gate is `pending`. A missing required Allane house number also stays `pending` for possible internal correction. A completed substantive rejection, unconfirmed address that does not meet the relevant pass rule, or website override means this address has **not passed verification**: set `address_check.verdict: pending` with a specific reason. This does not assert the address is fake. Pending address evidence does not veto ≥70 handoff or below-70 manual approval; if sent, disclose that the address was not verified. A correction triggers a new check; do not retry an unchanged substantive rejection as though it were a provider outage or automatically pass it after a timeout.

### Offer eligibility: declared customer type

Check customer type against the selected offer’s explicit audience rule: business-only leasing or sale offers, and the rental supplier’s B2C setting. A known mismatch fails. Missing or ambiguous Meta customer type stays pending; neither company name nor form title silently substitutes for a declaration. An inquiry without a selected offer has no offer-eligibility check.

A business-only form may **preselect business**. That default alone does not establish business eligibility when the customer supplies contradictory details. Whole-value company answers such as `Privatkunde`, `Privatkunden`, `Privatperson`, `Privat`, or `Private` explicitly signal a private customer and make the business-only inquiry ineligible on current data. Empty or non-answers such as `Keine Angabe`, `Keine Firma`, `N/A`, or `None` leave it unresolved and pending; they do not prove private status. A company answer equal to the contact’s name does not automatically fail: sole traders and freelancers legitimately use their own names. Do not apply substring rules that would reject a real name such as `Privatbrauerei Müller`. Corrections can request a re-check.

Keep the eligibility check concise: `status` says whether it was `checked`, `not_checked`, or `not_applicable`; the gate `verdict` is `passed`, `passed_with_limitations`, `pending`, or `failed` when applicable, and `null` when not applicable. Its `reason` explains non-passing results, for example `private_customer_on_business_only_offer`, `explicit_private_answer`, or `company_answer_missing`. `checked` means the check ran even when supplied answers conflict or are incomplete. Reason is a stable explanation, not a copy of the customer’s company field. This is a claim about allowed **supplied** customer type without explicit contradiction—not verification of business identity, vehicle suitability, affordability, creditworthiness, or serious buying intent.

### Business check: separate lookup facts, one categorical verdict

Keep **registry and directory results distinct** within `business_check.breakdown`. Each lookup has `status` (`checked`, `not_checked`, `unavailable`), factual `result` (`match`, `no_match`, or `null` if unassessed), a specific `reason` where useful, and optional small facts behind a partial or positive finding. A lookup failure or missing input is not a negative match; `no_match` means a completed lookup did not establish the relevant match, **not** that the business does not exist.

For registry, a match requires an active registry record and matching company name for the supplied identifier; a different registered-office address does not automatically defeat it. Reasons distinguish `no_identifier`/`no_vat_id`, `invalid_identifier`, `no_record`, `name_mismatch`, `inactive`, and provider failure. An invalid identifier can have `status: checked`, `result: null`, `reason: invalid_identifier`: the provider answered, but no identity match was assessed. Registry must **never** contain a directory match returned by a fallback.

For directory, a `match` requires company-name and address matches plus an operational listing; do not copy the existing lookup's `valid` or numerical `confidence`, which can be positive on a name match alone. A completed lookup with only a matching address is `no_match` with reason `name_mismatch`; only a matching name is `no_match` with reason `address_mismatch`; no listing found is `no_match` with reason `no_listing`. An absent or placeholder company answer is `not_checked` with a null result, and a provider failure is `unavailable` with a null result—not negative matches. The breakdown records name match, address match, and operational status without duplicating registry evidence. The combined example above shows a directory match without a usable registry identifier.

A positive match from **either** lookup makes `business_check` `passed` and earns the appropriate lookup points. Without one it remains `pending`; name-only and address-only directory findings may earn partial points but do not become a full business match. **A score ≥70 can send the lead anyway** if no hard gate applies, while the evidence state stays `business_unconfirmed`. Unsent lower-scoring leads may enter the confirmation queue. Do not classify a sole trader as private for lacking a listing. For private inquiries, `business_check` has `status: not_applicable` and `verdict: null`. Corporate versus free-mail and DNS-only `webPresence` are scored separately, not turned into a lookup match. A DNS record alone does not establish a reachable website and earns no website points; only an observed reachable website supports that five-point signal.

A team member who reaches the contact and confirms that the contact made this inquiry as a business can provide evidence for `business_check: passed_with_limitations` even without an independent match. Retain that the basis was customer confirmation, not a registry or directory result; it does not prove legal existence, creditworthiness, or purchase intent. A call without an answer supplies no confirmation: the business check and evidence state stay unconfirmed; an earlier completed handoff is not undone. No unanswered-call retry or expiry policy is needed to make that rule work. A denial blocks handoff and may require correcting the customer type and rerunning eligibility rather than automatically treating the business as fraudulent. `business_check` keeps the basis legible on its own: `verdict: passed_with_limitations`, `reason: customer_confirmed`, and a `confirmation` fact naming the basis and source. The call's own record lives in `customer_confirmation_check`; neither may be restated as a registry or directory result. Calls that correct supplied information still go through the update-and-recheck path. AI calling remains outside this pitch.

### Intent: answer required, strength not judged

Forms collect an urgency answer. Any valid answer—`urgent`, `concrete`, or `information`—meets the intent check (`passed`). Missing or unrecognised urgency leaves core evidence unresolved, reason `missing_or_unknown_urgency`, without independently blocking ≥70 handoff; it may indicate a wrong form, but missing urgency alone does not prove that. Use the existing lead `urgency` field rather than copying its value into qualification JSONB. Notes remain optional on the lead and are not duplicated into an intent signal. Urgent/concrete/information earns 10/7/0 business points or 20/15/0 private points where the form asked; no urgency points compensate for an explicit hard failure.

### Supplier view and feedback

The handoff email invites the supplier to **view the inquiry’s evidence and give feedback**, linking to that specific lead in the supplier portal. The link requires normal portal authentication; it is not an access token, and opening it must verify the signed-in supplier is entitled to that lead. Email alone does not expose the qualification breakdown.

The portal already lists delivered leads and opens a lead-detail slideover. Internally, show score and its separate contributions **alongside** `qualification_evidence_state`, delivery `status`, and check reasons; sorting by score does not change the state. Retool business-confirmation and core-requirements queues show **unsent leads only** that need those actions; a sent lead leaves the queue even if its evidence remains `business_unconfirmed`. A score band never supplies an overall quality colour; if used, colour reflects evidence state. Supplier detail gives a scan-friendly factual breakdown: distinguish risky email, validated versus reachable phone, address precision, offer fit, self-reported urgency, partial versus full business lookup, and customer confirmation. **Never badge a score-eligible `business_unconfirmed` lead as independently business-verified.** Historical leads without new checks show “Qualification breakdown unavailable,” not a retroactive claim. Internal scoring and point contributions are not silently exposed to suppliers; whether to share numbers externally is a separate decision. No raw provider payload, technical reason code, internal note, or tracking data is shown.

Show the supplier's current feedback and let them report the lead as **Won**, **Lost**, or **Still open** in the same slideover. Won and Lost each require **one primary reason**, with a separate free-text field for additional details; Still open requires neither. Won reasons: right vehicle/offer, price or terms worked, customer ready to proceed, other, or reason unknown. Lost reasons: could not reach customer, incorrect contact details, customer not eligible for offer, wrong vehicle/offer, price or terms did not work, financing/credit declined, customer not ready or no longer interested, chose competitor, supplier could not fulfil offer, other, or reason unknown. Additional detail is optional except when selecting **Other**, which needs an explanation. Allow **reason unknown** rather than forcing suppliers to guess. Distinguish supplier-side fulfilment failures from lead-quality issues.

A `supplier_note` is **qualification-neutral**: it never changes a check verdict, `qualification_evidence_state`, score, or routing, and it cannot substitute for evidence. A customer who wants a different vehicle does not lose points or change evidence state solely because of a note; a different selected offer is outside this lead's correction path and must not be hidden in a note. It is also **not a dumping ground**: customer-stated context only, never internal reason codes, provider payloads, scores, internal notes, or tracking data — the same boundary as the supplier-facing breakdown. Keep it short and reviewable, since it leaves our systems.

Keep feedback attributable to the supplier and lead, separate from qualification evidence. Supplier-reported outcomes inform later evaluation of the checks; they do not automatically reclassify the lead, revise its original handoff evidence, or change billing. Feedback collection does not itself alter the initial score, handoff, billing, or evidence state; it can inform later validation of the new weights.

**Supplier promise:** A delivered lead either reached ≥70 or was manually approved below 70, with no known hard failure. Its displayed checks say **exactly what evidence exists**; a `business_unconfirmed` lead may already have been delivered without a full lookup match or call. Do not promise verified business identity, verified contact, creditworthiness, or confirmed buying intent solely from the score or handoff status. If a delivered lead has unresolved non-hard evidence, show that limitation in the supplier breakdown rather than claiming it passed. A below-70 lead sent after manual approval makes the same factual evidence-only promise; approval is not proof that checks passed.

### Future target: universal contact confirmation

The separate AI-calling pitch targets an attempted call for **every inquiry** before handoff. Whether a successful conversation is required or an unanswered high-scoring inquiry can still be delivered belongs to that pitch; a call attempt alone cannot support a claim that the person was reached. A reached human caller meets the same confirmation standard as the AI agent, and both write `customer_confirmation_check`. One call may both confirm the inquiry and provide limited customer-confirmed business evidence when no lookup matched; do not count it as two calls. An unanswered call cannot establish contact or earn confirmation points. If the call corrects supplied details, update qualification inputs and rerun affected checks before handoff.

This is **not a current gate**: with the AI agent still in testing, ≥70 can auto-hand off without a call, including with `business_unconfirmed` evidence. Lower-scoring unsent business leads may be called manually; call attempts and successful confirmation are distinct. Do not claim all delivered leads were reached. The separate calling pitch must define any universal call-attempt or successful-confirmation gate, treatment of unanswered calls and score-eligible leads, new handoff trigger, and rollout of a stronger supplier promise; the existence of `customer_confirmation_check` alone enables none of those changes.

## Rabbit Holes

**Score changes the size of the manual queue; historical exports are not rollout forecasts.** A read-only comparison of `scratch/domain_leads.csv` found 633 scored Meta-tagged business leasing/sale inquiries above the old `> 50` threshold with currently passing stored phone/address outcomes; 381 lacked a positive registry or directory match. These are *candidates*, not verified historical deliveries: the export lacks form ID, offer/status gates, Bouncer outcomes, and the address-component evidence needed for the proposed street-level exception. The older score permitted many leads without a match. Measure new score distributions and unsent call volume before rollout. An unanswered call adds no points and changes no evidence; any already-sent lead remains sent. Do not invent an unanswered-call timeout rule.

Historical exports also reveal substantial potential Meta address holds, but cannot predict final qualification rates: they lack Bouncer verdicts and the Google component evidence needed to count street-level passes. A longer address timeout may reduce provider failures; it cannot supply a missing Allane house number or cure every substantive rejection. This pitch describes the **intended standard**, not a claim that all leads delivered today meet it. Before changing Meta address routing, distinguish timeouts from input problems, measure automatic recovery and remaining internal workload, and avoid claiming full verification on leads sent with pending address evidence. Allane’s existing manual portal submission remains distinct from the new business-confirmation call path.

## No Go’s

No universal AI calling in this phase, AI sentiment gate, manual approval of known hard failures, or customer confirmation-link step. Calls to unsent leads needing business confirmation remain in scope; automating universal calling does not. Meta cannot ask customers for a correction after submission. Billing price/rate changes, reports, score-derived colour/quality badges, ad-conversion changes, and duplicate or repeat-delivery policy remain outside this pitch. Preserve existing one-time delivery and billing guarantees while replacing the Meta score threshold with ≥70 and explicit hard gates.
