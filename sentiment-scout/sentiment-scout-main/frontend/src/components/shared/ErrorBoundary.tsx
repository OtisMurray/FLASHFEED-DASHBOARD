import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional label so the inline message can name the failing region. */
  label?: string
}
interface State {
  error: Error | null
}

/**
 * Class error boundary — catches render-time exceptions in its subtree and shows
 * a contained inline message instead of letting one component blank the whole app
 * (React unmounts the entire tree on an uncaught render error). Wrap the routed
 * pages with this so a single page/component throwing degrades gracefully.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown) {
    // Keep it visible in the console for debugging; never swallow silently.
    console.error('[ErrorBoundary] caught render error:', error, info)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="m-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <div className="font-semibold text-red-300 mb-1">
            Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}.
          </div>
          <p className="text-red-200/80 mb-2">
            This section hit an error and was contained — the rest of the app keeps working.
          </p>
          <pre className="text-[11px] text-red-200/70 whitespace-pre-wrap break-words mb-3">
            {this.state.error.message}
          </pre>
          <button
            onClick={this.reset}
            className="text-xs px-3 py-1.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 border border-red-500/40"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
