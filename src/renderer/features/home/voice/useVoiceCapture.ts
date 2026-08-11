/**
 * useVoiceCapture — record the microphone for hold-to-talk, and expose a live
 * 0..1 level so the orb can react while you speak.
 *
 * Unlike {@link useMicLevel} (which only meters), this owns a MediaRecorder so
 * we get the actual audio bytes. Call `start()` on key-down; `stop()` on key-up
 * resolves with the recorded clip (base64 + mime) ready for transcription, or
 * null if nothing usable was captured. One getUserMedia stream powers both the
 * recorder and the level meter, so it never fights useMicLevel for the device.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { callOr } from '../../../lib/ipc';
import { IPC } from '../../../../shared/ipc';
import type { MicStatus } from './useMicLevel';

export interface VoiceClip {
  base64: string;
  mimeType: string;
}

/** Pick a mime type the browser can record AND OpenAI accepts. */
function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported(type)
    ) {
      return type;
    }
  }
  return '';
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function useVoiceCapture() {
  const levelRef = useRef<number | null>(0);
  const [status, setStatus] = useState<MicStatus>('inactive');

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    levelRef.current = 0;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    setStatus('requesting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException('unsupported', 'NotSupportedError');
      }
      // Ensure OS mic access first (fires the native prompt on macOS when the
      // status is not-determined), same as useMicLevel.
      const perm = await callOr(
        IPC.system.requestMic,
        {},
        { status: 'unknown' },
      );
      if (perm.status === 'denied' || perm.status === 'restricted') {
        setStatus('denied');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // level meter for the orb
      const audioCtx = new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      )();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let smoothed = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const norm = Math.min(1, rms * 3.5);
        const rate = norm > smoothed ? 0.5 : 0.15;
        smoothed += (norm - smoothed) * rate;
        levelRef.current = smoothed;
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      // recorder
      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      setStatus('listening');
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
      console.warn('[useVoiceCapture] mic unavailable:', err);
    }
  }, [teardown]);

  /** Stop recording and resolve with the captured clip (or null). */
  const stop = useCallback(async (): Promise<VoiceClip | null> => {
    const recorder = recorderRef.current;
    setStatus('inactive');
    if (!recorder || recorder.state === 'inactive') {
      teardown();
      return null;
    }

    const clip = await new Promise<VoiceClip | null>((resolve) => {
      recorder.onstop = async () => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) {
          resolve(null);
          return;
        }
        try {
          const base64 = await blobToBase64(blob);
          resolve({ base64, mimeType: type });
        } catch {
          resolve(null);
        }
      };
      recorder.stop();
    });

    teardown();
    return clip;
  }, [teardown]);

  return { levelRef, status, start, stop };
}
