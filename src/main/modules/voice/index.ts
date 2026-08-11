/**
 * The `voice` module.
 *
 * Speech-to-text for hold-to-talk. Two paths, both keyed by the user's own
 * OpenAI key (from settings.json, read live):
 *
 *  - **Realtime** (`voice:realtime-*`): main holds ONE WebSocket to OpenAI's
 *    Realtime transcription API. The renderer streams PCM16 audio chunks; main
 *    forwards them and pushes partial + final transcripts back on the app event
 *    `voice:transcript` (bridged to `push:voice-transcript`). The key never
 *    leaves main. This is the live path — words appear as you speak.
 *  - **Batch** (`voice:transcribe`): record the whole clip, POST it to
 *    /v1/audio/transcriptions. Used as a fallback when realtime is unavailable.
 *
 * Uses `ws` for the WebSocket and global `fetch`/`FormData` for the batch POST.
 */
import WebSocket from 'ws';
import type { AppModule, IpcHandlerMap, ModuleContext } from '../types';
import type {
  VoiceTranscribeRequest,
  VoiceTranscribeResult,
  VoiceRealtimeStartResult,
  VoiceRealtimeAppend,
} from '../../../shared/ipc';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_REALTIME_URL =
  'wss://api.openai.com/v1/realtime?intent=transcription';
const DEFAULT_MODEL = 'gpt-4o-transcribe';
// OpenAI Realtime expects 24kHz mono PCM16.
const REALTIME_SAMPLE_RATE = 24000;

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
  if (request.language) form.append('language', request.language);

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

/* ------------------------------------------------------------------ */
/* Realtime transcription (WebSocket proxy)                            */
/* ------------------------------------------------------------------ */

/**
 * Holds the single live realtime session. Only one recording happens at a time
 * (hold-to-talk), so a module-level singleton is enough.
 */
class RealtimeSession {
  private ws: WebSocket | null = null;

  /** Accumulated finalized text across completed segments this session. */
  private committed = '';

  private readonly apiKey: string;

  private readonly model: string;

  private readonly onTranscript: (text: string, final: boolean) => void;

  private readonly logger?: ModuleContext['logger'];

  constructor(
    apiKey: string,
    model: string,
    onTranscript: (text: string, final: boolean) => void,
    logger?: ModuleContext['logger'],
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.onTranscript = onTranscript;
    this.logger = logger;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });
      this.ws = ws;

      ws.on('open', () => {
        // Configure the transcription session: model + server-side VAD so
        // segments finalize automatically as the user pauses.
        ws.send(
          JSON.stringify({
            type: 'transcription_session.update',
            session: {
              input_audio_format: 'pcm16',
              input_audio_transcription: { model: this.model },
              turn_detection: { type: 'server_vad' },
            },
          }),
        );
        resolve();
      });

      ws.on('message', (data) => this.handleMessage(data.toString()));
      ws.on('unexpected-response', (_req, res) => {
        // HTTP-level rejection (bad URL, auth, headers) — the body says why.
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          this.logger?.warn('realtime ws unexpected-response', {
            status: res.statusCode,
            body: Buffer.concat(chunks).toString().slice(0, 500),
          });
        });
      });
      ws.on('error', (err) => {
        this.logger?.warn('realtime ws error', {
          error: err instanceof Error ? err.message : String(err),
        });
        reject(err);
      });
      ws.on('close', (code, reason) => {
        this.logger?.warn('realtime ws closed', {
          code,
          reason: reason?.toString().slice(0, 300),
        });
        this.ws = null;
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: {
      type?: string;
      delta?: string;
      transcript?: string;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Temporary: surface every event type + any error so we can see the real
    // realtime protocol shape in the terminal log.
    this.logger?.info('realtime event', {
      type: msg.type,
      error: msg.error?.message,
    });
    switch (msg.type) {
      case 'conversation.item.input_audio_transcription.delta':
        // Partial: show committed segments + the in-progress delta.
        if (typeof msg.delta === 'string') {
          this.onTranscript(`${this.committed}${msg.delta}`.trimStart(), false);
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof msg.transcript === 'string') {
          this.committed = `${this.committed}${msg.transcript} `;
          this.onTranscript(this.committed.trim(), false);
        }
        break;
      default:
        break;
    }
  }

  append(audioBase64: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: audioBase64,
      }),
    );
  }

  /** Close the socket and return the full committed transcript. */
  close(): string {
    const text = this.committed.trim();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    return text;
  }
}

export interface VoiceModule extends AppModule {
  /** Wire up how the module reads the current OpenAI key/model. */
  configure(config: VoiceConfig): void;
}

export function createVoiceModule(): VoiceModule {
  let config: VoiceConfig = {
    getConfig: () => ({ apiKey: '', model: DEFAULT_MODEL }),
  };
  let events: ModuleContext['events'] | null = null;
  let logger: ModuleContext['logger'] | undefined;
  let session: RealtimeSession | null = null;

  const ipc: IpcHandlerMap = {
    'voice:transcribe': async (request) => transcribe(request, config),

    'voice:realtime-start': async (): Promise<VoiceRealtimeStartResult> => {
      const { apiKey, model } = config.getConfig();
      if (!apiKey) {
        return {
          ok: false,
          audioFormat: 'pcm16',
          sampleRate: REALTIME_SAMPLE_RATE,
          error: 'No OpenAI API key set. Add one in Settings › Voice.',
        };
      }
      // tear down any stale session first
      if (session) session.close();
      session = new RealtimeSession(
        apiKey,
        model || DEFAULT_MODEL,
        (text, final) => events?.emit('voice:transcript', { text, final }),
        logger,
      );
      try {
        await session.open();
        return {
          ok: true,
          audioFormat: 'pcm16',
          sampleRate: REALTIME_SAMPLE_RATE,
        };
      } catch (err) {
        session = null;
        return {
          ok: false,
          audioFormat: 'pcm16',
          sampleRate: REALTIME_SAMPLE_RATE,
          error: err instanceof Error ? err.message : 'Realtime unavailable.',
        };
      }
    },

    'voice:realtime-append': async (request: VoiceRealtimeAppend) => {
      session?.append(request.audioBase64);
      return { ok: true as const };
    },

    'voice:realtime-stop': async () => {
      if (session) {
        const text = session.close();
        session = null;
        // one last final push so the renderer has the settled transcript
        events?.emit('voice:transcript', { text, final: true });
      }
      return { ok: true as const };
    },
  };

  return {
    id: 'voice',
    migrations: [],
    ipc,
    start(ctx: ModuleContext) {
      events = ctx.events;
      logger = ctx.logger;
    },
    stop() {
      if (session) {
        session.close();
        session = null;
      }
    },
    configure(next) {
      config = next;
    },
  };
}

export default createVoiceModule;
