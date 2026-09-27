/**
 * 会话上下文：MVP 用 mock token（契约 §7 种子账号）。
 * token 含 tenantId+userId+role，一切资源按 token 的 tenantId 隔离。
 * 未登录访问受保护路由由 App 层 <RequireAuth> 重定向到 /login。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { UserSchema, type User } from '../api/types'
import { clearSession, getToken, queryClient, setStoredUser, setToken } from '../api/client'

interface AuthContextValue {
  user: User | null
  /** 登录 / 切换种子用户后写入会话 */
  signIn: (token: string, user: User) => void
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** 从 localStorage 恢复会话（信封外的本地缓存，恢复时重新走 zod 校验） */
function restoreUser(): User | null {
  if (!getToken()) return null
  const raw = localStorage.getItem('satmon_user')
  if (!raw) return null
  try {
    const parsed = UserSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(restoreUser)

  const signIn = useCallback((token: string, nextUser: User) => {
    setToken(token)
    setStoredUser(nextUser)
    // 会话主体（租户/用户）变更，旧缓存属于另一隔离边界，必须整体丢弃，
    // 否则切租户登录瞬间会闪现上一租户的数据（工程原则 3：隔离边界默认开启）
    queryClient.clear()
    setUser(nextUser)
  }, [])

  const signOut = useCallback(() => {
    clearSession()
    queryClient.clear()
    setUser(null)
  }, [])

  const value = useMemo(() => ({ user, signIn, signOut }), [user, signIn, signOut])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用')
  return ctx
}
