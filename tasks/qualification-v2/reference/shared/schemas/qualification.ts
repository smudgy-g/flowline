import { z } from 'zod'
import {
  resolveAddressPoints,
  resolveBusinessLookupPoints,
  resolveCustomerConfirmationPoints,
  resolveEmailPoints,
  resolvePhonePoints,
} from '#shared/utils/qualificationPoints'

const verdict = z.enum([
  'passed',
  'passed_with_limitations',
  'pending',
  'failed',
])
const check = <T extends z.ZodType>(evidence: T) =>
  z
    .union([
      z.strictObject({
        status: z.enum(['checked', 'not_checked', 'unavailable']),
        verdict,
        reason: z.string().nullable(),
        breakdown: evidence.optional(),
      }),
      z.strictObject({
        status: z.literal('not_applicable'),
        verdict: z.null(),
        reason: z.null(),
      }),
    ])
    .refine(
      (value) =>
        value.status === 'checked' ||
        value.status === 'not_applicable' ||
        value.verdict === 'pending'
    )

const lookup = z.strictObject({
  status: z.enum(['checked', 'not_checked', 'unavailable']),
  result: z.enum(['match', 'no_match']).nullable(),
  reason: z.string().optional(),
  nameMatched: z.boolean().optional(),
  addressMatched: z.boolean().optional(),
  operational: z.boolean().optional(),
  active: z.boolean().optional(),
  corporateLegalForm: z.boolean().optional(),
})

const confirmation = z.strictObject({
  source: z.enum(['human', 'ai_agent']),
  reached: z.boolean(),
  confirmedInquiry: z.boolean().optional(),
  confirmedBusiness: z.boolean().optional(),
})

export const emailCheckSchema = check(
  z.strictObject({
    mxStatus: z.enum(['present', 'absent', 'unavailable']),
    deliveryVerdict: z
      .enum(['deliverable', 'risky', 'undeliverable', 'unknown'])
      .nullable(),
    deliveryReason: z.string().nullable(),
    deliveryStatus: z.enum(['completed', 'unavailable', 'not_checked']),
  })
).refine((value) => {
  if (value.status === 'not_applicable') return true
  const evidence = value.breakdown
  if (
    evidence?.mxStatus === 'absent' ||
    evidence?.deliveryVerdict === 'undeliverable'
  )
    return value.status === 'checked' && value.verdict === 'failed'
  if (value.verdict === 'failed') return false
  if (value.verdict !== 'passed' && value.verdict !== 'passed_with_limitations')
    return true
  return (
    value.status === 'checked' &&
    evidence?.mxStatus === 'present' &&
    evidence.deliveryStatus === 'completed' &&
    evidence.deliveryVerdict ===
      (value.verdict === 'passed' ? 'deliverable' : 'risky')
  )
})
export const phoneCheckSchema = check(
  z.strictObject({
    valid: z.boolean().nullable(),
    lineStatus: z.string().nullable(),
    lookupStatus: z.enum(['completed', 'unavailable', 'not_attempted']),
  })
).refine((value) => {
  if (value.status === 'not_applicable') return true
  const evidence = value.breakdown
  if (evidence?.valid === false || evidence?.lineStatus === 'inactive')
    return value.status === 'checked' && value.verdict === 'failed'
  if (value.verdict === 'failed') return false
  if (value.verdict !== 'passed' && value.verdict !== 'passed_with_limitations')
    return true
  return (
    value.status === 'checked' &&
    evidence?.valid === true &&
    evidence.lookupStatus === 'completed' &&
    (value.verdict === 'passed'
      ? evidence.lineStatus === 'active' || evidence.lineStatus === 'reachable'
      : evidence.lineStatus === null || evidence.lineStatus === 'unknown')
  )
})
export const addressCheckSchema = check(
  z.strictObject({
    level: z.enum([
      'full',
      'full_corrected',
      'street_level',
      'not_verified',
      'unknown',
    ]),
    route: z
      .enum(['confirmed', 'unconfirmed', 'missing', 'unknown'])
      .optional(),
    postal_code: z
      .enum(['confirmed', 'unconfirmed', 'missing', 'unknown'])
      .optional(),
    locality: z
      .enum(['confirmed', 'unconfirmed', 'missing', 'unknown'])
      .optional(),
    street_number: z
      .enum(['confirmed', 'unconfirmed', 'missing', 'unknown'])
      .optional(),
    streetLevelExceptionEligible: z.boolean().optional(),
  })
).refine((value) => {
  if (value.status === 'not_applicable') return true
  if (value.verdict === 'failed')
    return (
      value.status === 'checked' &&
      value.reason === 'definitive_invalid_address'
    )
  if (value.verdict !== 'passed' && value.verdict !== 'passed_with_limitations')
    return true
  const evidence = value.breakdown
  if (value.status !== 'checked' || !evidence) return false
  if (value.verdict === 'passed')
    return (
      (evidence.level === 'full' || evidence.level === 'full_corrected') &&
      [
        evidence.route,
        evidence.postal_code,
        evidence.locality,
        evidence.street_number,
      ].every((component) => component === 'confirmed')
    )
  return (
    evidence.level === 'street_level' &&
    evidence.streetLevelExceptionEligible === true &&
    evidence.route === 'confirmed' &&
    evidence.postal_code === 'confirmed' &&
    evidence.locality === 'confirmed' &&
    evidence.street_number === 'missing'
  )
})
export const offerEligibilityCheckSchema = check(
  z.strictObject({
    audience: z.enum(['business_only', 'private_only', 'both']).optional(),
  })
).refine(
  (value) =>
    value.status === 'not_applicable' ||
    (value.verdict === 'failed'
      ? value.status === 'checked' && value.breakdown?.audience !== undefined
      : value.verdict === 'pending' ||
        (value.verdict === 'passed' &&
          value.status === 'checked' &&
          value.breakdown?.audience !== undefined))
)
export const businessCheckSchema = check(
  z.strictObject({
    registry: lookup,
    directory: lookup,
    confirmation: z
      .strictObject({
        basis: z.literal('customer_confirmed'),
        source: z.enum(['human', 'ai_agent']),
      })
      .optional(),
  })
).refine(
  (value) =>
    value.status === 'not_applicable' ||
    (value.verdict !== 'passed' &&
      value.verdict !== 'passed_with_limitations') ||
    (value.status === 'checked' && value.breakdown !== undefined)
)
export const customerConfirmationCheckSchema = check(confirmation).refine(
  (value) => {
    if (value.status === 'not_applicable') return true
    if (value.verdict === 'failed')
      return (
        value.status === 'checked' &&
        value.breakdown?.reached === true &&
        (value.reason === 'wrong_person' ||
          (value.reason === 'customer_denies_inquiry' &&
            value.breakdown.confirmedInquiry !== true &&
            value.breakdown.confirmedBusiness !== true) ||
          value.reason === 'no_longer_interested')
      )
    if (
      value.breakdown?.reached === true &&
      (value.reason === 'wrong_person' ||
        value.reason === 'customer_denies_inquiry' ||
        value.reason === 'no_longer_interested')
    )
      return false
    if (
      value.verdict !== 'passed' &&
      value.verdict !== 'passed_with_limitations'
    )
      return true
    return (
      value.reason !== 'callback_requested' &&
      value.reason !== 'language_barrier' &&
      value.status === 'checked' &&
      value.breakdown?.reached === true &&
      value.breakdown.confirmedInquiry === true
    )
  }
)
export const evidenceStateSchema = z.enum([
  'check_failed',
  'core_requirements_unresolved',
  'business_unconfirmed',
  'checks_satisfied',
])

export const qualificationScoreBreakdownSchema = z
  .strictObject({
    version: z.literal(2),
    customerType: z.enum(['business', 'private']),
    urgencyMissing: z.boolean(),
    placeholderCompanyName: z.literal(true).optional(),
    points: z.strictObject({
      phone: z.number().int().nonnegative(),
      email: z.number().int().nonnegative(),
      address: z.number().int().nonnegative(),
      urgency: z.number().int().nonnegative(),
      businessLookup: z.number().int().nonnegative(),
      corporateDomain: z.number().int().nonnegative(),
      website: z.number().int().nonnegative(),
      corporationLegalForm: z.number().int().nonnegative(),
      customerConfirmation: z.number().int().nonnegative(),
    }),
    businessLookupBasis: z
      .enum([
        'registry',
        'directory_full',
        'directory_name',
        'directory_address',
      ])
      .optional(),
    legalFormBasis: z
      .enum(['registry', 'directory_name', 'submitted_name'])
      .optional(),
    websiteBasis: z.literal('http_reachable').optional(),
  })
  .refine(
    (breakdown) =>
      (breakdown.points.website === 5) ===
      (breakdown.websiteBasis === 'http_reachable')
  )
export const supplierNoteSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  source: z.string().trim().min(1).max(100),
  authorType: z.enum(['human', 'ai_agent']),
  recordedAt: z.iso.datetime(),
  recordedBy: z.email().max(320).optional(),
})
export const qualificationCorrectionsSchema = z.strictObject({
  websiteBasis: z.literal('http_reachable').optional(),
  websiteChecked: z.boolean().optional(),
  fields: z.strictObject({
    customer_first_name: z.string().optional(),
    customer_last_name: z.string().nullable().optional(),
    customer_email: z.string().optional(),
    customer_phone: z.string().nullable().optional(),
    customer_company: z.string().nullable().optional(),
    customer_street: z.string().nullable().optional(),
    customer_zip: z.string().nullable().optional(),
    customer_city: z.string().nullable().optional(),
    is_business: z.boolean().optional(),
    vat_id: z
      .string()
      .regex(/^DE\d{9}$/)
      .nullable()
      .optional(),
  }),
  correctedBy: z.email(),
  correctedAt: z.iso.datetime(),
})

export function deriveEvidenceState(
  checks: {
    email_check: EmailCheck
    phone_check: PhoneCheck
    address_check: AddressCheck
    offer_eligibility_check: OfferEligibilityCheck
    business_check: BusinessCheck
    customer_confirmation_check: CustomerConfirmationCheck
  },
  urgencyMissing: boolean
): EvidenceState {
  const applicable = [
    checks.email_check,
    checks.phone_check,
    checks.address_check,
    checks.offer_eligibility_check,
    checks.business_check,
    checks.customer_confirmation_check,
  ]
  if (applicable.some((check) => check.verdict === 'failed'))
    return 'check_failed'
  const core = [checks.email_check, checks.phone_check, checks.address_check]
  const offer = checks.offer_eligibility_check
  if (
    core.some(
      (check) =>
        check.status !== 'checked' ||
        (check.verdict !== 'passed' &&
          check.verdict !== 'passed_with_limitations')
    ) ||
    (offer.status !== 'not_applicable' &&
      (offer.status !== 'checked' ||
        (offer.verdict !== 'passed' &&
          offer.verdict !== 'passed_with_limitations'))) ||
    urgencyMissing
  )
    return 'core_requirements_unresolved'
  if (
    checks.business_check.status !== 'not_applicable' &&
    (checks.business_check.status !== 'checked' ||
      (checks.business_check.verdict !== 'passed' &&
        checks.business_check.verdict !== 'passed_with_limitations'))
  )
    return 'business_unconfirmed'
  return 'checks_satisfied'
}

const checkPassed = (check: { verdict: string | null }) =>
  check.verdict === 'passed' || check.verdict === 'passed_with_limitations'

function supportedPoints(row: {
  phone_check: PhoneCheck
  email_check: EmailCheck
  address_check: AddressCheck
  business_check: BusinessCheck
  customer_confirmation_check: CustomerConfirmationCheck
  qualification_score_breakdown: QualificationScoreBreakdown
}): boolean {
  const { points, customerType, businessLookupBasis, placeholderCompanyName } =
    row.qualification_score_breakdown
  const call = row.customer_confirmation_check
  const business = row.business_check
  const registry =
    business.status === 'not_applicable'
      ? undefined
      : business.breakdown?.registry
  const directory =
    business.status === 'not_applicable'
      ? undefined
      : business.breakdown?.directory
  const confirmed =
    call.status === 'checked' &&
    checkPassed(call) &&
    call.breakdown?.reached === true &&
    call.breakdown.confirmedInquiry === true
  const registryMatch =
    registry?.status === 'checked' &&
    registry.result === 'match' &&
    registry.active === true &&
    registry.nameMatched === true
  const directoryFull =
    directory?.status === 'checked' &&
    directory.result === 'match' &&
    directory.operational === true &&
    directory.nameMatched === true &&
    directory.addressMatched === true
  const confirmedBusiness =
    confirmed &&
    call.status === 'checked' &&
    call.breakdown?.confirmedBusiness === true
  const denied =
    call.status === 'checked' &&
    call.verdict === 'failed' &&
    call.breakdown?.reached === true
  let businessVerdict =
    business.status === 'not_applicable' ||
    (business.verdict === 'failed' &&
      denied &&
      business.status === 'checked' &&
      business.reason === call.reason)
  if (business.verdict === 'passed')
    businessVerdict = !denied && Boolean(registryMatch || directoryFull)
  if (business.verdict === 'passed_with_limitations')
    businessVerdict =
      !denied &&
      confirmedBusiness &&
      business.breakdown?.confirmation?.source === call.breakdown?.source
  if (business.verdict === 'pending')
    businessVerdict =
      !denied &&
      (placeholderCompanyName === true || (!registryMatch && !directoryFull)) &&
      !confirmedBusiness
  const lookup =
    placeholderCompanyName === true
      ? { points: 0, basis: undefined }
      : resolveBusinessLookupPoints(business)
  return (
    businessVerdict &&
    (business.status === 'not_applicable' ||
      !business.breakdown?.confirmation ||
      (business.verdict === 'passed_with_limitations' && confirmedBusiness)) &&
    (placeholderCompanyName !== true ||
      (customerType === 'business' && business.verdict !== 'passed')) &&
    points.phone === resolvePhonePoints(row.phone_check, customerType) &&
    points.email === resolveEmailPoints(row.email_check) &&
    points.address === resolveAddressPoints(row.address_check, customerType) &&
    points.customerConfirmation ===
      resolveCustomerConfirmationPoints(call, customerType) &&
    lookup.basis === businessLookupBasis &&
    points.businessLookup === lookup.points
  )
}

export const qualificationAssessmentSchema = z
  .object({
    qualification_score: z.number().int().min(0).max(100),
    qualification_score_breakdown: qualificationScoreBreakdownSchema,
    qualification_evidence_state: evidenceStateSchema,
    email_check: emailCheckSchema,
    phone_check: phoneCheckSchema,
    address_check: addressCheckSchema,
    offer_eligibility_check: offerEligibilityCheckSchema,
    business_check: businessCheckSchema,
    customer_confirmation_check: customerConfirmationCheckSchema,
  })
  .refine((row) => {
    const {
      points,
      customerType,
      businessLookupBasis,
      legalFormBasis,
      urgencyMissing,
    } = row.qualification_score_breakdown
    const business = customerType === 'business'
    const offer = row.offer_eligibility_check
    const audience =
      offer.status === 'not_applicable' ? undefined : offer.breakdown?.audience
    const offerMismatch =
      (audience === 'business_only' && !business) ||
      (audience === 'private_only' && business)
    const limits = business
      ? {
          phone: 10,
          email: 10,
          address: 10,
          urgency: 10,
          businessLookup: 25,
          corporateDomain: 10,
          website: 5,
          corporationLegalForm: 5,
          customerConfirmation: 15,
        }
      : {
          phone: 15,
          email: 10,
          address: 35,
          urgency: 20,
          businessLookup: 0,
          corporateDomain: 0,
          website: 0,
          corporationLegalForm: 0,
          customerConfirmation: 20,
        }
    const withinLimits = (Object.keys(points) as (keyof typeof points)[]).every(
      (key) => points[key] <= limits[key]
    )
    const expectedState = deriveEvidenceState(row, urgencyMissing)
    return (
      withinLimits &&
      row.email_check.status !== 'not_applicable' &&
      row.phone_check.status !== 'not_applicable' &&
      row.address_check.status !== 'not_applicable' &&
      (offerMismatch
        ? offer.status === 'checked' && offer.verdict === 'failed'
        : offer.verdict !== 'failed' ||
          (offer.status === 'checked' &&
            offer.reason === 'contradictory_offer_details' &&
            audience !== undefined)) &&
      (business
        ? [0, 7, 10].includes(points.urgency)
        : [0, 15, 20].includes(points.urgency)) &&
      [0, 10].includes(points.corporateDomain) &&
      [0, 5].includes(points.website) &&
      [0, 5].includes(points.corporationLegalForm) &&
      (!urgencyMissing || points.urgency === 0) &&
      supportedPoints(row) &&
      Object.values(points).reduce((sum, value) => sum + value, 0) ===
        row.qualification_score &&
      Boolean(businessLookupBasis) === points.businessLookup > 0 &&
      Boolean(legalFormBasis) === points.corporationLegalForm > 0 &&
      row.qualification_evidence_state === expectedState &&
      (business
        ? row.business_check.status !== 'not_applicable'
        : row.business_check.status === 'not_applicable')
    )
  })

export type EmailCheck = z.infer<typeof emailCheckSchema>
export type PhoneCheck = z.infer<typeof phoneCheckSchema>
export type AddressCheck = z.infer<typeof addressCheckSchema>
export type OfferEligibilityCheck = z.infer<typeof offerEligibilityCheckSchema>
export type BusinessCheck = z.infer<typeof businessCheckSchema>
export type CustomerConfirmationCheck = z.infer<
  typeof customerConfirmationCheckSchema
>
export type EvidenceState = z.infer<typeof evidenceStateSchema>
export type QualificationScoreBreakdown = z.infer<
  typeof qualificationScoreBreakdownSchema
>
export type QualificationAssessment = z.infer<
  typeof qualificationAssessmentSchema
>
export type SupplierNote = z.infer<typeof supplierNoteSchema>
export type QualificationCorrections = z.infer<
  typeof qualificationCorrectionsSchema
>

export function parseQualificationAssessment(
  value: unknown
): QualificationAssessment | null {
  return qualificationAssessmentSchema.safeParse(value).data ?? null
}
