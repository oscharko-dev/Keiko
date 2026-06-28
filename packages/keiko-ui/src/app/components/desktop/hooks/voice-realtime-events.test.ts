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

  it("parses realtime function-call argument deltas", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "response.function_call_arguments.delta",
        response_id: "r-tool",
        item_id: "item-tool",
        call_id: "call-1",
        name: "search_keiko_grounding",
        delta: '{"query":"Fachkonzept"',
      }),
    ).toEqual({
      kind: "function-call-arguments-delta",
      responseId: "r-tool",
      itemId: "item-tool",
      callId: "call-1",
      name: "search_keiko_grounding",
      delta: '{"query":"Fachkonzept"',
    });
  });

  it("parses committed function calls from output_item.done", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "response.output_item.done",
        response_id: "r-tool",
        item: {
          id: "item-tool",
          type: "function_call",
          call_id: "call-1",
          name: "search_keiko_grounding",
          arguments: '{"query":"Worum geht es im Fachkonzept?"}',
        },
      }),
    ).toEqual({
      kind: "function-call-committed",
      responseId: "r-tool",
      itemId: "item-tool",
      callId: "call-1",
      name: "search_keiko_grounding",
      argumentsText: '{"query":"Worum geht es im Fachkonzept?"}',
    });
  });

  it("parses committed function calls from response.done output", () => {
    expect(
      parseRealtimeVoiceEvent({
        type: "response.done",
        response: {
          id: "r-tool",
          status: "completed",
          output: [
            {
              id: "item-tool",
              type: "function_call",
              call_id: "call-1",
              name: "search_keiko_grounding",
              arguments: { query: "Welche Quellen sind verbunden?" },
            },
          ],
        },
      }),
    ).toEqual({
      kind: "function-call-committed",
      responseId: "r-tool",
      itemId: "item-tool",
      callId: "call-1",
      name: "search_keiko_grounding",
      argumentsText: '{"query":"Welche Quellen sind verbunden?"}',
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
