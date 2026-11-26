import type { H3Event } from 'h3'
import type { BusinessCheck } from '#shared/schemas/qualification'
import type { CompanyValidationResult } from '#shared/types/companyValidation'
import { looksLikeDeVatId } from '#shared/utils/companyIdentifiers'
import { logValidationOutage } from '#server/utils/bouncerValidation'
import { isPlaceholderCompanyName } from '#shared/utils/isPlaceholderCompanyName'
import {
  businessLookupCheck,
  type RegistryFinding,
  type DirectoryFinding,
} from '#shared/utils/businessEvidence'

const LOOKUP_TIMEOUT_MS = 2500

async function boundedLookup(
  lookup: () => Promise<CompanyValidationResult>
): Promise<CompanyValidationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('lookup_timeout')),
          LOOKUP_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface BusinessInput {
  company: string | null
  vatId: string | null
  address: { street: string; zip: string; city: string }
}

function registryFinding(result: CompanyValidationResult): RegistryFinding {
  if (result.verificationDetails?.openApiHit) {
    return {
      status: 'checked',
      found: true,
      active: result.verificationDetails.statusActive,
      nameMatched: result.verificationDetails.nameMatched,
      legalType: result.legalType,
      ...(result.errorCode === 'COMPANY_INACTIVE'
        ? { reason: 'inactive_record' }
        : {}),
    }
  }
  if ((result.registryErrorCode ?? result.errorCode) === 'COMPANY_NOT_FOUND')
    return { status: 'checked', found: false, reason: 'no_record' }
  return { status: 'unavailable', reason: 'registry_unavailable' }
}

function directoryFinding(result: CompanyValidationResult): DirectoryFinding {
  if (result.errorCode === 'GOOGLE_ERROR')
    return { status: 'unavailable', reason: 'directory_unavailable' }
  const details = result.verificationDetails
  if (!details || details.openApiHit)
    return { status: 'checked', found: false, reason: 'no_listing' }
  return {
    status: 'checked',
    found: true,
    nameMatched: details.nameMatched,
    addressMatched: details.addressMatched,
    operational: details.googleOperational,
    matchedName: result.legalName,
  }
}

export async function stageBusinessEvidence(
  event: H3Event,
  input: BusinessInput & { isBusiness: boolean }
): Promise<{ business_check: BusinessCheck }> {
  if (!input.isBusiness)
    return {
      business_check: { status: 'not_applicable', verdict: null, reason: null },
    }
  return { business_check: await corroborateBusiness(event, input) }
}

export async function corroborateBusiness(
  event: H3Event,
  input: BusinessInput
): Promise<BusinessCheck> {
  const company = input.company?.trim() ?? ''
  if (!company || isPlaceholderCompanyName(company)) {
    return businessLookupCheck({
      companyName: company,
      registry: { status: 'not_checked', reason: 'no_company_name' },
      directory: { status: 'not_checked', reason: 'no_company_name' },
    })
  }
  let validateCompany: typeof import('#server/utils/companyValidation').validateCompany
  try {
    ;({ validateCompany } = await import('#server/utils/companyValidation'))
  } catch {
    logValidationOutage('registry', 'load_provider', 'unavailable')
    return businessLookupCheck({
      companyName: company,
      registry: { status: 'unavailable', reason: 'registry_unavailable' },
      directory: { status: 'unavailable', reason: 'directory_unavailable' },
    })
  }
  const vat = input.vatId?.trim() ?? ''
  const validVat = looksLikeDeVatId(vat)
  let registry: RegistryFinding = {
    status: 'not_checked',
    reason: vat ? 'invalid_identifier' : 'no_identifier',
  }
  let directoryResult: CompanyValidationResult | null = null
  if (validVat) {
    try {
      const result = await boundedLookup(() =>
        validateCompany(event, company, input.address, vat)
      )
      registry = registryFinding(result)
      if (result.tier === 'registry_then_directory') directoryResult = result
    } catch (error) {
      logValidationOutage(
        'registry',
        'lookup',
        error instanceof Error && error.message === 'lookup_timeout'
          ? 'timeout'
          : 'request_failed'
      )
      registry = { status: 'unavailable', reason: 'registry_unavailable' }
    }
  }
  if (!directoryResult) {
    try {
      directoryResult = await boundedLookup(() =>
        validateCompany(event, company, input.address)
      )
    } catch (error) {
      logValidationOutage(
        'directory',
        'lookup',
        error instanceof Error && error.message === 'lookup_timeout'
          ? 'timeout'
          : 'request_failed'
      )
      return businessLookupCheck({
        companyName: company,
        registry,
        directory: { status: 'unavailable', reason: 'directory_unavailable' },
      })
    }
  }
  return businessLookupCheck({
    companyName: company,
    registry,
    directory: directoryFinding(directoryResult),
  })
}
