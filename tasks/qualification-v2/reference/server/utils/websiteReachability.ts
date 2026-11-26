import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import {
  classifyEmailDomain,
  extractEmailDomain,
} from '#shared/utils/emailDomains'
import { logValidationOutage } from '#server/utils/bouncerValidation'

const TIMEOUT_MS = 2500
const MAX_BYTES = 8192
const MAX_REDIRECTS = 2
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

const reservedIpv6 = new BlockList()
reservedIpv6.addSubnet('2001::', 23, 'ipv6')
reservedIpv6.addSubnet('2001:db8::', 32, 'ipv6')
reservedIpv6.addSubnet('2002::', 16, 'ipv6')
reservedIpv6.addSubnet('3fff::', 20, 'ipv6')

const globalUnicastIpv6 = new BlockList()
globalUnicastIpv6.addSubnet('2000::', 3, 'ipv6')

type ResolvedAddress = { address: string; family: 4 | 6 }
export interface WebsiteProbeAdapter {
  resolve(host: string): Promise<ResolvedAddress[]>
  request(
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal
  ): Promise<{ status: number; location?: string }>
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    if (a === undefined || b === undefined || c === undefined) return false
    return (
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0 || b === 88)) &&
      !(a === 192 && b === 0 && c === 2) &&
      !(a === 198 && (b === 18 || b === 19 || b === 51)) &&
      !(a === 198 && b === 51 && c === 100) &&
      !(a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) !== 6) return false
  return (
    globalUnicastIpv6.check(address, 'ipv6') &&
    !reservedIpv6.check(address, 'ipv6')
  )
}

function validDestination(url: URL): boolean {
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    !url.username &&
    !url.password &&
    !url.port &&
    !isIP(url.hostname) &&
    HOSTNAME.test(url.hostname) &&
    !/\.(?:local|localhost|internal|test|invalid|example)$/i.test(url.hostname)
  )
}

const adapter: WebsiteProbeAdapter = {
  async resolve(host) {
    const records = await dns.lookup(host, { all: true, verbatim: true })
    return records.filter(
      (entry): entry is ResolvedAddress =>
        entry.family === 4 || entry.family === 6
    )
  },
  request(url, address, signal) {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      const request = transport.request(
        url,
        {
          method: 'GET',
          signal,
          agent: false,
          headers: { accept: 'text/html' },
          lookup(_host, _options, callback) {
            callback(null, address.address, address.family)
          },
        },
        (response) => {
          const status = response.statusCode ?? 0
          const location = response.headers.location
          let received = 0
          response.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (received > MAX_BYTES)
              request.destroy(new Error('response_too_large'))
          })
          response.on('end', () => resolve({ status, location }))
          response.on('error', reject)
        }
      )
      request.on('socket', (socket) => {
        socket.on('connect', () => {
          if (socket.remoteAddress !== address.address)
            request.destroy(new Error('destination_changed'))
        })
      })
      request.on('error', reject)
      request.end()
    })
  },
}

export async function probeBusinessEmailWebsite(
  email: string,
  isBusiness: boolean,
  client?: WebsiteProbeAdapter
): Promise<{ basis: 'http_reachable' } | null> {
  if (!isBusiness || classifyEmailDomain(email) !== 'corporate') return null
  const domain = extractEmailDomain(email)
  return domain ? probeCompanyWebsite(domain, client) : null
}

export async function probeCompanyWebsite(
  domain: string,
  client: WebsiteProbeAdapter = adapter
): Promise<{ basis: 'http_reachable' } | null> {
  const normalized = domain.trim().toLowerCase()
  if (!HOSTNAME.test(normalized)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let url = new URL(`https://${normalized}/`)
    let usedHttpFallback = false
    for (let redirects = 0; redirects <= MAX_REDIRECTS + 1; redirects++) {
      if (!validDestination(url) || controller.signal.aborted) return null
      const addresses = await Promise.race([
        client.resolve(url.hostname),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('timeout')),
            { once: true }
          )
        ),
      ])
      if (
        !addresses.length ||
        addresses.some((entry) => !isPublicAddress(entry.address))
      )
        return null
      let response: { status: number; location?: string }
      try {
        response = await client.request(url, addresses[0]!, controller.signal)
      } catch {
        if (
          url.protocol !== 'https:' ||
          redirects !== 0 ||
          controller.signal.aborted
        )
          throw new Error('probe_failed')
        url = new URL(`http://${normalized}/`)
        usedHttpFallback = true
        continue
      }
      if (response.status >= 200 && response.status < 300)
        return { basis: 'http_reachable' }
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.location
      ) {
        if (redirects - Number(usedHttpFallback) >= MAX_REDIRECTS) return null
        url = new URL(response.location, url)
        continue
      }
      if (url.protocol !== 'https:' || redirects !== 0) return null
      url = new URL(`http://${normalized}/`)
      usedHttpFallback = true
    }
  } catch {
    logValidationOutage(
      'website',
      'probe',
      controller.signal.aborted ? 'timeout' : 'request_failed'
    )
    return null
  } finally {
    clearTimeout(timer)
  }
  return null
}
