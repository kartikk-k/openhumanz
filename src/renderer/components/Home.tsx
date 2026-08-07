import { useState } from 'react';
import { cn } from '../lib/utils';
import { APP_NAME } from '../constants';

/**
 * Welcome screen for the template. Demonstrates Tailwind styling and a
 * round-trip over the `ipc-example` IPC channel.
 */
export default function Home() {
  const [reply, setReply] = useState<string | null>(null);

  const pingMain = () => {
    window.electron.ipcRenderer.once('ipc-example', (...args: unknown[]) => {
      setReply(String(args[0]));
    });
    window.electron.ipcRenderer.sendMessage('ipc-example', 'ping');
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <svg
          className="mb-5 h-8 w-8 text-neutral-900 dark:text-neutral-100"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="2.5" />
          <ellipse cx="12" cy="12" rx="10" ry="4.5" />
          <ellipse
            cx="12"
            cy="12"
            rx="10"
            ry="4.5"
            transform="rotate(60 12 12)"
          />
          <ellipse
            cx="12"
            cy="12"
            rx="10"
            ry="4.5"
            transform="rotate(120 12 12)"
          />
        </svg>

        <h1 className="text-xl font-semibold tracking-tight">{APP_NAME}</h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          Electron, React, TypeScript and Tailwind, ready to build on. Edit{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-800">
            src/renderer/components/Home.tsx
          </code>{' '}
          to get started.
        </p>

        <button
          type="button"
          onClick={pingMain}
          className={cn(
            'mt-6 w-full rounded-lg px-4 py-2 text-sm font-medium transition-colors',
            'bg-neutral-900 text-white hover:bg-neutral-700',
            'dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300',
          )}
        >
          Send IPC message
        </button>

        <p
          className={cn(
            'mt-3 text-center font-mono text-xs',
            reply
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-neutral-400',
          )}
        >
          {reply ?? 'No reply yet'}
        </p>
      </div>
    </main>
  );
}
