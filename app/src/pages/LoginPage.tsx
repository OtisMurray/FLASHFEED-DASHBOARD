import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/useAuth'

type Mode = 'login' | 'register'
type Step = 'form' | 'code'

const inputCls = 'w-full bg-bg border border-border rounded px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-accent'

export function LoginPage() {
  const navigate = useNavigate()
  const { setUser } = useAuth()

  const [mode, setMode] = useState<Mode>('login')
  const [step, setStep] = useState<Step>('form')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Login / register form fields
  const [usernameOrEmail, setUsernameOrEmail] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // 2FA step
  const [pendingToken, setPendingToken] = useState('')
  const [code, setCode] = useState('')
  const [resendCooldown, setResendCooldown] = useState(0)

  function switchMode(next: Mode) {
    setMode(next); setStep('form'); setError(''); setNotice('')
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setNotice(''); setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ usernameOrEmail, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Login failed.')
      setPendingToken(data.pendingToken)
      setNotice(data.message || 'Check your email for a code.')
      setStep('code')
      setResendCooldown(20)
      const t = setInterval(() => setResendCooldown(c => { if (c <= 1) { clearInterval(t); return 0 } return c - 1 }), 1000)
    } catch (err: any) {
      setError(err.message || 'Login failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setNotice(''); setLoading(true)
    try {
      if (password !== confirmPassword) throw new Error('Passwords do not match.')
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Registration failed.')
      setNotice('Account created — you can log in now.')
      setUsernameOrEmail(username)
      setPassword(''); setConfirmPassword('')
      setMode('login')
    } catch (err: any) {
      setError(err.message || 'Registration failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch('/api/auth/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pendingToken, code }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Verification failed.')
      setUser(data.user)
      navigate('/overview')
    } catch (err: any) {
      setError(err.message || 'Verification failed.')
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    if (resendCooldown > 0) return
    setError(''); setNotice('')
    try {
      const res = await fetch('/api/auth/resend-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pendingToken }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not resend the code.')
      setNotice(data.message || 'New code sent.')
      setResendCooldown(20)
      const t = setInterval(() => setResendCooldown(c => { if (c <= 1) { clearInterval(t); return 0 } return c - 1 }), 1000)
    } catch (err: any) {
      setError(err.message || 'Could not resend the code.')
    }
  }

  return (
    <div className="flex items-center justify-center min-h-[80vh] p-4">
      <div className="w-full max-w-sm bg-surface border border-border rounded-lg p-6 space-y-4">
        <div className="text-center">
          <div className="text-xl font-bold text-accent">FlashFeed</div>
          <div className="text-xs text-neutral mt-1">
            {step === 'code' ? 'Enter your verification code' : mode === 'login' ? 'Log in to your account' : 'Create an account'}
          </div>
        </div>

        {step === 'form' && (
          <div className="flex rounded overflow-hidden border border-border text-xs">
            <button onClick={() => switchMode('login')}
              className={`flex-1 py-1.5 ${mode === 'login' ? 'bg-accent text-white' : 'bg-bg text-neutral hover:text-white'}`}>Log In</button>
            <button onClick={() => switchMode('register')}
              className={`flex-1 py-1.5 ${mode === 'register' ? 'bg-accent text-white' : 'bg-bg text-neutral hover:text-white'}`}>Register</button>
          </div>
        )}

        {error && <div className="border border-red-500/40 bg-red-500/10 text-red-300 rounded p-2 text-xs">{error}</div>}
        {notice && !error && <div className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 rounded p-2 text-xs">{notice}</div>}

        {step === 'form' && mode === 'login' && (
          <form onSubmit={handleLogin} className="space-y-3">
            <input value={usernameOrEmail} onChange={e => setUsernameOrEmail(e.target.value)}
              placeholder="Username or email" autoComplete="username" className={inputCls} />
            <input value={password} onChange={e => setPassword(e.target.value)} type="password"
              placeholder="Password" autoComplete="current-password" className={inputCls} />
            <button type="submit" disabled={loading}
              className="w-full bg-accent text-white text-sm font-medium rounded py-2 hover:bg-sky-400 disabled:opacity-50">
              {loading ? 'Signing in…' : 'Log In'}
            </button>
          </form>
        )}

        {step === 'form' && mode === 'register' && (
          <form onSubmit={handleRegister} className="space-y-3">
            <input value={username} onChange={e => setUsername(e.target.value)}
              placeholder="Username" autoComplete="username" className={inputCls} />
            <input value={email} onChange={e => setEmail(e.target.value)} type="email"
              placeholder="Email" autoComplete="email" className={inputCls} />
            <input value={password} onChange={e => setPassword(e.target.value)} type="password"
              placeholder="Password (min. 8 characters)" autoComplete="new-password" className={inputCls} />
            <input value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} type="password"
              placeholder="Confirm password" autoComplete="new-password" className={inputCls} />
            <button type="submit" disabled={loading}
              className="w-full bg-accent text-white text-sm font-medium rounded py-2 hover:bg-sky-400 disabled:opacity-50">
              {loading ? 'Creating account…' : 'Create Account'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleVerify} className="space-y-3">
            <input value={code} onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              placeholder="8-digit code" inputMode="numeric" autoComplete="one-time-code"
              className={`${inputCls} text-center tracking-[0.4em] font-mono text-lg`} />
            <button type="submit" disabled={loading || code.length !== 8}
              className="w-full bg-accent text-white text-sm font-medium rounded py-2 hover:bg-sky-400 disabled:opacity-50">
              {loading ? 'Verifying…' : 'Verify & Log In'}
            </button>
            <div className="flex items-center justify-between text-[11px] text-neutral">
              <button type="button" onClick={() => setStep('form')} className="hover:text-white">← Back</button>
              <button type="button" onClick={handleResend} disabled={resendCooldown > 0} className="hover:text-white disabled:opacity-40">
                {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : 'Resend code'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
