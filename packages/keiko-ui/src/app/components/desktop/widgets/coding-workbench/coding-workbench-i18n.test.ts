import { describe, expect, it } from "vitest";

import { DE_MESSAGES } from "@/lib/i18n-messages.de";
import { EN_MESSAGES } from "@/lib/i18n-messages.en";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

describe("Coding Workbench translations", () => {
  it("localizes English and German feature labels", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.header.summary")).toBe(
      "Start and supervise one governed coding run. Authority and outcomes remain server-owned.",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.header.summary")).toBe(
      "Starte und beaufsichtige einen gesteuerten Coding-Lauf. Autorität und Ergebnisse bleiben serverseitig.",
    );
  });

  it("interpolates runtime state and revision in both catalogs", () => {
    expect(
      translateCodingWorkbench("en", "codingWorkbench.announcement.runRevision", {
        revision: 7,
        state: "Running",
      }),
    ).toBe("Running. Revision 7.");
    expect(
      translateCodingWorkbench("de", "codingWorkbench.announcement.runRevision", {
        revision: 7,
        state: "Wird ausgeführt",
      }),
    ).toBe("Wird ausgeführt. Revision 7.");
  });

  it("localizes the authenticated run-changes surface", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.changes.asOf", { head: "abc123" })).toBe(
      "As of abc123",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.changes.asOf", { head: "abc123" })).toBe(
      "Stand abc123",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.changes.diff.addedLine")).toBe(
      "Hinzugefügte Zeile",
    );
  });

  it("localizes the task-branch conflict with actionable copy", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.setup.branchConflict")).toBe(
      "The task branch for this coding run already exists. Remove the previous branch or its managed workspace. Alternatively, choose a different target branch.",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.setup.branchConflict")).toBe(
      "Der Aufgabenbranch für diesen Coding-Lauf existiert bereits. Entferne den früheren Branch oder den zugehörigen verwalteten Arbeitsbereich. Alternativ kannst du einen anderen Zielbranch wählen.",
    );
  });

  it("localizes the #2387 research grant, revoke, and auxiliary-outcome vocabulary", () => {
    const keys = [
      "codingWorkbench.research.chipLabel",
      "codingWorkbench.research.revoke",
      "codingWorkbench.research.revokeLabel",
      "codingWorkbench.announcement.researchActive",
      "codingWorkbench.event.child-run-completed",
      "codingWorkbench.outcomeLabel.denied",
      "codingWorkbench.outcomeLabel.limit-reached",
    ] as const;
    for (const key of keys) {
      const en = translateCodingWorkbench("en", key);
      const de = translateCodingWorkbench("de", key);
      expect(en.length).toBeGreaterThan(0);
      expect(de.length).toBeGreaterThan(0);
      expect(en).not.toBe(de);
    }
    expect(translateCodingWorkbench("en", "codingWorkbench.research.chipLabel")).toBe(
      "Internet · Research only",
    );
  });

  it("keeps every Coding Workbench key out of eager locale catalogs", () => {
    expect(Object.keys(EN_MESSAGES)).not.toContainEqual(
      expect.stringMatching(/^codingWorkbench\./u),
    );
    expect(Object.keys(DE_MESSAGES)).not.toContainEqual(
      expect.stringMatching(/^codingWorkbench\./u),
    );
  });
});
