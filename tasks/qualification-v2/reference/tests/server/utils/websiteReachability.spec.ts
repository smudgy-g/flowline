import { describe, expect, it, vi } from 'vitest'
import {
  isPublicAddress,
  probeBusinessEmailWebsite,
  probeCompanyWebsite,
  type WebsiteProbeAdapter,
} from '#server/utils/websiteReachability'

const client = (status: number, location?: string): WebsiteProbeAdapter => ({
  resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]),
  request: vi.fn(async () => ({ status, location })),
})

describe('bounded website signal', () => {
  it('when customer is private or email is free-mail, then website probe is skipped', async () => {
    const adapter = client(200)
    expect(
      await probeBusinessEmailWebsite('person@gmail.com', true, adapter)
    ).toBeNull()
    expect(
      await probeBusinessEmailWebsite('person@example.org', false, adapter)
    ).toBeNull()
    expect(adapter.resolve).not.toHaveBeenCalled()
  })

  it('when HTTPS fails but public HTTP returns 2xx, then website earns reachability', async () => {
    const adapter = client(200)
    adapter.request = vi.fn(async (url) => ({
      status: url.protocol === 'https:' ? 503 : 200,
    }))
    expect(await probeCompanyWebsite('example.org', adapter)).toEqual({
      basis: 'http_reachable',
    })
    expect(adapter.request).toHaveBeenCalledTimes(2)
  })

  it('when DNS resolves without HTTP success, then no reachability points are supported', async () => {
    expect(await probeCompanyWebsite('example.org', client(503))).toBeNull()
  })

  it('when pinned HTTP request responds 2xx, then reachability is supported', async () => {
    const adapter = client(204)
    expect(await probeCompanyWebsite('example.org', adapter)).toEqual({
      basis: 'http_reachable',
    })
    expect(adapter.request).toHaveBeenCalledOnce()
  })

  it('when DNS returns any private or reserved address, then never connect', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.0.0.1',
      '192.168.1.1',
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
      '2001:0db8:0:0::1',
      '2001:0000::1',
      '2002::1',
      '3fff::1',
      '3fff:0000:0000::1',
    ]) {
      expect(isPublicAddress(address)).toBe(false)
      const adapter = client(200)
      adapter.resolve = vi.fn(async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]) as WebsiteProbeAdapter['resolve']
      expect(await probeCompanyWebsite('example.org', adapter)).toBeNull()
      expect(adapter.request).not.toHaveBeenCalled()
    }
  })

  it('when DNS returns global unicast, then the website may be probed', async () => {
    for (const address of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
      const adapter = client(200)
      adapter.resolve = vi.fn(async () => [{ address, family: 6 as const }])
      expect(await probeCompanyWebsite('example.org', adapter)).toEqual({
        basis: 'http_reachable',
      })
      expect(adapter.request).toHaveBeenCalledOnce()
    }
  })

  it('when redirect targets a private address or forbidden host, then reject before connecting', async () => {
    const adapter = client(302, 'http://127.0.0.1/admin')
    expect(await probeCompanyWebsite('example.org', adapter)).toBeNull()
    expect(adapter.request).toHaveBeenCalledOnce()
  })

  it('when redirect hostname resolves to private address, then reject before second connection', async () => {
    const adapter = client(302, 'https://redirect.example.org/')
    adapter.resolve = vi.fn(async (host) => [
      {
        address: host === 'redirect.example.org' ? '192.0.0.1' : '8.8.8.8',
        family: 4 as const,
      },
    ])
    expect(await probeCompanyWebsite('example.org', adapter)).toBeNull()
    expect(adapter.request).toHaveBeenCalledOnce()
    expect(adapter.resolve).toHaveBeenCalledTimes(2)
  })

  it('when resolution never returns, then timeout terminates probe', async () => {
    const adapter = client(200)
    adapter.resolve = () => new Promise(() => {})
    expect(await probeCompanyWebsite('example.org', adapter)).toBeNull()
    expect(adapter.request).not.toHaveBeenCalled()
  }, 5000)

  it('when a connected request stalls, then its abort signal terminates the probe without earning points', async () => {
    const adapter = client(200)
    adapter.request = vi.fn(
      (_url, _address, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
    )
    expect(await probeCompanyWebsite('example.org', adapter)).toBeNull()
    expect(adapter.request).toHaveBeenCalledOnce()
  }, 5000)
})
