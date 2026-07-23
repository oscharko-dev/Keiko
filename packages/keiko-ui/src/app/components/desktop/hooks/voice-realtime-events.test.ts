import { describe, expect, it } from "vitest";
import { MAX_DESKTOP_CHAT_INPUT_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES,
  parseRealtimeVoiceEvent,
  realtimeTranscriptByteLength,
  REALTIME_PROVIDER_ERROR_MESSAGE,
  REALTIME_TRANSCRIPTION_ERROR_MESSAGE,
  REALTIME_TRANSCRIPT_LIMIT_MESSAGE,
} from "./voice-realtime-events";

describe("parseRealtimeVoiceEvent", () => {
  it("parses realtime session lifecycle acknowledgements", () => {
    expect(parseRealtimeVoiceEvent({ type: "session.created" })).toEqual({
      kind: "session-created",
    });
    expect(parseRealtimeVoiceEvent({ type: "session.updated" })).toEqual({
      kind: "session-updated",
    });
  });

  it("parses user speech lifecycle events", () => {
    expect(parseRealtimeVoiceEvent({ type: "input_audio_buffer.speech_started" })).toEqual({
      kind: "user-speech-start",
      itemId: undefined,
    });
    expect(parseRealtimeVoiceEvent({ type: "input_audio_buffer.speech_stopped" })).toEqual({
      kind: "user-speech-stop",
      itemId: undefined,
    });
  });

  it("parses committed user transcription", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "  open the deploy log  ",
      }),
    ).toEqual({
      kind: "user-transcript-committed",
      itemId: "u1",
      text: "open the deploy log",
    });
  });

  it("parses interim and failed user transcription events", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "u1",
        delta: "deploy ",
      }),
    ).toEqual({
      kind: "user-transcript-delta",
      itemId: "u1",
      delta: "deploy ",
    });
    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "u1",
        error: { message: "asr failed" },
      }),
    ).toEqual({
      kind: "user-transcript-failed",
      itemId: "u1",
      reason: "provider",
      message: REALTIME_TRANSCRIPTION_ERROR_MESSAGE,
    });
  });

  it("never forwards provider-controlled error details to browser-visible events", () => {
    const sensitiveMarker = "credential-marker-should-not-surface";

    expect(
      parseRealtimeVoiceEvent({
        type: "error",
        error: { message: sensitiveMarker, code: sensitiveMarker },
      }),
    ).toEqual({ kind: "error", message: REALTIME_PROVIDER_ERROR_MESSAGE });
    const failedTranscript = parseRealtimeVoiceEvent({
      type: "conversation.item.input_audio_transcription.failed",
      error: { message: sensitiveMarker },
    });
    expect(JSON.stringify(failedTranscript)).not.toContain(sensitiveMarker);
  });

  it("accepts one atomic final at the byte cap and rejects content beyond it", () => {
    const atLimit = "a".repeat(MAX_DESKTOP_CHAT_INPUT_CHARS);
    const overLimit = `${atLimit}a`;

    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "at-limit",
        transcript: atLimit,
      }),
    ).toEqual({ kind: "user-transcript-committed", itemId: "at-limit", text: atLimit });
    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "over-limit",
        transcript: overLimit,
      }),
    ).toEqual({
      kind: "user-transcript-failed",
      itemId: "over-limit",
      reason: "limit-exceeded",
      message: REALTIME_TRANSCRIPT_LIMIT_MESSAGE,
      reviewText: atLimit,
    });
    const oversizedDelta = parseRealtimeVoiceEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "beyond-review-cap-delta",
      delta: overLimit,
    });
    expect(oversizedDelta).toMatchObject({
      kind: "user-transcript-failed",
      itemId: "beyond-review-cap-delta",
      reason: "limit-exceeded",
      message: REALTIME_TRANSCRIPT_LIMIT_MESSAGE,
    });
    if (oversizedDelta?.kind !== "user-transcript-failed") {
      throw new Error("expected a bounded transcript failure");
    }
    expect(oversizedDelta.reviewText).toHaveLength(MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES);
  });

  it("bounds multibyte transcript review text without splitting a surrogate pair", () => {
    const beyondReviewCap = "😀".repeat(
      Math.floor(MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES / 4) + 1,
    );
    const parsed = parseRealtimeVoiceEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "multibyte-overflow",
      transcript: beyondReviewCap,
    });

    expect(parsed).toMatchObject({
      kind: "user-transcript-failed",
      reason: "limit-exceeded",
      itemId: "multibyte-overflow",
    });
    if (parsed?.kind !== "user-transcript-failed" || parsed.reviewText === undefined) {
      throw new Error("expected reviewable multibyte text");
    }
    expect(realtimeTranscriptByteLength(parsed.reviewText)).toBe(
      MAX_REVIEWABLE_REALTIME_TRANSCRIPT_BYTES,
    );
    expect(parsed.reviewText.endsWith("😀")).toBe(true);
  });

  it("drops every provider-native assistant, audio, response, and tool event", () => {
    for (const event of [
      { type: "response.output_audio_transcript.delta", delta: "parallel answer" },
      { type: "response.output_audio_transcript.done", transcript: "parallel answer" },
      { type: "response.output_audio.delta", delta: "provider audio" },
      { type: "output_audio_buffer.started" },
      { type: "response.function_call_arguments.delta", call_id: "call-1", delta: "{}" },
      { type: "response.output_item.done", item: { type: "function_call" } },
      { type: "response.done", response: { id: "r1", status: "completed" } },
      { type: "response.cancelled", response_id: "r1" },
    ]) {
      expect(parseRealtimeVoiceEvent(event)).toBeUndefined();
    }
  });

  it("does not retain oversized provider-controlled transcript item identifiers", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "i".repeat(257),
        transcript: "bounded identity",
      }),
    ).toEqual({
      kind: "user-transcript-committed",
      itemId: undefined,
      text: "bounded identity",
    });
  });

  it("ignores unknown and empty transcript events", () => {
    expect(parseRealtimeVoiceEvent({ type: "session.magic" })).toBeUndefined();
    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "   ",
      }),
    ).toBeUndefined();
  });
});
