import { describe, expect, it } from 'vitest'
import { parseQualificationAssessment } from '#shared/schemas/qualification'
import { effectiveQualificationInputs, confirmationFromOutcome } from '#shared/utils/qualificationActions'
import {
  canHandOffAssessment,
  deriveQualificationAssessment,
  type QualificationFacts,
} from '#shared/utils/qualificationAssessment'

const lookup = { status: 'not_checked' as const, result: null }
const facts = (): QualificationFacts => ({
  customerType: 'business',
  email: {
    status: 'checked',
    verdict: 'passed',
    reason: null,
    breakdown: {
      mxStatus: 'present',
      deliveryVerdict: 'deliverable',
      deliveryReason: null,
      deliveryStatus: 'completed',
    },
  },
  phone: {
    status: 'checked',
    verdict: 'passed',
    reason: null,
    breakdown: { valid: true, lineStatus: 'active', lookupStatus: 'completed' },
  },
  address: {
    status: 'checked',
    verdict: 'passed',
    reason: null,
    breakdown: {
      level: 'full',
      route: 'confirmed',
      postal_code: 'confirmed',
      locality: 'confirmed',
      street_number: 'confirmed',
    },
  },
  offerEligibility: {
    status: 'checked',
    verdict: 'passed',
    reason: null,
    breakdown: { audience: 'both' },
  },
  business: {
    status: 'checked',
    verdict: 'passed',
    reason: 'registry_match',
    breakdown: {
      registry: {
        status: 'checked',
        result: 'match',
        active: true,
        nameMatched: true,
        corporateLegalForm: true,
      },
      directory: lookup,
    },
  },
  customerConfirmation: {
    status: 'not_checked',
    verdict: 'pending',
    reason: 'not_called',
  },
  urgency: 'urgent',
  urgencyAsked: true,
  corporateDomain: true,
  reachableWebsite: { basis: 'http_reachable' },
  companyName: 'Example',
  placeholderCompanyName: false,
  streetLevelExceptionEligible: false,
})

function confirmed(input: QualificationFacts): QualificationFacts {
  return {
    ...input,
    customerConfirmation: {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        source: 'human',
        reached: true,
        confirmedInquiry: true,
        confirmedBusiness: input.customerType === 'business',
      },
    },
  }
}

describe('v2 qualification assessment', () => {
  it('when corrected customer type changes to private, then offer fit fails and business evidence becomes inapplicable', () => {
    const original = { is_business: true, customer_company: 'Example GmbH' }
    const effective = effectiveQualificationInputs(original, {
      fields: { is_business: false },
      correctedBy: 'staff@example.com',
      correctedAt: '2026-10-22T00:00:00Z',
    })
    const input = facts()
    input.customerType = effective.is_business ? 'business' : 'private'
    input.companyName = effective.customer_company
    input.offerEligibility = {
      status: 'checked', verdict: 'passed', reason: null,
      breakdown: { audience: 'business_only' },
    }
    const result = deriveQualificationAssessment(input)
    expect(original.is_business).toBe(true)
    expect(result.business_check.status).toBe('not_applicable')
    expect(result.offer_eligibility_check).toMatchObject({ verdict: 'failed', reason: 'customer_type_offer_mismatch' })
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
  })

  it('when human confirms inquiry after definitive email failure, then call points do not waive failed contact check', () => {
    const input = facts()
    input.customerConfirmation = confirmationFromOutcome('confirmed_business')
    input.email = {
      status: 'checked', verdict: 'failed', reason: 'undeliverable_mailbox',
      breakdown: { mxStatus: 'present', deliveryVerdict: 'undeliverable', deliveryReason: null, deliveryStatus: 'completed' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.customerConfirmation).toBe(15)
    expect(result.email_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
  })
  it('when registry confirms a corporation, then name evidence is not double-counted', () => {
    const input = facts()
    input.companyName = 'Example GmbH'
    expect(
      deriveQualificationAssessment(input).qualification_score_breakdown
    ).toMatchObject({
      points: { corporationLegalForm: 5 },
      legalFormBasis: 'registry',
    })
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'no_match',
      breakdown: { registry: lookup, directory: lookup },
    }
    expect(
      deriveQualificationAssessment(input).qualification_score_breakdown
        .legalFormBasis
    ).toBe('submitted_name')
  })

  it('when a business website earns five points, then persisted evidence identifies HTTP reachability', () => {
    const result = deriveQualificationAssessment(facts())
    expect(result.qualification_score_breakdown.points.website).toBe(5)
    expect(result.qualification_score_breakdown).toMatchObject({
      websiteBasis: 'http_reachable',
    })
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when a stored website contribution lacks HTTP reachability provenance, then it cannot authorise handoff', () => {
    const result = deriveQualificationAssessment(facts())
    expect(result.qualification_score_breakdown.points.website).toBe(5)
    const missingBasis = structuredClone(result)
    Reflect.deleteProperty(
      missingBasis.qualification_score_breakdown,
      'websiteBasis'
    )
    expect(parseQualificationAssessment(missingBasis)).toBeNull()
    expect(canHandOffAssessment(missingBasis, false)).toBe(false)
  })

  it('when all business signals and a call pass, then totals 100 (85 without call)', () => {
    const input = facts()
    expect(deriveQualificationAssessment(input).qualification_score).toBe(85)
    expect(
      deriveQualificationAssessment(confirmed(input)).qualification_score
    ).toBe(100)
  })

  it('when a business check claims passed without qualifying lookup facts, then evidence stays unconfirmed', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'passed',
      reason: 'registry_match',
      breakdown: {
        registry: {
          status: 'checked',
          result: 'match',
          active: false,
          nameMatched: true,
        },
        directory: {
          status: 'checked',
          result: 'no_match',
          nameMatched: false,
          addressMatched: false,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.business_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(0)
    expect(canHandOffAssessment(result, false)).toBe(false)
  })

  it('when customer confirms business without lookups, then confirmation supplies limited evidence', () => {
    const input = confirmed(facts())
    input.business = {
      status: 'not_checked',
      verdict: 'pending',
      reason: 'no_lookup',
    }
    const result = deriveQualificationAssessment(input)
    expect(result.business_check).toEqual({
      status: 'checked',
      verdict: 'passed_with_limitations',
      reason: 'customer_confirmed',
      breakdown: {
        registry: lookup,
        directory: lookup,
        confirmation: { basis: 'customer_confirmed', source: 'human' },
      },
    })
    expect(result.qualification_evidence_state).toBe('checks_satisfied')
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when a reached customer requests a callback despite positive flags, then confirmation and business evidence stay pending', () => {
    const input = facts()
    input.business = {
      status: 'not_checked',
      verdict: 'pending',
      reason: 'no_lookup',
    }
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'pending',
      reason: 'callback_requested',
      breakdown: {
        source: 'human',
        reached: true,
        confirmedInquiry: true,
        confirmedBusiness: true,
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.customer_confirmation_check.verdict).toBe('pending')
    expect(result.customer_confirmation_check.reason).toBe('callback_requested')
    expect(result.business_check.verdict).toBe('pending')
    expect(
      result.qualification_score_breakdown.points.customerConfirmation
    ).toBe(0)
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        customer_confirmation_check: {
          ...result.customer_confirmation_check,
          verdict: 'passed',
        },
      })
    ).toBeNull()
  })

  it('when a private customer has a language barrier despite positive flags, then no call points are awarded', () => {
    const input = confirmed({ ...facts(), customerType: 'private' })
    input.customerConfirmation = {
      ...input.customerConfirmation,
      reason: 'language_barrier',
    }
    const result = deriveQualificationAssessment(input)
    expect(result.customer_confirmation_check.verdict).toBe('pending')
    expect(
      result.qualification_score_breakdown.points.customerConfirmation
    ).toBe(0)
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when a checked positive call claims passed but inquiry was not confirmed, then it remains pending', () => {
    const input = { ...facts(), customerType: 'private' as const }
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: { source: 'human', reached: true, confirmedInquiry: false },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.customer_confirmation_check.verdict).toBe('pending')
    expect(
      result.qualification_score_breakdown.points.customerConfirmation
    ).toBe(0)
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        customer_confirmation_check: input.customerConfirmation,
      })
    ).toBeNull()
  })

  it('when a business inquiry has an inapplicable business check, then evidence stays unconfirmed', () => {
    const input = facts()
    input.business = { status: 'not_applicable', verdict: null, reason: null }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when a required contact check is marked inapplicable, then it cannot claim satisfied core evidence', () => {
    const input = facts()
    input.email = { status: 'not_applicable', verdict: null, reason: null }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
  })

  it('when a persisted row marks required email evidence inapplicable, then it is not a complete v2 assessment', () => {
    const input = facts()
    input.email = { status: 'not_applicable', verdict: null, reason: null }
    const result = deriveQualificationAssessment(input)
    expect(parseQualificationAssessment(result)).toBeNull()
  })

  it('when a required check is inapplicable at score 75, then handoff rejects the incomplete assessment', () => {
    const input = facts()
    input.email = { status: 'not_applicable', verdict: null, reason: null }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(75)
    expect(parseQualificationAssessment(result)).toBeNull()
    expect(canHandOffAssessment(result, false)).toBe(false)
    expect(canHandOffAssessment(result, true)).toBe(false)
  })

  it('when required phone or address evidence is inapplicable, then v2 parsing rejects it', () => {
    for (const key of ['phone', 'address'] as const) {
      const input = facts()
      input[key] = { status: 'not_applicable', verdict: null, reason: null }
      const result = deriveQualificationAssessment(input)
      expect(result.qualification_evidence_state).toBe(
        'core_requirements_unresolved'
      )
      expect(parseQualificationAssessment(result)).toBeNull()
    }
  })

  it('when a persisted business row claims business is inapplicable, then it is not a complete v2 assessment', () => {
    const input = facts()
    input.business = { status: 'not_applicable', verdict: null, reason: null }
    const result = deriveQualificationAssessment(input)
    expect(
      parseQualificationAssessment({
        ...result,
        business_check: input.business,
      })
    ).toBeNull()
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when private signals pass, then totals 80 before call and 100 after', () => {
    const input = { ...facts(), customerType: 'private' as const }
    const before = deriveQualificationAssessment(input)
    expect(before.qualification_score).toBe(80)
    expect(before.business_check.status).toBe('not_applicable')
    expect(before.qualification_score_breakdown.points.businessLookup).toBe(0)
    expect(
      deriveQualificationAssessment(confirmed(input)).qualification_score
    ).toBe(100)
  })

  it('when private evidence includes business-only signals, then they earn zero and never assert business verification', () => {
    const input = { ...facts(), customerType: 'private' as const }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points).toMatchObject({
      businessLookup: 0,
      corporateDomain: 0,
      website: 0,
      corporationLegalForm: 0,
    })
    expect(
      result.qualification_score_breakdown.businessLookupBasis
    ).toBeUndefined()
    expect(result.qualification_score_breakdown.legalFormBasis).toBeUndefined()
    expect(result.business_check.status).toBe('not_applicable')
    expect(result.qualification_evidence_state).toBe('checks_satisfied')
  })

  it('when an asked need is concrete, then distinct business and private urgency points are earned', () => {
    for (const [customerType, points] of [
      ['business', 7],
      ['private', 15],
    ] as const) {
      const input = { ...facts(), customerType, urgency: 'concrete' as const }
      const result = deriveQualificationAssessment(input)
      expect(result.qualification_score_breakdown.points.urgency).toBe(points)
      expect(result.qualification_evidence_state).toBe('checks_satisfied')
    }
  })

  it('when business has only a name directory hit, then 72 can hand off with pending business', () => {
    const input = facts()
    input.companyName = 'Example GmbH'
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'customer_confirmation_needed',
      breakdown: {
        registry: { status: 'checked', result: 'no_match' },
        directory: {
          status: 'checked',
          result: 'no_match',
          nameMatched: true,
          addressMatched: false,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(72)
    expect(result.qualification_score_breakdown.businessLookupBasis).toBe(
      'directory_name'
    )
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
    expect(canHandOffAssessment(result, false)).toBe(true)
    expect(result.business_check.verdict).toBe('pending')
  })

  it('when both registry and full directory match, then lookup awards only registry points', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'passed',
      reason: 'registry_match',
      breakdown: {
        registry: {
          status: 'checked',
          result: 'match',
          active: true,
          nameMatched: true,
        },
        directory: {
          status: 'checked',
          result: 'match',
          operational: true,
          nameMatched: true,
          addressMatched: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(25)
    expect(result.qualification_score_breakdown.businessLookupBasis).toBe(
      'registry'
    )
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when only directory address matches, then five lookup points do not claim full corroboration', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'customer_confirmation_needed',
      breakdown: {
        registry: { status: 'checked', result: 'no_match' },
        directory: {
          status: 'checked',
          result: 'no_match',
          operational: true,
          nameMatched: false,
          addressMatched: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(5)
    expect(result.qualification_score_breakdown.businessLookupBasis).toBe(
      'directory_address'
    )
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
    expect(result.business_check.verdict).toBe('pending')
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when score is exactly 70, then automatic handoff is eligible', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'no_match',
      breakdown: {
        registry: lookup,
        directory: {
          status: 'checked',
          result: 'no_match',
          nameMatched: false,
          addressMatched: false,
        },
      },
    }
    input.reachableWebsite = null
    expect(deriveQualificationAssessment(input).qualification_score).toBe(50)
    input.business = {
      ...input.business,
      breakdown: {
        registry: lookup,
        directory: {
          status: 'checked',
          result: 'match',
          nameMatched: true,
          addressMatched: true,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(70)
    expect(canHandOffAssessment(result, false)).toBe(true)
  })

  it('when a business inquiry earns 69 with only a name hit, then automatic handoff is denied but approval preserves pending evidence', () => {
    const input = facts()
    input.companyName = 'Example GmbH'
    input.urgency = 'concrete'
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'customer_confirmation_needed',
      breakdown: {
        registry: lookup,
        directory: {
          status: 'checked',
          result: 'no_match',
          nameMatched: true,
          addressMatched: false,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(69)
    expect(result.business_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
    expect(canHandOffAssessment(result, false)).toBe(false)
    expect(canHandOffAssessment(result, true)).toBe(true)
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when lookup is partial and providers unavailable, then earns only partial points without inventing success', () => {
    const input = facts()
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'provider_down',
    }
    input.business = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'registry_down',
      breakdown: {
        registry: { status: 'unavailable', result: null },
        directory: {
          status: 'checked',
          result: 'no_match',
          addressMatched: true,
          nameMatched: false,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.email).toBe(0)
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(5)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
  })

  it('when a directory partial hit has no operational evidence, then earns no lookup points', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'unconfirmed',
      breakdown: {
        registry: lookup,
        directory: {
          status: 'checked',
          result: 'no_match',
          nameMatched: true,
          addressMatched: false,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(0)
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when directory returned no assessed result despite residual match flags, then earns no lookup points', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'unassessed',
      breakdown: {
        registry: lookup,
        directory: {
          status: 'checked',
          result: null,
          nameMatched: true,
          addressMatched: true,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(0)
    expect(
      result.qualification_score_breakdown.businessLookupBasis
    ).toBeUndefined()
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when directory says no match despite full-match flags, then earns no lookup points', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'no_match',
      breakdown: {
        registry: lookup,
        directory: {
          status: 'checked',
          result: 'no_match',
          nameMatched: true,
          addressMatched: true,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(0)
    expect(
      result.qualification_score_breakdown.businessLookupBasis
    ).toBeUndefined()
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when urgency missing on an asked form, then earns zero and leaves core unresolved', () => {
    const input = facts()
    input.urgency = null
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.urgency).toBe(0)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
  })

  it('when an asked urgency has an unrecognised stored value, then it earns zero and leaves core unresolved', () => {
    const input = facts()
    input.urgency = 'later' as unknown as QualificationFacts['urgency']
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.urgency).toBe(0)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(canHandOffAssessment(result, false)).toBe(true)
  })

  it('when urgency was not asked but a value is present, then it earns no points and does not block', () => {
    const input = facts()
    input.urgencyAsked = false
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.urgency).toBe(0)
    expect(result.qualification_evidence_state).toBe('checks_satisfied')
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when required urgency is unanswered but score remains above 70, then evidence stays pending and handoff remains eligible', () => {
    const input = facts()
    input.urgency = null
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(75)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(canHandOffAssessment(result, false)).toBe(true)
  })

  it('when provider evidence is uncertain, then supplied failures cannot block handoff', () => {
    const input = facts()
    input.email = {
      status: 'unavailable',
      verdict: 'failed',
      reason: 'provider_down',
    }
    input.phone = {
      status: 'checked',
      verdict: 'failed',
      reason: 'unreachable',
      breakdown: {
        valid: null,
        lineStatus: 'unreachable',
        lookupStatus: 'completed',
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.email_check.verdict).toBe('pending')
    expect(result.phone_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(canHandOffAssessment(result, true)).toBe(true)
    expect(
      parseQualificationAssessment({
        ...result,
        email_check: input.email,
        qualification_evidence_state: 'check_failed',
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        phone_check: input.phone,
        qualification_evidence_state: 'check_failed',
      })
    ).toBeNull()
  })

  it.each(['business', 'private'] as const)(
    'when a reached %s customer loses interest after confirming the inquiry, then handoff is blocked',
    (customerType) => {
      const input = confirmed(facts())
      input.customerType = customerType
      input.customerConfirmation = {
        status: 'checked',
        verdict: 'failed',
        reason: 'no_longer_interested',
        breakdown: {
          source: 'human',
          reached: true,
          confirmedInquiry: true,
          confirmedBusiness: customerType === 'business',
        },
      }
      const result = deriveQualificationAssessment(input)
      expect(result.customer_confirmation_check.verdict).toBe('failed')
      expect(result.qualification_evidence_state).toBe('check_failed')
      expect(canHandOffAssessment(result, true)).toBe(false)
      expect(parseQualificationAssessment(result)).not.toBeNull()
    }
  )

  it.each(['business', 'private'] as const)(
    'when reached %s call records wrong person despite positive inquiry, then it blocks handoff and persisted pass',
    (customerType) => {
      const input = confirmed(facts())
      input.customerType = customerType
      input.customerConfirmation = {
        status: 'checked',
        verdict: 'failed',
        reason: 'wrong_person',
        breakdown: {
          source: 'human',
          reached: true,
          confirmedInquiry: true,
          confirmedBusiness: customerType === 'business',
        },
      }
      const result = deriveQualificationAssessment(input)
      expect(result.customer_confirmation_check.verdict).toBe('failed')
      expect(result.qualification_evidence_state).toBe('check_failed')
      expect(canHandOffAssessment(result, true)).toBe(false)
      expect(parseQualificationAssessment(result)).not.toBeNull()
      const persisted = deriveQualificationAssessment(
        confirmed({ ...facts(), customerType })
      )
      expect(
        parseQualificationAssessment({
          ...persisted,
          customer_confirmation_check: {
            ...persisted.customer_confirmation_check,
            reason: 'wrong_person',
            breakdown: input.customerConfirmation.breakdown,
          },
        })
      ).toBeNull()
    }
  )

  it('when a negative call follows another pending check, then failure wins at any score', () => {
    const input = confirmed(facts())
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'timeout',
    }
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'failed',
      reason: 'wrong_person',
      breakdown: { source: 'human', reached: true, confirmedInquiry: false },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
  })

  it('when below threshold with approval, then handoff does not alter evidence', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'no_match',
      breakdown: { registry: lookup, directory: lookup },
    }
    const result = deriveQualificationAssessment(input)
    expect(canHandOffAssessment(result, false)).toBe(false)
    expect(canHandOffAssessment(result, true)).toBe(true)
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when phone facts show an invalid number despite a passed verdict, then hard failure blocks automatic handoff', () => {
    const input = facts()
    input.phone = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        valid: false,
        lineStatus: 'inactive',
        lookupStatus: 'completed',
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.phone_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, false)).toBe(false)
  })

  it('when completed mailbox evidence contradicts a supplied pass, then the factual outcome sets the verdict and points', () => {
    for (const [deliveryVerdict, verdict, points] of [
      ['risky', 'passed_with_limitations', 5],
      ['deliverable', 'passed', 10],
    ] as const) {
      const input = facts()
      input.email = {
        status: 'checked',
        verdict:
          deliveryVerdict === 'risky' ? 'passed' : 'passed_with_limitations',
        reason: null,
        breakdown: {
          mxStatus: 'present',
          deliveryVerdict,
          deliveryReason: null,
          deliveryStatus: 'completed',
        },
      }
      const result = deriveQualificationAssessment(input)
      expect(result.email_check.verdict).toBe(verdict)
      expect(result.qualification_score_breakdown.points.email).toBe(points)
      expect(result.qualification_evidence_state).toBe('checks_satisfied')
      expect(parseQualificationAssessment(result)).not.toBeNull()
    }
  })

  it('when reached customer denies inquiry despite a pending input verdict, then denial blocks high-scoring handoff', () => {
    const input = facts()
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'pending',
      reason: 'wrong_person',
      breakdown: { source: 'human', reached: true, confirmedInquiry: false },
    }
    const result = deriveQualificationAssessment(input)
    expect(canHandOffAssessment(result, false)).toBe(false)
    expect(result.customer_confirmation_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
  })

  it('when email delivery is definitively undeliverable, then hard failure blocks even a high score and manual approval', () => {
    const input = facts()
    input.email = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        mxStatus: 'present',
        deliveryVerdict: 'undeliverable',
        deliveryReason: 'rejected',
        deliveryStatus: 'completed',
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.email_check.verdict).toBe('failed')
    expect(result.qualification_score_breakdown.points.email).toBe(0)
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
  })

  it('when email facts confirm no MX despite a passed verdict, then hard failure blocks manual handoff', () => {
    const input = facts()
    input.email = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        mxStatus: 'absent',
        deliveryVerdict: null,
        deliveryReason: null,
        deliveryStatus: 'not_checked',
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.email_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
  })

  it('when persisted contact verdict contradicts definitive failure facts, then parsing rejects it', () => {
    const input = facts()
    input.phone = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'lookup_down',
    }
    const withoutPhone = deriveQualificationAssessment(input)
    expect(
      parseQualificationAssessment({
        ...withoutPhone,
        phone_check: {
          status: 'checked',
          verdict: 'passed',
          reason: null,
          breakdown: {
            valid: false,
            lineStatus: 'inactive',
            lookupStatus: 'completed',
          },
        },
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
    input.phone = facts().phone
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'dns_down',
    }
    const withoutEmail = deriveQualificationAssessment(input)
    expect(
      parseQualificationAssessment({
        ...withoutEmail,
        email_check: {
          status: 'checked',
          verdict: 'passed',
          reason: null,
          breakdown: {
            mxStatus: 'absent',
            deliveryVerdict: null,
            deliveryReason: null,
            deliveryStatus: 'not_checked',
          },
        },
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
  })

  it('when persisted core check is unavailable but claims a pass, then parsing rejects it', () => {
    const input = facts()
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'provider_down',
    }
    const result = deriveQualificationAssessment(input)
    expect(
      parseQualificationAssessment({
        ...result,
        email_check: { status: 'unavailable', verdict: 'passed', reason: null },
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
  })

  it('when both business searches find no match and incoming verdict claims failure, then business remains unconfirmed', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'failed',
      reason: 'no_listing',
      breakdown: {
        registry: { status: 'checked', result: 'no_match' },
        directory: { status: 'checked', result: 'no_match' },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.business_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
    expect(result.qualification_score).toBe(55)
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(canHandOffAssessment(result, true)).toBe(true)
    expect(
      parseQualificationAssessment({
        ...result,
        business_check: { ...result.business_check, verdict: 'failed' },
        qualification_evidence_state: 'check_failed',
      })
    ).toBeNull()
  })

  it('when a reached customer denies an inquiry after a registry match, then business evidence fails too', () => {
    const input = facts()
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'failed',
      reason: 'customer_denies_inquiry',
      breakdown: { source: 'human', reached: true, confirmedInquiry: false },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.business_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it.each(['business', 'private'] as const)(
    'when a reached %s customer denies an inquiry without a confirmation flag, then handoff is blocked',
    (customerType) => {
      const input = facts()
      input.customerType = customerType
      input.customerConfirmation = {
        status: 'checked',
        verdict: 'pending',
        reason: 'customer_denies_inquiry',
        breakdown: { source: 'human', reached: true },
      }
      const result = deriveQualificationAssessment(input)
      expect(result.qualification_score).toBe(
        customerType === 'business' ? 85 : 80
      )
      expect(result.customer_confirmation_check.verdict).toBe('failed')
      expect(result.qualification_evidence_state).toBe('check_failed')
      expect(parseQualificationAssessment(result)).not.toBeNull()
      expect(canHandOffAssessment(result, false)).toBe(false)
      expect(canHandOffAssessment(result, true)).toBe(false)
    }
  )

  it('when persisted denial evidence contradicts its verdict or confirmation flag, then v2 parsing rejects it', () => {
    const input = facts()
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'failed',
      reason: 'customer_denies_inquiry',
      breakdown: { source: 'human', reached: true },
    }
    const result = deriveQualificationAssessment(input)
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        customer_confirmation_check: {
          ...result.customer_confirmation_check,
          verdict: 'pending',
        },
        business_check: { ...result.business_check, verdict: 'pending' },
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        customer_confirmation_check: {
          ...result.customer_confirmation_check,
          breakdown: { source: 'human', reached: true, confirmedInquiry: true },
        },
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        customer_confirmation_check: {
          ...result.customer_confirmation_check,
          breakdown: {
            source: 'human',
            reached: true,
            confirmedBusiness: true,
          },
        },
      })
    ).toBeNull()
  })

  it('when confirmation is withdrawn, then stale business confirmation disappears', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'passed_with_limitations',
      reason: 'customer_confirmed',
      breakdown: {
        registry: lookup,
        directory: lookup,
        confirmation: { basis: 'customer_confirmed', source: 'human' },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.business_check.verdict).toBe('pending')
    expect(
      result.business_check.status !== 'not_applicable' &&
        result.business_check.breakdown?.confirmation
    ).toBeUndefined()
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when a materially changed identity withdraws a prior business call, then stale confirmation and call points disappear', () => {
    const input = facts()
    input.business = {
      status: 'checked', verdict: 'pending', reason: 'customer_confirmation_needed',
      breakdown: { registry: lookup, directory: lookup },
    }
    const before = deriveQualificationAssessment({
      ...input,
      customerConfirmation: confirmationFromOutcome('confirmed_business'),
    })
    expect(before.business_check.verdict).toBe('passed_with_limitations')
    expect(before.qualification_score_breakdown.points.customerConfirmation).toBe(15)

    const after = deriveQualificationAssessment({
      ...input,
      customerConfirmation: { status: 'not_checked', verdict: 'pending', reason: null },
    })
    expect(after.business_check.verdict).toBe('pending')
    expect(after.business_check.status !== 'not_applicable' && after.business_check.breakdown?.confirmation).toBeUndefined()
    expect(after.qualification_score_breakdown.points.customerConfirmation).toBe(0)
    expect(after.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when a persisted business check retains a withdrawn confirmation, then v2 parsing rejects stale evidence', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'customer_confirmation_needed',
      breakdown: { registry: lookup, directory: lookup },
    }
    const pending = deriveQualificationAssessment(input)
    expect(parseQualificationAssessment(pending)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...pending,
        business_check: {
          ...pending.business_check,
          breakdown: {
            registry: lookup,
            directory: lookup,
            confirmation: { basis: 'customer_confirmed', source: 'human' },
          },
        },
      })
    ).toBeNull()
  })

  it('when no offer is selected and urgency was not asked, then neither is a core gate or a point source', () => {
    const input = facts()
    input.offerEligibility = {
      status: 'not_applicable',
      verdict: null,
      reason: null,
    }
    input.urgencyAsked = false
    input.urgency = null
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_evidence_state).toBe('checks_satisfied')
    expect(result.qualification_score_breakdown.points.urgency).toBe(0)
  })

  it('when a selected offer claims a limitation without an accepted exception, then it remains pending', () => {
    const input = facts()
    input.offerEligibility = {
      status: 'checked',
      verdict: 'passed_with_limitations',
      reason: null,
      breakdown: { audience: 'both' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.offer_eligibility_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(
      parseQualificationAssessment({
        ...result,
        offer_eligibility_check: input.offerEligibility,
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
  })

  it('when selected-offer audience is missing, then eligibility remains unresolved rather than passed', () => {
    const input = facts()
    input.offerEligibility = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {},
    }
    const result = deriveQualificationAssessment(input)
    expect(result.offer_eligibility_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
  })

  it('when a private customer denies the inquiry at a high score, then failure blocks handoff', () => {
    const input = { ...facts(), customerType: 'private' as const }
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'failed',
      reason: 'customer_denies_inquiry',
      breakdown: {
        source: 'human',
        reached: true,
        confirmedInquiry: false,
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(80)
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
  })

  it.each(['business', 'private'] as const)(
    'when %s call is unreached but marked failed, then it cannot block handoff',
    (customerType) => {
      const input = facts()
      input.customerType = customerType
      input.customerConfirmation = {
        status: 'checked',
        verdict: 'failed',
        reason: 'wrong_person',
        breakdown: { source: 'human', reached: false },
      }
      const result = deriveQualificationAssessment(input)
      expect(result.customer_confirmation_check.verdict).toBe('pending')
      expect(result.qualification_evidence_state).toBe('checks_satisfied')
      expect(
        result.qualification_score_breakdown.points.customerConfirmation
      ).toBe(0)
      expect(canHandOffAssessment(result, false)).toBe(true)
      expect(
        parseQualificationAssessment({
          ...result,
          customer_confirmation_check: input.customerConfirmation,
          qualification_evidence_state: 'check_failed',
        })
      ).toBeNull()
    }
  )

  it('when a call goes unanswered, then it earns no points or business corroboration', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'customer_confirmation_needed',
      breakdown: {
        registry: lookup,
        directory: lookup,
      },
    }
    input.customerConfirmation = {
      status: 'checked',
      verdict: 'pending',
      reason: 'not_reached',
      breakdown: {
        source: 'human',
        reached: false,
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(
      result.qualification_score_breakdown.points.customerConfirmation
    ).toBe(0)
    expect(result.business_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe('business_unconfirmed')
  })

  it('when confirmation is not checked, then stale confirmation facts earn no call points', () => {
    const input = facts()
    input.customerConfirmation = {
      status: 'not_checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        source: 'human',
        reached: true,
        confirmedInquiry: true,
        confirmedBusiness: true,
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(
      result.qualification_score_breakdown.points.customerConfirmation
    ).toBe(0)
    expect(result.qualification_score).toBe(85)
  })

  it('when an unrecorded call carries stale negative evidence, then it does not fail qualification', () => {
    const input = facts()
    input.customerConfirmation = {
      status: 'not_checked',
      verdict: 'failed',
      reason: 'wrong_person',
      breakdown: { source: 'human', reached: true, confirmedInquiry: false },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.customer_confirmation_check.verdict).toBe('pending')
    expect(result.customer_confirmation_check).not.toHaveProperty('breakdown')
    expect(result.qualification_evidence_state).toBe('checks_satisfied')
    expect(
      result.qualification_score_breakdown.points.customerConfirmation
    ).toBe(0)
    expect(canHandOffAssessment(result, false)).toBe(true)
  })

  it('when both lookups contribute, then only the best qualifying result is scored', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'passed',
      reason: 'registry_match',
      breakdown: {
        registry: {
          status: 'checked',
          result: 'match',
          active: true,
          nameMatched: true,
        },
        directory: {
          status: 'checked',
          result: 'match',
          nameMatched: true,
          addressMatched: true,
          operational: true,
        },
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(25)
    expect(result.qualification_score_breakdown.businessLookupBasis).toBe(
      'registry'
    )
  })

  it('when a core provider is unavailable at score 70 or above, then evidence remains unresolved but handoff is eligible', () => {
    const input = confirmed(facts())
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'provider_down',
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(90)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(canHandOffAssessment(result, false)).toBe(true)
  })

  it('when a persisted v2 row claims all checks satisfied despite unresolved core evidence, then parsing rejects it', () => {
    const input = facts()
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'provider_down',
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(
      parseQualificationAssessment({
        ...result,
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when persisted business evidence is pending or failed, then parsing rejects a contradictory state', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'no_match',
      breakdown: {
        registry: lookup,
        directory: lookup,
      },
    }
    const pending = deriveQualificationAssessment(input)
    expect(
      parseQualificationAssessment({
        ...pending,
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...pending,
        business_check: { ...pending.business_check, verdict: 'failed' },
        qualification_evidence_state: 'check_failed',
      })
    ).toBeNull()
  })

  it('when urgency earns zero, then parsing preserves both unanswered and information-answer assessments', () => {
    const input = facts()
    input.urgency = null
    expect(
      parseQualificationAssessment(deriveQualificationAssessment(input))
    ).not.toBeNull()
    input.urgency = 'information'
    expect(
      parseQualificationAssessment(deriveQualificationAssessment(input))
    ).not.toBeNull()
  })

  it('when an asked urgency is unanswered, then a persisted satisfied-state claim is rejected', () => {
    const input = facts()
    input.urgency = null
    const result = deriveQualificationAssessment(input)
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
  })

  it('when persisted points claim a phone passed while its check is pending, then row cannot authorise handoff', () => {
    const input = facts()
    input.phone = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'lookup_down',
    }
    const result = deriveQualificationAssessment(input)
    const inflated = {
      ...result,
      qualification_score: result.qualification_score + 10,
      qualification_score_breakdown: {
        ...result.qualification_score_breakdown,
        points: { ...result.qualification_score_breakdown.points, phone: 10 },
      },
    }
    expect(parseQualificationAssessment(inflated)).toBeNull()
  })

  it('when persisted business check claims a pass from an inactive registry, then parsing rejects it', () => {
    const result = deriveQualificationAssessment(facts())
    expect(
      parseQualificationAssessment({
        ...result,
        business_check: {
          ...result.business_check,
          breakdown: {
            registry: {
              status: 'checked',
              result: 'match',
              active: false,
              nameMatched: true,
            },
            directory: lookup,
          },
        },
      })
    ).toBeNull()
  })

  it('when persisted email or address points exceed their check evidence, then parsing rejects them', () => {
    const result = deriveQualificationAssessment(facts())
    expect(
      parseQualificationAssessment({
        ...result,
        email_check: {
          status: 'checked',
          verdict: 'passed_with_limitations',
          reason: 'risky_mailbox',
          breakdown: {
            mxStatus: 'present',
            deliveryVerdict: 'risky',
            deliveryReason: null,
            deliveryStatus: 'completed',
          },
        },
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        address_check: {
          status: 'checked',
          verdict: 'passed_with_limitations',
          reason: 'street_level_exception',
          breakdown: { level: 'street_level' },
        },
      })
    ).toBeNull()
  })

  it('when persisted call points have no recorded confirmation, then row cannot authorise handoff', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'no_match',
      breakdown: { registry: lookup, directory: lookup },
    }
    const result = deriveQualificationAssessment(input)
    const inflated = {
      ...result,
      qualification_score: result.qualification_score + 15,
      qualification_score_breakdown: {
        ...result.qualification_score_breakdown,
        points: {
          ...result.qualification_score_breakdown.points,
          customerConfirmation: 15,
        },
      },
    }
    expect(parseQualificationAssessment(inflated)).toBeNull()
  })

  it('when address is not verified but its verdict claims passed, then core evidence remains unresolved', () => {
    const input = facts()
    input.address = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: { level: 'not_verified' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.address_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    input.address = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: { level: 'full', route: 'unknown' },
    }
    expect(deriveQualificationAssessment(input).address_check.verdict).toBe(
      'pending'
    )
  })

  it.each(['route', 'postal_code', 'locality', 'street_number'] as const)(
    'when full address lacks %s, derivation and persisted parsing cannot treat it as verified',
    (component) => {
      const input = facts()
      if (input.address.status === 'not_applicable') throw new Error('fixture')
      input.address = {
        ...input.address,
        breakdown: { ...input.address.breakdown, [component]: undefined },
      }
      const result = deriveQualificationAssessment(input)
      expect(result.address_check.verdict).toBe('pending')
      expect(result.qualification_score_breakdown.points.address).toBe(0)
      expect(result.qualification_evidence_state).toBe(
        'core_requirements_unresolved'
      )
      expect(parseQualificationAssessment(result)).not.toBeNull()
      const complete = deriveQualificationAssessment(facts())
      expect(
        parseQualificationAssessment({
          ...complete,
          address_check: input.address,
        })
      ).toBeNull()
    }
  )

  it('when a full-level address lacks the required house number, then it remains pending even at a high score', () => {
    const input = facts()
    input.address = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        level: 'full',
        route: 'confirmed',
        postal_code: 'confirmed',
        locality: 'confirmed',
        street_number: 'missing',
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.address_check.verdict).toBe('pending')
    expect(result.qualification_score_breakdown.points.address).toBe(0)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
  })

  it('when a definitive address failure is recorded, then pending core checks cannot override the hard gate', () => {
    const input = facts()
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'dns_down',
    }
    input.address = {
      status: 'checked',
      verdict: 'failed',
      reason: 'definitive_invalid_address',
      breakdown: { level: 'not_verified' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.address_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
  })

  it('accepts street-level evidence only for eligible non-Allane inquiries', () => {
    const input = facts()
    input.address = {
      status: 'checked',
      verdict: 'passed_with_limitations',
      reason: 'street_level_exception',
      breakdown: {
        level: 'street_level',
        route: 'confirmed',
        postal_code: 'confirmed',
        locality: 'confirmed',
        street_number: 'missing',
      },
    }
    const allane = deriveQualificationAssessment(input)
    expect(allane.address_check.verdict).toBe('pending')
    expect(allane.qualification_score_breakdown.points.address).toBe(0)
    expect(parseQualificationAssessment(allane)).not.toBeNull()

    input.streetLevelExceptionEligible = true
    const eligible = deriveQualificationAssessment(input)
    expect(eligible.address_check.verdict).toBe('passed_with_limitations')
    expect(eligible.qualification_score_breakdown.points.address).toBe(5)
    expect(parseQualificationAssessment(eligible)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...eligible,
        address_check: {
          ...input.address,
        },
      })
    ).toBeNull()
  })

  it('when a valid phone has no confirmed line status, then its verdict retains the limitation', () => {
    const input = facts()
    input.phone = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: { valid: true, lineStatus: null, lookupStatus: 'completed' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.phone_check.verdict).toBe('passed_with_limitations')
    expect(result.phone_check.reason).toBe('line_status_not_returned')
    expect(result.qualification_score_breakdown.points.phone).toBe(10)
  })

  it('when completed lookup returns unknown line status, then valid phone scores with limitations', () => {
    const input = facts()
    input.phone = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: {
        valid: true,
        lineStatus: 'unknown',
        lookupStatus: 'completed',
      },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.phone_check.verdict).toBe('passed_with_limitations')
    expect(result.qualification_score_breakdown.points.phone).toBe(10)
    expect(parseQualificationAssessment(result)).not.toBeNull()
    input.phone = {
      ...input.phone,
      breakdown: { ...input.phone.breakdown!, lineStatus: 'unreachable' },
    }
    const unreachable = deriveQualificationAssessment(input)
    expect(unreachable.phone_check.verdict).toBe('pending')
    expect(unreachable.qualification_score_breakdown.points.phone).toBe(0)
  })

  it('when phone and address facts resolve but offer-fit details are still pending, then only the resolved checks pass', () => {
    const input = facts()
    input.phone = {
      status: 'checked',
      verdict: 'pending',
      reason: 'not_checked',
      breakdown: {
        valid: true,
        lineStatus: 'active',
        lookupStatus: 'completed',
      },
    }
    input.address = {
      status: 'checked',
      verdict: 'pending',
      reason: 'not_checked',
      breakdown: { ...facts().address.breakdown },
    }
    input.offerEligibility = {
      status: 'checked',
      verdict: 'pending',
      reason: 'not_checked',
      breakdown: { audience: 'both' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.phone_check.verdict).toBe('passed')
    expect(result.address_check.verdict).toBe('passed')
    expect(result.offer_eligibility_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('rejects persisted checks contradicting address precision or phone line evidence', () => {
    const result = deriveQualificationAssessment(facts())
    expect(
      parseQualificationAssessment({
        ...result,
        address_check: {
          status: 'checked',
          verdict: 'passed',
          reason: null,
          breakdown: { level: 'not_verified' },
        },
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        address_check: {
          status: 'checked',
          verdict: 'passed',
          reason: null,
          breakdown: { level: 'full', route: 'unknown' },
        },
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        phone_check: {
          status: 'checked',
          verdict: 'passed',
          reason: null,
          breakdown: {
            valid: true,
            lineStatus: null,
            lookupStatus: 'completed',
          },
        },
      })
    ).toBeNull()
  })

  it('rejects internally summed points that do not match v2 weights', () => {
    const result = deriveQualificationAssessment(facts())
    for (const [key, value] of [
      ['phone', 1],
      ['urgency', 9],
      ['corporateDomain', 1],
      ['website', 1],
      ['corporationLegalForm', 1],
    ] as const) {
      const changedScore =
        result.qualification_score -
        result.qualification_score_breakdown.points[key] +
        value
      expect(
        parseQualificationAssessment({
          ...result,
          qualification_score: changedScore,
          qualification_score_breakdown: {
            ...result.qualification_score_breakdown,
            points: {
              ...result.qualification_score_breakdown.points,
              [key]: value,
            },
          },
        }),
        key
      ).toBeNull()
    }
  })

  it('when a private inquiry targets a business-only offer, then contradictory passed input cannot allow handoff', () => {
    const input = { ...facts(), customerType: 'private' as const }
    input.offerEligibility = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: { audience: 'business_only' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.offer_eligibility_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, false)).toBe(false)
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        offer_eligibility_check: input.offerEligibility,
        qualification_evidence_state: 'checks_satisfied',
      })
    ).toBeNull()
  })

  it('when a matching offer audience has a known contradiction, then failure still blocks handoff', () => {
    const input = facts()
    input.offerEligibility = {
      status: 'checked',
      verdict: 'failed',
      reason: 'contradictory_offer_details',
      breakdown: { audience: 'business_only' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.offer_eligibility_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, false)).toBe(false)
  })

  it('when a business inquiry targets a private-only offer, then mismatch fails even with manual approval', () => {
    const input = facts()
    input.offerEligibility = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: { audience: 'private_only' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.offer_eligibility_check.verdict).toBe('failed')
    expect(result.qualification_evidence_state).toBe('check_failed')
    expect(canHandOffAssessment(result, true)).toBe(false)
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('parses complete v2 assessments inside lead rows without exposing unrelated columns', () => {
    const result = deriveQualificationAssessment(facts())
    expect(
      parseQualificationAssessment({ id: 'lead-id', status: 'new', ...result })
    ).toEqual(result)
    expect(
      parseQualificationAssessment({
        id: 'lead-id',
        ...result,
        phone_check: null,
      })
    ).toBeNull()
  })

  it('when persisted eligibility claims passed with no audience, then parsing rejects the incomplete evidence', () => {
    const input = facts()
    input.offerEligibility = {
      status: 'checked',
      verdict: 'passed',
      reason: null,
      breakdown: { audience: 'both' },
    }
    const result = deriveQualificationAssessment(input)
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        offer_eligibility_check: {
          status: 'checked',
          verdict: 'passed',
          reason: null,
          breakdown: {},
        },
      })
    ).toBeNull()
  })

  it('when a placeholder company name has a registry hit, then lookup earns zero without claiming a match', () => {
    const input = facts()
    input.placeholderCompanyName = true
    const result = deriveQualificationAssessment(input)
    expect(result.business_check.verdict).toBe('pending')
    expect(result.qualification_score_breakdown.points.businessLookup).toBe(0)
    expect(parseQualificationAssessment(result)).not.toBeNull()
  })

  it('when a matched registry loses its earned lookup points, then persisted assessment is incomplete', () => {
    const result = deriveQualificationAssessment(facts())
    const missingLookup = {
      ...result,
      qualification_score:
        result.qualification_score -
        result.qualification_score_breakdown.points.businessLookup,
      qualification_score_breakdown: {
        ...result.qualification_score_breakdown,
        points: {
          ...result.qualification_score_breakdown.points,
          businessLookup: 0,
        },
        businessLookupBasis: undefined,
      },
    }
    expect(parseQualificationAssessment(missingLookup)).toBeNull()
  })

  it('when a private inquiry has complete evidence but no call, then its score of 80 permits handoff', () => {
    const input = { ...facts(), customerType: 'private' as const }
    input.customerConfirmation = {
      status: 'not_checked',
      verdict: 'pending',
      reason: 'not_called',
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(80)
    expect(result.qualification_evidence_state).toBe('checks_satisfied')
    expect(result.business_check.status).toBe('not_applicable')
    expect(canHandOffAssessment(result, false)).toBe(true)
  })

  it('when an unresolved core check leaves score below 70, then approval permits handoff without upgrading evidence', () => {
    const input = facts()
    input.business = {
      status: 'checked',
      verdict: 'pending',
      reason: 'no_match',
      breakdown: { registry: lookup, directory: lookup },
    }
    input.email = {
      status: 'unavailable',
      verdict: 'pending',
      reason: 'provider_down',
    }
    const result = deriveQualificationAssessment(input)
    expect(result.qualification_score).toBe(45)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(result.email_check.verdict).toBe('pending')
    expect(canHandOffAssessment(result, false)).toBe(false)
    expect(canHandOffAssessment(result, true)).toBe(true)
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
  })

  it('when offer audience is unknown and incoming verdict says failed, then evidence remains pending', () => {
    const input = facts()
    input.offerEligibility = {
      status: 'checked',
      verdict: 'failed',
      reason: 'ambiguous_customer_type',
      breakdown: {},
    }
    const result = deriveQualificationAssessment(input)
    expect(result.offer_eligibility_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(canHandOffAssessment(result, true)).toBe(true)
    expect(
      parseQualificationAssessment({
        ...result,
        offer_eligibility_check: input.offerEligibility,
        qualification_evidence_state: 'check_failed',
      })
    ).toBeNull()
  })

  it('when an unconfirmed address is marked failed, then it stays pending rather than blocking approval', () => {
    const input = facts()
    input.address = {
      status: 'checked',
      verdict: 'failed',
      reason: 'unconfirmed_address',
      breakdown: { level: 'not_verified', route: 'unconfirmed' },
    }
    const result = deriveQualificationAssessment(input)
    expect(result.address_check.verdict).toBe('pending')
    expect(result.qualification_evidence_state).toBe(
      'core_requirements_unresolved'
    )
    expect(canHandOffAssessment(result, true)).toBe(true)
    expect(
      parseQualificationAssessment({
        ...result,
        address_check: input.address,
        qualification_evidence_state: 'check_failed',
      })
    ).toBeNull()
  })

  it('when old or partial rows are parsed, then they are not v2 assessments', () => {
    const result = deriveQualificationAssessment(facts())
    expect(parseQualificationAssessment(result)).not.toBeNull()
    expect(
      parseQualificationAssessment({
        qualification_score: 100,
        qualification_signals: {},
      })
    ).toBeNull()
    expect(
      parseQualificationAssessment({ ...result, phone_check: null })
    ).toBeNull()
    expect(
      parseQualificationAssessment({
        ...result,
        qualification_score_breakdown: {
          ...result.qualification_score_breakdown,
          version: 1,
        },
      })
    ).toBeNull()
  })
})
