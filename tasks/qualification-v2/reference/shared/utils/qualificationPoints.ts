import type {
  AddressCheck,
  BusinessCheck,
  CustomerConfirmationCheck,
  EmailCheck,
  PhoneCheck,
  QualificationScoreBreakdown,
} from '#shared/schemas/qualification'

const checkPassed = (check: { verdict: string | null }) =>
  check.verdict === 'passed' || check.verdict === 'passed_with_limitations'

export const PHONE_POINTS = { business: 10, private: 15 } as const
export const EMAIL_POINTS = { deliverable: 10, risky: 5 } as const
export const ADDRESS_POINTS = {
  business: { full: 10, street_level: 5 },
  private: { full: 35, street_level: 17 },
} as const
export const CUSTOMER_CONFIRMATION_POINTS = {
  business: 15,
  private: 20,
} as const
export const BUSINESS_LOOKUP_POINTS = {
  registry: 25,
  directory_full: 20,
  directory_name: 12,
  directory_address: 5,
} as const

export function resolvePhonePoints(
  phone: PhoneCheck,
  customerType: 'business' | 'private'
): number {
  if (phone.status !== 'checked' || !checkPassed(phone)) return 0
  if (phone.breakdown?.valid !== true) return 0
  return PHONE_POINTS[customerType]
}

export function resolveEmailPoints(email: EmailCheck): number {
  if (email.status !== 'checked' || !checkPassed(email)) return 0
  if (email.breakdown?.mxStatus !== 'present') return 0
  return email.breakdown.deliveryVerdict === 'deliverable'
    ? EMAIL_POINTS.deliverable
    : EMAIL_POINTS.risky
}

export function resolveAddressPoints(
  address: AddressCheck,
  customerType: 'business' | 'private'
): number {
  if (address.status !== 'checked' || !checkPassed(address)) return 0
  return address.breakdown?.level === 'street_level'
    ? ADDRESS_POINTS[customerType].street_level
    : ADDRESS_POINTS[customerType].full
}

export function resolveCustomerConfirmationPoints(
  confirmation: CustomerConfirmationCheck,
  customerType: 'business' | 'private'
): number {
  if (confirmation.status !== 'checked' || !checkPassed(confirmation)) return 0
  if (
    confirmation.breakdown?.reached !== true ||
    confirmation.breakdown.confirmedInquiry !== true
  )
    return 0
  return CUSTOMER_CONFIRMATION_POINTS[customerType]
}

export function resolveBusinessLookupPoints(business: BusinessCheck): {
  points: number
  basis?: QualificationScoreBreakdown['businessLookupBasis']
} {
  if (business.status === 'not_applicable' || !business.breakdown)
    return { points: 0 }
  const { registry, directory } = business.breakdown
  if (
    registry.status === 'checked' &&
    registry.result === 'match' &&
    registry.active === true &&
    registry.nameMatched === true
  )
    return { points: BUSINESS_LOOKUP_POINTS.registry, basis: 'registry' }
  if (directory.status !== 'checked' || directory.result === null)
    return { points: 0 }
  if (directory.operational !== true) return { points: 0 }
  const nameMatched = directory.nameMatched === true
  const addressMatched = directory.addressMatched === true
  if (nameMatched && addressMatched)
    return directory.result === 'match'
      ? {
          points: BUSINESS_LOOKUP_POINTS.directory_full,
          basis: 'directory_full',
        }
      : { points: 0 }
  if (nameMatched)
    return {
      points: BUSINESS_LOOKUP_POINTS.directory_name,
      basis: 'directory_name',
    }
  if (addressMatched)
    return {
      points: BUSINESS_LOOKUP_POINTS.directory_address,
      basis: 'directory_address',
    }
  return { points: 0 }
}
