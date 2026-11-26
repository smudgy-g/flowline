import { describe, expect, it } from 'vitest'
import {
  businessLookupCheck,
  corporationLegalFormBasis,
  legalFormBasisFromCheck,
} from '#shared/utils/businessEvidence'

const noRegistry = { status: 'checked' as const, found: false }
const partialDirectory = {
  status: 'checked' as const,
  found: true,
  operational: true,
  nameMatched: true,
  addressMatched: false,
}

describe('business corroboration', () => {
  it('when registry misses but directory matches, then registry does not inherit directory evidence', () => {
    const result = businessLookupCheck({
      companyName: 'Beispiel GmbH',
      registry: noRegistry,
      directory: { ...partialDirectory, addressMatched: true },
    })
    expect(result.verdict).toBe('passed')
    if (result.status === 'not_applicable') throw new Error('unexpected')
    expect(result.breakdown?.registry.result).toBe('no_match')
    expect(result.breakdown?.directory.result).toBe('match')
  })

  it('when registry matches but directory reports no listing, then positive registry remains decisive', () => {
    const result = businessLookupCheck({
      companyName: 'Beispiel GmbH',
      registry: {
        status: 'checked',
        found: true,
        active: true,
        nameMatched: true,
      },
      directory: { status: 'checked', found: false },
    })
    expect(result.verdict).toBe('passed')
    if (result.status === 'not_applicable') throw new Error('unexpected')
    expect(result.breakdown?.registry.result).toBe('match')
    expect(result.breakdown?.directory.result).toBe('no_match')
  })

  it('when only directory name or address matches, then check stays pending', () => {
    for (const directory of [
      partialDirectory,
      { ...partialDirectory, nameMatched: false, addressMatched: true },
    ]) {
      const result = businessLookupCheck({
        companyName: 'Beispiel GmbH',
        registry: noRegistry,
        directory,
      })
      expect(result.verdict).toBe('pending')
      if (result.status === 'not_applicable') throw new Error('unexpected')
      expect(result.breakdown?.directory.result).toBe('no_match')
    }
  })

  it('when registry is inactive but directory independently matches, then directory alone corroborates business', () => {
    const result = businessLookupCheck({
      companyName: 'Beispiel GmbH',
      registry: {
        status: 'checked',
        found: true,
        active: false,
        nameMatched: true,
        legalType: 'GmbH',
      },
      directory: {
        ...partialDirectory,
        addressMatched: true,
        matchedName: 'Beispiel',
      },
    })
    expect(result.verdict).toBe('passed')
    if (result.status === 'not_applicable') throw new Error('unexpected')
    expect(result.breakdown?.registry).toMatchObject({
      result: 'no_match',
      active: false,
    })
    expect(result.breakdown?.directory.result).toBe('match')
    expect(
      legalFormBasisFromCheck({ check: result, submittedName: 'Beispiel' })
    ).toBeUndefined()
  })

  it('when registry is inactive or company placeholder, then no positive match survives', () => {
    for (const companyName of ['Beispiel GmbH', 'Privatkunde']) {
      const result = businessLookupCheck({
        companyName,
        registry: {
          status: 'checked',
          found: true,
          active: companyName === 'Privatkunde',
          nameMatched: true,
        },
        directory: { status: 'not_checked' },
      })
      expect(result.verdict).toBe('pending')
    }
  })

  it('when provider is unavailable, then lookup is unknown rather than no match', () => {
    const result = businessLookupCheck({
      companyName: 'Beispiel GmbH',
      registry: { status: 'unavailable' },
      directory: { status: 'not_checked' },
    })
    expect(result.status).toBe('unavailable')
    if (result.status === 'not_applicable') throw new Error('unexpected')
    expect(result.breakdown?.registry.result).toBeNull()
  })

  it('when a corporation is declared without corroborating evidence, then it earns zero points', () => {
    const input = {
      registryMatched: false,
      directoryNameMatched: false,
      submittedName: 'Beispiel',
    }
    expect(corporationLegalFormBasis(input)).toBeUndefined()
    expect(
      corporationLegalFormBasis({
        ...input,
        registryMatched: true,
        registryLegalType: 'GmbH',
        directoryNameMatched: true,
        directoryName: 'Beispiel AG',
        submittedName: 'Beispiel SE',
      })
    ).toBe('registry')
    expect(
      corporationLegalFormBasis({
        ...input,
        directoryNameMatched: true,
        directoryName: 'Beispiel AG',
      })
    ).toBe('directory_name')
    expect(
      corporationLegalFormBasis({ ...input, submittedName: 'Beispiel GmbH' })
    ).toBe('submitted_name')
    expect(
      corporationLegalFormBasis({
        ...input,
        directoryNameMatched: true,
        directoryName: 'Beispiel',
      })
    ).toBeUndefined()
    expect(
      corporationLegalFormBasis({
        ...input,
        submittedName: 'Beispiel GmbH & Co KG',
      })
    ).toBeUndefined()
  })

  it('when persisted lookup facts carry corporate provenance, then score takes strongest single basis', () => {
    const check = businessLookupCheck({
      companyName: 'Beispiel SE',
      registry: {
        status: 'checked',
        found: true,
        active: true,
        nameMatched: true,
        legalType: 'Beispiel AG',
      },
      directory: { ...partialDirectory, matchedName: 'Beispiel GmbH' },
    })
    expect(
      legalFormBasisFromCheck({ check, submittedName: 'Beispiel SE' })
    ).toBe('registry')
    const noRegistryCheck = businessLookupCheck({
      companyName: 'Beispiel',
      registry: noRegistry,
      directory: { ...partialDirectory, matchedName: 'Beispiel GmbH' },
    })
    expect(
      legalFormBasisFromCheck({
        check: noRegistryCheck,
        submittedName: 'Beispiel',
      })
    ).toBe('directory_name')
  })
})
