/**
 * Tokens, ids and constant-time comparison.
 *
 * `node:crypto` only — ARCHITECTURE.md says reach for platform capabilities
 * before adding a dependency, and this is the clearest case of it.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/** Default entropy for {@link randomToken}. 32 bytes = 256 bits. */
export const TOKEN_BYTES = 32;

/**
 * A URL-safe random token. Used for the per-launch MCP token, which is
 * regenerated on every start and never logged.
 */
export function randomToken(bytes: number = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function uuid(): string {
  return randomUUID();
}

/**
 * An opaque identifier, optionally prefixed for readability in logs and in the
 * runs directory (`run_k3f9…`). Time-ordered prefix so ids sort roughly by
 * creation, which makes `ls runs/` useful.
 */
export function randomId(prefix?: string): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(8).toString('hex');
  const id = `${time}${rand}`;
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which would leak
 * length through an exception, so both sides are hashed to a fixed width first.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Hex sha256 of a string or byte array. */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/** Short sha256 prefix, for content hashes where 16 hex chars is plenty. */
export function shortHash(input: string | Uint8Array, length = 16): string {
  return sha256(input).slice(0, length);
}

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` dropped.
 * Two structurally equal values always stringify identically, which is what
 * makes an approval fingerprint stable across runs.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return typeof input === 'undefined' ? null : input;
    }
    if (seen.has(input as object)) return '[circular]';
    seen.add(input as object);

    if (Array.isArray(input)) return input.map(walk);

    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = walk(source[key]);
    }
    return out;
  };

  return JSON.stringify(walk(value));
}

/**
 * Stable hash of (tool name, arguments). The approval gate matches standing
 * grants on this, so it must not change when key order changes.
 */
export function fingerprint(toolName: string, args: unknown): string {
  return shortHash(stableStringify([toolName, args]), 32);
}
