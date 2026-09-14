import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { AntigravityAdapter, PROVIDER } from './adapter.js'
import { AntigravityAuthService } from './web-auth.js'

export { AntigravityAdapter, PROVIDER, parseGeminiSse } from './adapter.js'
export { credentialFilePath } from './auth.js'
export { AntigravityAuthService } from './web-auth.js'

export const name = 'llm-antigravity-oauth'
export const inject = ['llm']

/**
 * Lowercase-hyphenated literal rather than the `settingsNamespace()` helper,
 * which dsh 0.1.5 no longer exports. The brand is type-level only: 0.1.0-rc.6
 * brands the return value, 0.1.5 constrains the literal at the call site.
 */
const SETTINGS_NS = 'llm-antigravity-oauth' as SettingsNamespace
const PROVIDER_SETTINGS_PATH = ['providers', PROVIDER] as const
const PROVIDER_ENTRY = {
  provider: PROVIDER,
  displayName: 'Google Antigravity',
  settingsNs: SETTINGS_NS,
  settingsPath: PROVIDER_SETTINGS_PATH,
} as const
const SettingsConfig = z.object({
  enabled: z.boolean().default(true),
  providers: z.dict(z.object({})),
})

function hasProviderProfile(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const providers = (value as Record<string, unknown>).providers
  return providers !== null
    && typeof providers === 'object'
    && Object.prototype.hasOwnProperty.call(providers, PROVIDER)
}

function isDisabled(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && (value as Record<string, unknown>).enabled === false
}

function providerProfiles(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {}
  const providers = (value as Record<string, unknown>).providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return {}
  return providers as Record<string, unknown>
}

export function apply(ctx: Context): void {
  const authService = new AntigravityAuthService(ctx)
  const providerRegistration = ctx.llm.registerConfigurableProviders([PROVIDER_ENTRY])
  // Resolved per request: the attachment service may load after this plugin.
  const adapterRegistration = ctx.llm.registerAdapter(
    [PROVIDER],
    new AntigravityAdapter({ attachments: () => ctx.get('attachments') }),
  )
  ctx.inject(['settings'], scope => {
    const settings = scope.settings.register(SETTINGS_NS, SettingsConfig, { base: {} })
    const initial = settings.get()

    // Models owns the delete confirmation. A user profile acts as the provider
    // enable switch; the tombstone prevents a deleted profile from returning on
    // restart; the Antigravity page can restore the profile without re-login.
    const syncRegistrations = (value: unknown): void => {
      const enabled = hasProviderProfile(value)
      providerRegistration.replace(enabled ? [PROVIDER_ENTRY] : [])
      adapterRegistration.replace(enabled ? [PROVIDER] : [])
    }

    const enableProvider = async (): Promise<void> => {
      if (!hasProviderProfile(settings.get())) {
        await settings.update({
          enabled: true,
          providers: { ...providerProfiles(settings.get()), [PROVIDER]: {} },
        })
      }
      syncRegistrations(settings.get())
    }

    authService.setProviderController({
      enabled: () => hasProviderProfile(settings.get()),
      enable: enableProvider,
    })

    if (hasProviderProfile(initial)) {
      syncRegistrations(initial)
    } else if (isDisabled(initial)) {
      syncRegistrations(initial)
    } else {
      syncRegistrations({ providers: { [PROVIDER]: {} } })
      void enableProvider().catch(error => {
        ctx.logger.warn('antigravity: failed to initialize provider settings')
        ctx.logger.warn(error)
      })
    }

    settings.watch(next => {
      const profileExists = hasProviderProfile(next)
      syncRegistrations(next)
      if (profileExists && isDisabled(next)) {
        void settings.update({ enabled: true }).catch(error => {
          ctx.logger.warn('antigravity: failed to re-enable provider settings')
          ctx.logger.warn(error)
        })
      } else if (!profileExists && !isDisabled(next)) {
        void settings.update({ enabled: false }).catch(error => {
          ctx.logger.warn('antigravity: failed to persist provider removal')
          ctx.logger.warn(error)
        })
      }
    })
  })
}
