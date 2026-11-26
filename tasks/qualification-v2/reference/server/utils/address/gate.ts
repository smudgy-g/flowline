import type { H3Event } from 'h3'
import { addressCaptureCheck } from '#shared/utils/captureQualificationChecks'
import type { AddressCheck } from '#shared/schemas/qualification'
import { verifyGermanAddress } from '#server/utils/address/provider'
import {
  validateGermanAddress,
  combineStreetAndHouseNumber,
  mapAddressOutcome,
  type StructuredAddress,
  type AddressOutcome,
  type AddressRejectionCode,
} from '#shared/utils/address'
import type { AddressCorrectionNotice } from '#shared/types/interfaces'

export type CapturedAddress = StructuredAddress
export type AddressRejectionReason = 'format' | 'verification'

export function addressRejectionReason(
  error: unknown
): AddressRejectionReason | null {
  if (error === null || typeof error !== 'object') return null
  if (!('statusCode' in error) || error.statusCode !== 422) return null
  if (
    !('data' in error) ||
    error.data === null ||
    typeof error.data !== 'object'
  )
    return null
  if (!('addressRejection' in error.data)) return null
  return error.data.addressRejection === 'format' ||
    error.data.addressRejection === 'verification'
    ? error.data.addressRejection
    : null
}

export function buildCapturedAddress(address: {
  street?: string | null
  houseNumber?: string | null
  postalCode?: string | null
  city?: string | null
}): CapturedAddress {
  return {
    street: address.street ?? '',
    houseNumber: address.houseNumber ?? '',
    postalCode: address.postalCode ?? '',
    city: address.city ?? '',
  }
}

export interface ResolvedCapturedAddress {
  streetLine: string
  postalCode: string
  city: string
  outcome: AddressOutcome
  hasReplacedComponents: boolean
  check?: AddressCheck
}

function addressFixMessageCode(
  missingComponentTypes: string[]
): Extract<AddressRejectionCode, 'houseNumberMissing' | 'addressUnverifiable'> {
  return missingComponentTypes.includes('street_number')
    ? 'houseNumberMissing'
    : 'addressUnverifiable'
}

export async function resolveCapturedAddress(
  event: H3Event,
  address: CapturedAddress,
  overridden: boolean,
  verify: typeof verifyGermanAddress = verifyGermanAddress,
  meta = false,
  allane = false
): Promise<ResolvedCapturedAddress> {
  const { valid, errors } = validateGermanAddress(address)
  const missingNumber = errors.street === 'houseNumberMissing'
  if (
    !valid &&
    !meta &&
    (!missingNumber || errors.houseNumber || errors.postalCode)
  ) {
    throw createError({
      status: 422,
      statusText: 'Address failed the format check',
      data: {
        code: errors.street ?? errors.houseNumber ?? errors.postalCode,
        addressRejection: 'format',
      },
    })
  }

  const streetLine = combineStreetAndHouseNumber(
    address.street,
    address.houseNumber
  )

  if (overridden) {
    return {
      streetLine,
      postalCode: address.postalCode,
      city: address.city,
      outcome: 'overridden',
      hasReplacedComponents: false,
      check: addressCaptureCheck({
        outcome: 'overridden',
        hasReplacedComponents: false,
        missingComponentTypes: [],
        unconfirmedComponentTypes: [],
        houseNumberPresent: !!address.houseNumber || /\d/.test(address.street),
        meta,
        allane,
      }),
    }
  }

  const verdict = await verify(event, {
    ...address,
    street: streetLine,
    houseNumber: '',
  })
  const outcome = mapAddressOutcome(
    verdict?.outcome ?? null,
    false,
    verdict?.unconfirmedComponentTypes
  )

  if (!verdict && meta) {
    return {
      streetLine,
      postalCode: address.postalCode,
      city: address.city,
      outcome: 'unavailable',
      hasReplacedComponents: false,
      check: addressCaptureCheck({
        outcome: 'unavailable',
        hasReplacedComponents: false,
        missingComponentTypes: [],
        unconfirmedComponentTypes: [],
        houseNumberPresent: !!address.houseNumber || /\d/.test(address.street),
        meta,
        allane,
      }),
    }
  }
  if (outcome === null && meta) {
    return {
      streetLine,
      postalCode: address.postalCode,
      city: address.city,
      outcome: 'unconfirmed',
      hasReplacedComponents: false,
      check: addressCaptureCheck({
        outcome: 'unverified',
        hasReplacedComponents: false,
        missingComponentTypes: verdict?.missingComponentTypes ?? [],
        unconfirmedComponentTypes: verdict?.unconfirmedComponentTypes ?? [],
        confirmedComponentTypes: verdict?.confirmedComponentTypes,
        houseNumberPresent: !!address.houseNumber || /\d/.test(address.street),
        meta,
        allane,
      }),
    }
  }
  if (outcome === null && missingNumber && verdict) {
    return {
      streetLine,
      postalCode: address.postalCode,
      city: address.city,
      outcome: 'unconfirmed',
      hasReplacedComponents: false,
      check: addressCaptureCheck({
        outcome: 'unverified',
        hasReplacedComponents: false,
        missingComponentTypes: verdict.missingComponentTypes,
        unconfirmedComponentTypes: verdict.unconfirmedComponentTypes,
        confirmedComponentTypes: verdict.confirmedComponentTypes,
        houseNumberPresent: false,
        allane,
      }),
    }
  }
  if (outcome === null) {
    throw createError({
      status: 422,
      statusText: 'Address could not be verified',
      data: {
        code: addressFixMessageCode(verdict!.missingComponentTypes),
        addressRejection: 'verification',
      },
    })
  }

  return {
    streetLine: verdict
      ? combineStreetAndHouseNumber(
          verdict.address.street,
          verdict.address.houseNumber
        )
      : streetLine,
    postalCode: verdict?.address.postalCode ?? address.postalCode,
    city: verdict?.address.city ?? address.city,
    outcome: missingNumber ? 'unconfirmed' : outcome,
    hasReplacedComponents: verdict?.hasReplacedComponents ?? false,
    check: addressCaptureCheck({
      outcome:
        !missingNumber && (outcome === 'verified' || outcome === 'corrected')
          ? outcome
          : 'unverified',
      hasReplacedComponents: verdict?.hasReplacedComponents ?? false,
      missingComponentTypes: verdict?.missingComponentTypes ?? [],
      unconfirmedComponentTypes: verdict?.unconfirmedComponentTypes ?? [],
      confirmedComponentTypes: verdict?.confirmedComponentTypes,
      houseNumberPresent: !!address.houseNumber || /\d/.test(address.street),
      meta,
      allane,
    }),
  }
}

export function buildAddressCorrectionNotice(
  address: CapturedAddress,
  resolved: ResolvedCapturedAddress
): AddressCorrectionNotice | undefined {
  if (!resolved.hasReplacedComponents) return undefined

  return {
    submitted: {
      street: combineStreetAndHouseNumber(address.street, address.houseNumber),
      postalCode: address.postalCode,
      city: address.city,
    },
    stored: {
      street: resolved.streetLine,
      postalCode: resolved.postalCode,
      city: resolved.city,
    },
  }
}
