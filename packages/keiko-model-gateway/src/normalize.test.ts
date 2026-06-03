import { describe, expect, it } from "vitest";
import { MalformedToolCallError, ModelRefusalError } from "@oscharko-dev/keiko-security/errors/gateway";
import { normalizeChatResponse } from "./normalize.js";

const BASE_USAGE = { requestId: "req-1", latencyMs: 12, costClass: "medium" } as const;

function chatPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    choices: [
      {
        message: { role: "assistant", content: "hello there" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  };
}

describe("normalizeChatResponse", () => {
  it("normalises a well-formed chat response with populated usage", () => {
    const result = normalizeChatResponse(chatPayload(), "example-chat-model", BASE_USAGE);
    expect(result.content).toBe("hello there");
    expect(result.finishReason).toBe("stop");
    expect(result.modelId).toBe("example-chat-model");
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
    expect(result.usage.requestId).toBe("req-1");
    expect(result.toolCalls).toEqual([]);
    expect(result.structuredOutput).toBeNull();
  });

  it("normalises a tool-call response: content empty, finishReason tool_calls", () => {
    const payload = chatPayload({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                function: { name: "search", arguments: '{"q":"hi"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = normalizeChatResponse(payload, "example-chat-model", BASE_USAGE);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("search");
    expect(result.toolCalls[0]?.arguments).toEqual({ q: "hi" });
  });

  it("parses structured JSON output into structuredOutput", () => {
    const payload = chatPayload({
      choices: [
        {
          message: { role: "assistant", content: '{"answer":42}' },
          finish_reason: "stop",
        },
      ],
    });
    const result = normalizeChatResponse(payload, "example-chat-model", BASE_USAGE, true);
    expect(result.structuredOutput).toEqual({ answer: 42 });
  });

  it("throws MalformedToolCallError when tool-call arguments are not valid JSON", () => {
    const payload = chatPayload({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c", function: { name: "x", arguments: "{not json" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(() => normalizeChatResponse(payload, "m", BASE_USAGE)).toThrow(MalformedToolCallError);
  });

  it("throws MalformedToolCallError when a tool call has no function descriptor", () => {
    const payload = chatPayload({
      choices: [
        {
          message: { role: "assistant", content: null, tool_calls: [{ id: "c" }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(() => normalizeChatResponse(payload, "m", BASE_USAGE)).toThrow(MalformedToolCallError);
  });

  it("throws MalformedToolCallError when tool-call arguments parse to a non-object", () => {
    const payload = chatPayload({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c", function: { name: "x", arguments: "[1,2]" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(() => normalizeChatResponse(payload, "m", BASE_USAGE)).toThrow(MalformedToolCallError);
  });

  it("normalises missing usage counts to zero", () => {
    const payload = chatPayload({ usage: undefined });
    const result = normalizeChatResponse(payload, "m", BASE_USAGE);
    expect(result.usage.promptTokens).toBe(0);
    expect(result.usage.completionTokens).toBe(0);
  });

  it("maps an unrecognised finish_reason to stop", () => {
    const payload = chatPayload({
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "weird" }],
    });
    expect(normalizeChatResponse(payload, "m", BASE_USAGE).finishReason).toBe("stop");
  });

  it("maps length finish_reason through", () => {
    const payload = chatPayload({
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "length" }],
    });
    expect(normalizeChatResponse(payload, "m", BASE_USAGE).finishReason).toBe("length");
  });

  it("throws ModelRefusalError for a provider refusal field", () => {
    const payload = chatPayload({
      choices: [{ message: { role: "assistant", content: "", refusal: "I cannot comply" } }],
    });
    expect(() => normalizeChatResponse(payload, "m", BASE_USAGE)).toThrow(ModelRefusalError);
  });

  it("throws ModelRefusalError for content_filter finish_reason", () => {
    const payload = chatPayload({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
    });
    expect(() => normalizeChatResponse(payload, "m", BASE_USAGE)).toThrow(ModelRefusalError);
  });

  it("returns empty content when the provider omits the choices array", () => {
    const result = normalizeChatResponse({ usage: {} }, "m", BASE_USAGE);
    expect(result.content).toBe("");
    expect(result.finishReason).toBe("stop");
  });
});
