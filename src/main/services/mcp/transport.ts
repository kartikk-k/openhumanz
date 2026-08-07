/**
 * MCP `Transport` over an already-connected unix domain socket.
 *
 * Framing is the SDK's own: newline-delimited JSON, no Content-Length headers.
 * `ReadBuffer` and `serializeMessage` are imported from `shared/stdio.js`
 * rather than reimplemented, because a framing bug here is a security bug —
 * a desynchronised parser is how you smuggle a second request inside a first.
 *
 * Contract points that are easy to get wrong (see docs/API-NOTES.md §2a):
 *  - `start()` is called by `connect()` *after* the callbacks are installed.
 *    Never call it yourself; messages delivered before `onmessage` exists are
 *    silently dropped.
 *  - `close()` must fire `onclose?.()` even when called explicitly.
 *  - `onerror` is out-of-band and non-fatal. Socket errors go there.
 */
import type { Socket } from 'node:net';
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface UnixSocketTransportOptions {
  /**
   * Bytes already read off the socket that belong to the MCP stream — the tail
   * of the chunk that carried the handshake line. Without this, a client that
   * pipelines its first request behind the handshake loses it.
   */
  initialData?: Buffer;
  /** Cap on a single unparsed message. Defaults to the SDK's 10 MiB. */
  maxBufferSize?: number;
  /** Close the socket when the transport closes. Default true. */
  destroyOnClose?: boolean;
}

export class UnixSocketTransport implements Transport {
  private readonly socket: Socket;

  private readonly readBuffer: ReadBuffer;

  private readonly initialData?: Buffer;

  private readonly destroyOnClose: boolean;

  private started = false;

  private closed = false;

  onclose?: () => void;

  onerror?: (error: Error) => void;

  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: Socket, options: UnixSocketTransportOptions = {}) {
    this.socket = socket;
    this.readBuffer = new ReadBuffer(
      options.maxBufferSize === undefined
        ? undefined
        : { maxBufferSize: options.maxBufferSize },
    );
    this.initialData = options.initialData;
    this.destroyOnClose = options.destroyOnClose ?? true;
  }

  private handleData = (chunk: Buffer): void => {
    this.readBuffer.append(chunk);
    this.drain();
  };

  private handleError = (error: Error): void => {
    this.onerror?.(error);
  };

  private handleClose = (): void => {
    this.fireClose();
  };

  private drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (cause) {
        // A malformed frame desynchronises the stream; report and stop reading
        // this batch rather than looping on the same bad bytes.
        this.onerror?.(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
        return;
      }
      if (!message) return;
      this.onmessage?.(message);
    }
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.readBuffer.clear();
    this.socket.off('data', this.handleData);
    this.socket.off('error', this.handleError);
    this.socket.off('close', this.handleClose);
    this.onclose?.();
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('UnixSocketTransport already started');
    }
    this.started = true;

    this.socket.on('data', this.handleData);
    this.socket.on('error', this.handleError);
    this.socket.on('close', this.handleClose);

    if (this.initialData && this.initialData.length > 0) {
      this.readBuffer.append(this.initialData);
      this.drain();
    }
  }

  async send(
    message: JSONRPCMessage,
    // Resumption tokens are an HTTP/SSE concern; a unix socket either has the
    // stream or does not. Accepted and ignored, per the Transport contract.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed || this.socket.destroyed) {
      throw new Error('UnixSocketTransport is closed');
    }
    return new Promise((resolve, reject) => {
      this.socket.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    const wasClosed = this.closed;
    this.fireClose();
    if (!wasClosed && this.destroyOnClose) {
      this.socket.end();
      // The peer may never reply to the FIN; do not leave a half-open socket
      // holding the event loop open at quit.
      this.socket.destroy();
    }
  }
}
