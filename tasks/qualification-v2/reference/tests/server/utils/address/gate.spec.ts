import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { createError } from 'h3'
import type { H3Event } from 'h3'
import common from '../../../../i18n/locales/de/common.json'

const mockVerifyGermanAddress = vi.fn()

vi.mock('#server/utils/address/provider', () => ({
  verifyGermanAddress: (...args: unknown[]) => mockVerifyGermanAddress(...args),
}))

beforeAll(() => {
  vi.stubGlobal('createError', createError)
})

async function loadService() {
  return import('#server/utils/address/gate')
}

const FAKE_EVENT = {} as H3Event

const TYPED_ADDRESS = {
  street: 'Musterallee',
  houseNumber: '5',
  postalCode: '54321',
  city: 'Beispielstadt',
}

function acceptVerdict(unconfirmedComponentTypes: string[] = []) {
  return {
    outcome: 'accept',
    address: { ...TYPED_ADDRESS, street: 'Musterallee 5', houseNumber: '' },
    missingComponentTypes: [],
    unconfirmedComponentTypes,
    hasReplacedComponents: false,
  }
}

describe('resolveCapturedAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('given the address fails the format floor check', () => {
    it('when the house number is missing, then it asks Google and keeps unconfirmed evidence pending', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue({
        ...acceptVerdict(),
        confirmedComponentTypes: ['postal_code', 'locality'],
      })

      const result = await resolveCapturedAddress(
        FAKE_EVENT,
        { ...TYPED_ADDRESS, houseNumber: '' },
        false
      )
      expect(result.check?.verdict).toBe('pending')
      expect(mockVerifyGermanAddress).toHaveBeenCalledTimes(1)
    })

    it('when the postal code is not five digits, then it rejects with the postal-code code and never calls the provider', async () => {
      const { resolveCapturedAddress } = await loadService()

      await expect(
        resolveCapturedAddress(
          FAKE_EVENT,
          { ...TYPED_ADDRESS, postalCode: '1234' },
          false
        )
      ).rejects.toMatchObject({
        statusCode: 422,
        data: { code: 'invalidPostalCode', addressRejection: 'format' },
      })
      expect(mockVerifyGermanAddress).not.toHaveBeenCalled()
    })

    it('when the customer is overriding, then the floor check still rejects and the provider is still not called', async () => {
      const { resolveCapturedAddress } = await loadService()

      await expect(
        resolveCapturedAddress(
          FAKE_EVENT,
          { ...TYPED_ADDRESS, postalCode: '1234' },
          true
        )
      ).rejects.toMatchObject({
        statusCode: 422,
        data: { code: 'invalidPostalCode' },
      })
      expect(mockVerifyGermanAddress).not.toHaveBeenCalled()
    })
  })

  it('when Google confirms street components without number, then non-Allane is limited and Allane pending', async () => {
    const { resolveCapturedAddress } = await loadService()
    mockVerifyGermanAddress.mockResolvedValue({
      ...acceptVerdict(),
      missingComponentTypes: ['street_number'],
      confirmedComponentTypes: ['route', 'postal_code', 'locality'],
    })
    const address = { ...TYPED_ADDRESS, houseNumber: '' }
    const ordinary = await resolveCapturedAddress(FAKE_EVENT, address, false)
    const allane = await resolveCapturedAddress(
      FAKE_EVENT,
      address,
      false,
      undefined,
      false,
      true
    )
    expect(ordinary.check).toMatchObject({
      verdict: 'passed_with_limitations',
      reason: 'street_level_exception',
    })
    expect(allane.check).toMatchObject({
      verdict: 'pending',
      reason: 'house_number_required',
    })
  })

  it('when Google cannot confirm the route without number, then the check remains pending', async () => {
    const { resolveCapturedAddress } = await loadService()
    mockVerifyGermanAddress.mockResolvedValue({
      ...acceptVerdict(),
      missingComponentTypes: ['street_number'],
      confirmedComponentTypes: ['postal_code', 'locality'],
    })
    const result = await resolveCapturedAddress(
      FAKE_EVENT,
      { ...TYPED_ADDRESS, houseNumber: '' },
      false
    )
    expect(result.check?.verdict).toBe('pending')
  })

  describe('given the customer retries with the override flag', () => {
    it('when the floor check passes, then it never calls the validation service, records overridden, and returns the combined line', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue(null)

      const result = await resolveCapturedAddress(
        FAKE_EVENT,
        TYPED_ADDRESS,
        true
      )

      expect(mockVerifyGermanAddress).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        streetLine: 'Musterallee 5',
        postalCode: '54321',
        city: 'Beispielstadt',
        outcome: 'overridden',
        hasReplacedComponents: false,
      })
    })
  })

  describe('given the service accepts the address outright', () => {
    it('when checked, then it records verified and returns the combined stored line', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue(acceptVerdict())

      const result = await resolveCapturedAddress(
        FAKE_EVENT,
        TYPED_ADDRESS,
        false
      )

      expect(result).toMatchObject({
        streetLine: 'Musterallee 5',
        postalCode: '54321',
        city: 'Beispielstadt',
        outcome: 'verified',
        hasReplacedComponents: false,
      })
    })
  })

  describe('given the service accepts but will not confirm every component', () => {
    it('when checked, then the lead still goes through, recorded as unconfirmed rather than verified', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue(
        acceptVerdict(['street_number'])
      )

      const result = await resolveCapturedAddress(
        FAKE_EVENT,
        TYPED_ADDRESS,
        false
      )

      expect(result.outcome).toBe('unconfirmed')
      expect(result.streetLine).toBe('Musterallee 5')
    })
  })

  describe('given the service confirms with a correction', () => {
    it('when checked, then it never blocks, records corrected, and returns the corrected address', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue({
        outcome: 'confirm',
        address: {
          street: 'Musterallee 5',
          houseNumber: '',
          postalCode: '54399',
          city: 'Beispielstadt',
        },
        missingComponentTypes: [],
        unconfirmedComponentTypes: ['postal_code'],
        hasReplacedComponents: true,
      })

      const result = await resolveCapturedAddress(
        FAKE_EVENT,
        TYPED_ADDRESS,
        false
      )

      expect(result).toMatchObject({
        streetLine: 'Musterallee 5',
        postalCode: '54399',
        city: 'Beispielstadt',
        outcome: 'corrected',
        hasReplacedComponents: true,
      })
    })
  })

  describe('given the service says fix and the customer has not overridden', () => {
    it('when checked, then it rejects with 422 and a house-number code, and calls the service exactly once', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue({
        outcome: 'fix',
        address: TYPED_ADDRESS,
        missingComponentTypes: ['street_number'],
        unconfirmedComponentTypes: [],
        hasReplacedComponents: false,
      })

      await expect(
        resolveCapturedAddress(FAKE_EVENT, TYPED_ADDRESS, false)
      ).rejects.toMatchObject({
        statusCode: 422,
        data: { code: 'houseNumberMissing', addressRejection: 'verification' },
      })
      expect(mockVerifyGermanAddress).toHaveBeenCalledTimes(1)
    })

    it('when checked with a different missing component, then it rejects with the generic code', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue({
        outcome: 'fix',
        address: TYPED_ADDRESS,
        missingComponentTypes: ['locality'],
        unconfirmedComponentTypes: [],
        hasReplacedComponents: false,
      })

      await expect(
        resolveCapturedAddress(FAKE_EVENT, TYPED_ADDRESS, false)
      ).rejects.toMatchObject({
        statusCode: 422,
        data: { code: 'addressUnverifiable' },
      })
    })
  })

  describe('given the service is unreachable', () => {
    it('when the service resolves null, then it records unavailable and proceeds on the combined line as typed', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue(null)

      const result = await resolveCapturedAddress(
        FAKE_EVENT,
        TYPED_ADDRESS,
        false
      )

      expect(result).toMatchObject({
        streetLine: 'Musterallee 5',
        postalCode: '54321',
        city: 'Beispielstadt',
        outcome: 'unavailable',
        hasReplacedComponents: false,
      })
    })
  })

  describe('given a street that already carries its house number', () => {
    it('when combined, then no number is duplicated in the stored line', async () => {
      const { resolveCapturedAddress } = await loadService()
      mockVerifyGermanAddress.mockResolvedValue(null)

      const result = await resolveCapturedAddress(
        FAKE_EVENT,
        { ...TYPED_ADDRESS, street: 'Musterallee 5', houseNumber: '' },
        false
      )

      expect(result.streetLine).toBe('Musterallee 5')
    })
  })

  describe('the rejection vocabulary', () => {
    async function resolveRejectionMessage(code: string): Promise<string> {
      const { createI18n } =
        await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
      const i18n = createI18n({
        legacy: false,
        locale: 'de',
        messages: { de: common },
      })
      return i18n.global.t(`addressInput.${code}`)
    }

    it.each(['houseNumberMissing', 'invalidPostalCode', 'addressUnverifiable'])(
      'when the code is %s, then it resolves to a defined German message rather than the raw key path',
      async (code) => {
        const resolved = await resolveRejectionMessage(code)

        expect(resolved).not.toBe(`addressInput.${code}`)
        expect(resolved.length).toBeGreaterThan(0)
      }
    )
  })
})

describe('buildAddressCorrectionNotice', () => {
  it('given the provider replaced a value the customer typed, when built, then it carries both the typed and the stored address', async () => {
    const { buildAddressCorrectionNotice } = await loadService()

    const notice = buildAddressCorrectionNotice(TYPED_ADDRESS, {
      streetLine: 'Musterallee 5',
      postalCode: '10315',
      city: 'Beispielstadt',
      outcome: 'corrected',
      hasReplacedComponents: true,
    })

    expect(notice).toEqual({
      submitted: {
        street: 'Musterallee 5',
        postalCode: '54321',
        city: 'Beispielstadt',
      },
      stored: {
        street: 'Musterallee 5',
        postalCode: '10315',
        city: 'Beispielstadt',
      },
    })
  })

  it('given the provider only reformatted what the customer typed, when built, then there is no notice', async () => {
    const { buildAddressCorrectionNotice } = await loadService()

    const notice = buildAddressCorrectionNotice(TYPED_ADDRESS, {
      streetLine: 'Musterallee 5',
      postalCode: '54321',
      city: 'Beispielstadt',
      outcome: 'verified',
      hasReplacedComponents: false,
    })

    expect(notice).toBeUndefined()
  })
})
