import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  GEMINI_CLI_HEADERS,
  calculateTokenExpiry,
  fetchWithActiveTimeout,
  formatRefreshParts,
  type AntigravityTokenExchangeResult,
} from '@cortexkit/antigravity-auth-core'

/**
 * OAuth code exchange that survives an unreachable `www.googleapis.com`.
 *
 * Core's `exchangeAntigravity()` fetches the userinfo profile after the token
 * POST and lets any network error end the whole exchange, discarding tokens
 * that Google has already issued. userinfo only supplies the display email and
 * label, so a blocked or flaky userinfo host must not fail a login — notably on
 * networks where `oauth2.googleapis.com` is reachable but `www.googleapis.com`
 * is not. The token request below mirrors core 2.1.0 parameter for parameter.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'
const TOKEN_TIMEOUT_MS = 20_000
const USERINFO_TIMEOUT_MS = 4_000

const NETWORK_FAILURE =
  /fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket disconnected|aborted|timed out/i

/**
 * Login failure message for presentation. Network-level failures carry an
 * explicit hint because "fetch failed" alone is indistinguishable from a
 * rejected authorization code and hides which hop actually broke.
 */
export function describeExchangeFailure(error: string): string {
  const base = `Antigravity token exchange failed: ${error}`
  return NETWORK_FAILURE.test(error)
    ? `${base} — check that the DSH host can reach oauth2.googleapis.com`
    : base
}

interface DecodedState {
  verifier: string
  projectId: string
}

function failure(error: unknown): AntigravityTokenExchangeResult {
  return { type: 'failed', error: error instanceof Error ? error.message : 'Unknown error' }
}

/**
 * Decode the PKCE state that core embeds in the authorization URL. Accepts
 * both base64url and standard base64, matching core's own decoder.
 */
function decodeState(state: string): DecodedState {
  const normalized = state.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error('Missing PKCE verifier in state')
  const record = parsed as Record<string, unknown>
  if (typeof record.verifier !== 'string' || record.verifier.length === 0) {
    throw new Error('Missing PKCE verifier in state')
  }
  return {
    verifier: record.verifier,
    projectId: typeof record.projectId === 'string' ? record.projectId : '',
  }
}

async function readProfile(accessToken: string): Promise<{ email?: string; label?: string }> {
  try {
    const response = await fetchWithActiveTimeout(USERINFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
      },
    }, { timeoutMs: USERINFO_TIMEOUT_MS })
    if (!response.ok) return {}
    const profile = (await response.json()) as { email?: unknown; name?: unknown }
    return {
      ...(typeof profile.email === 'string' && profile.email.length > 0 ? { email: profile.email } : {}),
      ...(typeof profile.name === 'string' && profile.name.trim().length > 0
        ? { label: profile.name.trim() }
        : {}),
    }
  } catch {
    return {}
  }
}

export async function exchangeAntigravityResilient(
  code: string,
  state: string,
): Promise<AntigravityTokenExchangeResult> {
  let decoded: DecodedState
  try {
    decoded = decodeState(state)
  } catch (error: unknown) {
    return failure(error)
  }

  const startTime = Date.now()
  let tokenResponse: Response
  try {
    tokenResponse = await fetchWithActiveTimeout(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        code_verifier: decoded.verifier,
      }),
    }, { timeoutMs: TOKEN_TIMEOUT_MS })
  } catch (error: unknown) {
    return failure(error)
  }
  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text().catch(() => '')
    return { type: 'failed', error: errorText || `token endpoint responded ${tokenResponse.status}` }
  }

  const payload = (await tokenResponse.json().catch(() => ({}))) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : ''
  if (refreshToken.length === 0) return { type: 'failed', error: 'Missing refresh token in response' }
  const access = typeof payload.access_token === 'string' ? payload.access_token : ''
  const expires = calculateTokenExpiry(
    startTime,
    typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
  )

  const profile = await readProfile(access)
  return {
    type: 'success',
    refresh: formatRefreshParts({ refreshToken, projectId: decoded.projectId }),
    access,
    expires,
    projectId: decoded.projectId,
    ...profile,
  }
}
