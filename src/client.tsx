import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  Button,
  IconRightUpOutline16,
  IconTrashOutline16,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'

type LoginAuthState =
  | { status: 'loading' }
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'authenticated'; email?: string }
  | { status: 'failed'; error: string }

type LoginStatus = LoginAuthState & {
  providerEnabled: boolean
}

interface LoginStart {
  status: 'pending'
  authorizationUrl: string
}

interface LoginSectionProps {
  connection?: ConnectionHandle
}

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 620,
  color: 'var(--dsw-alias-label-primary)',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  padding: '14px 16px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseStatus(value: unknown): LoginStatus {
  if (value === null || typeof value !== 'object') throw new Error('登录状态响应无效')
  const record = value as Record<string, unknown>
  const providerEnabled = record.providerEnabled !== false
  if (record.status === 'idle' || record.status === 'pending') {
    return { status: record.status, providerEnabled }
  }
  if (record.status === 'authenticated') {
    return {
      status: 'authenticated',
      providerEnabled,
      ...(typeof record.email === 'string' ? { email: record.email } : {}),
    }
  }
  if (record.status === 'failed' && typeof record.error === 'string') {
    return { status: 'failed', error: record.error, providerEnabled }
  }
  throw new Error('登录状态响应无效')
}

function parseStart(value: unknown): LoginStart {
  if (value === null || typeof value !== 'object') throw new Error('登录响应无效')
  const record = value as Record<string, unknown>
  if (record.status !== 'pending' || typeof record.authorizationUrl !== 'string') {
    throw new Error('登录响应无效')
  }
  const url = new URL(record.authorizationUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') {
    throw new Error('登录地址不是受信任的 Google 地址')
  }
  return { status: 'pending', authorizationUrl: url.href }
}

async function call(connection: ConnectionHandle, method: 'enable' | 'start' | 'status' | 'logout'): Promise<unknown> {
  const result = await connection.rpc.call('/api', `antigravityAuth/${method}`, { args: {} })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function statusCopy(status: LoginStatus): { dot: StateDotState; text: string } {
  const disabled = status.providerEnabled ? '' : ' · 提供商已停用'
  switch (status.status) {
    case 'loading': return { dot: 'ongoing', text: '正在检查登录状态' }
    case 'idle': return { dot: 'warning', text: `未登录${disabled}` }
    case 'pending': return { dot: 'ongoing', text: '等待 Google 授权' }
    case 'authenticated': return {
      dot: 'done',
      text: `${status.email === undefined ? '已登录' : `已登录 · ${status.email}`}${disabled}`,
    }
    case 'failed': return { dot: 'error', text: `登录失败${disabled}` }
  }
}

function LoginSection({ connection }: LoginSectionProps): ReactNode {
  const [status, setStatus] = useState<LoginStatus>({ status: 'loading', providerEnabled: true })
  const [starting, setStarting] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [authorizationUrl, setAuthorizationUrl] = useState<string>()

  useEffect(() => {
    if (connection === undefined) return
    let active = true
    void call(connection, 'status').then(parseStatus).then(next => {
      if (active) setStatus(next)
    }).catch(error => {
      if (active) setStatus({ status: 'failed', error: messageOf(error), providerEnabled: true })
    })
    return () => { active = false }
  }, [connection])

  useEffect(() => {
    if (connection === undefined || status.status !== 'pending') return
    let active = true
    let refreshing = false
    const timer = window.setInterval(() => {
      if (refreshing) return
      refreshing = true
      void call(connection, 'status').then(parseStatus).then(next => {
        if (active) {
          setStatus(next)
          if (next.status !== 'pending') setAuthorizationUrl(undefined)
        }
      }).catch(error => {
        if (active) setStatus({ status: 'failed', error: messageOf(error), providerEnabled: true })
      }).finally(() => { refreshing = false })
    }, 1_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [connection, status.status])

  if (connection === undefined) return null
  const summary = statusCopy(status)
  const enableOnly = status.status === 'authenticated' && !status.providerEnabled
  const enableProvider = async (): Promise<void> => {
    setStarting(true)
    try {
      await call(connection, 'enable')
      setStatus(current => ({ ...current, providerEnabled: true }))
    } catch (error: unknown) {
      setStatus({ status: 'failed', error: messageOf(error), providerEnabled: false })
    } finally {
      setStarting(false)
    }
  }
  const beginLogin = async (): Promise<void> => {
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    setStarting(true)
    setAuthorizationUrl(undefined)
    try {
      const started = parseStart(await call(connection, 'start'))
      setStatus({ status: 'pending', providerEnabled: true })
      if (popup === null) setAuthorizationUrl(started.authorizationUrl)
      else popup.location.replace(started.authorizationUrl)
    } catch (error: unknown) {
      popup?.close()
      setStatus({ status: 'failed', error: messageOf(error), providerEnabled: status.providerEnabled })
    } finally {
      setStarting(false)
    }
  }
  const logout = async (): Promise<void> => {
    if (!window.confirm('退出登录将删除本机保存的 Antigravity OAuth 凭据，确定继续吗？')) return
    setLoggingOut(true)
    try {
      await call(connection, 'logout')
      setAuthorizationUrl(undefined)
      setStatus({ status: 'idle', providerEnabled: true })
    } catch (error: unknown) {
      setStatus({ status: 'failed', error: messageOf(error), providerEnabled: status.providerEnabled })
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <section style={sectionStyle} aria-labelledby="antigravity-auth-title">
      <div>
        <h2 id="antigravity-auth-title" style={{ margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500 }}>
          Google Antigravity
        </h2>
      </div>
      <div style={rowStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <StateDot state={summary.dot} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, lineHeight: '22px', fontWeight: 500 }}>Antigravity OAuth</div>
            <div aria-live="polite" style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }}>
              {summary.text}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
          <Button
            variant="primary"
            icon={<IconRightUpOutline16 size={16} />}
            disabled={starting || loggingOut || status.status === 'pending' || status.status === 'loading'}
            onClick={() => { void (enableOnly ? enableProvider() : beginLogin()) }}
          >
            {enableOnly ? '启用提供商' : status.status === 'authenticated' ? '重新登录' : '登录 Google'}
          </Button>
          {status.status === 'authenticated' && status.providerEnabled && (
            <Button
              variant="outline"
              icon={<IconTrashOutline16 size={16} />}
              disabled={starting || loggingOut}
              onClick={() => { void logout() }}
            >
              {loggingOut ? '退出中…' : '退出登录'}
            </Button>
          )}
        </div>
      </div>
      {authorizationUrl !== undefined && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-label)' }}>
          浏览器阻止了登录窗口。
          <Button
            size="sm"
            variant="outline"
            icon={<IconRightUpOutline16 size={16} />}
            onClick={() => { window.open(authorizationUrl, '_blank', 'noopener,noreferrer') }}
          >
            打开授权页面
          </Button>
        </div>
      )}
      {status.status === 'failed' && (
        <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' }}>
          {status.error}
        </p>
      )}
    </section>
  )
}

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'antigravity-oauth',
    order: 12,
    label: 'Antigravity',
    inject: () => ({ connection }),
  }, LoginSection))
}
