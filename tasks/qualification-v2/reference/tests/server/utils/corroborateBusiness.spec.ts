import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import type { CompanyValidationResult } from '#shared/types/companyValidation'
import { stageBusinessEvidence } from '#server/utils/corroborateBusiness'
import { legalFormBasisFromCheck } from '#shared/utils/businessEvidence'

const validateCompany = vi.hoisted(() => vi.fn())
vi.mock('#server/utils/companyValidation', () => ({ validateCompany }))
vi.mock('#server/utils/bouncerValidation', () => ({
  logValidationOutage: vi.fn(),
}))

const providerResult = (
  overrides: Partial<CompanyValidationResult> = {}
): CompanyValidationResult => ({
  valid: true,
  companyName: null,
  address: null,
  cached: false,
  confidence: 0,
  tier: 'directory',
  errorCode: null,
  legalName: 'Example GmbH',
  status: null,
  legalAddress: null,
  taxNumber: null,
  businessNumber: null,
  formationDate: null,
  rawData: null,
  verificationDetails: {
    openApiHit: false,
    nameMatched: true,
    addressMatched: false,
    statusActive: true,
    googleMatch: true,
    googleOperational: true,
  },
  identifierBonusesApplied: {
    taxNumberProvided: false,
    businessNumberProvided: false,
    registrationCourtProvided: false,
  },
  ...overrides,
})

const input = {
  isBusiness: true,
  company: 'Example GmbH',
  vatId: null,
  address: { street: 'Street 1', zip: '10115', city: 'Berlin' },
}

describe('business evidence capture', () => {
  beforeEach(() => {
    validateCompany.mockReset()
  })

  it('when private, then no business provider is called', async () => {
    const result = await stageBusinessEvidence({} as H3Event, {
      ...input,
      isBusiness: false,
    })
    expect(result.business_check.status).toBe('not_applicable')
    expect(validateCompany).not.toHaveBeenCalled()
  })

  it('when VAT identifier is invalid, then registry is not called or credited', async () => {
    validateCompany.mockResolvedValue(providerResult())
    const result = await stageBusinessEvidence({} as H3Event, {
      ...input,
      vatId: 'DE-INVALID',
    })
    expect(validateCompany).toHaveBeenCalledOnce()
    expect(validateCompany.mock.calls[0]).toHaveLength(3)
    if (result.business_check.status === 'not_applicable')
      throw new Error('unexpected')
    expect(result.business_check.breakdown?.registry).toMatchObject({
      status: 'not_checked',
      result: null,
      reason: 'invalid_identifier',
    })
    expect(result.business_check.verdict).toBe('pending')
  })

  it('when matched registry name has GmbH suffix but no legal type, then do not attribute legal form to registry', async () => {
    validateCompany
      .mockResolvedValueOnce(
        providerResult({
          tier: 'registry',
          verificationDetails: {
            openApiHit: true,
            nameMatched: true,
            addressMatched: false,
            statusActive: true,
            googleMatch: false,
            googleOperational: false,
          },
        })
      )
      .mockResolvedValueOnce(
        providerResult({
          legalName: 'Example',
          verificationDetails: {
            openApiHit: false,
            nameMatched: false,
            addressMatched: false,
            statusActive: false,
            googleMatch: false,
            googleOperational: false,
          },
        })
      )
    const { business_check: check } = await stageBusinessEvidence(
      {} as H3Event,
      { ...input, company: 'Example', vatId: 'DE123456789' }
    )
    expect(check.status).toBe('checked')
    expect(
      legalFormBasisFromCheck({ check, submittedName: 'Example' })
    ).toBeUndefined()
  })

  it('when matched registry supplies corporate legal type, then registry wins legal-form basis', async () => {
    validateCompany
      .mockResolvedValueOnce(
        providerResult({
          tier: 'registry',
          legalType: 'GmbH',
          verificationDetails: {
            openApiHit: true,
            nameMatched: true,
            addressMatched: false,
            statusActive: true,
            googleMatch: false,
            googleOperational: false,
          },
        })
      )
      .mockResolvedValueOnce(providerResult({ legalName: 'Example AG' }))
    const { business_check: check } = await stageBusinessEvidence(
      {} as H3Event,
      { ...input, company: 'Example', vatId: 'DE123456789' }
    )
    expect(check.status).toBe('checked')
    expect(
      legalFormBasisFromCheck({ check, submittedName: 'Example AG' })
    ).toBe('registry')
  })

  it('when registry stalls, then persist unavailable registry and continue directory lookup', async () => {
    validateCompany
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(providerResult())
    const result = await stageBusinessEvidence({} as H3Event, {
      ...input,
      vatId: 'DE123456789',
    })
    expect(validateCompany).toHaveBeenCalledTimes(2)
    if (result.business_check.status === 'not_applicable')
      throw new Error('unexpected')
    expect(result.business_check.breakdown?.registry).toMatchObject({
      status: 'unavailable',
    })
    expect(result.business_check.breakdown?.directory).toMatchObject({
      status: 'checked',
    })
  }, 6000)

  it('when directory stalls, then persist unavailable directory evidence', async () => {
    validateCompany.mockImplementation(() => new Promise(() => {}))
    const result = await stageBusinessEvidence({} as H3Event, input)
    expect(validateCompany).toHaveBeenCalledOnce()
    if (result.business_check.status === 'not_applicable')
      throw new Error('unexpected')
    expect(result.business_check.breakdown?.directory).toMatchObject({
      status: 'unavailable',
    })
  }, 6000)

  it('when registry finds no record and directory fails, then preserve both independent outcomes', async () => {
    validateCompany
      .mockResolvedValueOnce(
        providerResult({
          tier: 'registry_then_directory',
          errorCode: 'GOOGLE_ERROR',
          registryErrorCode: 'COMPANY_NOT_FOUND',
          verificationDetails: undefined,
        })
      )
      .mockResolvedValueOnce(
        providerResult({
          tier: 'unqualified',
          errorCode: 'GOOGLE_ERROR',
          verificationDetails: undefined,
        })
      )
    const { business_check: check } = await stageBusinessEvidence(
      {} as H3Event,
      { ...input, vatId: 'DE123456789' }
    )
    if (check.status === 'not_applicable') throw new Error('unexpected')
    expect(check.breakdown?.registry).toMatchObject({
      status: 'checked',
      result: 'no_match',
    })
    expect(check.breakdown?.directory).toMatchObject({ status: 'unavailable' })
  })

  it('when inactive registry and operational name-only directory, then preserve separate facts', async () => {
    validateCompany
      .mockResolvedValueOnce(
        providerResult({
          tier: 'unqualified',
          errorCode: 'COMPANY_INACTIVE',
          verificationDetails: {
            openApiHit: true,
            nameMatched: true,
            addressMatched: false,
            statusActive: false,
            googleMatch: false,
            googleOperational: false,
          },
        })
      )
      .mockResolvedValueOnce(providerResult())
    const result = await stageBusinessEvidence({} as H3Event, {
      ...input,
      vatId: 'DE123456789',
    })
    expect(validateCompany).toHaveBeenCalledTimes(2)
    if (result.business_check.status === 'not_applicable')
      throw new Error('unexpected')
    expect(result.business_check.breakdown?.registry).toMatchObject({
      status: 'checked',
      result: 'no_match',
      active: false,
    })
    expect(result.business_check.breakdown?.directory).toMatchObject({
      status: 'checked',
      result: 'no_match',
      nameMatched: true,
      operational: true,
    })
    expect(result.business_check.verdict).toBe('pending')
  })
})
