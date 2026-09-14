import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  buildAntigravityHarnessUserAgent,
  fetchWithAgyCliTransport,
} from '@cortexkit/antigravity-auth-core'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
  type ToolCallBlock,
} from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Plugin from '../src/index.js'
import {
  AntigravityAdapter,
  parseGeminiSse,
  type AntigravityAdapterDeps,
  type AttachmentImageStore,
} from '../src/adapter.js'
import type { StoredCredentials } from '../src/auth.js'
import { startOAuthCallbackServer } from '../src/oauth-callback.js'

const MODEL = 'antigravity-gemini-3.7-flash'
const stored: StoredCredentials = {
  version: 1,
  refresh: 'refresh|project',
  access: 'access',
  expires: Date.now() + 60_000,
}

function events(...chunks: unknown[]): Response {
  const body = `${chunks.map(chunk => `data: ${JSON.stringify({ response: chunk })}\r\n\r\n`).join('')}data: [DONE]\r\n\r\n`
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: MODEL,
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })],
    ...overrides,
  }
}

function adapter(
  transport: typeof fetchWithAgyCliTransport,
  credentials: NonNullable<AntigravityAdapterDeps['credentials']> = () => Promise.resolve(stored),
  attachments?: AntigravityAdapterDeps['attachments'],
  availableModels: NonNullable<AntigravityAdapterDeps['availableModels']> = () => Promise.resolve({ models: {} }),
): AntigravityAdapter {
  return new AntigravityAdapter({
    transport,
    credentials,
    project: auth => Promise.resolve({ auth, effectiveProjectId: 'project' }),
    save: () => Promise.resolve(),
    availableModels,
    ...(attachments ? { attachments } : {}),
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

function imageAttachment(id: string, mediaType: ImageRef['mediaType']): ImageRef {
  return {
    attachmentId: id as ImageRef['attachmentId'],
    mediaType,
    bytes: 4,
    width: 1,
    height: 1,
  }
}

describe('AntigravityAdapter', () => {
  it('maps thinking, tool calls, usage and wire attribution', async () => {
    const transport = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(events(
      { candidates: [{ content: { parts: [{ thought: true, text: 'plan', thoughtSignature: 'sig-r' }] } }] },
      {
        candidates: [{
          content: { parts: [
            { thought: true, thoughtSignature: 'sig-tool' },
            { functionCall: { id: 'call_1', name: 'lookup', args: { query: 'raw' } } },
          ] },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 10,
          cachedContentTokenCount: 3,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 2,
        },
      },
    )))

    const chunks = await collect(adapter(transport).stream(options({
      reasoningEffort: ReasoningEffortId('high'),
      tools: [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }],
    })))

    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'block-end',
      'block-start', 'tool-call-delta', 'block-end',
      'usage', 'finish',
    ])
    expect(chunks.find(chunk => chunk.type === 'tool-call-delta')).toMatchObject({
      id: 'call_1',
      name: 'lookup',
      argumentsDelta: '{"query":"raw"}',
    })
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 7, outputTokens: 6, cacheReadTokens: 3, reasoningTokens: 2 },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: {
        blocks: [
          { type: 'reasoning', thoughtSignature: 'sig-r' },
          { type: 'tool-call', thoughtSignature: 'sig-tool' },
        ],
      },
    })

    const [url, init, transportOptions] = transport.mock.calls[0]!
    expect(url).toContain('/v1internal:streamGenerateContent?alt=sse')
    expect(transportOptions?.idleTimeoutMs).toBe(5 * 60_000)
    const userAgent = new Headers(init?.headers).get('user-agent')
    expect(userAgent).toContain(buildAntigravityHarnessUserAgent())
    expect(userAgent).toContain(attributionHeaders()['user-agent'])
  })

  it('explains a location rejection instead of only echoing it', async () => {
    const transport = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(new Response(
      JSON.stringify({
        error: {
          code: 400,
          message: 'User location is not supported for the API use.',
          status: 'FAILED_PRECONDITION',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )))

    await expect(collect(adapter(transport).stream(options()))).rejects.toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('run the DSH host through a proxy node/region it accepts') as unknown as string,
    })
  })

  it('replays thought signatures and tool results losslessly', async () => {
    const callId = 'call_history' as ToolCallBlock['id']
    const transport = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(events({
      candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    })))
    const messages = [
      createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'why' },
          { type: 'tool-call', id: callId, name: 'lookup', arguments: '{"city":"Shanghai"}' },
        ],
        source: {
          provider: 'antigravity',
          model: MODEL,
          replayState: {
            kind: 'dsh-antigravity-oauth',
            version: 1,
            provider: 'antigravity',
            model: MODEL,
            blocks: [
              { type: 'reasoning', thoughtSignature: 'sig-r' },
              { type: 'tool-call', thoughtSignature: 'sig-t' },
            ],
          },
        },
      }),
      createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'sunny' }],
        isError: false,
      }),
    ]

    await collect(adapter(transport).stream(options({ messages })))
    const envelope = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
    expect(envelope.request.contents).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'why', thought: true, thoughtSignature: 'sig-r' },
          {
            functionCall: { name: 'lookup', args: { city: 'Shanghai' }, id: 'call_history' },
            thoughtSignature: 'sig-t',
          },
        ],
      },
      {
        role: 'model',
        parts: [{
          functionResponse: { name: 'lookup', response: { output: 'sunny' }, id: 'call_history' },
        }],
      },
    ])
  })

  it('falls back only after 404 and refreshes once after 401', async () => {
    const transport = vi.fn<typeof fetchWithAgyCliTransport>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(events({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      }))
    const credentials = vi.fn((force = false) => Promise.resolve({
      ...stored,
      access: force ? 'fresh' : 'stale',
    }))

    await collect(adapter(transport, credentials).stream(options()))

    expect(transport).toHaveBeenCalledTimes(3)
    expect(transport.mock.calls[0]?.[0]).toContain(ANTIGRAVITY_ENDPOINT_FALLBACKS[0])
    expect(transport.mock.calls[1]?.[0]).toContain(ANTIGRAVITY_ENDPOINT_FALLBACKS[1])
    expect(new Headers(transport.mock.calls[2]?.[1]?.headers).get('authorization')).toBe('Bearer fresh')
    expect(credentials.mock.calls.map(call => call[0])).toEqual([false, true])
  })

  it('propagates abort to the transport', async () => {
    const controller = new AbortController()
    let started!: () => void
    const transportStarted = new Promise<void>(resolve => { started = resolve })
    const transport = vi.fn<typeof fetchWithAgyCliTransport>((_url, _init, transportOptions) => {
      started()
      return new Promise((_resolve, reject) => {
        transportOptions?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })

    const pending = collect(adapter(transport).stream(options({ signal: controller.signal })))
    await transportStarted
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(transport.mock.calls[0]?.[2]?.signal).toBe(controller.signal)
  })

  it('rejects malformed and empty SSE streams', async () => {
    const malformed = new Response('data: {not-json}\n\n')
    await expect(collect(parseGeminiSse(malformed))).rejects.toMatchObject({ code: 'TRANSPORT' })

    const transport = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(new Response('data: [DONE]\n\n')))
    await expect(collect(adapter(transport).stream(options()))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('normalizes frames whose content omits parts or uses a non-Gemini role', async () => {
    const framed = new Response(
      'data: {"candidates":[{"content":{"role":"assistant"}}]}\n\n'
      + 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"},"finishReason":"STOP"}]}\n\n',
    )
    const chunks = await collect(parseGeminiSse(framed))
    expect(chunks[0]?.candidates?.[0]?.content).toEqual({ role: 'model', parts: [] })
    expect(chunks[1]?.candidates?.[0]?.content).toEqual({ role: 'model', parts: [{ text: 'hi' }] })
  })

  it('sends image attachments as inlineData and reads each attachment once', async () => {
    const attachment = imageAttachment('attachment-1', 'image/png')
    const readImage = vi.fn<AttachmentImageStore['readImage']>(
      ref => Promise.resolve({ ref, data: Uint8Array.from([1, 2, 3, 4]) }),
    )
    const transport = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(events({
      candidates: [{ content: { parts: [{ text: 'seen' }] }, finishReason: 'STOP' }],
    })))
    const messages = [createUserMessage({
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', attachment },
        { type: 'image', attachment },
      ],
      source: { kind: 'user' },
    })]

    await collect(adapter(transport, undefined, () => ({ readImage })).stream(options({ messages })))

    const envelope = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
    expect(envelope.request.contents).toEqual([{
      role: 'user',
      parts: [
        { text: 'what is this' },
        { inlineData: { mimeType: 'image/png', data: 'AQIDBA==' } },
        { inlineData: { mimeType: 'image/png', data: 'AQIDBA==' } },
      ],
    }])
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('rejects image content when the host exposes no attachment service', async () => {
    const attachment = imageAttachment('attachment-2', 'image/jpeg')
    const transport = vi.fn<typeof fetchWithAgyCliTransport>()
    const messages = [createUserMessage({
      content: [{ type: 'image', attachment }],
      source: { kind: 'user' },
    })]

    await expect(collect(adapter(transport).stream(options({ messages }))))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('retries an empty STOP response and gives up after the third attempt', async () => {
    const empty = { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    const retrying = vi.fn<typeof fetchWithAgyCliTransport>()
      .mockResolvedValueOnce(events(empty))
      .mockResolvedValueOnce(events({
        candidates: [{ content: { parts: [{ text: 'second try' }] }, finishReason: 'STOP' }],
      }))

    const chunks = await collect(adapter(retrying).stream(options()))
    expect(retrying).toHaveBeenCalledTimes(2)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'second try' })

    const alwaysEmpty = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(events(empty)))
    await expect(collect(adapter(alwaysEmpty).stream(options())))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    expect(alwaysEmpty).toHaveBeenCalledTimes(3)
  })

  it('moves numeric tool-schema constraints into descriptions for gpt-oss models', async () => {
    const transport = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(events({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    })))
    const tool = {
      name: 'lookup',
      description: 'Look up a value',
      parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'] },
    }

    await collect(adapter(transport).stream(options({ model: 'antigravity-gpt-oss-120b-medium', tools: [tool] })))
    const gpt = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
    expect(gpt.request.tools[0].functionDeclarations[0].parameters.properties.query)
      .toEqual({ type: 'STRING', description: 'minLength: 1' })

    await collect(adapter(transport).stream(options({ tools: [tool] })))
    const gemini = JSON.parse(String(transport.mock.calls[1]?.[1]?.body))
    expect(gemini.request.tools[0].functionDeclarations[0].parameters.properties.query)
      .toEqual({ type: 'STRING', minLength: 1 })
  })

  it('resolves full model metadata for the model picker', async () => {
    const instance = adapter(vi.fn<typeof fetchWithAgyCliTransport>())

    await expect(instance.resolveModel('antigravity', MODEL)).resolves.toMatchObject({
      provider: 'antigravity',
      id: MODEL,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 65_536,
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'high', name: 'High' },
        ],
      },
    })
    await expect(instance.resolveModel('antigravity', 'antigravity-gemini-3.1-pro')).resolves.toMatchObject({
      reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] },
    })
    await expect(instance.resolveModel('antigravity', 'antigravity-unknown')).resolves.toEqual({
      provider: 'antigravity',
      id: 'antigravity-unknown',
      name: 'antigravity-unknown',
    })
  })

  it('unregisters its provider when the plugin fiber is disposed', async () => {
    vi.stubEnv('DSH_ANTIGRAVITY_AUTH_FILE', '/nonexistent/antigravity-oauth.json')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(Plugin)
    expect(ctx.llm.listProviders()).toEqual([{ id: 'antigravity', name: 'Google Antigravity' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'antigravity',
      displayName: 'Google Antigravity',
      settingsNs: 'llm-antigravity-oauth',
      settingsPath: ['providers', 'antigravity'],
    }])
    await expect(ctx.llm.listModels('antigravity')).resolves.toMatchObject([
      { id: 'antigravity-gemini-3.7-flash', inputModalities: ['text', 'image'] },
      { id: 'antigravity-gemini-3.6-flash', inputModalities: ['text', 'image'] },
      { id: 'antigravity-gemini-3.5-flash', inputModalities: ['text', 'image'] },
      { id: 'antigravity-gemini-3.1-pro', inputModalities: ['text', 'image'] },
    ])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })
})

describe('AntigravityAdapter upstream model discovery', () => {
  it('merges the upstream catalog the bundled table does not know yet', async () => {
    const availableModels = vi.fn<NonNullable<AntigravityAdapterDeps['availableModels']>>(async () => ({
      models: {
        // Static families arrive as tier variants and must collapse onto the known id.
        'gemini-3.7-flash-medium': {},
        'gemini-3.7-flash-high': {},
        // Newer families the bundled table cannot know about.
        'gemini-3.8-flash-low': {},
        'gemini-3.8-flash-medium': {},
        'gemini-3.8-flash-tiered': {},
        'gemini-3.9-pro-low': {},
        'gemini-3.9-pro-high': {},
        // Aliased key whose upstream label names a different model.
        'gemini-2.5-flash': { displayName: 'Gemini 3.5 Flash Lite' },
        // Families the request path cannot address exactly, or out of scope.
        'gemini-3.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite' },
        'gemini-3-flash': {},
        'gemini-3.1-flash-image': { displayName: 'Nano Banana' },
        'gpt-oss-120b-medium': {},
        'claude-sonnet-4-6-thinking': {},
        'chat_20706': {},
        'tab_jump_flash_lite_preview': {},
      },
    }))
    const instance = adapter(vi.fn<typeof fetchWithAgyCliTransport>(), undefined, undefined, availableModels)

    const models = await instance.listModels('antigravity')

    expect(models.map(model => model.id)).toEqual([
      'antigravity-gemini-3.7-flash',
      'antigravity-gemini-3.6-flash',
      'antigravity-gemini-3.5-flash',
      'antigravity-gemini-3.1-pro',
      'antigravity-gemini-3.9-pro',
      'antigravity-gemini-3.8-flash',
      'antigravity-gemini-2.5-flash',
    ])
    expect(models.at(-2)).toMatchObject({
      provider: 'antigravity',
      name: 'Gemini 3.8 Flash (Antigravity)',
      inputModalities: ['text', 'image'],
    })
    // Names come from the id, not from an upstream label that names another model.
    expect(models.at(-1)).toMatchObject({ id: 'antigravity-gemini-2.5-flash', name: 'Gemini 2.5 Flash (Antigravity)' })
    await expect(instance.resolveModel('antigravity', 'antigravity-gemini-3.9-pro')).resolves.toMatchObject({
      name: 'Gemini 3.9 Pro (Antigravity)',
      context: { contextWindow: 1_048_576 },
      reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] },
    })
  })

  it('routes a discovered model with its resolved upstream id', async () => {
    const transport = vi.fn<typeof fetchWithAgyCliTransport>(() => Promise.resolve(events({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    })))
    const instance = adapter(transport, undefined, undefined, async () => ({
      models: { 'gemini-3.8-flash-medium': {}, 'gemini-3.8-flash-high': {} },
    }))

    await collect(instance.stream(options({
      model: 'antigravity-gemini-3.8-flash',
      reasoningEffort: ReasoningEffortId('high'),
    })))

    const envelope = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
    expect(envelope.model).toBe('gemini-3.8-flash-high')
  })

  it('keeps the bundled catalog when discovery fails', async () => {
    const availableModels = vi.fn<NonNullable<AntigravityAdapterDeps['availableModels']>>(
      async () => { throw new Error('fetch failed') },
    )
    const instance = adapter(vi.fn<typeof fetchWithAgyCliTransport>(), undefined, undefined, availableModels)

    await expect(instance.listModels('antigravity')).resolves.toHaveLength(4)
    await instance.listModels('antigravity')
    expect(availableModels).toHaveBeenCalledTimes(1)
  })

  it('skips discovery when no credentials are stored', async () => {
    const credentials = vi.fn(() => Promise.reject(new LlmError('not logged in', 'MISSING_CREDENTIAL')))
    const availableModels = vi.fn<NonNullable<AntigravityAdapterDeps['availableModels']>>(async () => ({
      models: { 'gemini-3.8-flash-medium': {} },
    }))
    const instance = adapter(vi.fn<typeof fetchWithAgyCliTransport>(), credentials, undefined, availableModels)

    await expect(instance.listModels('antigravity')).resolves.toHaveLength(4)
    expect(availableModels).not.toHaveBeenCalled()
  })

  it('caches the discovered catalog across calls', async () => {
    const availableModels = vi.fn<NonNullable<AntigravityAdapterDeps['availableModels']>>(async () => ({
      models: { 'gemini-3.8-flash-medium': {} },
    }))
    const instance = adapter(vi.fn<typeof fetchWithAgyCliTransport>(), undefined, undefined, availableModels)

    const first = await instance.listModels('antigravity')
    const second = await instance.listModels('antigravity')

    expect(second).toEqual(first)
    expect(availableModels).toHaveBeenCalledTimes(1)
  })
})

describe('OAuth callback server', () => {
  it('rejects a mismatched state and captures a valid callback', async () => {
    const listener = await startOAuthCallbackServer('expected-state', { port: 0, timeoutMs: 1_000 })
    const baseUrl = `http://127.0.0.1:${listener.port}/oauth-callback`
    try {
      const mismatch = await fetch(`${baseUrl}?state=wrong-state&code=wrong-code`)
      expect(mismatch.status).toBe(400)

      const callback = fetch(`${baseUrl}?state=expected-state&code=authorization-code`)
      await expect(listener.result).resolves.toEqual({
        code: 'authorization-code',
        state: 'expected-state',
      })
      expect((await callback).status).toBe(200)
    } finally {
      await listener.close()
    }
  })
})
