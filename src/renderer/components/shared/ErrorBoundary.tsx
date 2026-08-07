import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { CodeBlock } from '../ui/CodeBlock';

interface Props {
  children: ReactNode;
  /** Shown above the error. Defaults to a generic message. */
  title?: string;
}

interface State {
  error: Error | null;
  stack: string | null;
}

/**
 * Catches a render crash in one screen so it does not take the shell with it.
 *
 * The shell keys this by route, so navigating away and back clears it. The
 * stack is shown rather than hidden: this is a local-first tool with no crash
 * reporting anywhere, so the only person who can act on the error is the one
 * looking at the screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, stack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? error.stack ?? null });
    // eslint-disable-next-line no-console
    console.error('Renderer error boundary caught:', error, info);
  }

  private reset = (): void => {
    this.setState({ error: null, stack: null });
  };

  render(): ReactNode {
    const { error, stack } = this.state;
    const { children, title = 'This screen hit an error' } = this.props;

    if (!error) return children;

    return (
      <div className="mx-auto max-w-2xl px-5 py-10">
        <div className="flex items-start gap-3">
          <AlertTriangle
            size={18}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-rose-500"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {title}
            </h2>
            <p className="mt-1 text-[13px] text-zinc-600 dark:text-zinc-400">
              {error.message}
            </p>
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={this.reset}>
                Try again
              </Button>
            </div>
            {stack ? (
              <CodeBlock
                className="mt-4"
                language="stack"
                code={stack.trim()}
                maxHeight="14rem"
                wrap
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
