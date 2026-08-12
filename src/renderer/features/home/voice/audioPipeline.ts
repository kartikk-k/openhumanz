/**
 * audioPipeline — the pre-transcription audio engineering that makes dictation
 * accurate. Ported from Echotype Mac's native pipeline.
 *
 * The transcription model (gpt-4o-transcribe) is far more accurate on audio that
 * has been leveled, gated, and trimmed than on raw browser capture. So instead
 * of shipping the raw MediaRecorder Opus blob, we capture float PCM off the Web
 * Audio graph and run it through the same three stages Echotype uses, then encode
 * a clean 16 kHz mono PCM16 WAV for the API.
 *
 * Pipeline order (matches Echotype): capture → AudioEnhancer (AGC + noise gate)
 * → SilenceTrimmer (adaptive VAD) → WAV encode.
 *
 * Everything here operates on Float32 samples in [-1, 1] at a fixed frame size
 * of 20 ms, so the constants map 1:1 to Echotype's Int16 constants scaled by
 * 1/32767. Where Echotype uses an absolute Int16 value (e.g. speechAbsMin=300),
 * we divide by 32767 to get the float equivalent.
 */

/** Target output format for the API. Mono, 16 kHz, PCM16 — canonical + small. */
export const TARGET_SAMPLE_RATE = 16000;
/** 20 ms frames at the target rate: 16000 / 50 = 320 samples. */
const FRAME_MS = 20;

/* ------------------------------------------------------------------ */
/* Stage 1 — AudioEnhancer: boost-only AGC + soft noise gate           */
/* ------------------------------------------------------------------ */

/**
 * Streaming, stateful enhancer over 20 ms frames, applied in place.
 * - AGC normalizes speech toward 20% of full scale, boost-only (never
 *   attenuates speech), max 10x, with slow attack/release so it can't pump.
 * - Noise gate softly ducks (never mutes) frames below a tracked noise floor,
 *   so soft word onsets survive.
 *
 * Constants are Echotype's, converted from Int16 (÷32767) where absolute.
 */
class AudioEnhancer {
  // AGC
  private static readonly TARGET_LEVEL = 0.2; // 20% of full scale

  private static readonly MAX_GAIN = 10.0;

  private static readonly MIN_GAIN = 1.0; // boost-only

  private static readonly GAIN_ATTACK = 0.3;

  private static readonly GAIN_RELEASE = 0.05;

  private static readonly SPEECH_ABS_MIN = 300 / 32767; // ~0.00916

  private static readonly SPEECH_FLOOR_MARGIN = 2.5;

  // Noise gate
  private static readonly GATE_THRESHOLD = 1.8;

  private static readonly GATE_FLOOR_GAIN = 0.5; // -6 dB, never full mute

  private static readonly NOISE_FLOOR_MIN = 40 / 32767; // ~0.00122

  private static readonly NOISE_FLOOR_INIT = 150 / 32767; // ~0.00458

  private currentGain = 1.0;

  private speechEnvelope = 0;

  private noiseFloor = AudioEnhancer.NOISE_FLOOR_INIT;

  /** Process one buffer in place, frame by frame. */
  process(samples: Float32Array, frameSize: number): void {
    for (let start = 0; start < samples.length; start += frameSize) {
      const end = Math.min(start + frameSize, samples.length);
      const rms = frameRms(samples, start, end);

      // Noise floor via minimum-follower: falls fast toward quieter frames,
      // rises very slowly. Clamped so it never collapses to zero.
      if (rms < this.noiseFloor) {
        this.noiseFloor = 0.85 * this.noiseFloor + 0.15 * rms;
      } else {
        this.noiseFloor = 0.999 * this.noiseFloor + 0.001 * rms;
      }
      if (this.noiseFloor < AudioEnhancer.NOISE_FLOOR_MIN) {
        this.noiseFloor = AudioEnhancer.NOISE_FLOOR_MIN;
      }

      const isSpeech =
        rms > AudioEnhancer.SPEECH_ABS_MIN &&
        rms > this.noiseFloor * AudioEnhancer.SPEECH_FLOOR_MARGIN;

      // AGC: only chase gain toward target during speech; hold otherwise so we
      // don't crank up silence.
      let desiredGain = this.currentGain;
      if (isSpeech) {
        this.speechEnvelope =
          this.speechEnvelope === 0
            ? rms
            : 0.8 * this.speechEnvelope + 0.2 * rms;
        const raw =
          this.speechEnvelope > 0
            ? AudioEnhancer.TARGET_LEVEL / this.speechEnvelope
            : AudioEnhancer.MIN_GAIN;
        desiredGain = clamp(
          raw,
          AudioEnhancer.MIN_GAIN,
          AudioEnhancer.MAX_GAIN,
        );
      }
      const smooth =
        desiredGain > this.currentGain
          ? AudioEnhancer.GAIN_ATTACK
          : AudioEnhancer.GAIN_RELEASE;
      this.currentGain += (desiredGain - this.currentGain) * smooth;

      // Noise gate: soft duck for frames below the floor.
      const gateGain =
        rms < this.noiseFloor * AudioEnhancer.GATE_THRESHOLD
          ? AudioEnhancer.GATE_FLOOR_GAIN
          : 1.0;

      const g = this.currentGain * gateGain;
      for (let i = start; i < end; i += 1) {
        samples[i] = clamp(samples[i] * g, -1, 1);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Stage 2 — SilenceTrimmer: adaptive VAD, terrified of clipping words */
/* ------------------------------------------------------------------ */

const MAX_PAUSE_SECONDS = 0.8; // only pauses longer than this get collapsed
const KEPT_PAUSE_SECONDS = 0.2; // retained slice of a collapsed pause
const MAX_TRIM_FRACTION = 0.6; // abort trim if it would remove >60%

/**
 * Collapse long internal/edge pauses using a per-recording relative threshold.
 * Thresholds are derived from THIS recording's own dynamic range (percentiles),
 * and the whole trim is discarded if it would remove too much — so it can never
 * eat quiet speech or make a recording worse.
 */
function trimSilence(samples: Float32Array, sampleRate: number): Float32Array {
  const frameSize = Math.max(1, Math.floor(sampleRate / 50)); // 20 ms
  const frameCount = Math.floor(samples.length / frameSize);
  if (frameCount <= 4) return samples;

  const rms: number[] = new Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const s = f * frameSize;
    rms[f] = frameRms(samples, s, s + frameSize);
  }

  const sorted = [...rms].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.1); // noise floor
  const speechLevel = percentile(sorted, 0.95); // robust "loud" level

  // No usable dynamic range → nothing to trim.
  if (speechLevel <= floor * 2.5 || speechLevel <= 1.0 / 32767) return samples;

  // Anchored to the noise floor, capped 35% toward speech so it can't eat
  // quiet speech.
  const threshold = Math.min(
    Math.max(floor * 2.2, floor + 40 / 32767),
    floor + (speechLevel - floor) * 0.35,
  );

  const maxPauseFrames = Math.round(
    (MAX_PAUSE_SECONDS * sampleRate) / frameSize,
  );
  const keptPauseFrames = Math.round(
    (KEPT_PAUSE_SECONDS * sampleRate) / frameSize,
  );

  // Mark voiced frames, then walk runs of silence and keep only a padded slice
  // of any run longer than maxPauseFrames. Edge silence keeps half the padding.
  const voiced = rms.map((r) => r > threshold);
  const keep = new Array<boolean>(frameCount).fill(true);

  let f = 0;
  while (f < frameCount) {
    if (voiced[f]) {
      f += 1;
      continue;
    }
    let runEnd = f;
    while (runEnd < frameCount && !voiced[runEnd]) runEnd += 1;
    const runLen = runEnd - f;
    if (runLen > maxPauseFrames) {
      const atEdge = f === 0 || runEnd === frameCount;
      const pad = atEdge ? Math.floor(keptPauseFrames / 2) : keptPauseFrames;
      // Keep `pad` frames at each side of the pause (clamped to the run).
      const keepHead = f === 0 ? 0 : Math.min(pad, runLen);
      const keepTail = runEnd === frameCount ? 0 : Math.min(pad, runLen);
      for (let k = f + keepHead; k < runEnd - keepTail; k += 1) keep[k] = false;
    }
    f = runEnd;
  }

  // Rebuild the sample buffer from kept frames, preserving the trailing
  // sub-frame remainder (< 20 ms) that fell outside frameCount.
  const kept: number[] = [];
  let keptFrames = 0;
  for (let i = 0; i < frameCount; i += 1) {
    if (keep[i]) {
      kept.push(i);
      keptFrames += 1;
    }
  }
  const remainder = samples.length - frameCount * frameSize;
  const outLen = keptFrames * frameSize + remainder;

  // Safety valve: if we'd remove >60% of audio, assume the VAD misfired and
  // return the original untouched.
  if (outLen === 0 || outLen < samples.length * (1 - MAX_TRIM_FRACTION)) {
    return samples;
  }

  const out = new Float32Array(outLen);
  let w = 0;
  for (const frame of kept) {
    const s = frame * frameSize;
    out.set(samples.subarray(s, s + frameSize), w);
    w += frameSize;
  }
  if (remainder > 0) {
    out.set(samples.subarray(frameCount * frameSize), w);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stage 3 — WAV encode: 16 kHz mono PCM16                             */
/* ------------------------------------------------------------------ */

/** Encode Float32 [-1,1] samples as a canonical 16-bit PCM WAV blob. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate = rate * blockAlign
  view.setUint16(32, 2, true); // blockAlign = channels * 16/8
  view.setUint16(34, 16, true); // bitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = clamp(samples[i], -1, 1);
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run captured mono Float32 PCM (at `inputSampleRate`) through the full
 * pipeline and return a clean 16 kHz mono PCM16 WAV, or null if there's nothing
 * usable to send.
 */
export function processCapturedAudio(
  input: Float32Array,
  inputSampleRate: number,
): Blob | null {
  if (input.length === 0) return null;

  // Resample to the fixed target rate first, so every downstream constant
  // (frame size, pause lengths) is rate-consistent.
  const resampled =
    inputSampleRate === TARGET_SAMPLE_RATE
      ? input
      : resampleLinear(input, inputSampleRate, TARGET_SAMPLE_RATE);

  const frameSize = Math.floor((TARGET_SAMPLE_RATE * FRAME_MS) / 1000); // 320

  const enhancer = new AudioEnhancer();
  enhancer.process(resampled, frameSize);

  const trimmed = trimSilence(resampled, TARGET_SAMPLE_RATE);
  if (trimmed.length === 0) return null;

  return encodeWav(trimmed, TARGET_SAMPLE_RATE);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function frameRms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  const n = end - start;
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/** `sorted` must be ascending. p in [0,1]. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Simple linear-interpolation resampler (mono). Good enough for speech STT. */
function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
