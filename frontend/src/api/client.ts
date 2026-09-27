/**
 * 后端访问唯一封装：
 * - Bearer token 自动附带；401 时清理会话并回登录页
 * - 信封 {code, msg, data, timestamp} 解包，code!==0 或 HTTP 非 2xx 统一抛 ApiError
 * - 8s AbortController 硬超时（对齐契约「禁止无边界重试」，超时即失败给用户明确提示）
 * - 错误统一走 antd message 提示，业务层只需 catch 后做自己的降级 UI
 */
import { message } from 'antd'
import { QueryClient } from '@tanstack/react-query'

const TOKEN_KEY = 'satmon_token'
const USER_KEY = 'satmon_user'

/** 与契约 OData 适配器一致的 8s 硬超时 */
export const API_TIMEOUT_MS = 8000

export class ApiError extends Error {
  /** 信封错误码（如 1003/2001）；-1/-2/-3 为前端本地错误（非 JSON/超时/网络） */
  readonly code: number
  readonly status: number
  constructor(msg: string, code: number, status: number) {
    super(msg)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function getStoredUser(): string | null {
  return localStorage.getItem(USER_KEY)
}

export function setStoredUser(user: unknown): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

interface Envelope<T> {
  code: number
  msg: string
  data: T
  timestamp: string
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (init?.body != null) headers['Content-Type'] = 'application/json'

  try {
    const res = await fetch(path, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    })

    if (res.status === 401) {
      clearSession()
      // 未登录/会话失效：整页跳转，避免各页面重复处理
      if (!window.location.pathname.startsWith('/login')) window.location.assign('/login')
      throw new ApiError('登录已失效，请重新登录', 401, 401)
    }

    let body: Envelope<T> | null = null
    try {
      body = (await res.json()) as Envelope<T>
    } catch {
      // 代理 502 / 后端崩溃等非 JSON 响应
    }
    if (!body) {
      const msg = `服务异常（HTTP ${res.status}）`
      message.error(msg)
      throw new ApiError(msg, -1, res.status)
    }
    if (!res.ok || body.code !== 0) {
      const msg = body.msg || `请求失败（HTTP ${res.status}）`
      message.error(msg)
      throw new ApiError(msg, body.code, res.status)
    }
    return body.data
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (e instanceof DOMException && e.name === 'AbortError') {
      const msg = `请求超时（${API_TIMEOUT_MS / 1000}s），请稍后重试`
      message.error(msg)
      throw new ApiError(msg, -2, 0)
    }
    const msg = '网络异常，服务不可达'
    message.error(msg)
    throw new ApiError(msg, -3, 0)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * TanStack Query 全局设置：retry=1（有界重试，对齐工程原则「不做无边界重试」）。
 * 窗口聚焦不自动重拉，避免演示中被后台刷新打断。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
})
