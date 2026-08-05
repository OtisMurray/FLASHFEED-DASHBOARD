import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

// The Decision Map builds a WebGL scene imperatively — geometries, textures,
// pointer handlers, an animation loop. A throw anywhere in that has no React
// state to fall back on, and an uncaught render error unmounts the whole tree,
// so a fault confined to the map used to take the entire route with it.
//
// The renderer's own construction is handled inside the component, which can
// fail gracefully and still show its data. This is the outer net for everything
// that is not that: a driver dying mid-frame, a bad row shape, a Three.js
// upgrade changing an API. It keeps the failure local to the panel.
interface Props {
  children: ReactNode
  /** Shown in place of the children. Receives the error for display. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}
interface State { error: Error | null }

export class MapErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Left visible in the console on purpose. This boundary stops the page
    // going blank, which also means the failure stops being obvious — without
    // a log, a silently degraded panel is harder to notice than a crash.
    console.error('Decision Map failed and was contained by its error boundary:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      <div
        role="alert"
        data-testid="decision-map-error-boundary"
        className="relative h-[560px] min-h-[420px] overflow-auto rounded border border-border bg-bg p-4"
      >
        <h3 className="text-sm font-semibold text-rose-300">The Decision Map could not be displayed</h3>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-neutral">
          Something went wrong while drawing the map. The rest of the page is unaffected — the
          screener, news and charts views all read the same data and are still available.
        </p>
        <p className="mt-2 font-mono text-[10px] text-slate-500">{error.message}</p>
        <button
          type="button"
          onClick={this.reset}
          className="mt-3 rounded border border-border bg-surface px-3 py-1.5 text-xs text-neutral transition-colors hover:border-accent hover:text-white"
        >
          Try again
        </button>
      </div>
    )
  }
}
