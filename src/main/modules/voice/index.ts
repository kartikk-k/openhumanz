/**
 * The `voice` module.
 *
 * Speech-to-text for hold-to-talk, keyed by the user's own OpenAI key (from
 * settings.json, read live):
 *
 *  - **Batch** (`voice:transcribe`): record the whole clip, POST it to
 *    /v1/audio/transcriptions.
 *
 * Uses global `fetch`/`FormData` for the batch POST.
 */
import type { AppModule, IpcHandlerMap } from '../types';
import type {
  VoiceTranscribeRequest,
  VoiceTranscribeResult,
} from '../../../shared/ipc';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'gpt-4o-transcribe';

interface VoiceConfig {
  /** Returns the current OpenAI key/model plus language/prompt from settings (read live). */
  getConfig: () => {
    apiKey: string;
    model: string;
    language: string;
    prompt: string;
  };
}

/** How many attempts a transient failure gets before we give up. */
const MAX_ATTEMPTS = 3;

/**
 * A permanent HTTP failure (4xx other than 429): retrying will not help, so the
 * retry loop rethrows it immediately. Everything else — network/fetch throws,
 * 429, 5xx — is treated as transient and retried with backoff.
 */
class PermanentError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ------------------------------------------------------------------ */
/* Batch transcription                                                 */
/* ------------------------------------------------------------------ */

function filenameFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'audio.webm';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'audio.mp4';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'audio.mp3';
  if (mimeType.includes('wav')) return 'audio.wav';
  if (mimeType.includes('ogg')) return 'audio.ogg';
  return 'audio.webm';
}

async function transcribe(
  request: VoiceTranscribeRequest,
  config: VoiceConfig,
): Promise<VoiceTranscribeResult> {
  const { apiKey, model, language, prompt } = config.getConfig();
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key set. Add one in Settings › Voice to use hold-to-talk.',
    );
  }

  const bytes = Buffer.from(request.audioBase64, 'base64');
  if (bytes.length === 0) return { text: '' };

  const mime = request.mimeType || 'audio/webm';
  // Per-call request wins; fall back to the configured settings values.
  const effectiveLanguage = request.language || language;
  const effectivePrompt = request.prompt || prompt;

  // One POST to OpenAI. Rebuilt per attempt because FormData/Blob are single-use.
  async function attempt(): Promise<VoiceTranscribeResult> {
    const form = new FormData();
    const blob = new Blob([bytes], { type: mime });
    form.append('file', blob, filenameFor(mime));
    form.append('model', model || DEFAULT_MODEL);
    form.append('response_format', 'json');
    // Only pin a language when we have one; empty lets the model auto-detect.
    if (effectiveLanguage) form.append('language', effectiveLanguage);
    // Optional prompt biases the model's vocabulary/spelling.
    if (effectivePrompt) form.append('prompt', effectivePrompt);

    const response = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = `OpenAI transcription failed (${response.status})`;
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        if (detail) message = `${message}: ${detail.slice(0, 200)}`;
      }
      // 429 and 5xx are worth retrying; other 4xx are permanent, so mark them.
      if (response.status !== 429 && response.status < 500) {
        throw new PermanentError(message);
      }
      throw new Error(message);
    }

    const data = (await response.json()) as { text?: string };
    return { text: (data.text ?? '').trim() };
  }

  // Retry transient failures (network throws, 429, 5xx) with a growing backoff.
  let lastError: unknown;
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await attempt();
    } catch (error) {
      lastError = error;
      // Permanent HTTP errors (4xx other than 429) never get a retry.
      if (error instanceof PermanentError) throw error;
      // eslint-disable-next-line no-await-in-loop
      if (n < MAX_ATTEMPTS) await sleep(n * 1500 + 1000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('OpenAI transcription failed');
}

export interface VoiceModule extends AppModule {
  /** Wire up how the module reads the current OpenAI key/model. */
  configure(config: VoiceConfig): void;
}

export function createVoiceModule(): VoiceModule {
  let config: VoiceConfig = {
    getConfig: () => ({
      apiKey: '',
      model: DEFAULT_MODEL,
      language: '',
      prompt: '',
    }),
  };

  const ipc: IpcHandlerMap = {
    'voice:transcribe': async (request) => transcribe(request, config),
  };

  return {
    id: 'voice',
    migrations: [],
    ipc,
    configure(next) {
      config = next;
    },
  };
}

export default createVoiceModule;
