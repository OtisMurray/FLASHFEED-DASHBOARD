import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'

// Session state. Most of the site is still open to anyone; what changed is that
// the settings and maintenance API routes now require an admin session, so the
// UI needs to know who is signed in to avoid offering controls that will come
// back 401. The API guards are the security boundary — everything here is about
// not showing someone a door they cannot open.
export interface AuthUser {
  username: string
  email: string
  role: 'admin' | 'user'
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  /** Signed in AND role === 'admin'. False while the session is still loading. */
  isAdmin: boolean
  setUser: (u: AuthUser | null) => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled && data?.ok) setUser(data.user) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const logout = useCallback(async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }) } catch (_) {}
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, isAdmin: user?.role === 'admin', setUser, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
