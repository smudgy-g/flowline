import type { H3Event } from 'h3'
import { z } from 'zod'
import { captureException } from '@sentry/node'
import type { DeliveryResult } from '#shared/utils/captureQualificationChecks'

const BOUNCER_TIMEOUT_MS = 3000
const BOUNCER_ENDPOINT = 'https://api.usebouncer.com/v1.1/email/verify'
const responseSchema = z.object({
  status: z.enum(['deliverable', 'risky', 'undeliverable', 'unknown']),
  reason: z.string().nullish(),
})

export function logValidationOutage(
  provider:
    | 'dns'
    | 'bouncer'
    | 'google'
    | 'twilio'
    | 'registry'
    | 'directory'
    | 'website',
  operation: string,
  category: string,
  correlation?: string
): void {
  captureException(new Error('Validation provider unavailable'), {
    extra: { provider, operation, category, correlation },
  })
}

export async function checkBouncer(
  event: H3Event,
  email: string
): Promise<DeliveryResult> {
  const key = useRuntimeConfig(event).BOUNCER_API_KEY
  if (!key) {
    logValidationOutage('bouncer', 'verify', 'not_configured')
    return { status: 'unavailable', verdict: null, reason: null }
  }

  try {
    const raw: unknown = await $fetch(BOUNCER_ENDPOINT, {
      headers: { 'x-api-key': key },
      query: { email },
      retry: 0,
      timeout: BOUNCER_TIMEOUT_MS,
    })
    const result = responseSchema.safeParse(raw)
    if (!result.success) {
      logValidationOutage('bouncer', 'verify', 'invalid_response')
      return { status: 'unavailable', verdict: null, reason: null }
    }
    return {
      status: 'completed',
      verdict: result.data.status,
      reason: result.data.reason ?? null,
    }
  } catch (error) {
    const category =
      error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'request_failed'
    logValidationOutage('bouncer', 'verify', category)
    return { status: 'unavailable', verdict: null, reason: null }
  }
}
