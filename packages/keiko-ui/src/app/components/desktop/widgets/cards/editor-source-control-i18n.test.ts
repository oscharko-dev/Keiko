import { describe, expect, it } from "vitest";

import { translateEditorSourceControl } from "./editor-source-control-i18n";

describe("editor source-control i18n", () => {
  it("translates command and status labels in both supported locales", () => {
    expect(translateEditorSourceControl("en", "conflicts.next")).toBe("Go to next merge conflict");
    expect(translateEditorSourceControl("de", "conflicts.next")).toBe(
      "Zum nächsten Merge-Konflikt",
    );
    expect(translateEditorSourceControl("en", "conflicts.status", { count: 2 })).toBe(
      "2 conflicts",
    );
    expect(translateEditorSourceControl("de", "conflicts.status", { count: 2 })).toBe(
      "2 Konflikte",
    );
  });
});
