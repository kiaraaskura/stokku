import { Component, type ReactNode } from 'react'
import { ErrorView } from '../components/state'

interface State {
  error: Error | null
}

/** Keeps one component crash from blanking the whole app; offers a reload. */
export class CrashBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app" style={{ alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)' }}>
          <ErrorView
            message={this.state.error.message}
            onRetry={() => {
              this.setState({ error: null })
              location.assign('/barang')
            }}
          />
        </div>
      )
    }
    return this.props.children
  }
}
