import type {
  AddressCheck,
  EmailCheck,
  OfferEligibilityCheck,
  PhoneCheck,
} from '#shared/schemas/qualification'
import type { PhoneValidationResult } from '#shared/types/phoneValidation'

export type MxResult = 'present' | 'absent' | 'unavailable'
export type DeliveryResult =
  | {
      status: 'completed'
      verdict: 'deliverable' | 'risky' | 'undeliverable' | 'unknown'
      reason: string | null
    }
  | { status: 'unavailable' | 'not_checked'; verdict: null; reason: null }

export function emailCaptureCheck(
  mx: MxResult,
  delivery: DeliveryResult
): EmailCheck {
  const breakdown = {
    mxStatus: mx,
    deliveryVerdict: delivery.verdict,
    deliveryReason: delivery.reason,
    deliveryStatus: delivery.status,
  }
  if (mx === 'absent' || delivery.verdict === 'undeliverable')
    return {
      status: 'checked',
      verdict: 'failed',
      reason: mx === 'absent' ? 'no_mx' : 'undeliverable_mailbox',
      breakdown,
    }
  if (
    mx !== 'present' ||
    delivery.status !== 'completed' ||
    delivery.verdict === 'unknown'
  )
    return {
      status:
        mx === 'unavailable' || delivery.status === 'unavailable'
          ? 'unavailable'
          : 'checked',
      verdict: 'pending',
      reason: mx === 'unavailable' ? 'dns_unavailable' : 'delivery_unavailable',
      breakdown,
    }
  return delivery.verdict === 'risky'
    ? {
        status: 'checked',
        verdict: 'passed_with_limitations',
        reason: 'risky_mailbox',
        breakdown,
      }
    : { status: 'checked', verdict: 'passed', reason: null, breakdown }
}

export function phoneCaptureCheck(result: PhoneValidationResult): PhoneCheck {
  const unavailable = result.failureReason === 'twilio_unavailable'
  let lookupStatus: 'unavailable' | 'not_attempted' | 'completed' = 'completed'
  if (unavailable) lookupStatus = 'unavailable'
  else if (result.failureReason === 'format_invalid')
    lookupStatus = 'not_attempted'
  const breakdown = {
    valid: unavailable ? null : result.valid,
    lineStatus: result.lineStatus,
    lookupStatus,
  }
  if (!result.valid)
    return {
      status: 'checked',
      verdict: 'failed',
      reason: result.failureReason,
      breakdown: { ...breakdown, valid: false },
    }
  if (unavailable)
    return {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'twilio_unavailable',
      breakdown,
    }
  if (result.lineStatus === 'unreachable')
    return {
      status: 'checked',
      verdict: 'pending',
      reason: 'line_unreachable',
      breakdown,
    }
  if (result.lineStatus === 'active' || result.lineStatus === 'reachable')
    return { status: 'checked', verdict: 'passed', reason: null, breakdown }
  return {
    status: 'checked',
    verdict: 'passed_with_limitations',
    reason: 'line_status_not_returned',
    breakdown,
  }
}

const PRIVATE_ANSWERS = new Set([
  'privatkunde',
  'privatkunden',
  'privatperson',
  'privat',
  'private',
])
const EMPTY_ANSWERS = new Set([
  '',
  'keine angabe',
  'keine firma',
  'n/a',
  'none',
])

export function offerCaptureCheck(input: {
  selected: boolean
  audience: 'business_only' | 'private_only' | 'both'
  customerType: 'business' | 'private' | null
  companyAnswer?: string | null
  businessOnlyForm?: boolean
}): OfferEligibilityCheck {
  if (!input.selected)
    return { status: 'not_applicable', verdict: null, reason: null }
  const breakdown = { audience: input.audience }
  const company = input.companyAnswer?.trim().toLocaleLowerCase('de-DE') ?? ''
  if (input.businessOnlyForm && PRIVATE_ANSWERS.has(company))
    return {
      status: 'checked',
      verdict: 'failed',
      reason: 'explicit_private_answer',
      breakdown,
    }
  if (input.businessOnlyForm && EMPTY_ANSWERS.has(company))
    return {
      status: 'checked',
      verdict: 'pending',
      reason: 'company_answer_missing',
      breakdown,
    }
  if (!input.customerType)
    return {
      status: 'checked',
      verdict: 'pending',
      reason: 'customer_type_missing',
      breakdown,
    }
  if (
    input.audience !== 'both' &&
    input.audience !== `${input.customerType}_only`
  )
    return {
      status: 'checked',
      verdict: 'failed',
      reason: 'customer_type_mismatch',
      breakdown,
    }
  return { status: 'checked', verdict: 'passed', reason: null, breakdown }
}

export interface AddressCaptureFacts {
  outcome:
    | 'verified'
    | 'corrected'
    | 'unconfirmed'
    | 'overridden'
    | 'unavailable'
    | 'unverified'
  hasReplacedComponents: boolean
  missingComponentTypes: string[]
  unconfirmedComponentTypes: string[]
  confirmedComponentTypes?: string[]
  houseNumberPresent: boolean
  meta?: boolean
  allane: boolean
}

export function addressCaptureCheck(facts: AddressCaptureFacts): AddressCheck {
  const missing = new Set(facts.missingComponentTypes)
  const unconfirmed = new Set(facts.unconfirmedComponentTypes)
  const confirmed = new Set(facts.confirmedComponentTypes ?? [])
  const component = (
    name: string
  ): 'confirmed' | 'unconfirmed' | 'missing' | 'unknown' => {
    if (missing.has(name)) return 'missing'
    if (unconfirmed.has(name)) return 'unconfirmed'
    if (facts.outcome === 'unavailable' || facts.outcome === 'overridden')
      return 'unknown'
    return confirmed.has(name) ? 'confirmed' : 'unknown'
  }
  const breakdown = {
    level: 'not_verified' as const,
    route: component('route'),
    postal_code: component('postal_code'),
    locality: component('locality'),
    street_number: component('street_number'),
  }
  if (facts.outcome === 'unavailable')
    return {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'address_provider_unavailable',
      breakdown: { ...breakdown, level: 'unknown' },
    }
  if (facts.outcome === 'overridden')
    return {
      status: 'checked',
      verdict: 'pending',
      reason: 'address_overridden',
      breakdown,
    }
  const streetConfirmed =
    breakdown.route === 'confirmed' &&
    breakdown.postal_code === 'confirmed' &&
    breakdown.locality === 'confirmed'
  if (
    streetConfirmed &&
    breakdown.street_number === 'confirmed' &&
    (facts.outcome === 'verified' || facts.outcome === 'corrected')
  )
    return {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        ...breakdown,
        level: facts.hasReplacedComponents ? 'full_corrected' : 'full',
      },
    }
  const missingNumberOnly =
    facts.outcome === 'unverified' &&
    facts.missingComponentTypes.length === 1 &&
    missing.has('street_number') &&
    unconfirmed.size === 0
  if (
    streetConfirmed &&
    breakdown.street_number === 'missing' &&
    !facts.houseNumberPresent &&
    !facts.allane &&
    (facts.outcome === 'verified' ||
      facts.outcome === 'corrected' ||
      missingNumberOnly)
  )
    return {
      status: 'checked',
      verdict: 'passed_with_limitations',
      reason: 'street_level_exception',
      breakdown: {
        ...breakdown,
        level: 'street_level',
        streetLevelExceptionEligible: true,
      },
    }
  return {
    status: 'checked',
    verdict: 'pending',
    reason:
      facts.allane && !facts.houseNumberPresent
        ? 'house_number_required'
        : 'address_unconfirmed',
    breakdown,
  }
}
