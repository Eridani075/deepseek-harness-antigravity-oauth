import {
  authorizeAntigravity,
  exchangeAntigravity,
} from '@cortexkit/antigravity-auth-core'
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { loadCredentials, removeCredentials, saveCredentials } from './auth.js'
import {
  startOAuthCallbackServer,
  type OAuthCallbackServer,
} from './oauth-callback.js'

type AntigravityAuthState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'authenticated'; email?: string }
  | { status: 'failed'; error: string }

export type AntigravityLoginStatus = AntigravityAuthState & {
  providerEnabled: boolean
}

export interface AntigravityLoginStart {
  status: 'pending'
  authorizationUrl: string
}

export interface AntigravityProviderController {
  enabled(): boolean
  enable(): Promise<void>
}

export interface AntigravityAuthServiceDeps {
  authorize: typeof authorizeAntigravity
  exchange: typeof exchangeAntigravity
  listen: typeof startOAuthCallbackServer
  load: typeof loadCredentials
  save: typeof saveCredentials
  remove: typeof removeCredentials
}

const defaultDeps: AntigravityAuthServiceDeps = {
  authorize: authorizeAntigravity,
  exchange: exchangeAntigravity,
  listen: startOAuthCallbackServer,
  load: loadCredentials,
  save: saveCredentials,
  remove: removeCredentials,
}

const defaultProviderController: AntigravityProviderController = {
  enabled: () => true,
  enable: async () => {},
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/https?:\/\/\S+/gu, '[URL]')
    .replace(/\b(?:4\/|1\/\/|ya29\.)[A-Za-z0-9._-]+/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240) || 'Unknown error'
}

export class AntigravityAuthService extends TypertRemoteService {
  private readonly deps: AntigravityAuthServiceDeps
  private providerController = defaultProviderController
  private current: AntigravityAuthState | undefined
  private authorizationUrl: string | undefined
  private listener: OAuthCallbackServer | undefined
  private starting: Promise<AntigravityLoginStart> | undefined

  constructor(ctx: Context, deps: AntigravityAuthServiceDeps = defaultDeps) {
    super(ctx, 'antigravityAuth')
    this.deps = deps
    for (const initializer of remoteInitializers) initializer.call(this)
  }

  setProviderController(controller: AntigravityProviderController): void {
    this.providerController = controller
  }

  async enable(): Promise<{ providerEnabled: true }> {
    await this.providerController.enable()
    return { providerEnabled: true }
  }

  async logout(): Promise<{ status: 'idle' }> {
    const listener = this.listener
    this.listener = undefined
    this.authorizationUrl = undefined
    try {
      await this.deps.remove()
      this.current = { status: 'idle' }
      return { status: 'idle' }
    } catch (error: unknown) {
      this.current = { status: 'failed', error: errorSummary(error) }
      throw error
    } finally {
      await listener?.close().catch(() => {})
    }
  }

  async start(): Promise<AntigravityLoginStart> {
    await this.providerController.enable()
    if (this.current?.status === 'pending' && this.authorizationUrl !== undefined) {
      return { status: 'pending', authorizationUrl: this.authorizationUrl }
    }
    if (this.starting !== undefined) return this.starting

    const starting = this.begin()
    this.starting = starting
    return starting.finally(() => {
      if (this.starting === starting) this.starting = undefined
    })
  }

  async status(): Promise<AntigravityLoginStatus> {
    const providerEnabled = this.providerController.enabled()
    if (this.current !== undefined) return { ...this.current, providerEnabled }
    try {
      const credentials = await this.deps.load()
      return {
        status: 'authenticated',
        providerEnabled,
        ...(credentials.email === undefined ? {} : { email: credentials.email }),
      }
    } catch (error: unknown) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') {
        return { status: 'idle', providerEnabled }
      }
      return { status: 'failed', error: errorSummary(error), providerEnabled }
    }
  }

  private async begin(): Promise<AntigravityLoginStart> {
    this.current = { status: 'pending' }
    try {
      const authorization = await this.deps.authorize()
      const state = new URL(authorization.url).searchParams.get('state')
      if (!state) throw new Error('Antigravity authorization URL is missing OAuth state')

      const listener = await this.deps.listen(state)
      this.listener = listener
      this.authorizationUrl = authorization.url
      void this.complete(listener)
      return { status: 'pending', authorizationUrl: authorization.url }
    } catch (error: unknown) {
      this.current = { status: 'failed', error: errorSummary(error) }
      this.authorizationUrl = undefined
      throw new Error(errorSummary(error), { cause: error })
    }
  }

  private async complete(listener: OAuthCallbackServer): Promise<void> {
    try {
      const callback = await listener.result
      if (this.listener !== listener) return
      if (callback === undefined) throw new Error('Google authorization timed out')
      const result = await this.deps.exchange(callback.code, callback.state)
      if (this.listener !== listener) return
      if (result.type === 'failed') throw new Error(`Antigravity token exchange failed: ${result.error}`)
      await this.deps.save({
        version: 1,
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
        ...(result.email === undefined ? {} : { email: result.email }),
        ...(result.label === undefined ? {} : { label: result.label }),
      })
      this.current = {
        status: 'authenticated',
        ...(result.email === undefined ? {} : { email: result.email }),
      }
    } catch (error: unknown) {
      this.current = { status: 'failed', error: errorSummary(error) }
    } finally {
      this.authorizationUrl = undefined
      if (this.listener === listener) this.listener = undefined
      await listener.close().catch(() => {})
    }
  }
}

// Vitest's current transform does not parse standard decorator syntax. The
// protocol decorator still owns marker creation; these initializers invoke it
// with the same context shape TypeScript emits for `@Remote`.
const remoteInitializers: Array<(this: AntigravityAuthService) => void> = []
function markRemote(method: 'enable' | 'start' | 'status' | 'logout'): void {
  Remote(AntigravityAuthService.prototype[method] as never, {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: {
      has: (object: AntigravityAuthService) => method in object,
      get: (object: AntigravityAuthService) => object[method],
    },
    addInitializer(initializer: (this: AntigravityAuthService) => void) {
      remoteInitializers.push(initializer as (this: AntigravityAuthService) => void)
    },
  } as never)
}
markRemote('start')
markRemote('status')
markRemote('enable')
markRemote('logout')
