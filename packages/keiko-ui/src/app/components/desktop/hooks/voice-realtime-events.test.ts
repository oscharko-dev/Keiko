import { describe, expect, it } from "vitest";
import { parseRealtimeVoiceEvent } from "./voice-realtime-events";

describe("parseRealtimeVoiceEvent", () => {
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

  it("parses assistant transcript delta and done events", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "response.output_audio_transcript.delta",
        response_id: "r1",
        item_id: "a1",
        delta: "Hello",
      }),
    ).toEqual({
      kind: "assistant-transcript-delta",
      responseId: "r1",
      itemId: "a1",
      delta: "Hello",
    });
    expect(
      parseRealtimeVoiceEvent({
        type: "response.output_audio_transcript.done",
        response_id: "r1",
        item_id: "a1",
        transcript: "Hello there.",
      }),
    ).toEqual({
      kind: "assistant-transcript-committed",
      responseId: "r1",
      itemId: "a1",
      text: "Hello there.",
    });
  });

  it("keeps compatibility with older audio_transcript event names", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "response.audio_transcript.done",
        response_id: "r-old",
        transcript: "Done.",
      }),
    ).toEqual({
      kind: "assistant-transcript-committed",
      responseId: "r-old",
      itemId: undefined,
      text: "Done.",
    });
  });

  it("maps response.done statuses", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "response.done",
        response: { id: "r2", status: "cancelled" },
      }),
    ).toEqual({
      kind: "response-done",
      responseId: "r2",
      status: "cancelled",
    });
  });

  it("ignores unknown and empty transcript events", () => {
    expect(parseRealtimeVoiceEvent({ type: "session.created" })).toBeUndefined();
    expect(
      parseRealtimeVoiceEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "   ",
      }),
    ).toBeUndefined();
  });
});
