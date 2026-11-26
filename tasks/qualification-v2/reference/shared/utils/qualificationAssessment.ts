import type {
  AddressCheck,
  BusinessCheck,
  CustomerConfirmationCheck,
  EmailCheck,
  OfferEligibilityCheck,
  PhoneCheck,
  QualificationAssessment,
  QualificationScoreBreakdown,
} from '#shared/schemas/qualification'
import {
  deriveEvidenceState,
  parseQualificationAssessment,
} from '#shared/schemas/qualification'
import { legalFormBasisFromCheck } from '#shared/utils/businessEvidence'
import {
  resolveAddressPoints,
  resolveBusinessLookupPoints,
  resolveCustomerConfirmationPoints,
  resolveEmailPoints,
  resolvePhonePoints,
} from '#shared/utils/qualificationPoints'

export interface QualificationFacts {
  customerType: 'business' | 'private'
  email: EmailCheck
  phone: PhoneCheck
  address: AddressCheck
  offerEligibility: OfferEligibilityCheck
  business: BusinessCheck
  customerConfirmation: CustomerConfirmationCheck
  urgency: 'urgent' | 'concrete' | 'information' | null
  urgencyAsked: boolean
  corporateDomain: boolean
  reachableWebsite: { basis: 'http_reachable' } | null
  companyName: string | null
  placeholderCompanyName: boolean
  streetLevelExceptionEligible: boolean
}

const satisfied = (check: { verdict: string | null }) =>
  check.verdict === 'passed' || check.verdict === 'passed_with_limitations'

function reconcileEmail(check: EmailCheck): EmailCheck {
  if (check.status === 'not_applicable') return check
  if (check.breakdown?.mxStatus === 'absent')
    return {
      ...check,
      status: 'checked',
      verdict: 'failed',
      reason: 'missing_mx',
    }
  if (check.breakdown?.deliveryVerdict === 'undeliverable')
    return {
      ...check,
      status: 'checked',
      verdict: 'failed',
      reason: 'undeliverable_mailbox',
    }
  if (
    check.status === 'checked' &&
    check.breakdown?.mxStatus === 'present' &&
    check.breakdown.deliveryStatus === 'completed'
  ) {
    if (check.breakdown.deliveryVerdict === 'deliverable')
      return { ...check, verdict: 'passed', reason: null }
    if (check.breakdown.deliveryVerdict === 'risky')
      return {
        ...check,
        verdict: 'passed_with_limitations',
        reason: 'risky_mailbox',
      }
  }
  if (satisfied(check) || check.verdict === 'failed')
    return { ...check, verdict: 'pending', reason: 'email_unresolved' }
  return check
}

function reconcilePhone(check: PhoneCheck): PhoneCheck {
  if (check.status === 'not_applicable') return check
  if (
    check.breakdown?.valid === false ||
    check.breakdown?.lineStatus === 'inactive'
  )
    return {
      ...check,
      status: 'checked',
      verdict: 'failed',
      reason: 'invalid_or_inactive_phone',
    }
  if (
    check.status === 'checked' &&
    check.breakdown?.valid === true &&
    check.breakdown.lookupStatus === 'completed'
  ) {
    const lineStatus = check.breakdown.lineStatus
    if (lineStatus === 'active' || lineStatus === 'reachable')
      return { ...check, verdict: 'passed', reason: null }
    if (lineStatus === null || lineStatus === 'unknown')
      return {
        ...check,
        verdict: 'passed_with_limitations',
        reason: 'line_status_not_returned',
      }
  }
  if (satisfied(check) || check.verdict === 'failed')
    return { ...check, verdict: 'pending', reason: 'phone_unresolved' }
  return check
}

function reconcileAddress(
  check: AddressCheck,
  streetLevelExceptionEligible: boolean
): AddressCheck {
  if (check.status === 'not_applicable') return check
  if (
    check.status === 'checked' &&
    check.verdict === 'failed' &&
    check.reason === 'definitive_invalid_address'
  )
    return check
  const evidence = check.breakdown
  const full =
    evidence?.level === 'full' || evidence?.level === 'full_corrected'
  const coreConfirmed = [
    evidence?.route,
    evidence?.postal_code,
    evidence?.locality,
  ].every((component) => component === 'confirmed')
  if (
    check.status !== 'checked' ||
    !coreConfirmed ||
    (!full && evidence?.level !== 'street_level')
  )
    return { ...check, verdict: 'pending', reason: 'address_unresolved' }
  if (full && evidence?.street_number === 'confirmed')
    return check.verdict === 'passed'
      ? check
      : { ...check, verdict: 'passed', reason: null }
  if (
    streetLevelExceptionEligible &&
    evidence?.level === 'street_level' &&
    evidence.route === 'confirmed' &&
    evidence.postal_code === 'confirmed' &&
    evidence.locality === 'confirmed' &&
    evidence.street_number === 'missing'
  )
    return {
      ...check,
      verdict: 'passed_with_limitations',
      reason: 'street_level_exception',
      breakdown: { ...evidence, streetLevelExceptionEligible: true },
    }
  return { ...check, verdict: 'pending', reason: 'address_unresolved' }
}

function reconcileOfferEligibility(
  check: OfferEligibilityCheck,
  customerType: QualificationFacts['customerType']
): OfferEligibilityCheck {
  if (check.status === 'not_applicable') return check
  const audience = check.breakdown?.audience
  if (!audience)
    return {
      ...check,
      verdict: 'pending',
      reason: 'offer_audience_unresolved',
    }
  const mismatch =
    (audience === 'business_only' && customerType === 'private') ||
    (audience === 'private_only' && customerType === 'business')
  if (mismatch)
    return {
      ...check,
      status: 'checked',
      verdict: 'failed',
      reason: 'customer_type_offer_mismatch',
    }
  if (
    check.verdict === 'failed' &&
    check.reason === 'contradictory_offer_details'
  )
    return check
  if (check.verdict === 'failed' || check.verdict === 'passed_with_limitations')
    return { ...check, verdict: 'pending', reason: 'offer_fit_unresolved' }
  return check
}

function reconcileConfirmation(
  check: CustomerConfirmationCheck
): CustomerConfirmationCheck {
  if (check.status === 'not_applicable') return check
  if (check.status !== 'checked')
    return {
      status: check.status,
      verdict: 'pending',
      reason: check.status === 'not_checked' ? null : check.reason,
    }
  const evidence = check.breakdown
  if (evidence?.reached !== true)
    return { ...check, verdict: 'pending', reason: 'not_reached' }
  const denial =
    check.reason === 'wrong_person' ||
    check.reason === 'customer_denies_inquiry' ||
    check.reason === 'no_longer_interested'
  if (denial) return { ...check, verdict: 'failed' }
  if (
    check.reason === 'callback_requested' ||
    check.reason === 'language_barrier'
  )
    return { ...check, verdict: 'pending' }
  if (evidence.confirmedInquiry === true)
    return { ...check, verdict: 'passed', reason: null }
  return { ...check, verdict: 'pending', reason: 'confirmation_unresolved' }
}

function businessEvidence(facts: QualificationFacts): BusinessCheck {
  if (facts.customerType === 'private') {
    return { status: 'not_applicable', verdict: null, reason: null }
  }
  const business = facts.business
  const breakdown = {
    registry:
      business.status === 'not_applicable'
        ? { status: 'not_checked' as const, result: null }
        : (business.breakdown?.registry ?? {
            status: 'not_checked' as const,
            result: null,
          }),
    directory:
      business.status === 'not_applicable'
        ? { status: 'not_checked' as const, result: null }
        : (business.breakdown?.directory ?? {
            status: 'not_checked' as const,
            result: null,
          }),
  }
  const status =
    business.status === 'not_applicable' ? 'not_checked' : business.status
  const confirmation = facts.customerConfirmation
  if (
    confirmation.status === 'checked' &&
    confirmation.verdict === 'failed' &&
    confirmation.breakdown?.reached === true
  )
    return {
      status: 'checked',
      verdict: 'failed',
      reason: confirmation.reason,
      breakdown,
    }
  const registry = breakdown.registry
  const directory = breakdown.directory
  const registryMatched =
    !facts.placeholderCompanyName &&
    registry.status === 'checked' &&
    registry.result === 'match' &&
    registry.active === true &&
    registry.nameMatched === true
  const directoryMatched =
    !facts.placeholderCompanyName &&
    directory.status === 'checked' &&
    directory.result === 'match' &&
    directory.operational === true &&
    directory.nameMatched === true &&
    directory.addressMatched === true
  if (registryMatched || directoryMatched) {
    return {
      status: 'checked',
      verdict: 'passed',
      reason: registryMatched ? 'registry_match' : 'directory_match',
      breakdown,
    }
  }
  const confirmed =
    confirmation.status === 'checked' &&
    satisfied(confirmation) &&
    confirmation.breakdown?.reached === true &&
    confirmation.breakdown.confirmedInquiry === true &&
    confirmation.breakdown.confirmedBusiness === true
  if (confirmed) {
    return {
      status: 'checked',
      verdict: 'passed_with_limitations',
      reason: 'customer_confirmed',
      breakdown: {
        ...breakdown,
        confirmation: {
          basis: 'customer_confirmed',
          source: confirmation.breakdown!.source,
        },
      },
    }
  }
  return {
    status,
    verdict: 'pending',
    reason: 'customer_confirmation_needed',
    breakdown,
  }
}

function lookupPoints(
  facts: QualificationFacts,
  business: BusinessCheck
): {
  points: number
  basis?: QualificationScoreBreakdown['businessLookupBasis']
} {
  if (facts.customerType !== 'business' || facts.placeholderCompanyName)
    return { points: 0 }
  return resolveBusinessLookupPoints(business)
}

function urgencyPoints(facts: QualificationFacts): number {
  if (!facts.urgencyAsked) return 0
  const business = facts.customerType === 'business'
  if (facts.urgency === 'urgent') return business ? 10 : 20
  if (facts.urgency === 'concrete') return business ? 7 : 15
  return 0
}

function scoreBreakdown(
  facts: QualificationFacts,
  business: BusinessCheck
): QualificationScoreBreakdown {
  const isBusiness = facts.customerType === 'business'
  const lookup = lookupPoints(facts, business)
  const legalFormBasis = isBusiness
    ? legalFormBasisFromCheck({
        check: business,
        submittedName: facts.companyName,
      })
    : undefined
  const points = {
    phone: resolvePhonePoints(facts.phone, facts.customerType),
    email: resolveEmailPoints(facts.email),
    address: resolveAddressPoints(facts.address, facts.customerType),
    urgency: urgencyPoints(facts),
    businessLookup: lookup.points,
    corporateDomain: isBusiness && facts.corporateDomain ? 10 : 0,
    website:
      isBusiness && facts.reachableWebsite?.basis === 'http_reachable' ? 5 : 0,
    corporationLegalForm: legalFormBasis ? 5 : 0,
    customerConfirmation: resolveCustomerConfirmationPoints(
      facts.customerConfirmation,
      facts.customerType
    ),
  }
  return {
    version: 2,
    customerType: facts.customerType,
    urgencyMissing:
      facts.urgencyAsked &&
      facts.urgency !== 'urgent' &&
      facts.urgency !== 'concrete' &&
      facts.urgency !== 'information',
    ...(isBusiness && facts.placeholderCompanyName
      ? { placeholderCompanyName: true }
      : {}),
    points,
    ...(lookup.basis ? { businessLookupBasis: lookup.basis } : {}),
    ...(points.website ? { websiteBasis: 'http_reachable' as const } : {}),
    ...(points.corporationLegalForm ? { legalFormBasis } : {}),
  }
}

export function deriveQualificationAssessment(
  facts: QualificationFacts
): QualificationAssessment {
  const checkedFacts = {
    ...facts,
    email: reconcileEmail(facts.email),
    phone: reconcilePhone(facts.phone),
    address: reconcileAddress(
      facts.address,
      facts.streetLevelExceptionEligible
    ),
    offerEligibility: reconcileOfferEligibility(
      facts.offerEligibility,
      facts.customerType
    ),
    customerConfirmation: reconcileConfirmation(facts.customerConfirmation),
  }
  const business = businessEvidence(checkedFacts)
  const confirmedFacts = {
    ...checkedFacts,
    customerConfirmation:
      business.status !== 'not_applicable' &&
      business.reason === 'customer_confirmed' &&
      checkedFacts.customerConfirmation.status === 'checked'
        ? {
            ...checkedFacts.customerConfirmation,
            verdict: 'passed_with_limitations' as const,
            reason: 'customer_self_report',
          }
        : checkedFacts.customerConfirmation,
  }
  const breakdown = scoreBreakdown(confirmedFacts, business)
  const checks = {
    email_check: confirmedFacts.email,
    phone_check: confirmedFacts.phone,
    address_check: confirmedFacts.address,
    offer_eligibility_check: confirmedFacts.offerEligibility,
    business_check: business,
    customer_confirmation_check: confirmedFacts.customerConfirmation,
  }
  return {
    qualification_score: Object.values(breakdown.points).reduce(
      (sum, points) => sum + points,
      0
    ),
    qualification_score_breakdown: breakdown,
    qualification_evidence_state: deriveEvidenceState(
      checks,
      breakdown.urgencyMissing
    ),
    ...checks,
  }
}

export function canHandOffAssessment(
  assessment: QualificationAssessment | null,
  manuallyApproved: boolean
): boolean {
  const complete = parseQualificationAssessment(assessment)
  if (!complete || complete.qualification_evidence_state === 'check_failed')
    return false
  return complete.qualification_score >= 70 || manuallyApproved
}
