import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../game/log.ts';

interface Props {
  children: ReactNode;
  /** What crashed, for the log line and the fallback text. */
  label?: string;
}

/** Contains a render crash to one panel: logs it once and offers to re-mount the subtree. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error);
    log.push('error', `${this.props.label ?? 'panel'} crashed: ${message}${info.componentStack ? ` (${info.componentStack.trim().split('\n')[0]?.trim()})` : ''}`);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="p-3 text-sm text-neutral-400" role="alert" data-testid="panel-crashed">
        This panel crashed —{' '}
        <button className="underline" onClick={() => this.setState({ failed: false })}>
          reload panel
        </button>
      </div>
    );
  }
}
