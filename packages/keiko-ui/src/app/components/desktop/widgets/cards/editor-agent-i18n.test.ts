import { describe, expect, it } from "vitest";

import { translateEditorAgent } from "./editor-agent-i18n";

describe("editor agent translations", () => {
  it("localizes code-apply states and interpolates conflict codes", () => {
    expect(translateEditorAgent("en", "chat.codeApply.conflict", { code: "DIRTY" })).toBe(
      "Conflict: DIRTY",
    );
    expect(translateEditorAgent("de", "chat.codeApply.conflict", { code: "DIRTY" })).toBe(
      "Konflikt: DIRTY",
    );
    expect(translateEditorAgent("de", "chat.codeApply.outcomeUnknownStatus")).toBe(
      "Ergebnis unbekannt. Prüfe den Editor.",
    );
  });

  it("localizes selection and content-free review notices", () => {
    expect(translateEditorAgent("de", "editor.askSelection.selectText")).toBe(
      "Wähle Text im aktiven Editor aus, bevor du Keiko fragst.",
    );
    expect(translateEditorAgent("en", "editor.agentReview.awaitingResult")).toBe(
      "The review result is unknown. Waiting for authoritative editor status.",
    );
    expect(translateEditorAgent("de", "editor.agentReview.timedOut")).toBe(
      "Die Editor-Prüfung ist abgelaufen. Fordere die Änderung erneut an.",
    );
  });

  it("localizes conflict and recent-action surfaces", () => {
    expect(translateEditorAgent("de", "conflict.title.dirty")).toBe(
      "Konflikt mit ungespeicherten Änderungen",
    );
    expect(
      translateEditorAgent("en", "actions.rowSummary", {
        action: "Save",
        disposition: "Allowed",
        outcome: "succeeded",
        reason: "",
        target: " on src/app.ts",
      }),
    ).toBe("Save on src/app.ts: Allowed, succeeded");
  });
});
