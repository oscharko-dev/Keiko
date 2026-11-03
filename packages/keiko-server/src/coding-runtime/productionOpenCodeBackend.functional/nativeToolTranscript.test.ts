import { describe, expect, it } from "vitest";

import {
  nativeSystemPrompt,
  nativeToolResultText,
  nativeWorkingDirectory,
} from "./nativeToolTranscript.js";

const SYSTEM = [
  "You are an AI agent running in OpenCode.",
  "<env>",
  "  Working directory: /work/space/ws_1",
  "  Workspace root folder: /work/space/ws_1",
  "</env>",
].join("\n");

function transcript(...messages: readonly Record<string, unknown>[]): string {
  return JSON.stringify(messages);
}

describe("native tool transcript reader", () => {
  it("returns the plain text result correlated to a tool call", () => {
    const text = transcript(
      { role: "tool", toolCallId: "other", content: "elsewhere" },
      { role: "tool", toolCallId: "call-1", content: "Found 1 matches" },
    );
    expect(nativeToolResultText(text, "call-1")).toBe("Found 1 matches");
  });

  it.each([
    ["a result of another call", { role: "tool", toolCallId: "other", content: "text" }],
    ["a result without text", { role: "tool", toolCallId: "call-1", content: 7 }],
    ["a message that is not a tool result", { role: "user", toolCallId: "call-1", content: "x" }],
  ])("refuses %s", (_name, message) => {
    expect(() => nativeToolResultText(transcript(message), "call-1")).toThrow(TypeError);
  });

  it("refuses the runtime's own failure object instead of treating it as a result", () => {
    const failed = JSON.stringify({
      error: { type: "unknown", message: "ripgrep execution failed" },
      content: [],
    });
    expect(() =>
      nativeToolResultText(
        transcript({ role: "tool", toolCallId: "call-1", content: failed }),
        "call-1",
      ),
    ).toThrow(TypeError);
  });

  it("keeps a result that merely starts like JSON", () => {
    const text = transcript({ role: "tool", toolCallId: "call-1", content: "{ not json" });
    expect(nativeToolResultText(text, "call-1")).toBe("{ not json");
  });

  it("refuses anything that is not a message list", () => {
    expect(() => nativeToolResultText('{"role":"tool"}', "call-1")).toThrow(TypeError);
  });

  it("joins the system messages and reads the working directory the runtime states", () => {
    const text = transcript(
      { role: "system", content: SYSTEM },
      { role: "user", content: "Working directory: /not/the/runtime" },
    );
    expect(nativeSystemPrompt(text)).toBe(SYSTEM);
    expect(nativeWorkingDirectory(text)).toBe("/work/space/ws_1");
  });

  it("refuses a transcript whose system prompt does not state a working directory", () => {
    expect(() =>
      nativeWorkingDirectory(transcript({ role: "system", content: "no environment" })),
    ).toThrow(TypeError);
  });
});
