/**
 * Transient notifications.
 *
 * A store rather than a context so that non-React code — an IPC error handler,
 * a push-channel subscriber in another store — can raise a toast without a
 * component in scope. Import `toast`, call it, done.
 *
 * Toasts are for things the user does not need to act on. Anything requiring a
 * decision is an approval, not a toast.
 */
import { create } from 'zustand';
import type { Tone } from '../lib/tone';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  tone: Tone;
  title: string;
  description?: string;
  /** 0 keeps it up until dismissed. */
  durationMs: number;
  action?: ToastAction;
  createdAt: number;
}

export interface ToastOptions {
  description?: string;
  /** Default 5000ms; 0 to make it sticky. */
  durationMs?: number;
  action?: ToastAction;
  /**
   * Collapse repeats: pushing the same key replaces the existing toast instead
   * of stacking. Use it for repeated failures on the same channel.
   */
  key?: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (tone: Tone, title: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const MAX_VISIBLE = 4;
let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (tone, title, options = {}) => {
    counter += 1;
    const id = options.key ?? `toast-${counter}`;
    const item: ToastItem = {
      id,
      tone,
      title,
      description: options.description,
      durationMs: options.durationMs ?? 5000,
      action: options.action,
      createdAt: Date.now(),
    };
    set((state) => {
      const without = state.toasts.filter((existing) => existing.id !== id);
      return { toasts: [...without, item].slice(-MAX_VISIBLE) };
    });
    return id;
  },

  dismiss: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((item) => item.id !== id),
    })),

  clear: () => set({ toasts: [] }),
}));

/** Imperative API. Safe to call from anywhere, including outside React. */
export const toast = {
  info: (title: string, options?: ToastOptions) =>
    useToastStore.getState().push('info', title, options),
  success: (title: string, options?: ToastOptions) =>
    useToastStore.getState().push('success', title, options),
  warning: (title: string, options?: ToastOptions) =>
    useToastStore.getState().push('warning', title, options),
  error: (title: string, options?: ToastOptions) =>
    useToastStore
      .getState()
      .push('danger', title, { durationMs: 8000, ...options }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
  clear: () => useToastStore.getState().clear(),
};
