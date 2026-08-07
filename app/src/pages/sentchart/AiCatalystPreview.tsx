'use client'
import { useMemo, useState } from 'react'
import { clsx } from 'clsx'
import type { LongTermFundamentalsRow } from '@/lib/types'

// AI Catalyst Analysis — a live panel over Infrastructure/server/routes/aiCatalyst.js,
// which calls a Groq-hosted LLM (lib/aiCatalystAgent.js) against the same
// fundamentals row the Long-Term Score table already shows for a ticker, plus a
// short window of recent approved-source headlines.
//
// This is commentary, not a signal. The API call fires only when the user clicks
// Analyze — there is no auto-fetch, no polling, and nothing here feeds
// scoreLongTerm or the table's ranking. Confidence is the model's own
// self-reported number, not a measured probability; the disclaimer below (and the
// one the API returns) says so every time a result renders.

interface AiCatalystAnalysis {
  signal: 'bullish' | 'bearish' | 'neutral' | 'watch'
  confidence: number
  reasoning: string
  key_catalysts: string[]
  risks: string[]
  data_quality: 'high' | 'medium' | 'low'
}

interface AiCatalystResult {
  ok: boolean
  ticker?: string
  analysis?: AiCatalystAnalysis
  model?: string
  generated_at?: string
  cached?: boolean
  error?: string
  message?: string
  disclaimer?: string
}

const FALLBACK_DISCLAIMER =
  'AI-generated commentary from an LLM. Not verified financial advice, not a backtested signal, and not an input ' +
  "to any ranking on this page. Confidence is the model's own self-reported number, not a measured probability."

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: 'No AI provider key is configured on the server.',
  budget_exhausted: 'The per-window analysis budget has been reached — try again later.',
  provider_error: 'The AI provider returned an error.',
  unparseable_response: 'The AI provider returned a response that could not be parsed.',
  invalid_shape: "The AI provider's response did not match the expected format.",
  timeout: 'The request to the AI provider timed out.',
  request_failed: 'The request to the AI provider failed.',
  invalid_ticker: 'Invalid ticker.',
}

function signalTone(signal: string | undefined): string {
  switch (signal) {
    case 'bullish': return 'text-emerald-400'
    case 'bearish': return 'text-red-400'
    case 'watch': return 'text-amber-400'
    default: return 'text-slate-300'
  }
}

function dataQualityTone(quality: string | undefined): string {
  if (quality === 'high') return 'text-emerald-400'
  if (quality === 'medium') return 'text-amber-400'
  return 'text-slate-500'
}

export function AiCatalystPreview({ rows }: { rows: LongTermFundamentalsRow[] }) {
  const [open, setOpen] = useState<boolean>(false)
  const [ticker, setTicker] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)
  const [result, setResult] = useState<AiCatalystResult | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const eligible = useMemo(() => (rows ?? []).slice(0, 25), [rows])

  const analyze = async () => {
    if (!ticker) return
    setLoading(true)
    setFetchError(null)
    setResult(null)
    try {
      const res = await fetch('/api/ai-catalyst/ticker/' + encodeURIComponent(ticker))
      const json: AiCatalystResult = await res.json()
      setResult(json)
    } catch {
      setFetchError('Could not reach the analysis endpoint.')
    } finally {
      setLoading(false)
    }
  }

  const disclaimer = result?.disclaimer || FALLBACK_DISCLAIMER
  const analysis = result?.ok ? result.analysis : undefined

  return (
    <div className="bg-surface border border-border rounded-lg mb-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-700/30 transition-colors"
      >
        <span className="block">
          <span className="text-white font-semibold text-sm">AI-Generated Analysis</span>{' '}
          <span className="text-[10px] uppercase tracking-wide font-medium text-amber-300 bg-amber-500/10 border border-amber-500/40 rounded px-1.5 py-0.5">
            LLM — not advice
          </span>
          <span className="block text-neutral text-[11px] mt-1">
            Live commentary from a language model over the fundamentals row above — call it on demand per ticker.
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-neutral text-[10px] uppercase tracking-wide font-medium">
            {open ? 'Hide' : 'Show'}
          </span>
          <span className="text-neutral text-xs">{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <select
              value={ticker}
              onChange={e => setTicker(e.target.value)}
              className="bg-bg border border-border rounded px-2 py-1 text-xs text-white"
            >
              <option value="">Select a ticker…</option>
              {eligible.map(r => (
                <option key={r.ticker} value={r.ticker}>
                  {r.ticker} — {r.company || 'Unknown'}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={analyze}
              disabled={!ticker || loading}
              className="text-[10px] text-neutral uppercase tracking-wide font-medium hover:text-white border border-border rounded px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>

          {fetchError && (
            <div className="bg-bg border border-border rounded-lg p-3 mb-3">
              <div className="text-slate-300 text-xs font-semibold mb-1">AI analysis unavailable</div>
              <div className="text-[11px] text-slate-500 leading-relaxed">{fetchError}</div>
            </div>
          )}

          {result && !result.ok && (
            <div className="bg-bg border border-border rounded-lg p-3 mb-3">
              <div className="text-slate-300 text-xs font-semibold mb-1">AI analysis unavailable</div>
              <div className="text-[11px] text-slate-500 leading-relaxed">
                {result.message || ERROR_MESSAGES[result.error || ''] || 'The analysis request did not succeed.'}
              </div>
            </div>
          )}

          {result?.ok && analysis && (
            <div className="bg-bg border border-border rounded-lg p-3 mb-3">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="font-mono font-bold text-accent">{result.ticker}</span>
                {result.cached === true && (
                  <span className="text-[10px] uppercase tracking-wide font-medium text-slate-500 border border-border rounded px-1.5 py-0.5">
                    cached
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
                <div>
                  <div className="text-neutral text-[10px] uppercase tracking-wide font-medium">Signal</div>
                  <div className={clsx('font-mono font-semibold', signalTone(analysis.signal))}>
                    {analysis.signal}
                  </div>
                </div>
                <div>
                  <div className="text-neutral text-[10px] uppercase tracking-wide font-medium">Confidence</div>
                  <div className="font-mono text-slate-300">
                    {analysis.confidence.toFixed(2)}{' '}
                    <span className="text-neutral text-[10px]">model self-reported</span>
                  </div>
                </div>
                <div>
                  <div className="text-neutral text-[10px] uppercase tracking-wide font-medium">Data Quality</div>
                  <div className={clsx('font-mono', dataQualityTone(analysis.data_quality))}>
                    {analysis.data_quality}
                  </div>
                </div>
              </div>

              <div className="mb-3">
                <div className="text-neutral text-[10px] uppercase tracking-wide font-medium mb-1">Reasoning</div>
                <div className="text-slate-300 text-xs leading-relaxed">{analysis.reasoning}</div>
              </div>

              {analysis.key_catalysts.length > 0 && (
                <div className="mb-3">
                  <div className="text-neutral text-[10px] uppercase tracking-wide font-medium mb-1">Key Catalysts</div>
                  <ul className="list-disc list-inside text-slate-300 text-xs leading-relaxed space-y-0.5">
                    {analysis.key_catalysts.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}

              {analysis.risks.length > 0 && (
                <div className="mb-3">
                  <div className="text-neutral text-[10px] uppercase tracking-wide font-medium mb-1">Risks</div>
                  <ul className="list-disc list-inside text-slate-300 text-xs leading-relaxed space-y-0.5">
                    {analysis.risks.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}

              <div className="text-neutral text-[10px]">
                {result.model && <span>model: {result.model}</span>}
                {result.generated_at && <span className="ml-2">generated: {result.generated_at}</span>}
              </div>
            </div>
          )}

          <div className="text-[10px] text-slate-500 mt-1 leading-relaxed">{disclaimer}</div>
        </div>
      )}
    </div>
  )
}
