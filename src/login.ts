#!/usr/bin/env node

import {
  authorizeAntigravity,
  exchangeAntigravity,
} from '@cortexkit/antigravity-auth-core'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { credentialFilePath, saveCredentials } from './auth.js'
import { startOAuthCallbackServer } from './oauth-callback.js'

function callbackInput(value: string, fallbackState: string): { code: string; state: string } {
  const input = value.trim()
  if (!input) throw new Error('Authorization code is empty')
  if (!URL.canParse(input)) return { code: input, state: fallbackState }

  const callback = new URL(input)
  const error = callback.searchParams.get('error')
  if (error) throw new Error(`Google authorization failed: ${error}`)
  const code = callback.searchParams.get('code')
  if (!code) throw new Error('Callback URL does not contain an authorization code')
  const state = callback.searchParams.get('state')
  if (state !== null && state !== fallbackState) throw new Error('OAuth state mismatch')
  return { code, state: fallbackState }
}

async function main(): Promise<void> {
  const authorization = await authorizeAntigravity()
  const state = new URL(authorization.url).searchParams.get('state')
  if (!state) throw new Error('Antigravity authorization URL is missing OAuth state')

  let listener
  try {
    listener = await startOAuthCallbackServer(state)
  } catch (error: unknown) {
    console.error(`Automatic OAuth callback unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  stdout.write(`Open this URL in your browser:\n\n${authorization.url}\n\n`)
  const readline = createInterface({ input: stdin, output: stdout })
  try {
    const manual = readline.question(
      listener === undefined
        ? 'Paste the callback URL or authorization code: '
        : 'Waiting for browser authorization (paste the callback URL/code only if needed): ',
    ).then(value => callbackInput(value, state))
    let callback = listener === undefined
      ? await manual
      : await Promise.race([listener.result, manual])
    if (callback === undefined) {
      stdout.write('\nAutomatic callback timed out; paste the callback URL or authorization code.\n')
      callback = await manual
    }
    const result = await exchangeAntigravity(callback.code, callback.state)
    if (result.type === 'failed') throw new Error(`Antigravity token exchange failed: ${result.error}`)
    await saveCredentials({
      version: 1,
      refresh: result.refresh,
      access: result.access,
      expires: result.expires,
      ...(result.email === undefined ? {} : { email: result.email }),
      ...(result.label === undefined ? {} : { label: result.label }),
    })
    stdout.write(`\nCredentials saved to ${credentialFilePath()}\n`)
  } finally {
    readline.close()
    await listener?.close()
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1
  console.error(error instanceof Error ? error.message : String(error))
})
