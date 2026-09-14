import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeExchangeFailure, exchangeAntigravityResilient } from '../src/oauth-exchange.js'

function state(verifier: string, projectId: string): string {
  return Buffer.from(JSON.stringify({ verifier, projectId }), 'utf8').toString('base64url')
}

function tokenPayload(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('exchangeAntigravityResilient', () => {
  it('exchanges the code and keeps the profile email', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(tokenPayload())
      if (url.startsWith('https://www.googleapis.com/oauth2/v1/userinfo')) {
        return Promise.resolve(new Response(JSON.stringify({ email: 'user@example.com', name: ' User ' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await exchangeAntigravityResilient('auth-code', state('pkce-verifier', 'project-1'))

    expect(result).toMatchObject({
      type: 'success',
      refresh: 'refresh-token|project-1',
      access: 'access-token',
      email: 'user@example.com',
      label: 'User',
      projectId: 'project-1',
    })
    if (result.type !== 'success') throw new Error('expected success')
    expect(result.expires).toBeGreaterThan(Date.now())

    const body = calls[0]?.init?.body as URLSearchParams
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(Object.fromEntries(body)).toMatchObject({
      code: 'auth-code',
      grant_type: 'authorization_code',
      code_verifier: 'pkce-verifier',
      redirect_uri: 'http://localhost:51121/oauth-callback',
    })
    expect(body.get('client_id')).toBeTruthy()
    expect(new Headers(calls[0]?.init?.headers).get('content-type'))
      .toBe('application/x-www-form-urlencoded;charset=UTF-8')
  })

  it('succeeds when the userinfo host is unreachable', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(tokenPayload())
      return Promise.reject(new TypeError('fetch failed'))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await exchangeAntigravityResilient('auth-code', state('pkce-verifier', ''))

    expect(result).toMatchObject({
      type: 'success',
      refresh: 'refresh-token|',
      access: 'access-token',
      projectId: '',
    })
    expect(result.type === 'success' && result.email).not.toBeTruthy()
    expect(result.type === 'success' && result.label).not.toBeTruthy()
  })

  it('succeeds when the userinfo host answers with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(tokenPayload())
      return Promise.resolve(new Response('nope', { status: 502 }))
    }))

    await expect(exchangeAntigravityResilient('auth-code', state('pkce-verifier', 'project-1')))
      .resolves.toMatchObject({ type: 'success', projectId: 'project-1' })
  })

  it('reports the token endpoint error body', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ))))

    await expect(exchangeAntigravityResilient('used-code', state('pkce-verifier', '')))
      .resolves.toEqual({ type: 'failed', error: JSON.stringify({ error: 'invalid_grant' }) })
  })

  it('fails when the token endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))

    await expect(exchangeAntigravityResilient('auth-code', state('pkce-verifier', '')))
      .resolves.toEqual({ type: 'failed', error: 'fetch failed' })
  })

  it('fails when the response carries no refresh token', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(tokenPayload({ refresh_token: undefined }))))

    await expect(exchangeAntigravityResilient('auth-code', state('pkce-verifier', '')))
      .resolves.toEqual({ type: 'failed', error: 'Missing refresh token in response' })
  })

  it('rejects a state without a PKCE verifier', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const encoded = Buffer.from(JSON.stringify({ projectId: 'project-1' }), 'utf8').toString('base64url')
    await expect(exchangeAntigravityResilient('auth-code', encoded))
      .resolves.toEqual({ type: 'failed', error: 'Missing PKCE verifier in state' })

    const garbage = await exchangeAntigravityResilient('auth-code', 'not-base64-json')
    expect(garbage.type).toBe('failed')
    expect(garbage.type === 'failed' && garbage.error.length).toBeGreaterThan(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('describeExchangeFailure', () => {
  it('hints at host connectivity for network failures', () => {
    expect(describeExchangeFailure('fetch failed'))
      .toBe('Antigravity token exchange failed: fetch failed — check that the DSH host can reach oauth2.googleapis.com')
    expect(describeExchangeFailure('Client network socket disconnected before secure TLS connection was established'))
      .toContain('check that the DSH host can reach oauth2.googleapis.com')
  })

  it('keeps provider errors free of the connectivity hint', () => {
    expect(describeExchangeFailure('{"error":"invalid_grant"}'))
      .toBe('Antigravity token exchange failed: {"error":"invalid_grant"}')
  })
})
