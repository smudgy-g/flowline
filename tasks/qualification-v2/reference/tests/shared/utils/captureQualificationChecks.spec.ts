import { describe, expect, it } from 'vitest'
import {
  addressCaptureCheck,
  emailCaptureCheck,
  offerCaptureCheck,
  phoneCaptureCheck,
} from '#shared/utils/captureQualificationChecks'
import type { PhoneValidationResult } from '#shared/types/phoneValidation'

const noDelivery = {
  status: 'not_checked',
  verdict: null,
  reason: null,
} as const
const phone: PhoneValidationResult = {
  valid: true,
  e164: '+4915112345678',
  countryCode: 'DE',
  lineType: null,
  carrierName: null,
  mobileCountryCode: null,
  mobileNetworkCode: null,
  lineStatus: null,
  lineStatusErrorCode: null,
  failureReason: 'none',
  cached: false,
}
const address = {
  outcome: 'verified' as const,
  hasReplacedComponents: false,
  missingComponentTypes: ['street_number'],
  unconfirmedComponentTypes: [],
  confirmedComponentTypes: ['route', 'postal_code', 'locality'],
  houseNumberPresent: false,
  allane: false,
}

describe('staged factual qualification checks', () => {
  it('when MX is absent versus DNS unavailable, then only the confirmed absence fails', () => {
    expect(emailCaptureCheck('absent', noDelivery).verdict).toBe('failed')
    expect(emailCaptureCheck('unavailable', noDelivery)).toMatchObject({
      status: 'unavailable',
      verdict: 'pending',
      reason: 'dns_unavailable',
    })
  })

  it('when Bouncer is risky, unknown, or unavailable, then only risky earns an accepted limitation', () => {
    expect(
      emailCaptureCheck('present', {
        status: 'completed',
        verdict: 'risky',
        reason: 'low_quality',
      })
    ).toMatchObject({
      verdict: 'passed_with_limitations',
      breakdown: { deliveryReason: 'low_quality' },
    })
    expect(
      emailCaptureCheck('present', {
        status: 'completed',
        verdict: 'unknown',
        reason: 'timeout',
      }).verdict
    ).toBe('pending')
    expect(
      emailCaptureCheck('present', {
        status: 'unavailable',
        verdict: null,
        reason: null,
      }).verdict
    ).toBe('pending')
    expect(
      emailCaptureCheck('present', {
        status: 'completed',
        verdict: 'undeliverable',
        reason: null,
      }).verdict
    ).toBe('failed')
  })

  it('when Twilio supplies no line status versus inactive, then only inactive fails', () => {
    expect(phoneCaptureCheck(phone).verdict).toBe('passed_with_limitations')
    expect(
      phoneCaptureCheck({
        ...phone,
        valid: false,
        lineStatus: 'inactive',
        failureReason: 'line_status_inactive',
      }).verdict
    ).toBe('failed')
    expect(
      phoneCaptureCheck({ ...phone, lineStatus: 'unreachable' }).verdict
    ).toBe('pending')
    expect(
      phoneCaptureCheck({ ...phone, failureReason: 'twilio_unavailable' })
        .verdict
    ).toBe('pending')
  })

  it('when Twilio is unavailable, then valid formatting is not mistaken for a completed lookup', () => {
    expect(
      phoneCaptureCheck({ ...phone, failureReason: 'twilio_unavailable' })
    ).toMatchObject({
      status: 'unavailable',
      verdict: 'pending',
      breakdown: { valid: null, lookupStatus: 'unavailable' },
    })
  })

  it('when confirmed MX has no completed delivery check, then mailbox remains pending', () => {
    expect(emailCaptureCheck('present', noDelivery)).toMatchObject({
      verdict: 'pending',
      breakdown: { mxStatus: 'present', deliveryStatus: 'not_checked' },
    })
  })

  it('when an accepted address has an unconfirmed component, then it remains pending rather than fully verified', () => {
    expect(
      addressCaptureCheck({
        ...address,
        outcome: 'unconfirmed',
        houseNumberPresent: true,
        missingComponentTypes: [],
        unconfirmedComponentTypes: ['street_number'],
      })
    ).toMatchObject({
      verdict: 'pending',
      breakdown: { street_number: 'unconfirmed' },
    })
  })

  it('when a house number is missing, then Allane stays pending and non-Allane retains street-level evidence', () => {
    expect(addressCaptureCheck(address)).toMatchObject({
      verdict: 'passed_with_limitations',
      breakdown: {
        route: 'confirmed',
        postal_code: 'confirmed',
        locality: 'confirmed',
        street_number: 'missing',
      },
    })
    expect(addressCaptureCheck({ ...address, allane: true }).verdict).toBe(
      'pending'
    )
    expect(
      addressCaptureCheck({ ...address, outcome: 'unavailable' }).verdict
    ).toBe('pending')
    expect(
      addressCaptureCheck({ ...address, outcome: 'overridden' }).verdict
    ).toBe('pending')
    expect(
      addressCaptureCheck({ ...address, confirmedComponentTypes: undefined })
    ).toMatchObject({ verdict: 'pending', breakdown: { route: 'unknown' } })
  })

  it('when Google reports a missing house number with confirmed street components, then only non-Allane gets a limited pass', () => {
    const input = { ...address, outcome: 'unverified' as const }
    expect(addressCaptureCheck(input)).toMatchObject({
      verdict: 'passed_with_limitations',
      breakdown: { level: 'street_level' },
    })
    expect(
      addressCaptureCheck({ ...input, houseNumberPresent: true })
    ).toMatchObject({
      verdict: 'pending',
      breakdown: { level: 'not_verified', street_number: 'missing' },
    })
    expect(addressCaptureCheck({ ...input, allane: true })).toMatchObject({
      verdict: 'pending',
      reason: 'house_number_required',
    })
    expect(
      addressCaptureCheck({ ...input, confirmedComponentTypes: [] }).verdict
    ).toBe('pending')
  })

  it('when Google confirms every address component and corrects a field, then correction evidence remains visible', () => {
    expect(
      addressCaptureCheck({
        ...address,
        outcome: 'corrected',
        hasReplacedComponents: true,
        houseNumberPresent: true,
        missingComponentTypes: [],
        confirmedComponentTypes: [
          'route',
          'postal_code',
          'locality',
          'street_number',
        ],
      })
    ).toMatchObject({
      verdict: 'passed',
      breakdown: { level: 'full_corrected' },
    })
  })

  it('when offer audience is known but customer type is unanswered, then eligibility remains pending', () => {
    expect(
      offerCaptureCheck({
        selected: true,
        audience: 'business_only',
        customerType: null,
      })
    ).toMatchObject({ verdict: 'pending', reason: 'customer_type_missing' })
  })

  it('when a private customer selects a business-only offer, then eligibility fails', () => {
    expect(
      offerCaptureCheck({
        selected: true,
        audience: 'business_only',
        customerType: 'private',
      })
    ).toMatchObject({ verdict: 'failed', reason: 'customer_type_mismatch' })
  })

  it('when whole-value business answer contradicts offer, then fail without substring guesses', () => {
    const fit = {
      selected: true,
      audience: 'business_only' as const,
      customerType: 'business' as const,
      businessOnlyForm: true,
    }
    expect(offerCaptureCheck({ ...fit, companyAnswer: 'Privat' }).verdict).toBe(
      'failed'
    )
    expect(
      offerCaptureCheck({ ...fit, companyAnswer: 'Privatbrauerei Müller' })
        .verdict
    ).toBe('passed')
    expect(
      offerCaptureCheck({ ...fit, companyAnswer: 'Keine Firma' }).verdict
    ).toBe('pending')
    expect(offerCaptureCheck({ ...fit, selected: false }).status).toBe(
      'not_applicable'
    )
  })
})
