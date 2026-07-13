import { describe, expect, it } from "vitest";

import { debuggingTranslate } from "./debugging-i18n";

describe("debuggingTranslate", () => {
  it("returns the exact English lazy-panel copy", () => {
    const t = debuggingTranslate("en");

    expect(t("title")).toBe("Governed debugging");
    expect(t("stateDisabledByPolicy")).toBe("Disabled by policy");
    expect(t("confirmDisable")).toBe("Disable debugging");
  });

  it("returns the exact German lazy-panel copy", () => {
    const t = debuggingTranslate("de");

    expect(t("title")).toBe("Gesteuertes Debugging");
    expect(t("stateNotProvisioned")).toBe("Nicht bereitgestellt");
    expect(t("confirmDisable")).toBe("Debugging deaktivieren");
  });
});
