import {
  AgyRequestSessionStore,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  buildAgyAgentRequestMetadata,
  buildAntigravityHarnessUserAgent,
  ensureProjectContext,
  fetchWithAgyCliTransport,
  getPublicModelDefinitions,
  orderAgyRequestPayloadInPlace,
  parseRateLimitReason,
  resolveModelForHeaderStyle,
  toGeminiSchema,
  type AgyRequestLabels,
} from '@cortexkit/antigravity-auth-core'
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  attributionHeaders,
  isContextWindowExceededError,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
  type ToolCallBlock,
} from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import {
  credentialsForRequest,
  saveCredentials,
  type StoredCredentials,
} from './auth.js'

export const PROVIDER = 'antigravity'

const STREAM_ACTION = 'streamGenerateContent'
const IDLE_TIMEOUT_MS = 5 * 60_000

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { name: string; args: Record<string, unknown>; id: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id: string } }

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<{
    functionDeclarations: Array<{ name: string; description: string; parameters: unknown }>
  }>
  toolConfig?: { functionCallingConfig: { mode: 'VALIDATED' } }
  generationConfig?: Record<string, unknown>
  labels?: AgyRequestLabels
  sessionId?: string
}

interface GeminiResponsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string }
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

export interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: GeminiResponsePart[] }
    finishReason?: string
  }>
  usageMetadata?: GeminiUsageMetadata
  error?: unknown
  promptFeedback?: unknown
}

interface ReplayBlock {
  type: 'text' | 'reasoning' | 'tool-call'
  thoughtSignature?: string
}

interface ReplayState {
  kind: 'dsh-antigravity-oauth'
  version: 1
  provider: string
  model: string
  blocks: ReplayBlock[]
}

interface RequestResult {
  response: Response
  errorBody?: string
}

export interface AntigravityAdapterDeps {
  transport?: typeof fetchWithAgyCliTransport
  credentials?: typeof credentialsForRequest
  project?: typeof ensureProjectContext
  save?: typeof saveCredentials
}

const modelDefinitions = getPublicModelDefinitions()
const geminiModels = Object.values(modelDefinitions)
  .filter(model => model.id.startsWith('antigravity-gemini-') && !model.modalities.output.includes('image'))

function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
}

function reasoningEfforts(model: string) {
  const ids = model.includes('-pro') ? ['low', 'high'] : ['low', 'medium', 'high']
  return {
    efforts: ids.map(id => ({ id: ReasoningEffortId(id), name: id[0]!.toUpperCase() + id.slice(1) })),
  }
}

function modelInfo(provider: string, model: (typeof geminiModels)[number]): LlmResolvedModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: ['text'],
    context: { contextWindow: model.limit.context },
    defaultMaxTokens: model.limit.output,
    reasoning: reasoningEfforts(model.id),
  }
}

function parseArguments(raw: string, callId: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch { /* handled below */ }
  throw new LlmError(`Tool call ${callId} has invalid JSON object arguments`, 'INVALID_HISTORY')
}

function replayOf(message: Message, options: GenerateOptions): ReplayState | undefined {
  if (message.role !== 'assistant' || message.source.kind !== 'model') return undefined
  if (message.source.provider !== options.provider || message.source.model !== options.model) return undefined
  const state = message.source.replayState
  if (state === undefined) return undefined
  if (state === null || typeof state !== 'object') {
    throw new LlmError('Antigravity replay state is not an object', 'INVALID_HISTORY')
  }
  const value = state as Partial<ReplayState>
  if (value.kind !== 'dsh-antigravity-oauth' || value.version !== 1
    || value.provider !== message.source.provider || value.model !== message.source.model
    || !Array.isArray(value.blocks) || value.blocks.length !== message.content.length) {
    throw new LlmError('Antigravity replay state does not match its assistant message', 'INVALID_HISTORY')
  }
  for (const [index, block] of value.blocks.entries()) {
    if (block === null || typeof block !== 'object'
      || !['text', 'reasoning', 'tool-call'].includes(block.type)
      || block.type !== message.content[index]?.type
      || (block.thoughtSignature !== undefined && typeof block.thoughtSignature !== 'string')) {
      throw new LlmError('Antigravity replay state contains an invalid block', 'INVALID_HISTORY')
    }
  }
  return value as ReplayState
}

function assistantParts(message: Message, options: GenerateOptions): GeminiPart[] {
  const replay = replayOf(message, options)
  const parts: GeminiPart[] = []
  for (const [index, block] of message.content.entries()) {
    const signature = replay?.blocks[index]?.thoughtSignature
    switch (block.type) {
      case 'text':
        if (block.text) parts.push({ text: sanitize(block.text), ...(signature ? { thoughtSignature: signature } : {}) })
        break
      case 'reasoning':
        if (block.text && signature) {
          parts.push({ text: sanitize(block.text), thought: true, thoughtSignature: signature })
        }
        break
      case 'tool-call':
        parts.push({
          functionCall: { name: block.name, args: parseArguments(block.arguments, block.id), id: block.id },
          ...(signature ? { thoughtSignature: signature } : {}),
        })
        break
      default:
        throw new LlmError(`Unsupported assistant content block: ${block.type}`, 'UNSUPPORTED_CONTENT')
    }
  }
  return parts
}

function textFromBlocks(blocks: readonly ContentBlock[]): string {
  const text: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') text.push(block.text)
    else throw new LlmError(`Unsupported tool-result content block: ${block.type}`, 'UNSUPPORTED_CONTENT')
  }
  return text.join('\n')
}

function buildGeminiRequest(options: GenerateOptions): GeminiRequest {
  const contents: GeminiContent[] = []
  const system: string[] = options.system?.trim() ? [options.system.trim()] : []
  const calls = new Map<string, { name: string; target: boolean }>()

  for (const message of options.messages) {
    if (message.role !== 'assistant') continue
    const target = message.source.kind === 'model'
      && message.source.provider === options.provider
      && message.source.model === options.model
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.set(block.id, { name: block.name, target })
    }
  }

  for (const message of options.messages) {
    if (message.role === 'system') {
      system.push(textFromBlocks(message.content))
      continue
    }

    if (message.role === 'assistant') {
      const parts = assistantParts(message, options)
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    const toolResults = message.content.filter(block => block.type === 'tool-result')
    if (toolResults.length > 0) {
      if (toolResults.length !== message.content.length) {
        throw new LlmError('A tool-result message cannot mix tool results with other blocks', 'INVALID_HISTORY')
      }
      for (const block of toolResults) {
        const call = calls.get(block.toolCallId)
        if (!call) throw new LlmError(`Tool result has no matching call: ${block.toolCallId}`, 'INVALID_HISTORY')
        const text = textFromBlocks(block.content)
        const part: GeminiPart = {
          functionResponse: {
            name: call.name,
            id: block.toolCallId,
            response: block.isError ? { error: text || 'Error' } : { output: text },
          },
        }
        const role = call.target ? 'model' : 'user'
        const last = contents.at(-1)
        if (last?.role === role && last.parts.every(item => 'functionResponse' in item)) last.parts.push(part)
        else contents.push({ role, parts: [part] })
      }
      continue
    }

    const parts: GeminiPart[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text) parts.push({ text: sanitize(block.text) })
      } else {
        throw new LlmError(`Unsupported user content block: ${block.type}`, 'UNSUPPORTED_CONTENT')
      }
    }
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }

  const request: GeminiRequest = { contents }
  if (system.length > 0) request.systemInstruction = { parts: [{ text: sanitize(system.join('\n\n')) }] }
  if (options.tools?.length) {
    request.tools = [{
      functionDeclarations: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: toGeminiSchema(tool.parameters),
      })),
    }]
    request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } }
  }

  const generationConfig: Record<string, unknown> = {}
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens
  if (options.stop !== undefined) generationConfig.stopSequences = options.stop

  const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
  if (effort !== undefined && !['low', 'medium', 'high'].includes(effort)) {
    throw new LlmError(`Unsupported Antigravity reasoning effort: ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  if (effort === 'medium' && options.model.includes('-pro')) {
    throw new LlmError(`${options.model} supports only low and high reasoning`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  const resolved = resolveModelForHeaderStyle(
    effort === undefined ? options.model : `${options.model}-${effort}`,
    'antigravity',
  )
  if (resolved.thinkingLevel) {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: resolved.thinkingLevel }
  } else if (resolved.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: resolved.thinkingBudget }
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  return request
}

function unwrapChunk(raw: unknown): GeminiStreamChunk {
  if (raw !== null && typeof raw === 'object' && 'response' in raw) {
    const response = (raw as { response?: unknown }).response
    if (response !== null && typeof response === 'object') return response as GeminiStreamChunk
  }
  return raw as GeminiStreamChunk
}

export async function* parseGeminiSse(response: Response): AsyncGenerator<GeminiStreamChunk> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const parseFrame = (frame: string): GeminiStreamChunk | undefined => {
    const data = frame.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return undefined
    try {
      return unwrapChunk(JSON.parse(data))
    } catch (error: unknown) {
      throw new LlmError('Antigravity returned malformed SSE JSON', 'TRANSPORT', { cause: error })
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = parseFrame(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (chunk) yield chunk
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    const tail = parseFrame(buffer.replace(/\r\n?/g, '\n'))
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function embeddedFailure(chunk: GeminiStreamChunk): string | undefined {
  if (chunk.error !== undefined) {
    const error = asRecord(chunk.error)
    const message = error?.message
    return typeof message === 'string' ? message : 'Antigravity returned an in-stream error'
  }
  const feedback = asRecord(chunk.promptFeedback)
  if (!feedback) return undefined
  const reason = typeof feedback.blockReason === 'string' ? feedback.blockReason : undefined
  const message = typeof feedback.blockReasonMessage === 'string' ? feedback.blockReasonMessage : undefined
  return reason || message ? `Antigravity prompt blocked${reason ? ` (${reason})` : ''}${message ? `: ${message}` : ''}` : undefined
}

function usageOf(usage: GeminiUsageMetadata): TokenUsage {
  const cached = usage.cachedContentTokenCount ?? 0
  return {
    inputTokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(usage.thoughtsTokenCount === undefined ? {} : { reasoningTokens: usage.thoughtsTokenCount }),
  }
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(value)
  const delay = date - Date.now()
  return Number.isFinite(date) && delay > 0 ? delay : undefined
}

function errorFacts(body: string | undefined): { message?: string; reason?: string } {
  if (!body) return {}
  try {
    const parsed: unknown = JSON.parse(body)
    const root = asRecord(parsed)
    const error = asRecord(root?.error) ?? root
    const details = Array.isArray(error?.details) ? error.details : []
    const reason = details.map(detail => asRecord(detail)?.reason)
      .find((value): value is string => typeof value === 'string')
    return {
      ...(typeof error?.message === 'string' ? { message: error.message } : {}),
      ...(reason ? { reason } : {}),
    }
  } catch {
    return {}
  }
}

function responseError(result: RequestResult, requestId: string): LlmError {
  const { response, errorBody } = result
  const facts = errorFacts(errorBody)
  const detail = (facts.message ?? response.statusText) || `HTTP ${response.status}`
  const limit = parseRateLimitReason(facts.reason, detail, response.status)
  const retryAfter = retryAfterMs(response)
  let code = 'PROVIDER'
  if (response.status === 401 || response.status === 403) code = 'AUTH'
  else if (response.status === 404) code = 'UNKNOWN_MODEL'
  else if (response.status === 408 || response.status === 504) code = 'TIMEOUT'
  else if (response.status === 429) code = limit === 'QUOTA_EXHAUSTED' ? QUOTA_EXCEEDED_CODE : 'RATE_LIMIT'
  else if (response.status >= 500) code = 'SERVER'
  else if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  return new LlmError(`Antigravity request failed: ${detail}`, code, {
    status: response.status,
    requestId: ProviderRequestId(requestId),
    ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
  })
}

export class AntigravityAdapter extends LlmAdapter {
  private readonly transport: typeof fetchWithAgyCliTransport
  private readonly credentials: typeof credentialsForRequest
  private readonly project: typeof ensureProjectContext
  private readonly save: typeof saveCredentials
  private readonly requestSessions = new AgyRequestSessionStore('')

  constructor(deps: AntigravityAdapterDeps = {}) {
    super()
    this.transport = deps.transport ?? fetchWithAgyCliTransport
    this.credentials = deps.credentials ?? credentialsForRequest
    this.project = deps.project ?? ensureProjectContext
    this.save = deps.save ?? saveCredentials
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Google Antigravity' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(geminiModels.map(model => modelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const definition = modelDefinitions[model]
    return Promise.resolve(definition ? modelInfo(provider, definition) : { provider, id: model, name: model })
  }

  private prepare(options: GenerateOptions, project: string) {
    const effort = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
    const resolved = resolveModelForHeaderStyle(
      effort === undefined ? options.model : `${options.model}-${effort}`,
      'antigravity',
    )
    const request = buildGeminiRequest(options)
    const scope = this.requestSessions.beginRequest(String(options.sessionId ?? '__default__'))
    const metadata = buildAgyAgentRequestMetadata(
      scope.session,
      request as unknown as Record<string, unknown>,
      resolved.actualModel,
      scope.timestamp,
      { stepCountMode: 'cli' },
    )
    request.labels = metadata.labels
    request.sessionId = metadata.sessionId
    orderAgyRequestPayloadInPlace(request as unknown as Record<string, unknown>)
    return {
      requestId: metadata.requestId,
      body: JSON.stringify({
        project,
        requestId: metadata.requestId,
        request,
        model: resolved.actualModel,
        userAgent: 'antigravity',
        requestType: 'agent',
      }),
    }
  }

  private async send(body: string, access: string, signal: AbortSignal | undefined): Promise<RequestResult> {
    const attribution = attributionHeaders()['user-agent']
    for (const [index, endpoint] of ANTIGRAVITY_ENDPOINT_FALLBACKS.entries()) {
      const response = await this.transport(
        `${endpoint}/v1internal:${STREAM_ACTION}?alt=sse`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${access}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'Accept-Encoding': 'gzip',
            'User-Agent': `${buildAntigravityHarnessUserAgent()} ${attribution}`,
          },
          body,
        },
        { signal: signal ?? null, idleTimeoutMs: IDLE_TIMEOUT_MS },
      )
      if (response.ok) return { response }
      const errorBody = await response.text().catch(() => '')
      const canFallback = response.status === 404 && index < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1
      if (!canFallback) return { response, errorBody }
    }
    throw new LlmError('Antigravity endpoint list is empty', 'TRANSPORT')
  }

  private async response(options: GenerateOptions): Promise<{ result: RequestResult; requestId: string }> {
    let credentials = await this.credentials(false)
    const context = await this.project({
      type: 'oauth',
      refresh: credentials.refresh,
      access: credentials.access,
      expires: credentials.expires,
    })
    if (context.auth.refresh !== credentials.refresh) {
      credentials = { ...credentials, refresh: context.auth.refresh }
      await this.save(credentials)
    }
    const prepared = this.prepare(options, context.effectiveProjectId)
    let result = await this.send(prepared.body, credentials.access, options.signal)
    if (result.response.status === 401) {
      credentials = await this.credentials(true)
      result = await this.send(prepared.body, credentials.access, options.signal)
    }
    return { result, requestId: prepared.requestId }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) throw new LlmError('Antigravity request aborted', 'ABORTED')
    let response: Response | undefined
    try {
      const request = await this.response(options)
      if (!request.result.response.ok) throw responseError(request.result, request.requestId)
      response = request.result.response

      let nextIndex = 0
      let text: { index: number; value: string } | undefined
      let reasoning: { index: number; value: string } | undefined
      let pendingThoughtSignature: string | undefined
      let terminal: string | undefined
      let usage: TokenUsage | undefined
      let hasContent = false
      let hasToolCall = false
      const replayBlocks: ReplayBlock[] = []

      const closeText = (): StreamChunk[] => {
        if (!text) return []
        const current = text
        text = undefined
        return [{ type: 'block-end', index: current.index, block: { type: 'text', text: current.value } }]
      }
      const closeReasoning = (): StreamChunk[] => {
        if (!reasoning) return []
        const current = reasoning
        reasoning = undefined
        return [{ type: 'block-end', index: current.index, block: { type: 'reasoning', text: current.value } }]
      }

      for await (const chunk of parseGeminiSse(response)) {
        const failure = embeddedFailure(chunk)
        if (failure) throw new LlmError(failure, 'PROVIDER')
        if (chunk.usageMetadata) usage = usageOf(chunk.usageMetadata)
        const candidate = chunk.candidates?.[0]

        for (const part of candidate?.content?.parts ?? []) {
          if (part.thought && !part.functionCall && !part.text && part.thoughtSignature) {
            const openIndex = text?.index
            if (openIndex !== undefined) replayBlocks[openIndex] = { type: 'text', thoughtSignature: part.thoughtSignature }
            else pendingThoughtSignature = part.thoughtSignature
            continue
          }

          if (part.functionCall) {
            for (const event of closeText()) yield event
            for (const event of closeReasoning()) yield event
            const id = CallId(part.functionCall.id ?? `call_${randomUUID()}`)
            const name = part.functionCall.name ?? ''
            const argumentsText = JSON.stringify(part.functionCall.args ?? {})
            const index = nextIndex++
            const signature = part.thoughtSignature ?? pendingThoughtSignature
            pendingThoughtSignature = undefined
            replayBlocks[index] = { type: 'tool-call', ...(signature ? { thoughtSignature: signature } : {}) }
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsText }
            const block: ToolCallBlock = { type: 'tool-call', id, name, arguments: argumentsText }
            yield { type: 'block-end', index, block }
            hasContent = true
            hasToolCall = true
            continue
          }

          if (part.thought) {
            if (!part.text) continue
            for (const event of closeText()) yield event
            if (!reasoning) {
              const index = nextIndex++
              reasoning = { index, value: '' }
              replayBlocks[index] = {
                type: 'reasoning',
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              }
              yield { type: 'block-start', index, blockType: 'reasoning' }
            }
            reasoning.value += part.text
            if (part.thoughtSignature) {
              replayBlocks[reasoning.index] = { type: 'reasoning', thoughtSignature: part.thoughtSignature }
            }
            yield { type: 'reasoning-delta', index: reasoning.index, text: part.text }
            hasContent = true
            continue
          }

          if (part.text) {
            for (const event of closeReasoning()) yield event
            if (!text) {
              const index = nextIndex++
              const signature = part.thoughtSignature ?? pendingThoughtSignature
              pendingThoughtSignature = undefined
              text = { index, value: '' }
              replayBlocks[index] = { type: 'text', ...(signature ? { thoughtSignature: signature } : {}) }
              yield { type: 'block-start', index, blockType: 'text' }
            }
            text.value += part.text
            if (part.thoughtSignature) replayBlocks[text.index] = { type: 'text', thoughtSignature: part.thoughtSignature }
            yield { type: 'text-delta', index: text.index, text: part.text }
            hasContent = true
          }
        }

        if (candidate?.finishReason) {
          terminal = candidate.finishReason
          break
        }
      }

      for (const event of closeText()) yield event
      for (const event of closeReasoning()) yield event
      if (options.signal?.aborted) throw new LlmError('Antigravity request aborted', 'ABORTED')
      if (!terminal) throw new LlmError('Antigravity stream ended without a terminal response', 'TRANSPORT')
      if (!hasContent) throw new LlmError('Antigravity returned an empty response', EMPTY_RESPONSE_CODE)
      if (usage) yield { type: 'usage', usage }

      const reason = hasToolCall
        ? { kind: 'tool-calls' as const }
        : terminal === 'MAX_TOKENS'
          ? { kind: 'max-tokens' as const }
          : { kind: 'stop' as const }
      if (reason.kind !== 'tool-calls') this.requestSessions.completeExecution(String(options.sessionId ?? '__default__'))
      const replayState: ReplayState = {
        kind: 'dsh-antigravity-oauth',
        version: 1,
        provider: options.provider,
        model: options.model,
        blocks: replayBlocks,
      }
      yield { type: 'finish', reason, replayState }
    } catch (error: unknown) {
      if (options.signal?.aborted && !(error instanceof LlmError && error.code === 'ABORTED')) {
        throw new LlmError('Antigravity request aborted', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('Antigravity transport failed', 'TRANSPORT', { cause: error })
    } finally {
      await response?.body?.cancel().catch(() => {})
    }
  }
}
