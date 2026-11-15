import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_TOOL_CALLING_OUTCOMES,
  type GatewayToolCallingOutcome,
} from "@oscharko-dev/keiko-contracts/bff-wire";
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

  // What each sentence must never lose, in both languages: the substance a reader acts on. A record
  // over the closed outcomes, so an outcome added without a pin does not compile.
  const PINS: Readonly<Record<GatewayToolCallingOutcome, readonly [RegExp, RegExp]>> = {
    "called-unforced": [/work/iu, /funktionier/iu],
    "called-only-forced": [/only when forced/iu, /nur auf, wenn der Aufruf erzwungen/iu],
    "forced-refused": [/not available/iu, /nicht verfügbar/iu],
    "no-call": [/not available/iu, /nicht verfügbar/iu],
    "tools-refused": [/not available/iu, /nicht verfügbar/iu],
    inconclusive: [/again/iu, /erneut/iu],
  };

  it.each(GATEWAY_TOOL_CALLING_OUTCOMES)("keeps the substance of the %s sentence", (outcome) => {
    const key = `settings.models.toolOutcome.${outcome}` as keyof typeof settingsMessages;
    const message = settingsMessages[key] as { en: string; de: string };
    const [english, german] = PINS[outcome];
    expect(message.en).toMatch(english);
    expect(message.de).toMatch(german);
  });

  it("names every path into the inconclusive outcome, the model not finishing the test included", () => {
    const message = settingsMessages["settings.models.toolOutcome.inconclusive"];
    expect(message.en).toMatch(/timed out/iu);
    expect(message.en).toMatch(/did not complete the test steps/iu);
    expect(message.de).toMatch(/nicht rechtzeitig/iu);
    expect(message.de).toMatch(/Testschritte nicht abgeschlossen/iu);
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
