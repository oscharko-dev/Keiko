// Typed parser for provider-side Realtime data-channel events.
//
// The browser receives OpenAI/Azure-compatible Realtime events over the WebRTC
// data channel. Only reviewable transcript text and content-free lifecycle
// signals leave this module; raw audio, SDP, credentials, and provider URLs are
// not represented here.

export const REALTIME_PROVIDER_ERROR_MESSAGE = "Real-time voice connection failed.";
export const REALTIME_TRANSCRIPTION_ERROR_MESSAGE = "Speech transcription failed.";
export const REALTIME_TRANSCRIPT_LIMIT_MESSAGE =
  "The spoken transcript is too long to send as one chat message.";
const MAX_REALTIME_EVENT_IDENTIFIER_CHARS = 256;
export const MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES = 256_000;
const TRANSCRIPT_ENCODER = new TextEncoder();

export type ParsedRealtimeVoiceEvent =
  | { readonly kind: "session-created" }
  | { readonly kind: "session-updated" }
  | { readonly kind: "user-speech-start"; readonly itemId?: string | undefined }
  | { readonly kind: "user-speech-stop"; readonly itemId?: string | undefined }
  | {
      readonly kind: "user-transcript-delta";
      readonly delta: string;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "user-transcript-committed";
      readonly text: string;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "user-transcript-failed";
      readonly message: string;
      readonly reason: "provider" | "limit-exceeded";
      readonly reviewText?: string | undefined;
      readonly itemId?: string | undefined;
    }
  | { readonly kind: "error"; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identifierField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value !== undefined && value.length <= MAX_REALTIME_EVENT_IDENTIFIER_CHARS
    ? value
    : undefined;
}

function itemId(record: Record<string, unknown>): string | undefined {
  const direct = identifierField(record, "item_id");
  if (direct !== undefined) return direct;
  const item = record.item;
  return isRecord(item) ? identifierField(item, "id") : undefined;
}

export function realtimeTranscriptByteLength(text: string): number {
  return TRANSCRIPT_ENCODER.encode(text).byteLength;
}

export function boundedRealtimeTranscriptText(text: string): string {
  if (realtimeTranscriptByteLength(text) <= MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (
      realtimeTranscriptByteLength(text.slice(0, midpoint)) <=
      MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES
    ) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  const boundary = low > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(low - 1)) ? low - 1 : low;
  return text.slice(0, boundary);
}

function parseUserTranscriptCommitted(
  raw: Record<string, unknown>,
): ParsedRealtimeVoiceEvent | undefined {
  const rawText = stringField(raw, "transcript");
  if (
    rawText !== undefined &&
    realtimeTranscriptByteLength(rawText) > MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES
  ) {
    return {
      kind: "user-transcript-failed",
      reason: "limit-exceeded",
      message: REALTIME_TRANSCRIPT_LIMIT_MESSAGE,
      reviewText: boundedRealtimeTranscriptText(rawText),
      itemId: itemId(raw),
    };
  }
  const text = rawText?.trim();
  return text === undefined || text.length === 0
    ? undefined
    : { kind: "user-transcript-committed", text, itemId: itemId(raw) };
}

function parseUserTranscriptDelta(
  raw: Record<string, unknown>,
): ParsedRealtimeVoiceEvent | undefined {
  const delta = stringField(raw, "delta");
  if (
    delta !== undefined &&
    realtimeTranscriptByteLength(delta) > MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES
  ) {
    return {
      kind: "user-transcript-failed",
      reason: "limit-exceeded",
      message: REALTIME_TRANSCRIPT_LIMIT_MESSAGE,
      reviewText: boundedRealtimeTranscriptText(delta),
      itemId: itemId(raw),
    };
  }
  return delta === undefined
    ? undefined
    : { kind: "user-transcript-delta", delta, itemId: itemId(raw) };
}

export function parseRealtimeVoiceEvent(raw: unknown): ParsedRealtimeVoiceEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const type = stringField(raw, "type") ?? stringField(raw, "kind");
  switch (type) {
    case "session.created":
      return { kind: "session-created" };
    case "session.updated":
      return { kind: "session-updated" };
    case "input_audio_buffer.speech_started":
      return { kind: "user-speech-start", itemId: itemId(raw) };
    case "input_audio_buffer.speech_stopped":
      return { kind: "user-speech-stop", itemId: itemId(raw) };
    case "conversation.item.input_audio_transcription.completed":
      return parseUserTranscriptCommitted(raw);
    case "conversation.item.input_audio_transcription.delta":
      return parseUserTranscriptDelta(raw);
    case "conversation.item.input_audio_transcription.failed":
      return {
        kind: "user-transcript-failed",
        reason: "provider",
        message: REALTIME_TRANSCRIPTION_ERROR_MESSAGE,
        itemId: itemId(raw),
      };
    case "error":
      return { kind: "error", message: REALTIME_PROVIDER_ERROR_MESSAGE };
    default:
      return undefined;
  }
}
