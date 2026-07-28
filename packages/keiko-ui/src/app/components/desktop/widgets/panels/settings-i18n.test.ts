import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import settingsMessages from "./settings-i18n.messages.json";
import { useSettingsTranslate } from "./settings-i18n";

describe("settings tab translations", () => {
  it("contains exact English and German labels for the Debugging tab", () => {
    expect(settingsMessages["settings.tabs.debugging"]).toEqual({
      en: "Debugging",
      de: "Debugging",
    });
  });

  it("interpolates named values in settings messages", () => {
    const { result } = renderHook(useSettingsTranslate);
    expect(result.current("settings.models.modelCount", { count: 3 })).toBe("3 models");
  });
});
