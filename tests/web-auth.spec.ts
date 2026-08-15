import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  AntigravityAuthService,
  type AntigravityAuthServiceDeps,
} from '../src/web-auth.js'
import type { StoredCredentials } from '../src/auth.js'
import type { OAuthCallbackServer } from '../src/oauth-callback.js'

describe('AntigravityAuthService', () => {
  it('starts OAuth, completes the callback in the background, and exposes no tokens', async () => {
    let resolveCallback!: (value: { code: string; state: string }) => void
    const callback = new Promise<{ code: string; state: string }>(resolve => { resolveCallback = resolve })
    const listener: OAuthCallbackServer = {
      port: 51121,
      result: callback,
      close: vi.fn(async () => {}),
    }
    let saved: StoredCredentials | undefined
    const save = vi.fn(async (value: StoredCredentials) => { saved = value })
    const remove = vi.fn(async () => {})
    const deps: AntigravityAuthServiceDeps = {
      authorize: vi.fn(async () => ({
        url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test-state',
        verifier: 'verifier',
        projectId: '',
      })),
      exchange: vi.fn(async () => ({
        type: 'success' as const,
        refresh: 'refresh-token',
        access: 'access-token',
        expires: Date.now() + 60_000,
        email: 'user@example.com',
        projectId: 'project',
      })),
      listen: vi.fn(async () => listener),
      load: vi.fn(async () => { throw new Error('missing') }),
      save,
      remove,
    }
    const service = new AntigravityAuthService(new Context(), deps)

    expect(remoteMethods(service).map(method => method.method)).toEqual(['start', 'status', 'enable', 'logout'])
    await expect(service.status()).resolves.toEqual({ status: 'failed', error: 'missing', providerEnabled: true })
    await expect(service.start()).resolves.toEqual({
      status: 'pending',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=test-state',
    })
    await expect(service.status()).resolves.toEqual({ status: 'pending', providerEnabled: true })

    resolveCallback({ code: 'authorization-code', state: 'test-state' })
    await vi.waitFor(async () => {
      await expect(service.status()).resolves.toEqual({
        status: 'authenticated',
        email: 'user@example.com',
        providerEnabled: true,
      })
    })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      email: 'user@example.com',
    }))
    expect(saved?.access).toBe('access-token')
    expect(saved?.refresh).toBe('refresh-token')
    expect(listener.close).toHaveBeenCalled()
  })

  it('deletes local credentials and returns to idle', async () => {
    const remove = vi.fn(async () => {})
    const service = new AntigravityAuthService(new Context(), {
      authorize: vi.fn(),
      exchange: vi.fn(),
      listen: vi.fn(),
      load: vi.fn(async () => ({
        version: 1 as const,
        refresh: 'refresh-token',
        access: 'access-token',
        expires: Date.now() + 60_000,
        email: 'user@example.com',
      })),
      save: vi.fn(),
      remove,
    })

    await expect(service.status()).resolves.toEqual({
      status: 'authenticated',
      email: 'user@example.com',
      providerEnabled: true,
    })
    await expect(service.logout()).resolves.toEqual({ status: 'idle' })
    expect(remove).toHaveBeenCalledOnce()
    await expect(service.status()).resolves.toEqual({ status: 'idle', providerEnabled: true })
  })
})
