import type {
  BusinessCheck,
  QualificationScoreBreakdown,
} from '#shared/schemas/qualification'
import { isPlaceholderCompanyName } from '#shared/utils/isPlaceholderCompanyName'

type Lookup = NonNullable<
  Exclude<BusinessCheck, { status: 'not_applicable' }>['breakdown']
>['registry']

export interface RegistryFinding {
  status: 'checked' | 'not_checked' | 'unavailable'
  found?: boolean
  active?: boolean
  nameMatched?: boolean
  reason?: string
  legalType?: string | null
}

export interface DirectoryFinding {
  status: 'checked' | 'not_checked' | 'unavailable'
  found?: boolean
  operational?: boolean
  nameMatched?: boolean
  addressMatched?: boolean
  matchedName?: string | null
  reason?: string
}

function registryFact(finding: RegistryFinding, placeholder: boolean): Lookup {
  if (finding.status !== 'checked')
    return { status: finding.status, result: null, reason: finding.reason }
  if (!finding.found)
    return {
      status: 'checked',
      result: 'no_match',
      reason: finding.reason ?? 'no_record',
    }
  return {
    status: 'checked',
    result:
      !placeholder && finding.active && finding.nameMatched
        ? 'match'
        : 'no_match',
    active: finding.active === true,
    nameMatched: !placeholder && finding.nameMatched === true,
    corporateLegalForm: CORPORATE_SUFFIX.test(finding.legalType ?? ''),
    ...(finding.reason ? { reason: finding.reason } : {}),
  }
}

function directoryFact(
  finding: DirectoryFinding,
  placeholder: boolean
): Lookup {
  if (finding.status !== 'checked')
    return { status: finding.status, result: null, reason: finding.reason }
  if (!finding.found)
    return {
      status: 'checked',
      result: 'no_match',
      reason: finding.reason ?? 'no_listing',
    }
  const nameMatched = !placeholder && finding.nameMatched === true
  const addressMatched = !placeholder && finding.addressMatched === true
  const operational = finding.operational === true
  return {
    status: 'checked',
    result: operational && nameMatched && addressMatched ? 'match' : 'no_match',
    operational,
    nameMatched,
    addressMatched,
    corporateLegalForm:
      nameMatched && CORPORATE_SUFFIX.test(finding.matchedName ?? ''),
    ...(finding.reason ? { reason: finding.reason } : {}),
  }
}

export function businessLookupCheck(input: {
  companyName: string | null
  registry: RegistryFinding
  directory: DirectoryFinding
}): BusinessCheck {
  const placeholder = isPlaceholderCompanyName(input.companyName ?? '')
  const registry = registryFact(input.registry, placeholder)
  const directory = directoryFact(input.directory, placeholder)
  const matched = registry.result === 'match' || directory.result === 'match'
  let status: 'checked' | 'unavailable' | 'not_checked' = 'not_checked'
  if (registry.status === 'unavailable' || directory.status === 'unavailable')
    status = 'unavailable'
  if (
    matched ||
    registry.status === 'checked' ||
    directory.status === 'checked'
  )
    status = 'checked'
  let reason = 'customer_confirmation_needed'
  if (directory.result === 'match') reason = 'directory_match'
  if (registry.result === 'match') reason = 'registry_match'
  return {
    status,
    verdict: matched ? 'passed' : 'pending',
    reason,
    breakdown: { registry, directory },
  }
}

const CORPORATE_SUFFIX =
  /(?:^|[\s,.()])(?:gmbh|ug(?:\s*\(haftungsbeschr[aä]nkt\))?|ag|se|kgaa|eg)[\s,.()]*$/iu

export function legalFormBasisFromCheck(input: {
  check: BusinessCheck
  submittedName: string | null
}): QualificationScoreBreakdown['legalFormBasis'] {
  const evidence =
    input.check.status === 'not_applicable' ? undefined : input.check.breakdown
  if (
    evidence?.registry.result === 'match' &&
    evidence.registry.corporateLegalForm
  )
    return 'registry'
  if (
    evidence?.directory.status === 'checked' &&
    evidence.directory.nameMatched &&
    evidence.directory.corporateLegalForm
  )
    return 'directory_name'
  if (
    CORPORATE_SUFFIX.test(input.submittedName ?? '') &&
    !isPlaceholderCompanyName(input.submittedName ?? '')
  )
    return 'submitted_name'
  return undefined
}

export function corporationLegalFormBasis(input: {
  registryLegalType?: string | null
  registryMatched: boolean
  directoryName?: string | null
  directoryNameMatched: boolean
  submittedName?: string | null
}): QualificationScoreBreakdown['legalFormBasis'] {
  if (
    input.registryMatched &&
    CORPORATE_SUFFIX.test(input.registryLegalType ?? '')
  )
    return 'registry'
  if (
    input.directoryNameMatched &&
    CORPORATE_SUFFIX.test(input.directoryName ?? '')
  )
    return 'directory_name'
  if (
    CORPORATE_SUFFIX.test(input.submittedName ?? '') &&
    !isPlaceholderCompanyName(input.submittedName ?? '')
  )
    return 'submitted_name'
  return undefined
}
