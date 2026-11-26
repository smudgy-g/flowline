import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { captureException } from '@sentry/node'

const fetchMock = vi.fn()
vi.stubGlobal('$fetch', fetchMock)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/' },
  BOUNCER_API_KEY: 'test-key',
}))
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }))
const event = {} as H3Event

beforeEach(() => vi.clearAllMocks())

describe('Bouncer submit-time lookup', () => {
  it.each([
    ['risky', 'low_quality'],
    ['unknown', 'timeout'],
    ['undeliverable', 'invalid_mailbox'],
  ] as const)(
    'when status is %s, then it retains documented reason from one bounded request',
    async (status, reason) => {
      fetchMock.mockResolvedValueOnce({ status, reason, score: 0 })

      const { checkBouncer } = await import('#server/utils/bouncerValidation')
      const result = await checkBouncer(event, 'person@example.com')

      expect(result).toEqual({ status: 'completed', verdict: status, reason })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('usebouncer.com'),
        expect.objectContaining({
          retry: 0,
          timeout: 3000,
          headers: { 'x-api-key': 'test-key' },
        })
      )
    }
  )

  it('when request times out, then it records unavailable without leaking email, response or credentials', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('person@example.com'), { name: 'AbortError' })
    )

    const { checkBouncer } = await import('#server/utils/bouncerValidation')
    expect(await checkBouncer(event, 'person@example.com')).toEqual({
      status: 'unavailable',
      verdict: null,
      reason: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Validation provider unavailable' }),
      {
        extra: {
          provider: 'bouncer',
          operation: 'verify',
          category: 'timeout',
          correlation: undefined,
        },
      }
    )
  })

  it('when response is malformed, then it remains unavailable without logging raw data', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 'bad',
      email: 'person@example.com',
    })

    const { checkBouncer } = await import('#server/utils/bouncerValidation')
    expect(await checkBouncer(event, 'person@example.com')).toMatchObject({
      status: 'unavailable',
      verdict: null,
    })
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: {
        provider: 'bouncer',
        operation: 'verify',
        category: 'invalid_response',
        correlation: undefined,
      },
    })
  })
})
