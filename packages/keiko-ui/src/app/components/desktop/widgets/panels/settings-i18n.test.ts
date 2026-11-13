import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GATEWAY_TOOL_CALLING_OUTCOMES } from "@oscharko-dev/keiko-contracts/bff-wire";
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
    expect(result.current("settings.models.modelCount", { count: 3 })).toBe("3 configured models");
  });

  // #4351: every closed outcome of the tool-calling check has one sentence per language, derived from
  // the closed value, with no placeholder and informal German.
  it.each(GATEWAY_TOOL_CALLING_OUTCOMES)("words the %s outcome in both languages", (outcome) => {
    const key = `settings.models.toolOutcome.${outcome}` as keyof typeof settingsMessages;
    const message = settingsMessages[key] as { en: string; de: string };
    expect(message.en.trim().length).toBeGreaterThan(0);
    expect(message.de.trim().length).toBeGreaterThan(0);
    expect(`${message.en}${message.de}`).not.toMatch(/[{}]/u);
    expect(message.de).not.toMatch(/\b(Sie|Ihr|Ihre|Ihren|Ihrer|Ihrem|Ihnen)\b/u);
  });

  it("has a sentence for no key other than a closed outcome", () => {
    const keys = Object.keys(settingsMessages).filter((key) =>
      key.startsWith("settings.models.toolOutcome."),
    );
    expect(keys.toSorted()).toEqual(
      GATEWAY_TOOL_CALLING_OUTCOMES.map(
        (outcome) => `settings.models.toolOutcome.${outcome}`,
      ).toSorted(),
    );
  });
});
