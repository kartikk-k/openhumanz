/**
 * useVoiceCapture — record the microphone for hold-to-talk, and expose a live
 * 0..1 level so the orb can react while you speak.
 *
 * Unlike {@link useMicLevel} (which only meters), this captures the actual audio.
 * Rather than a MediaRecorder Opus blob, we tap raw float PCM off the Web Audio
 * graph and run it through {@link processCapturedAudio} — AGC + noise gate +
 * silence trim — before encoding a clean 16 kHz mono WAV. The transcription model
 * is markedly more accurate on that engineered audio than on raw browser capture.
 * Call `start()` on key-down; `stop()` on key-up resolves with the processed clip
 * (base64 + mime) ready for transcription, or null if nothing usable was captured.
 * One getUserMedia stream powers both the PCM tap and the level meter, so it never
 * fights useMicLevel for the device.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { callOr } from '../../../lib/ipc';
import { IPC } from '../../../../shared/ipc';
import type { MicStatus } from './useMicLevel';
import { TARGET_SAMPLE_RATE, processCapturedAudio } from './audioPipeline';

export interface VoiceClip {
  base64: string;
  mimeType: string;
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
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    levelRef.current = 0;
    // Disconnect the PCM tap before closing the context so the graph tears down
    // cleanly, then drop the collected samples.
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    pcmChunksRef.current = [];
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
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

      // Hint mono at the pipeline's target rate. These are only hints — the
      // browser may ignore sampleRate — so the pipeline resamples from the
      // actual audioCtx.sampleRate regardless.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: TARGET_SAMPLE_RATE,
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
      // Boost quiet/distant speech before the level meter. ~3x; tune if it clips.
      const gain = audioCtx.createGain();
      gain.gain.value = 3;
      source.connect(gain);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      gain.connect(analyser);
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

      // PCM tap. We use a ScriptProcessorNode off the SAME source: it's
      // deprecated but universally supported and needs no separate worklet file
      // (an AudioWorklet would). Each onaudioprocess hands us channel-0 float
      // samples, which we copy into a growing chunk list for the pipeline.
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      pcmChunksRef.current = [];
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        // getChannelData returns a view into a reused buffer, so copy it.
        pcmChunksRef.current.push(new Float32Array(input));
      };
      // The processor only fires while connected to a destination. Route it
      // through a zero-gain node so nothing is ever audible.
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(audioCtx.destination);
      processorRef.current = processor;
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

  /** Stop recording and resolve with the processed clip (or null). */
  const stop = useCallback(async (): Promise<VoiceClip | null> => {
    const audioCtx = audioCtxRef.current;
    const chunks = pcmChunksRef.current;
    setStatus('inactive');
    if (!audioCtx || chunks.length === 0) {
      teardown();
      return null;
    }

    // Flatten every captured chunk into one contiguous Float32 buffer, then run
    // it through the pipeline at the context's ACTUAL rate (it resamples to
    // 16 kHz internally).
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const flat = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      flat.set(chunk, offset);
      offset += chunk.length;
    }

    const wav = processCapturedAudio(flat, audioCtx.sampleRate);
    if (!wav || wav.size === 0) {
      teardown();
      return null;
    }

    let clip: VoiceClip | null = null;
    try {
      const base64 = await blobToBase64(wav);
      clip = { base64, mimeType: 'audio/wav' };
    } catch {
      clip = null;
    }

    teardown();
    return clip;
  }, [teardown]);

  return { levelRef, status, start, stop };
}
