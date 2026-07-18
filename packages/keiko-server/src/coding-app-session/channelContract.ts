// Wire shapes for the authenticated local app-session channel (ADR-0141).
//
// These are the shapes the channel serves over the authenticated transport: a bounded content item
// (prompts, model output, plan, tool activity in later waves) and the fail-closed snapshot. They are
// held server-internal in this wave (W1.4) and promoted to `keiko-contracts` alongside the browser
// client in W1.5, so the single contracts measured-surface change is batched there (the issue's D12
// guidance) rather than forcing a standalone perf-evidence regeneration here. Nothing consumes them
// across the package boundary yet. The bearer is an HttpOnly cookie and is never represented here.

/** Contract version for the authenticated app-session channel wire shapes (ADR-0141). */
export const CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION = "1" as const;

/** Maximum characters for a bounded content item's `kind` label. */
export const CODING_APP_SESSION_CHANNEL_KIND_MAX_CHARS = 64;
/** Maximum characters for a bounded content item's untrusted `body`. Mirrors the question budget. */
export const CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS = 4_096;
/** Aggregate UTF-8 byte ceiling for a serialized channel snapshot. Mirrors the question budget. */
export const CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES = 64 * 1_024;

/**
 * One bounded content item served over the authenticated channel to a paired session. `body` is
 * untrusted runtime text for transient browser rendering only; it reuses the runtime-question
 * bounding discipline (bounded, non-empty, aggregate-capped).
 */
export interface CodingAppSessionChannelContent {
  readonly kind: string;
  /** Untrusted runtime text for transient browser rendering only. */
  readonly body: string;
}

/**
 * The authenticated channel snapshot. Fail-closed (ADR-0141 D6): an unpaired caller receives the
 * same `content: null` shape a paired caller with no available content receives, so the response
 * never reveals whether a session or protected content exists.
 */
export interface CodingAppSessionChannelSnapshot {
  readonly schemaVersion: typeof CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION;
  readonly content: CodingAppSessionChannelContent | null;
}

/**
 * The content-free acknowledgement returned by pairing and session-lifecycle endpoints. It never
 * carries bearer material; the session, when issued, is delivered only as an `HttpOnly` cookie.
 */
export interface CodingAppSessionAcknowledgement {
  readonly schemaVersion: typeof CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION;
}

export type ChannelValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The single source of the fail-closed content-free snapshot shape (ADR-0141 D6). */
export function contentFreeCodingAppSessionChannelSnapshot(): CodingAppSessionChannelSnapshot {
  return { schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION, content: null };
}

/** The content-free acknowledgement shape returned by pairing and lifecycle endpoints. */
export function codingAppSessionAcknowledgement(): CodingAppSessionAcknowledgement {
  return { schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpectedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  return Object.keys(value)
    .filter((key): boolean => !allowed.includes(key))
    .map((key): string => `${path}.${key} is not allowed`);
}

function checkBoundedText(value: unknown, path: string, max: number, errors: string[]): void {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    errors.push(`${path} must be a bounded non-empty string`);
  }
}

function serializedUtf8Bytes(value: object): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function checkChannelContent(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object or null`);
    return;
  }
  errors.push(...unexpectedKeys(value, ["kind", "body"], path));
  checkBoundedText(value.kind, `${path}.kind`, CODING_APP_SESSION_CHANNEL_KIND_MAX_CHARS, errors);
  checkBoundedText(value.body, `${path}.body`, CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS, errors);
}

function finish<T>(value: unknown, errors: string[]): ChannelValidation<T> {
  return errors.length === 0 ? { ok: true, value: value as T } : { ok: false, errors };
}

/** Validate a single bounded content item in isolation (used before projecting it into a snapshot). */
export function validateCodingAppSessionChannelContent(
  value: unknown,
): ChannelValidation<CodingAppSessionChannelContent> {
  if (!isRecord(value)) return { ok: false, errors: ["channel content must be an object"] };
  const errors: string[] = [];
  checkChannelContent(value, "channelContent", errors);
  return finish(value, errors);
}

/**
 * Validate a channel snapshot: exact keys, correct version, a bounded content item or `null`, and an
 * aggregate UTF-8 budget. The server validates every projected snapshot before it crosses the wire.
 */
export function validateCodingAppSessionChannelSnapshot(
  value: unknown,
): ChannelValidation<CodingAppSessionChannelSnapshot> {
  if (!isRecord(value)) return { ok: false, errors: ["channel snapshot must be an object"] };
  const errors = unexpectedKeys(value, ["schemaVersion", "content"], "channelSnapshot");
  if (value.schemaVersion !== CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION) {
    errors.push("channelSnapshot.schemaVersion is invalid");
  }
  if (value.content !== null) checkChannelContent(value.content, "channelSnapshot.content", errors);
  if (
    errors.length === 0 &&
    serializedUtf8Bytes(value) > CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES
  ) {
    errors.push("channel snapshot exceeds the aggregate UTF-8 byte budget");
  }
  return finish(value, errors);
}
