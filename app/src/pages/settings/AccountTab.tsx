import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '@/lib/useAuth'
import { Section, Badge } from './shared'

/**
 * Account.
 *
 * Identity, sign-out, and the preferences that are safe to show. Deliberately
 * NOT here: password state, 2FA secrets or delivery internals, API key values.
 * The full account page at /account owns those; this tab is the identity and
 * the way out, next to the settings a reader is already editing.
 */
export function AccountTab() {
  const { user, loading, logout } = useAuth()
  const navigate = useNavigate()

  if (loading) return <Section title="Account"><p className="text-sm text-neutral">Loading…</p></Section>

  if (!user) {
    return (
      <Section title="Account">
        <p className="text-sm text-neutral">
          <Link to="/login" className="text-accent hover:underline">Log in</Link> to manage your account.
        </p>
      </Section>
    )
  }

  return (
    <div className="space-y-6">
      <Section title="Signed in as">
        <dl className="text-sm space-y-2">
          <Row term="Username" desc={user.username} />
          <Row term="Email" desc={user.email} />
          <Row
            term="Role"
            desc={
              <Badge tone={user.role === 'admin' ? 'text-emerald-400 border-emerald-500/50' : 'text-sky-400 border-sky-500/50'}>
                {user.role}
              </Badge>
            }
          />
        </dl>

        <div className="flex flex-wrap gap-2 mt-4">
          <button
            onClick={async () => { await logout(); navigate('/login') }}
            className="border border-red-500/40 text-red-300 hover:text-red-200 rounded px-3 py-1.5 text-xs"
          >
            Log out
          </button>
          <Link
            to="/account"
            className="border border-border text-neutral hover:text-white rounded px-3 py-1.5 text-xs"
          >
            Notification & API key settings
          </Link>
        </div>
      </Section>

      <Section
        title="Security"
        hint="Managed elsewhere, on purpose."
      >
        <p className="text-sm text-neutral">
          Password and two-factor settings are not editable from this page, and no part of them —
          no hash, no secret, no recovery code — is sent to it. Two-factor delivery is configured
          on the <Link to="/account" className="text-accent hover:underline">account page</Link>.
        </p>
      </Section>
    </div>
  )
}

function Row({ term, desc }: { term: string; desc: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-3 sm:items-center">
      <dt className="text-neutral sm:w-32 shrink-0">{term}</dt>
      <dd className="text-slate-200">{desc}</dd>
    </div>
  )
}
