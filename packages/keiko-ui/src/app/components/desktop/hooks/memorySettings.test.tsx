import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentConversationMemoryModeRevision,
  resetConversationMemorySettingsForTests,
  useConversationMemorySettings,
} from "./memorySettings";

afterEach(() => {
  resetConversationMemorySettingsForTests();
});

describe("conversation memory settings store", () => {
  it("defaults memory inclusion off until the user explicitly enables it", () => {
    const { result } = renderHook(() => useConversationMemorySettings());
    expect(result.current).toMatchObject({
      memoryEnabled: false,
      memoryBudgetTokens: 1200,
      memoryMode: "governed-assist",
    });
  });

  it("publishes mode changes to every subscriber and suppresses equal updates", () => {
    const first = renderHook(() => useConversationMemorySettings());
    const second = renderHook(() => useConversationMemorySettings());
    act(() => {
      first.result.current.setMemoryMode("supervised-coding");
    });
    expect(first.result.current.memoryMode).toBe("supervised-coding");
    expect(second.result.current.memoryMode).toBe("supervised-coding");

    const unchangedSnapshot = first.result.current;
    act(() => {
      first.result.current.setMemoryMode("supervised-coding");
    });
    expect(first.result.current).toBe(unchangedSnapshot);
  });

  it("isolates memory inclusion and budgets by conversation", () => {
    const privateChat = renderHook(() => useConversationMemorySettings("chat-private"));
    const businessChat = renderHook(() => useConversationMemorySettings("chat-business"));

    act(() => {
      privateChat.result.current.setMemoryEnabled(true);
      privateChat.result.current.setMemoryBudgetTokens(2400);
    });

    expect(privateChat.result.current).toMatchObject({
      memoryEnabled: true,
      memoryBudgetTokens: 2400,
    });
    expect(businessChat.result.current).toMatchObject({
      memoryEnabled: false,
      memoryBudgetTokens: 1200,
    });

    act(() => {
      privateChat.result.current.setMemoryMode("supervised-coding");
    });
    expect(privateChat.result.current.memoryMode).toBe("supervised-coding");
    expect(businessChat.result.current.memoryMode).toBe("supervised-coding");
  });

  it("restores the safe default through the existing reset seam", () => {
    const { result } = renderHook(() => useConversationMemorySettings());
    act(() => {
      result.current.setMemoryMode("autonomous-delivery");
      resetConversationMemorySettingsForTests();
    });
    expect(result.current.memoryMode).toBe("governed-assist");
  });

  it("tracks every effective settings change, including an ABA mode transition", () => {
    const { result } = renderHook(() => useConversationMemorySettings());
    const initialRevision = currentConversationMemoryModeRevision();
    act(() => {
      result.current.setMemoryBudgetTokens(800);
      result.current.setMemoryMode("autonomous-delivery");
      result.current.setMemoryMode("governed-assist");
      result.current.setMemoryMode("governed-assist");
    });

    expect(currentConversationMemoryModeRevision()).toBe(initialRevision + 2);
  });
});
