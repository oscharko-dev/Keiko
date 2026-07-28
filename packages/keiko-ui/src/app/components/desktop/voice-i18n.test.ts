import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { useVoiceTranslate } from "./voice-i18n";

function I18nWrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return createElement(I18nProvider, null, children);
}

describe("voice translations", () => {
  it("interpolates named values in voice status messages", () => {
    const { result } = renderHook(useVoiceTranslate, { wrapper: I18nWrapper });
    expect(result.current("voice.realtime.memory.many", { count: 3 })).toBe(
      "3 recalled memories active.",
    );
  });
});
