import { useEffect, useRef } from 'react';
import { call } from '../../../lib/ipc';
import { IPC } from '../../../../shared/ipc';

/**
 * Hold-Space voice → transcribe → send flow.
 *
 * While the Space key is held down (and the user isn't typing in an input),
 * we start listening. It tries the realtime transcription path first and falls
 * back to batch recording when realtime is unavailable. On key release it
 * finalizes the transcript (realtime) or stops recording and POSTs the clip
 * (batch), then submits the resulting text.
 *
 * Global keydown/keyup listeners are registered once on mount. All mutable
 * inputs are held in refs so the listeners never capture stale state, which is
 * why the effect must run with an empty dependency array.
 */
export function useHoldToTalk(opts: {
  startRealtime: () => Promise<{ realtime: boolean }>;
  stopRealtime: () => Promise<string>;
  startBatch: () => Promise<void>;
  stopBatch: () => Promise<{ base64: string; mimeType: string } | null>;
  submit: (text: string) => void;
  busy: boolean; // storeBusy — block starting while true
  onListeningChange: (listening: boolean) => void;
  onTranscribingChange: (transcribing: boolean) => void;
  onVoiceError: (msg: string | null) => void;
  onLiveTranscriptReset: () => void; // clear the live transcript on start
  setUsingRealtime: (v: boolean) => void; // record which path is active
}): void {
  const listeningRef = useRef(false);
  const usingRealtimeRef = useRef(false);
  const busyRef = useRef(opts.busy);
  busyRef.current = opts.busy;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const isTyping = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return (
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      );
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
      if (busyRef.current || listeningRef.current) return;
      e.preventDefault();
      listeningRef.current = true;
      optsRef.current.onVoiceError(null);
      optsRef.current.onLiveTranscriptReset();
      optsRef.current.onListeningChange(true);
      void (async () => {
        // try realtime; if unavailable, fall back to batch recording.
        const { realtime } = await optsRef.current.startRealtime();
        usingRealtimeRef.current = realtime;
        optsRef.current.setUsingRealtime(realtime);
        if (!realtime) await optsRef.current.startBatch();
      })();
    };

    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !listeningRef.current) return;
      listeningRef.current = false;
      optsRef.current.onListeningChange(false);
      void (async () => {
        if (usingRealtimeRef.current) {
          // realtime: the transcript already streamed in; take the final.
          optsRef.current.onTranscribingChange(true);
          try {
            const text = await optsRef.current.stopRealtime();
            if (text) optsRef.current.submit(text);
            else optsRef.current.onVoiceError("Didn't catch that — try again.");
          } finally {
            optsRef.current.onTranscribingChange(false);
            optsRef.current.onLiveTranscriptReset();
          }
          return;
        }
        // batch fallback: stop recording, POST the clip, send the result.
        const clip = await optsRef.current.stopBatch();
        if (!clip) return;
        optsRef.current.onTranscribingChange(true);
        try {
          const { text } = await call(IPC.voice.transcribe, {
            audioBase64: clip.base64,
            mimeType: clip.mimeType,
          });
          if (text) optsRef.current.submit(text);
          else optsRef.current.onVoiceError("Didn't catch that — try again.");
        } catch (cause) {
          optsRef.current.onVoiceError(
            cause instanceof Error ? cause.message : 'Transcription failed.',
          );
        } finally {
          optsRef.current.onTranscribingChange(false);
        }
      })();
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
