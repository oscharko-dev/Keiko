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

  // Issue #2120: agent-presence-indicator labels moved out of hardcoded English literals.
  it("localizes the agent-presence-indicator labels and interpolates the action count", () => {
    expect(translateEditorAgent("en", "presence.detached")).toBe(
      "Agent not attached - no recent activity",
    );
    expect(translateEditorAgent("de", "presence.detached")).toBe(
      "Agent nicht verbunden - keine aktuelle Aktivität",
    );
    expect(translateEditorAgent("en", "presence.idle")).toBe("Agent attached - idle");
    expect(translateEditorAgent("de", "presence.idle")).toBe("Agent verbunden - inaktiv");
    expect(translateEditorAgent("en", "presence.active.one")).toBe(
      "Agent attached - 1 action in progress",
    );
    expect(translateEditorAgent("de", "presence.active.one")).toBe(
      "Agent verbunden - 1 Aktion in Bearbeitung",
    );
    expect(translateEditorAgent("en", "presence.active.many", { count: 3 })).toBe(
      "Agent attached - 3 actions in progress",
    );
    expect(translateEditorAgent("de", "presence.active.many", { count: 3 })).toBe(
      "Agent verbunden - 3 Aktionen in Bearbeitung",
    );
    expect(translateEditorAgent("en", "presence.review.active")).toBe(
      "Agent attached - review required",
    );
    expect(translateEditorAgent("de", "presence.review.active")).toBe(
      "Agent verbunden - Prüfung erforderlich",
    );
    expect(translateEditorAgent("en", "presence.review.idle")).toBe(
      "Agent review required - no recent activity",
    );
    expect(translateEditorAgent("de", "presence.review.idle")).toBe(
      "Prüfung erforderlich - keine aktuelle Aktivität",
    );
  });
});
