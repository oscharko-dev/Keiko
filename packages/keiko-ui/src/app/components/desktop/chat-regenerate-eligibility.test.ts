import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/types";
import { latestRegenerableAssistantId } from "./chat-regenerate-eligibility";

function message(id: string, role: ChatMessage["role"], runId?: string): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    role,
    content: id,
    timestamp: 1,
    runId,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

describe("latestRegenerableAssistantId", () => {
  it("names the answer that ends the conversation", () => {
    expect(latestRegenerableAssistantId([message("u1", "user"), message("a1", "assistant")])).toBe(
      "a1",
    );
  });

  it("names none when a newer question follows the last answer", () => {
    expect(
      latestRegenerableAssistantId([
        message("u1", "user"),
        message("a1", "assistant"),
        message("u2", "user"),
      ]),
    ).toBeUndefined();
  });

  it("looks past a run summary after the last answer, as the server does", () => {
    expect(
      latestRegenerableAssistantId([
        message("u1", "user"),
        message("a1", "assistant"),
        message("s1", "system", "run-1"),
      ]),
    ).toBe("a1");
  });

  it("names none for an empty conversation or one without an answer", () => {
    expect(latestRegenerableAssistantId([])).toBeUndefined();
    expect(latestRegenerableAssistantId([message("u1", "user")])).toBeUndefined();
  });
});
