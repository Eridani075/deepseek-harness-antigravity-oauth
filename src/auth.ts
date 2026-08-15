import {
  formatRefreshParts,
  parseRefreshParts,
  refreshAntigravityToken,
  writeJsonAtomic,
} from '@cortexkit/antigravity-auth-core'
import { INVALID_CREDENTIAL_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { chmod, mkdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const CREDENTIAL_VERSION = 1
const EXPIRY_BUFFER_MS = 60_000

export interface StoredCredentials {
  version: 1
  refresh: string
  access: string
  expires: number
  email?: string
  label?: string
}

const refreshes = new Map<string, Promise<StoredCredentials>>()

export function credentialFilePath(): string {
  const explicit = process.env.DSH_ANTIGRAVITY_AUTH_FILE?.trim()
  if (explicit) return resolve(explicit)
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(dshHome, 'antigravity-oauth.json')
}

function parseCredentials(value: unknown, path: string): StoredCredentials {
  if (value === null || typeof value !== 'object') {
    throw new LlmError(`Antigravity credential file is not an object: ${path}`, INVALID_CREDENTIAL_CODE)
  }
  const record = value as Record<string, unknown>
  if (record.version !== CREDENTIAL_VERSION
    || typeof record.refresh !== 'string' || record.refresh.length === 0
    || typeof record.access !== 'string' || record.access.length === 0
    || typeof record.expires !== 'number' || !Number.isFinite(record.expires)) {
    throw new LlmError(`Antigravity credential file is invalid: ${path}`, INVALID_CREDENTIAL_CODE)
  }
  return {
    version: CREDENTIAL_VERSION,
    refresh: record.refresh,
    access: record.access,
    expires: record.expires,
    ...(typeof record.email === 'string' ? { email: record.email } : {}),
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
  }
}

export async function loadCredentials(path = credentialFilePath()): Promise<StoredCredentials> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LlmError(
        `Antigravity is not logged in. Run "dsh plugin --profile web exec dsh-antigravity-login".`,
        'MISSING_CREDENTIAL',
      )
    }
    throw new LlmError(`Cannot read Antigravity credentials: ${path}`, INVALID_CREDENTIAL_CODE, { cause: error })
  }
  try {
    return parseCredentials(JSON.parse(raw), path)
  } catch (error: unknown) {
    if (error instanceof LlmError) throw error
    throw new LlmError(`Antigravity credential file contains invalid JSON: ${path}`, INVALID_CREDENTIAL_CODE, {
      cause: error,
    })
  }
}

export async function saveCredentials(
  credentials: StoredCredentials,
  path = credentialFilePath(),
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  await writeJsonAtomic(path, credentials)
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

export async function removeCredentials(path = credentialFilePath()): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function refreshCredentials(path: string): Promise<StoredCredentials> {
  const current = await loadCredentials(path)
  const parts = parseRefreshParts(current.refresh)
  if (!parts.refreshToken) {
    throw new LlmError(`Antigravity refresh token is missing: ${path}`, INVALID_CREDENTIAL_CODE)
  }

  let refreshed
  try {
    refreshed = await refreshAntigravityToken(parts.refreshToken)
  } catch (error: unknown) {
    throw new LlmError('Antigravity OAuth token refresh failed; run dsh-antigravity-login again.', 'AUTH', {
      cause: error,
    })
  }

  const next: StoredCredentials = {
    ...current,
    access: refreshed.access,
    expires: refreshed.expires,
    refresh: formatRefreshParts({ ...parts, refreshToken: refreshed.refresh }),
  }
  await saveCredentials(next, path)
  return next
}

export async function credentialsForRequest(
  forceRefresh = false,
  path = credentialFilePath(),
): Promise<StoredCredentials> {
  const current = await loadCredentials(path)
  if (!forceRefresh && current.expires > Date.now() + EXPIRY_BUFFER_MS) return current

  const running = refreshes.get(path)
  if (running) return running
  const refresh = refreshCredentials(path).finally(() => refreshes.delete(path))
  refreshes.set(path, refresh)
  return refresh
}
