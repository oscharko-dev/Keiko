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

  // ADR-0163 D9: every new key resolves non-empty in BOTH catalogs and the two strings differ, so
  // a German entry copied from the English one cannot pass as a translation. The wording must never
  // present the evaluation runtime with an unqualified "ready", "verified" or "confirmed".
  it.each([
    "codingWorkbench.readiness.runtime.label",
    "codingWorkbench.readiness.runtime.verified",
    "codingWorkbench.readiness.runtime.evaluation",
    "codingWorkbench.header.readyEvaluation",
    "codingWorkbench.announcement.runtime.evaluation",
    "codingWorkbench.setup.runtimeEvaluation",
  ] as const)("localizes %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });

  it.each([
    "codingWorkbench.readiness.runtime.evaluation",
    "codingWorkbench.header.readyEvaluation",
    "codingWorkbench.announcement.runtime.evaluation",
    "codingWorkbench.setup.runtimeEvaluation",
  ] as const)("names %s as unverified rather than ready or verified", (key) => {
    const en = translateCodingWorkbench("en", key);
    expect(en.toLowerCase()).toContain("unverified");
    expect(en).not.toMatch(/\bverified\b(?!\s*evaluation)/u);
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

  // The retired identity bound only the inode, so a same-path replacement reproduces it exactly:
  // the operator's approval — not a proof Keiko holds — is what re-registers the tree. The card is
  // the only place that judgement is made, so both catalogs must state the caveat the
  // task-workspace-identity-rule-retired troubleshooting entry already carries (#3381 review).
  it.each(["en", "de"] as const)(
    "states in %s that repairing re-registers whatever is on disk at that path",
    (locale) => {
      const text = translateCodingWorkbench(locale, "codingWorkbench.setup.repairRequired", {
        finding: "F",
        effect: "E",
      });
      expect(text).toContain(locale === "en" ? "at the same path" : "am selben Pfad");
      expect(text).toContain(
        locale === "en" ? "whatever is on disk" : "was dort auf der Festplatte",
      );
      expect(text).toContain(locale === "en" ? "Task workspaces" : "Task Workspaces");
    },
  );

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

  // #3381 review: both new governance strings — the one that explains why a run's chips no longer
  // follow the active workspace, and the one that explains a disabled Approve — must exist in both
  // catalogs, since either shown blank leaves an operator with an unexplained blocked control.
  it.each([
    "codingWorkbench.composer.workspaceMismatch",
    "codingWorkbench.approval.evidenceRequired",
  ] as const)("localizes %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });

  // #3390 wave: the trust affordance's three strings — restated in both catalogs, not copied
  // verbatim from one to the other.
  it.each([
    "codingWorkbench.trust.restrictedNotice",
    "codingWorkbench.trust.allow",
    "codingWorkbench.trust.allowing",
  ] as const)("localizes %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
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
