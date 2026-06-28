// Typed parser for provider-side Realtime data-channel events.
//
// The browser receives OpenAI/Azure-compatible Realtime events over the WebRTC
// data channel. Only reviewable transcript text and content-free lifecycle
// signals leave this module; raw audio, SDP, credentials, and provider URLs are
// not represented here.

export type ParsedRealtimeVoiceEvent =
  | { readonly kind: "user-speech-start"; readonly itemId?: string | undefined }
  | { readonly kind: "user-speech-stop"; readonly itemId?: string | undefined }
  | {
      readonly kind: "user-transcript-committed";
      readonly text: string;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "assistant-transcript-delta";
      readonly delta: string;
      readonly responseId?: string | undefined;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "assistant-transcript-committed";
      readonly text: string;
      readonly responseId?: string | undefined;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "assistant-output-start";
      readonly responseId?: string | undefined;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "assistant-output-stop";
      readonly responseId?: string | undefined;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "function-call-arguments-delta";
      readonly callId: string;
      readonly name?: string | undefined;
      readonly delta: string;
      readonly responseId?: string | undefined;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "function-call-committed";
      readonly callId: string;
      readonly name: string;
      readonly argumentsText: string;
      readonly responseId?: string | undefined;
      readonly itemId?: string | undefined;
    }
  | {
      readonly kind: "response-done";
      readonly responseId?: string | undefined;
      readonly status?: "completed" | "cancelled" | "failed" | "incomplete" | undefined;
    }
  | { readonly kind: "response-cancelled"; readonly responseId?: string | undefined }
  | { readonly kind: "error"; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function responseId(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, "response_id");
  if (direct !== undefined) return direct;
  const response = record.response;
  return isRecord(response) ? stringField(response, "id") : undefined;
}

function itemId(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, "item_id");
  if (direct !== undefined) return direct;
  const item = record.item;
  return isRecord(item) ? stringField(item, "id") : undefined;
}

function callId(record: Record<string, unknown>): string | undefined {
  const direct = stringField(record, "call_id");
  if (direct !== undefined) return direct;
  const item = record.item;
  if (isRecord(item)) {
    const fromItem = stringField(item, "call_id");
    if (fromItem !== undefined) return fromItem;
  }
  return itemId(record);
}

function responseStatus(
  record: Record<string, unknown>,
): "completed" | "cancelled" | "failed" | "incomplete" | undefined {
  const response = record.response;
  const raw = isRecord(response) ? stringField(response, "status") : stringField(record, "status");
  if (raw === "completed" || raw === "cancelled" || raw === "failed" || raw === "incomplete") {
    return raw;
  }
  return undefined;
}

function errorMessage(record: Record<string, unknown>): string {
  const error = record.error;
  if (isRecord(error)) {
    const message = stringField(error, "message");
    if (message !== undefined) return message;
    const code = stringField(error, "code");
    if (code !== undefined) return `Realtime error: ${code}`;
  }
  return stringField(record, "message") ?? "Realtime voice provider reported an error.";
}

function transcriptFromOutputItem(record: Record<string, unknown>): string | undefined {
  const item = record.item;
  if (!isRecord(item) || item.role !== "assistant" || !Array.isArray(item.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of item.content) {
    if (isRecord(part)) {
      const transcript = stringField(part, "transcript");
      if (transcript !== undefined) parts.push(transcript);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : undefined;
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function functionCallFromItem(
  item: unknown,
  fallback: Record<string, unknown>,
):
  | {
      readonly callId: string;
      readonly name: string;
      readonly argumentsText: string;
      readonly itemId?: string | undefined;
    }
  | undefined {
  if (!isRecord(item) || item.type !== "function_call") {
    return undefined;
  }
  const id = stringField(item, "call_id") ?? callId(fallback);
  const name = stringField(item, "name");
  if (id === undefined || name === undefined) {
    return undefined;
  }
  return {
    callId: id,
    name,
    argumentsText: argumentsText(item.arguments),
    itemId: stringField(item, "id") ?? itemId(fallback),
  };
}

function functionCallFromOutputItem(
  record: Record<string, unknown>,
):
  | {
      readonly callId: string;
      readonly name: string;
      readonly argumentsText: string;
      readonly itemId?: string | undefined;
    }
  | undefined {
  return functionCallFromItem(record.item, record);
}

function functionCallFromResponseDone(
  record: Record<string, unknown>,
):
  | {
      readonly callId: string;
      readonly name: string;
      readonly argumentsText: string;
      readonly itemId?: string | undefined;
    }
  | undefined {
  const response = record.response;
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return undefined;
  }
  for (const item of response.output) {
    const call = functionCallFromItem(item, record);
    if (call !== undefined) return call;
  }
  return undefined;
}

export function parseRealtimeVoiceEvent(raw: unknown): ParsedRealtimeVoiceEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const type = stringField(raw, "type") ?? stringField(raw, "kind");
  switch (type) {
    case "input_audio_buffer.speech_started":
      return { kind: "user-speech-start", itemId: itemId(raw) };
    case "input_audio_buffer.speech_stopped":
      return { kind: "user-speech-stop", itemId: itemId(raw) };
    case "conversation.item.input_audio_transcription.completed": {
      const text = stringField(raw, "transcript")?.trim();
      return text === undefined || text.length === 0
        ? undefined
        : { kind: "user-transcript-committed", text, itemId: itemId(raw) };
    }
    case "conversation.item.input_audio_transcription.failed":
      return { kind: "error", message: errorMessage(raw) };
    case "response.audio_transcript.delta":
    case "response.output_audio_transcript.delta": {
      const delta = stringField(raw, "delta");
      return delta === undefined
        ? undefined
        : {
            kind: "assistant-transcript-delta",
            delta,
            responseId: responseId(raw),
            itemId: itemId(raw),
          };
    }
    case "response.audio_transcript.done":
    case "response.output_audio_transcript.done": {
      const text = stringField(raw, "transcript")?.trim();
      return text === undefined || text.length === 0
        ? undefined
        : {
            kind: "assistant-transcript-committed",
            text,
            responseId: responseId(raw),
            itemId: itemId(raw),
          };
    }
    case "response.function_call_arguments.delta": {
      const id = callId(raw);
      const delta = stringField(raw, "delta");
      return id === undefined || delta === undefined
        ? undefined
        : {
            kind: "function-call-arguments-delta",
            callId: id,
            name: stringField(raw, "name"),
            delta,
            responseId: responseId(raw),
            itemId: itemId(raw),
          };
    }
    case "response.output_item.done": {
      const call = functionCallFromOutputItem(raw);
      if (call !== undefined) {
        return {
          kind: "function-call-committed",
          callId: call.callId,
          name: call.name,
          argumentsText: call.argumentsText,
          responseId: responseId(raw),
          itemId: call.itemId,
        };
      }
      const text = transcriptFromOutputItem(raw);
      return text === undefined
        ? undefined
        : {
            kind: "assistant-transcript-committed",
            text,
            responseId: responseId(raw),
            itemId: itemId(raw),
          };
    }
    case "response.audio.delta":
    case "response.output_audio.delta":
    case "output_audio_buffer.started":
      return { kind: "assistant-output-start", responseId: responseId(raw), itemId: itemId(raw) };
    case "output_audio_buffer.stopped":
      return { kind: "assistant-output-stop", responseId: responseId(raw), itemId: itemId(raw) };
    case "response.cancelled":
      return { kind: "response-cancelled", responseId: responseId(raw) };
    case "response.done": {
      const call = functionCallFromResponseDone(raw);
      if (call !== undefined) {
        return {
          kind: "function-call-committed",
          callId: call.callId,
          name: call.name,
          argumentsText: call.argumentsText,
          responseId: responseId(raw),
          itemId: call.itemId,
        };
      }
      return { kind: "response-done", responseId: responseId(raw), status: responseStatus(raw) };
    }
    case "error":
      return { kind: "error", message: errorMessage(raw) };
    default:
      return undefined;
  }
}
