import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Last line of defence against silent failures: if a screen throws while rendering, show what happened
 * instead of a blank page. (API failures are handled per screen; this catches everything else.)
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[doctor-portal] screen crashed while rendering', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 p-6 text-red-900">
        <p className="font-semibold">This screen hit an unexpected error.</p>
        <p className="mt-1 text-sm">
          <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">RENDER_ERROR</code>
          <span className="ml-2">{error.message}</span>
        </p>
        <div className="mt-4 flex gap-3">
          <button type="button" onClick={() => this.setState({ error: null })} className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()} className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium hover:bg-red-100">
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
