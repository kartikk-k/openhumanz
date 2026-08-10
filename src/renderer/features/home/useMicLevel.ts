/**
 * useMicLevel — capture the microphone and expose a live 0..1 volume level.
 *
 * While `active` is true it opens the mic (getUserMedia), runs a Web Audio
 * analyser, and updates the returned ref every animation frame with a smoothed
 * RMS level normalized to roughly 0..1. When `active` flips false it tears the
 * mic + audio graph down and resets the level to 0.
 *
 * Returns { levelRef, status } — levelRef is a ref (read it in your own rAF
 * loop without re-renders); status is React state so the UI can show feedback
 * (e.g. "microphone access denied").
 */
import { useEffect, useRef, useState } from 'react';
import { callOr } from '../../lib/ipc';
import { IPC } from '../../../shared/ipc';

export type MicStatus =
  | 'inactive' // not listening
  | 'requesting' // asking for permission / opening the device
  | 'listening' // live
  | 'denied' // permission refused
  | 'nodevice' // no microphone found
  | 'error'; // anything else

export function useMicLevel(active: boolean) {
  const levelRef = useRef<number | null>(0);
  const [status, setStatus] = useState<MicStatus>('inactive');

  useEffect(() => {
    if (!active) {
      levelRef.current = 0;
      setStatus('inactive');
      return undefined;
    }

    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;

    setStatus('requesting');

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new DOMException('unsupported', 'NotSupportedError');
        }
        // First ask the main process to ensure OS-level mic access. On macOS
        // this fires the native prompt (and registers the app in the privacy
        // list) when the status is still not-determined. If the OS reports a
        // hard "denied", surface it without attempting getUserMedia (which would
        // just fail with a generic error).
        const perm = await callOr(
          IPC.system.requestMic,
          {},
          { status: 'unknown' },
        );
        if (cancelled) return;
        if (perm.status === 'denied' || perm.status === 'restricted') {
          setStatus('denied');
          levelRef.current = 0;
          return;
        }

        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        audioCtx = new (
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext
        )();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);

        const buf = new Uint8Array(analyser.fftSize);
        let smoothed = 0;
        setStatus('listening');

        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          // RMS around the 128 midpoint
          let sum = 0;
          for (let i = 0; i < buf.length; i += 1) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length); // ~0..1 (usually < 0.3 for speech)
          // normalize & shape: quiet speech should still read clearly
          const norm = Math.min(1, rms * 3.5);
          // attack fast, release slower so the orb feels responsive but not jittery
          const rate = norm > smoothed ? 0.5 : 0.15;
          smoothed += (norm - smoothed) * rate;
          levelRef.current = smoothed;
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        levelRef.current = 0;
        const name = (err as DOMException)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('denied');
        } else if (
          name === 'NotFoundError' ||
          name === 'OverconstrainedError'
        ) {
          setStatus('nodevice');
        } else {
          setStatus('error');
        }
        console.warn('[useMicLevel] mic unavailable:', err);
      }
    };

    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      levelRef.current = 0;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (audioCtx) audioCtx.close().catch(() => {});
    };
  }, [active]);

  return { levelRef, status };
}
