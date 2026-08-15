import { createServer, type ServerResponse } from 'node:http'

const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/oauth-callback'
const CALLBACK_PORT = 51121
const CALLBACK_TIMEOUT_MS = 5 * 60_000

const SUCCESS_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Antigravity login complete</title>
<body><h1>Login complete</h1><p>You can close this tab and return to DeepSeek Harness.</p></body></html>`
const FAILURE_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Antigravity login failed</title>
<body><h1>Login failed</h1><p>Return to the terminal and try again.</p></body></html>`

export interface OAuthCallback {
  code: string
  state: string
}

export interface OAuthCallbackServer {
  port: number
  result: Promise<OAuthCallback | undefined>
  close(): Promise<void>
}

interface OAuthCallbackServerOptions {
  port?: number
  timeoutMs?: number
}

function respond(response: ServerResponse, status: number, page: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-type': 'text/html; charset=utf-8',
  })
  response.end(page)
}

export async function startOAuthCallbackServer(
  expectedState: string,
  options: OAuthCallbackServerOptions = {},
): Promise<OAuthCallbackServer> {
  if (!expectedState) throw new Error('OAuth state is empty')

  let resolveResult!: (value: OAuthCallback | undefined) => void
  let rejectResult!: (error: Error) => void
  const result = new Promise<OAuthCallback | undefined>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let closePromise: Promise<void> | undefined
  let finish!: (value?: OAuthCallback, error?: Error) => void

  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? '/', `http://${CALLBACK_HOST}`)
    if (request.method !== 'GET' || callback.pathname !== CALLBACK_PATH) {
      respond(response, 404, FAILURE_PAGE)
      return
    }
    if (callback.searchParams.get('state') !== expectedState) {
      respond(response, 400, FAILURE_PAGE)
      return
    }
    if (callback.searchParams.has('error')) {
      respond(response, 400, FAILURE_PAGE)
      finish(undefined, new Error('Google authorization failed or was cancelled'))
      return
    }
    const code = callback.searchParams.get('code')
    if (!code) {
      respond(response, 400, FAILURE_PAGE)
      return
    }
    respond(response, 200, SUCCESS_PAGE)
    finish({ code, state: expectedState })
  })

  const close = (): Promise<void> => closePromise ??= new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(error => error === undefined ? resolve() : reject(error))
  })

  finish = (value, error) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    void close().catch(() => {})
    if (error === undefined) resolveResult(value)
    else rejectResult(error)
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options.port ?? CALLBACK_PORT, CALLBACK_HOST, () => {
      server.off('error', onError)
      resolve()
    })
  })
  server.on('error', error => finish(undefined, error))

  timer = setTimeout(() => finish(), options.timeoutMs ?? CALLBACK_TIMEOUT_MS)
  timer.unref()
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('OAuth callback server has no TCP address')

  return {
    port: address.port,
    result,
    async close() {
      finish()
      await close()
    },
  }
}
