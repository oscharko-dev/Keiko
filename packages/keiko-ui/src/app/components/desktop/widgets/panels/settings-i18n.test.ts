import { describe, expect, it } from "vitest";

import settingsMessages from "./settings-i18n.messages.json";

describe("settings tab translations", () => {
  it("contains exact English and German labels for the Debugging tab", () => {
    expect(settingsMessages["settings.tabs.debugging"]).toEqual({
      en: "Debugging",
      de: "Debugging",
    });
  });
});
