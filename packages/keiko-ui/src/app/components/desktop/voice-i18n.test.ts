import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useVoiceTranslate } from "./voice-i18n";

describe("voice translations", () => {
  it("interpolates named values in voice status messages", () => {
    const { result } = renderHook(useVoiceTranslate);
    expect(result.current("voice.realtime.memory.many", { count: 3 })).toBe(
      "3 recalled memories active.",
    );
  });
});
