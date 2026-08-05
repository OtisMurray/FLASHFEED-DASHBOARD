import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '@/lib/useAuth'

// UI-layer gating only. The API guards are the security boundary — these exist
// so an unauthorised visitor gets a straight answer instead of a page that
// renders and then fills with 401s.
//
// Every guard waits for /api/auth/me to resolve before deciding. Rendering the
// children first would flash protected content, and redirecting first would
// bounce a signed-in admin to /login on every refresh, because `user` is null
// until that request comes back.

function AuthPending() {
  return (
    <div className="m-4 rounded-lg border border-border bg-surface p-4 text-sm text-neutral" role="status" aria-live="polite">
      Checking your session…
    </div>
  )
}

function AccessDenied({ need }: { need: string }) {
  return (
    <div className="m-4 rounded-lg border border-border bg-surface p-6 max-w-xl" role="alert">
      <h1 className="text-white font-semibold text-base">Not available on this account</h1>
      <p className="text-neutral text-sm mt-2 leading-relaxed">
        This page needs {need}. You are signed in, but this account does not have that access.
      </p>
      <p className="text-neutral text-xs mt-3">
        Nothing is wrong with your session — ask an administrator if you need it.
      </p>
    </div>
  )
}

/** Requires any signed-in user. Sends anonymous visitors to /login with a return path. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <AuthPending />
  // `state.from` is what LoginPage sends the user back to. Carrying the whole
  // location keeps any query string and hash, not just the pathname.
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  return <>{children}</>
}

/** Requires an admin. Anonymous visitors go to /login; signed-in non-admins are told plainly. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, isAdmin, loading } = useAuth()
  const location = useLocation()
  if (loading) return <AuthPending />
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  // Deliberately not a redirect. Bouncing a signed-in user to /login implies
  // their session is the problem, and they would log in again to the same wall.
  if (!isAdmin) return <AccessDenied need="an administrator account" />
  return <>{children}</>
}

/**
 * Renders children only for admins, and renders nothing otherwise — including
 * while the session is still loading, so a control never appears and then
 * vanishes. For controls sitting inside a page anyone can open.
 */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin, loading } = useAuth()
  if (loading || !isAdmin) return null
  return <>{children}</>
}
