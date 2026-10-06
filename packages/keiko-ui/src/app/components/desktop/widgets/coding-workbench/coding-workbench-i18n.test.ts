import { describe, expect, it } from "vitest";

import { DE_MESSAGES } from "@/lib/i18n-messages.de";
import { EN_MESSAGES } from "@/lib/i18n-messages.en";
import { translateCodingWorkbench } from "./coding-workbench-i18n";
import { DE_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.de";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";

describe("Coding Workbench translations", () => {
  it.each([
    "codingWorkbench.setup.runtimeUnavailable",
    "codingWorkbench.alert.runtimeUnqualified",
  ] as const)("explains the Windows npm runtime limitation in %s", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en).toContain("Windows network isolation is not implemented yet");
    expect(de).toContain("Windows-Netzwerkisolation ist noch nicht implementiert");
    for (const text of [en, de]) {
      expect(text).toContain("npm");
      expect(text).toContain("Mac");
      expect(text).toContain("@oscharko-dev/keiko-coding-runtime-darwin-arm64");
      expect(text).toContain("@oscharko-dev/keiko-coding-runtime-darwin-x64");
    }
  });

  it("localizes English and German feature labels", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.header.summary")).toBe(
      "Start and supervise one governed coding run. Authority and outcomes remain server-owned.",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.header.summary")).toBe(
      "Starte und beaufsichtige einen gesteuerten Coding-Lauf. Autorität und Ergebnisse bleiben serverseitig.",
    );
  });

  it("describes scoped Full delivery without advertising approval-free merge", () => {
    const en = translateCodingWorkbench(
      "en",
      "codingWorkbench.mode.autonomous-delivery.description",
    );
    const de = translateCodingWorkbench(
      "de",
      "codingWorkbench.mode.autonomous-delivery.description",
    );
    for (const text of [en, de]) {
      expect(text).toMatch(/commit/iu);
      expect(text).toMatch(/push/iu);
      expect(text).toMatch(/merge/iu);
    }
    expect(en).toContain("draft pull request");
    expect(en).toContain("Merge remains separately approval-gated");
    expect(de).toContain("Draft-Pull-Request");
    expect(de).toContain("Merge bleibt separat genehmigungspflichtig");
    expect(translateCodingWorkbench("en", "codingWorkbench.controls.help")).toContain(
      "server-confirmed mode",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.controls.help")).toContain(
      "serverbestätigten Modus",
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

  // #3878: the timeline shows the model's reasoning now, so its boundary copy says what is shown
  // instead of promising that reasoning is never exposed, and the reasoning is called unverified.
  it("describes the timeline's model reasoning as unverified in both catalogs", () => {
    const en = translateCodingWorkbench("en", "codingWorkbench.activity.reasoningBoundary");
    const de = translateCodingWorkbench("de", "codingWorkbench.activity.reasoningBoundary");
    expect(en).not.toContain("never exposes private reasoning");
    expect(en).toContain("model's own reasoning");
    expect(en).toContain("unverified");
    expect(de).not.toContain("niemals offengelegt");
    expect(de).toContain("ungeprüft");
  });

  it.each([
    "codingWorkbench.activity.reasoning.title",
    "codingWorkbench.activity.reasoning.badge",
    "codingWorkbench.activity.reasoning.note",
  ] as const)("localizes the reasoning label %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });

  it("addresses the reader informally in the German reasoning note", () => {
    const note = translateCodingWorkbench("de", "codingWorkbench.activity.reasoning.note");
    expect(note).toMatch(/\bdich\b/u);
    expect(note).not.toMatch(/\b(?:Ihnen|Ihre?)\b/u);
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

  it("falls back instead of crashing when a feature catalog is momentarily stale", () => {
    const key = "codingWorkbench.activity.toolCount";
    const messages = DE_CODING_WORKBENCH_MESSAGES as Partial<
      Record<CodingWorkbenchMessageKey, string>
    >;
    const previous = messages[key];
    expect(previous).toBeDefined();
    if (previous === undefined) {
      throw new TypeError(`${key} must exist before the stale-catalog regression runs`);
    }
    delete messages[key];

    try {
      expect(translateCodingWorkbench("de", key, { count: 3 })).toBe("3 calls");
    } finally {
      messages[key] = previous;
    }
  });

  it("returns the key instead of throwing when no catalog contains a runtime key", () => {
    const key = "codingWorkbench.runtime.missing" as CodingWorkbenchMessageKey;
    expect(translateCodingWorkbench("en", key)).toBe(key);
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

  // #3873 F1: a repository whose location the server's read surface excludes is a policy decision,
  // and both catalogs say so instead of suggesting the folder is not a Git repository.
  it("names a read-surface refusal as a policy decision in both catalogs", () => {
    const en = translateCodingWorkbench("en", "codingWorkbench.repository.deniedHelp");
    const de = translateCodingWorkbench("de", "codingWorkbench.repository.deniedHelp");
    expect(en).toContain("excluded from the read surface");
    expect(en).toContain("not a missing Git repository");
    expect(en).not.toMatch(/may not be a Git repository/iu);
    expect(de).toContain("von der Leseoberfläche ausgeschlossen");
    expect(de).toContain("kein fehlendes Git-Repository");
    expect(de).not.toMatch(/möglicherweise ist er kein Git-Repository/iu);
    expect(de).not.toMatch(/\b(?:Sie|Ihre?[mnrs]?)\b/u);
  });

  // F5 (#3873): a run its repeated edit refusals ended names the refusal class with a next step in
  // both catalogs, German in the informal du-form, and never as an internal error.
  it.each([
    "codingWorkbench.event.failure.edits-blocked",
    "codingWorkbench.event.failure.edit-retries-exhausted",
  ] as const)("explains %s with a next step and never as an internal error", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en).not.toBe(key);
    expect(de).not.toBe(key);
    expect(en).toMatch(/refused several times in a row/iu);
    expect(de).toMatch(/mehrmals hintereinander/iu);
    expect(en).toMatch(/start the task again/iu);
    expect(de).toMatch(/starte die Aufgabe/iu);
    expect(en).not.toMatch(/internal error/iu);
    expect(de).not.toMatch(/interne[nr]? Fehler/iu);
    expect(de).not.toMatch(/\b(?:Sie|Ihre?[mnrs]?)\b/u);
  });

  it("names the missing Workbench among the causes an edit block has", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.event.failure.edits-blocked")).toContain(
      "no Coding Workbench is connected for this workspace",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.event.failure.edits-blocked")).toContain(
      "keine Coding Workbench für diesen Arbeitsbereich verbunden",
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
    "codingWorkbench.questions.answerRejected",
  ] as const)("localizes %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });

  // #3390 wave: the trust affordance's strings — restated in both catalogs, not copied verbatim
  // from one to the other. The drift notice (ADR-0147 D3, 2026-09-10) and the run-waiting notice
  // (the pauseReason "workspace-script-trust" branch, 2026-09-10) join them.
  it.each([
    "codingWorkbench.trust.restrictedNotice",
    "codingWorkbench.trust.driftNotice",
    "codingWorkbench.trust.runWaitingNotice",
    "codingWorkbench.trust.allow",
    "codingWorkbench.trust.allowing",
  ] as const)("localizes %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });

  // #3390 wave: the workbench's own event-label catalog (`codingWorkbench.event.${eventKind}`,
  // read by codingWorkbenchLabels.ts) restates a distinct string for the operator-decision runtime
  // event kind — separate from the desktop-shell activity-bus label
  // ("activity.event.operatorDecision" in i18n-messages.en.ts / .de.ts, covered where that catalog
  // is tested).
  it("localizes codingWorkbench.event.operator-decision in both catalogs", () => {
    const en = translateCodingWorkbench("en", "codingWorkbench.event.operator-decision");
    const de = translateCodingWorkbench("de", "codingWorkbench.event.operator-decision");
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });

  // F9 (#3873, live Gemma qualification): a budget-exhausted run read "The coding run ended with an
  // internal error". Each terminal model-call cause is plain language with a next step in both
  // catalogs, German in the informal du-form, and only `runtime-failed` speaks of an internal error.
  it.each([
    "codingWorkbench.event.failure.prompt-allowance-exhausted",
    "codingWorkbench.event.failure.envelope-duration-exhausted",
    "codingWorkbench.event.failure.output-exhausted-repeated",
    "codingWorkbench.event.failure.provider-unavailable",
    "codingWorkbench.event.failure.model-turn-failed",
  ] as const)("explains %s with a next step and never as an internal error", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en).not.toBe(key);
    expect(de).not.toBe(key);
    expect(de).not.toBe(en);
    expect(en).not.toMatch(/internal error/iu);
    expect(de).not.toMatch(/interne[nr]? Fehler/iu);
    expect(en).toMatch(/start the task again/iu);
    expect(de).toMatch(/starte die Aufgabe/iu);
    expect(de).not.toMatch(/\b(?:Sie|Ihre?[mnrs]?)\b/u);
  });

  it("names the exhausted allowance and the outage window an operator can raise", () => {
    for (const locale of ["en", "de"] as const) {
      expect(
        translateCodingWorkbench(
          locale,
          "codingWorkbench.event.failure.prompt-allowance-exhausted",
        ),
      ).toContain("KEIKO_CODING_RUNTIME_MAX_PROMPT_TOKENS");
      expect(
        translateCodingWorkbench(
          locale,
          "codingWorkbench.event.failure.envelope-duration-exhausted",
        ),
      ).toContain("KEIKO_CODING_RUNTIME_MAX_DURATION_MINUTES");
      expect(
        translateCodingWorkbench(locale, "codingWorkbench.event.failure.provider-unavailable"),
      ).toContain("codingOutageWindowMs");
      expect(
        translateCodingWorkbench(locale, "codingWorkbench.event.failure.output-exhausted-repeated"),
      ).toContain("max_output_tokens");
    }
    expect(
      translateCodingWorkbench("en", "codingWorkbench.event.failure.prompt-allowance-exhausted"),
    ).toMatch(/prompt allowance/iu);
    expect(
      translateCodingWorkbench("en", "codingWorkbench.event.failure.provider-unavailable"),
    ).toMatch(/could not be reached/iu);
  });

  it("says an operator-stopped run was stopped on request and that nothing failed", () => {
    const en = translateCodingWorkbench("en", "codingWorkbench.event.stopped.operator");
    const de = translateCodingWorkbench("de", "codingWorkbench.event.stopped.operator");
    expect(en).toMatch(/you stopped this run/iu);
    expect(en).toMatch(/nothing failed/iu);
    expect(en).not.toMatch(/internal error/iu);
    expect(de).toMatch(/du hast diesen Lauf gestoppt/iu);
    expect(de).not.toMatch(/interne[nr]? Fehler/iu);
    expect(de).not.toMatch(/\b(?:Sie|Ihre?[mnrs]?)\b/u);
  });

  it("keeps the internal-error sentence for a genuine internal failure", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.event.failure.runtime")).toMatch(
      /internal error/iu,
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.event.failure.runtime")).toMatch(
      /internen Fehler/iu,
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
