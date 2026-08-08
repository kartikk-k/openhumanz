/**
 * Connections — connect third-party apps through the user's own Composio
 * account.
 *
 * The user brings their own Composio API key; their connected apps live in
 * their Composio account. This panel: takes the key, verifies it, shows which
 * apps are connected, sends the user to Composio's own site to connect more
 * (their page handles the sign-in), and — for a connected app — shows the tools
 * it exposes (proof the pipe works end to end).
 *
 * This is the foundation slice: it does not yet register those tools with the
 * assistant. That comes next.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Plug,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { IPC } from '../../../shared/ipc';
import type {
  ComposioStatus,
  ComposioToolInfo,
  ComposioToolkit,
} from '../../../shared/ipc';
import { call, callReply } from '../../lib/ipc';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { textMuted, textSubtle } from '../../components/ui/styles';

export function ComposioPanel() {
  const [status, setStatus] = useState<ComposioStatus | null>(null);
  const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
  const [keyDraft, setKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [toolsFor, setToolsFor] = useState<{
    slug: string;
    tools: ComposioToolInfo[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await callReply(IPC.composio.status, {});
    if (s.ok) setStatus(s.data);
    const tk = await callReply(IPC.composio.listToolkits, {});
    if (tk.ok) setToolkits(tk.data);
  }, []);

  useEffect(() => {
    void refresh();
    // Connections are made on Composio's site; re-check when the user returns
    // to the app so a freshly-connected app shows up without a manual refresh.
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const saveKey = async (): Promise<void> => {
    setSavingKey(true);
    setError(null);
    try {
      const next = await call(IPC.composio.setKey, { apiKey: keyDraft.trim() });
      setStatus(next);
      setKeyDraft('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingKey(false);
    }
  };

  const openConnections = async (): Promise<void> => {
    setError(null);
    try {
      const result = await call(IPC.composio.connect, {});
      if (!result.opened && result.error) setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const showTools = async (slug: string): Promise<void> => {
    const reply = await callReply(IPC.composio.toolsFor, { toolkitSlug: slug });
    if (reply.ok) setToolsFor({ slug, tools: reply.data });
  };

  const configured = status?.configured ?? false;
  const verified = status?.verified ?? false;

  return (
    <div className="space-y-4">
      {/* API key */}
      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <Input
            id="composio-key"
            label="Composio API key"
            type="password"
            inputClassName="font-mono"
            placeholder={
              configured
                ? '•••••••••••• (saved)'
                : 'ak_… from dashboard.composio.dev'
            }
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            containerClassName="flex-1"
          />
          <Button
            size="sm"
            variant="secondary"
            loading={savingKey}
            disabled={keyDraft.trim().length === 0}
            onClick={() => {
              void saveKey();
            }}
          >
            Save
          </Button>
        </div>
        <p className={cn('text-[12px] leading-relaxed', textSubtle)}>
          Your key connects the app to your own Composio account. Your connected
          apps live in your account — get a key at{' '}
          <a
            href="https://dashboard.composio.dev"
            target="_blank"
            rel="noreferrer noopener"
            className="text-indigo-500 hover:underline"
          >
            dashboard.composio.dev
          </a>
          .
        </p>
        {configured ? (
          <div
            className={cn('flex items-center gap-1.5 text-[12px]', textMuted)}
          >
            {verified ? (
              <>
                <CheckCircle2
                  size={13}
                  className="text-emerald-500"
                  aria-hidden
                />
                Key verified.
              </>
            ) : (
              <span className="text-rose-500">
                {status?.error ?? 'Key not verified yet.'}
              </span>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {/* Toolkits */}
      {verified ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300">
              Apps
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                icon={RefreshCw}
                onClick={() => {
                  void refresh();
                }}
              >
                Refresh
              </Button>
              <Button
                size="xs"
                variant="outline"
                icon={ExternalLink}
                onClick={() => {
                  void openConnections();
                }}
              >
                Manage on Composio
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800/70 dark:border-zinc-800">
            {toolkits.map((tk) => (
              <li key={tk.slug} className="flex items-center gap-3 px-3 py-2.5">
                <Plug size={15} aria-hidden className={textMuted} />
                <span className="flex-1 text-[13px] text-zinc-800 dark:text-zinc-200">
                  {tk.name}
                </span>
                {tk.connected ? (
                  <>
                    <span className="inline-flex items-center gap-1 text-[12px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 size={13} aria-hidden />
                      Connected
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={Wrench}
                      onClick={() => {
                        void showTools(tk.slug);
                      }}
                    >
                      Tools
                    </Button>
                  </>
                ) : (
                  <span className={cn('text-[12px]', textSubtle)}>
                    Not connected
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className={cn('text-[12px]', textSubtle)}>
            Connect apps on Composio&apos;s site — their page handles the
            sign-in. When you come back, this list refreshes automatically.
          </p>
        </div>
      ) : null}

      {/* Tools preview for a connected toolkit */}
      {toolsFor ? (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300">
              {toolsFor.slug} — {toolsFor.tools.length} tools
            </span>
            <Button size="xs" variant="ghost" onClick={() => setToolsFor(null)}>
              Close
            </Button>
          </div>
          <ul className="max-h-64 overflow-y-auto p-2">
            {toolsFor.tools.map((tool) => (
              <li key={tool.slug} className="px-1 py-1.5">
                <div className="font-mono text-[12px] text-zinc-800 dark:text-zinc-200">
                  {tool.slug}
                </div>
                <div className={cn('text-[11.5px] leading-4', textSubtle)}>
                  {tool.description}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default ComposioPanel;
