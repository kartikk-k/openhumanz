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
  /** Returns the current OpenAI key and model from settings (read live). */
  getConfig: () => { apiKey: string; model: string };
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
  const { apiKey, model } = config.getConfig();
  if (!apiKey) {
    throw new Error(
      'No OpenAI API key set. Add one in Settings › Voice to use hold-to-talk.',
    );
  }

  const bytes = Buffer.from(request.audioBase64, 'base64');
  if (bytes.length === 0) return { text: '' };

  const mime = request.mimeType || 'audio/webm';
  const form = new FormData();
  const blob = new Blob([bytes], { type: mime });
  form.append('file', blob, filenameFor(mime));
  form.append('model', model || DEFAULT_MODEL);
  form.append('response_format', 'json');
  // Language is fixed to English regardless of request.language.
  form.append('language', 'en');

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
    throw new Error(message);
  }

  const data = (await response.json()) as { text?: string };
  return { text: (data.text ?? '').trim() };
}

export interface VoiceModule extends AppModule {
  /** Wire up how the module reads the current OpenAI key/model. */
  configure(config: VoiceConfig): void;
}

export function createVoiceModule(): VoiceModule {
  let config: VoiceConfig = {
    getConfig: () => ({ apiKey: '', model: DEFAULT_MODEL }),
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
