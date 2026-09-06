import { describe, expect, it } from "vitest";

import { countGatewayPromptTokens } from "./prompt-token-accounting.js";

describe("countGatewayPromptTokens", () => {
  it("counts assistant tool arguments and tool-result ids as forwarded prompt context", () => {
    const visibleOnly = countGatewayPromptTokens({
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "" },
        { role: "tool", content: "rejected" },
      ],
    });
    const completeTranscript = countGatewayPromptTokens({
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-large",
              name: "keiko_changeset_edit",
              arguments: { patch: "x".repeat(600_000) },
            },
          ],
        },
        { role: "tool", content: "rejected", toolCallId: "call-large" },
      ],
    });

    expect(visibleOnly).toBeLessThan(128_000);
    expect(completeTranscript).toBeGreaterThan(128_000);
  });

  it("uses the selected model calibration and preserves ordinary tool traffic", () => {
    const input = {
      messages: [
        { role: "user" as const, content: "inspect the repository" },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "call-1", name: "keiko_git_status", arguments: {} }],
        },
        { role: "tool" as const, content: "clean", toolCallId: "call-1" },
      ],
    };
    const fallback = countGatewayPromptTokens(input);
    const calibrated = countGatewayPromptTokens(input, {
      source: "calibrated",
      counterId: "fixture-counter",
      scaleMilli: 1_250,
      offsetTokens: 2,
    });

    expect(fallback).toBeLessThan(128_000);
    expect(calibrated).toBeGreaterThan(fallback);
    expect(calibrated).toBeLessThan(128_000);
  });
});
