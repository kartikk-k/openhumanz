/**
 * useRealtimeVoice — hold-to-talk with LIVE transcription.
 *
 * On `start()` it opens a realtime session in main (which holds the WebSocket to
 * OpenAI), then captures the mic, downsamples to 24kHz mono PCM16, and streams
 * the audio to main in small chunks. Partial transcripts arrive on the
 * `push:voice-transcript` channel and are exposed via `transcriptRef` +
 * `onTranscript` so the UI can stream them into the question text as you speak.
 *
 * `stop()` closes the session and resolves with the final transcript.
 *
 * If the realtime session can't open (no key, WS error), `start()` returns
 * `{ realtime: false }` and the caller should fall back to batch recording.
 *
 * Also exposes `levelRef` (0..1) so the orb reacts to your voice, same as
 * useVoiceCapture.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, callOr, subscribe } from '../../../lib/ipc';
import { IPC } from '../../../../shared/ipc';
import type { MicStatus } from './useMicLevel';

const TARGET_RATE = 24000; // OpenAI Realtime expects 24kHz PCM16

/** Downsample a Float32 mono buffer to `TARGET_RATE` and encode as PCM16. */
function encodePcm16(input: Float32Array, inputRate: number): string {
  // linear-resample to TARGET_RATE
  let samples: Float32Array;
  if (inputRate === TARGET_RATE) {
    samples = input;
  } else {
    const ratio = inputRate / TARGET_RATE;
    const outLen = Math.floor(input.length / ratio);
    samples = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      samples[i] = input[Math.floor(i * ratio)];
    }
  }
  // Float32 [-1,1] -> Int16LE
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  // Int16Array -> base64
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function useRealtimeVoice(onTranscript: (text: string) => void) {
  const levelRef = useRef<number | null>(0);
  const [status, setStatus] = useState<MicStatus>('inactive');

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const rafRef = useRef(0);
  const unsubRef = useRef<(() => void) | null>(null);
  const finalRef = useRef('');
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    levelRef.current = 0;
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  /** Open the realtime session + mic. Returns whether realtime is live. */
  const start = useCallback(async (): Promise<{ realtime: boolean }> => {
    setStatus('requesting');
    finalRef.current = '';
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException('unsupported', 'NotSupportedError');
      }
      const perm = await callOr(
        IPC.system.requestMic,
        {},
        { status: 'unknown' },
      );
      if (perm.status === 'denied' || perm.status === 'restricted') {
        setStatus('denied');
        return { realtime: false };
      }

      // ask main to open the OpenAI realtime socket
      const session = await call(IPC.voice.realtimeStart, {});
      if (!session.ok) {
        // realtime unavailable (no key / ws error) — caller falls back to batch
        return { realtime: false };
      }

      // subscribe to live transcripts pushed from main
      unsubRef.current = subscribe('push:voice-transcript', (payload) => {
        if (payload.final) finalRef.current = payload.text;
        onTranscriptRef.current(payload.text);
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const audioCtx = new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      )();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      // Boost quiet/distant speech before analysis + streaming to OpenAI.
      // ~3x; tune if it clips.
      const gain = audioCtx.createGain();
      gain.gain.value = 3;
      source.connect(gain);

      // ScriptProcessor captures raw PCM frames we can encode + stream.
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      let smoothed = 0;
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        // level meter
        let sum = 0;
        for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const norm = Math.min(1, rms * 3.5);
        const rate = norm > smoothed ? 0.5 : 0.15;
        smoothed += (norm - smoothed) * rate;
        levelRef.current = smoothed;
        // stream audio to main
        const audioBase64 = encodePcm16(input, audioCtx.sampleRate);
        void call(IPC.voice.realtimeAppend, { audioBase64 }).catch(() => {});
      };
      gain.connect(processor);
      // ScriptProcessor needs a sink to run in some browsers; a muted gain works.
      const sink = audioCtx.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(audioCtx.destination);

      setStatus('listening');
      return { realtime: true };
    } catch (err) {
      teardown();
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus('nodevice');
      } else {
        setStatus('error');
      }
      // eslint-disable-next-line no-console
      console.warn('[useRealtimeVoice] failed:', err);
      return { realtime: false };
    }
  }, [teardown]);

  /** Stop the session and resolve with the final transcript. */
  const stop = useCallback(async (): Promise<string> => {
    setStatus('inactive');
    // stop streaming audio first
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    // ask main to close + flush the final transcript
    const reply = await callOr(IPC.voice.realtimeStop, {}, { ok: true });
    void reply;
    // give the final push a beat to land
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });
    teardown();
    return finalRef.current.trim();
  }, [teardown]);

  return { levelRef, status, start, stop };
}
