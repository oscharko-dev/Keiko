import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetConversationMemorySettingsForTests,
  useConversationMemorySettings,
} from "./memorySettings";

afterEach(() => {
  resetConversationMemorySettingsForTests();
});

describe("conversation memory settings store", () => {
  it("uses the safe mode default on the one existing settings store", () => {
    const { result } = renderHook(() => useConversationMemorySettings());
    expect(result.current).toMatchObject({
      memoryEnabled: true,
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

  it("restores the safe default through the existing reset seam", () => {
    const { result } = renderHook(() => useConversationMemorySettings());
    act(() => {
      result.current.setMemoryMode("autonomous-delivery");
      resetConversationMemorySettingsForTests();
    });
    expect(result.current.memoryMode).toBe("governed-assist");
  });
});
