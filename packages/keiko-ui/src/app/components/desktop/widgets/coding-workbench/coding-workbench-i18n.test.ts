import { describe, expect, it } from "vitest";

import { DE_MESSAGES } from "@/lib/i18n-messages.de";
import { EN_MESSAGES } from "@/lib/i18n-messages.en";
import { translateCodingWorkbench } from "./coding-workbench-i18n";
import { DE_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.de";
import {
  EN_CODING_WORKBENCH_MESSAGES,
  type CodingWorkbenchMessageKey,
} from "./coding-workbench-i18n.en";

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
    "codingWorkbench.activity.exitCode",
    "codingWorkbench.activity.toolError",
    "codingWorkbench.activity.toolState.waiting-for-trust",
    "codingWorkbench.activity.toolState.no-runnable-steps",
    "codingWorkbench.activity.toolState.not-run",
    "codingWorkbench.activity.verification.passed",
    "codingWorkbench.activity.verification.failed-check",
    "codingWorkbench.activity.verification.waiting-for-trust",
    "codingWorkbench.activity.verification.no-runnable-steps",
    "codingWorkbench.activity.verification.not-run",
  ] as const)("localizes the reasoning label %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
  });

  // ADR-0137 D10: the `/` command menu, the sentence that holds a send until the run's commands are
  // known, and the refusal of a start whose files or command were not accepted. Both catalogs
  // carry every key, the German one translated rather than copied, in the informal du-form.
  it.each([
    "codingWorkbench.composer.commands.title",
    "codingWorkbench.composer.commands.results",
    "codingWorkbench.composer.commands.option",
    "codingWorkbench.composer.commands.active",
    "codingWorkbench.composer.commands.loading",
    "codingWorkbench.composer.commands.found",
    "codingWorkbench.composer.commands.empty",
    "codingWorkbench.composer.commands.none",
    "codingWorkbench.composer.commands.error",
    "codingWorkbench.composer.commands.retry",
    "codingWorkbench.composer.commands.init.description",
    "codingWorkbench.composer.commands.review.description",
    "codingWorkbench.composer.blocked.commandsLoading",
    "codingWorkbench.event.failure.invalid-intent",
  ] as const)("localizes %s in both catalogs", (key) => {
    const en = translateCodingWorkbench("en", key, { name: "n", count: 1, position: 1, total: 1 });
    const de = translateCodingWorkbench("de", key, { name: "n", count: 1, position: 1, total: 1 });
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    // Only the position announcement `/{name}, {position} of {total}` shares its words with German.
    if (key !== "codingWorkbench.composer.commands.active") expect(de).not.toBe(en);
    expect(de).not.toMatch(/\b(?:Sie|Ihre?[mnrs]?)\b/u);
    expect(de).not.toMatch(/\{\w+\}/u);
  });

  it("keeps the placeholders the command menu fills in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      expect(
        translateCodingWorkbench(locale, "codingWorkbench.composer.commands.option"),
      ).toContain("{name}");
      expect(translateCodingWorkbench(locale, "codingWorkbench.composer.commands.found")).toContain(
        "{count}",
      );
      expect(translateCodingWorkbench(locale, "codingWorkbench.composer.commands.active")).toMatch(
        /\{name\}.*\{position\}.*\{total\}/u,
      );
    }
  });

  // #3907 (owner: less is more): the approval card's native help is one short sentence about what
  // Approve does, never a second sentence explaining Deny.
  it.each([
    "codingWorkbench.approval.native.help",
    "codingWorkbench.approval.native.help.shell",
    "codingWorkbench.approval.native.help.edit",
    "codingWorkbench.approval.native.help.execute",
    "codingWorkbench.approval.native.help.worktree",
  ] as const)("keeps the native approval help %s to one short sentence", (key) => {
    for (const locale of ["en", "de"] as const) {
      const help = translateCodingWorkbench(locale, key);
      expect(help.length).toBeLessThanOrEqual(90);
      expect(help).not.toMatch(/\b(?:deny|Ablehnen)\b/iu);
    }
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

  // #3873 review: both settings are read once when Keiko starts and both have a hard cap, so an
  // operator who sets the variable in a running Keiko, or past its cap, saw the same limit again.
  // Each message states the cap and that Keiko must be restarted, in both languages. The caps are
  // pinned against the server's own constants by tests/qa/coding-limit-message-parity.test.ts.
  it.each([
    [
      "codingWorkbench.event.failure.prompt-allowance-exhausted",
      "20,000,000 tokens",
      "20.000.000 Tokens",
    ],
    ["codingWorkbench.event.failure.envelope-duration-exhausted", "480 minutes", "480 Minuten"],
  ] as const)("states the cap and the restart in %s", (key, enCap, deCap) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(en).toContain(`up to ${enCap}`);
    expect(en).toMatch(/reads the setting only when it starts/iu);
    expect(en).toMatch(/restart Keiko after changing it/iu);
    expect(de).toContain(`bis höchstens ${deCap}`);
    expect(de).toMatch(/liest die Einstellung nur beim Start/iu);
    expect(de).toMatch(/muss Keiko neu gestartet werden/iu);
  });

  // #3873 review: a `cancelled` run does not record who stopped it — the operator's Stop and a
  // Keiko shutdown (an update, a restart, a machine shutdown) settle identically — so the sentence
  // says the run was stopped and that nothing failed, in both catalogs, and never attributes the
  // stop to the operator.
  it("says a stopped run was stopped and that nothing failed, without attributing the stop", () => {
    const en = translateCodingWorkbench("en", "codingWorkbench.event.stopped");
    const de = translateCodingWorkbench("de", "codingWorkbench.event.stopped");
    expect(en).not.toBe("codingWorkbench.event.stopped");
    expect(de).not.toBe("codingWorkbench.event.stopped");
    expect(de).not.toBe(en);
    expect(en).toMatch(/this run was stopped/iu);
    expect(en).toMatch(/nothing failed/iu);
    expect(en).not.toMatch(/internal error/iu);
    expect(en).not.toMatch(/\byou stopped\b|\bstopped by you\b|\boperator\b/iu);
    expect(de).toMatch(/dieser Lauf wurde gestoppt/iu);
    expect(de).not.toMatch(/interne[nr]? Fehler/iu);
    expect(de).not.toMatch(/\bdu hast\b|\bvon dir\b|\bBetreiber\b/iu);
    expect(de).not.toMatch(/\b(?:Sie|Ihre?[mnrs]?)\b/u);
  });

  it("no longer carries the operator-attributed stop key", () => {
    for (const catalog of [EN_CODING_WORKBENCH_MESSAGES, DE_CODING_WORKBENCH_MESSAGES]) {
      expect(Object.keys(catalog)).not.toContain("codingWorkbench.event.stopped.operator");
    }
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

// #3897 review: the native OpenCode profile's approval card, tool names, plan progress and mode
// texts. Every key resolves in both catalogs with a distinct German text, and the German product
// wording addresses nobody (neither "Sie" nor "du"), like the approval strings around it.
describe("Coding Workbench native profile copy", () => {
  const NATIVE_KEYS = [
    "codingWorkbench.approval.native.help",
    "codingWorkbench.approval.native.help.shell",
    "codingWorkbench.approval.native.help.edit",
    "codingWorkbench.approval.native.help.internet",
    "codingWorkbench.approval.native.noResources",
    "codingWorkbench.approval.native.nothingNamed",
    "codingWorkbench.approval.native.resources",
    "codingWorkbench.approval.native.unavailable",
    "codingWorkbench.activity.plan.progress",
    "codingWorkbench.timeline.tool.read",
    "codingWorkbench.timeline.tool.glob",
    "codingWorkbench.timeline.tool.grep",
    "codingWorkbench.timeline.tool.list",
    "codingWorkbench.timeline.tool.edit",
    "codingWorkbench.timeline.tool.write",
    "codingWorkbench.timeline.tool.patch",
    "codingWorkbench.timeline.tool.shell",
    "codingWorkbench.timeline.tool.webfetch",
    "codingWorkbench.timeline.tool.websearch",
    "codingWorkbench.timeline.tool.skill",
    "codingWorkbench.timeline.tool.subagent",
    "codingWorkbench.timeline.tool.todo",
    "codingWorkbench.timeline.tool.question",
    "codingWorkbench.mode.governed-assist.short",
    "codingWorkbench.mode.supervised-coding.short",
    "codingWorkbench.mode.autonomous-delivery.short",
    "codingWorkbench.mode.governed-assist.description",
    "codingWorkbench.mode.supervised-coding.description",
    "codingWorkbench.mode.autonomous-delivery.description",
  ] as const;

  it.each(NATIVE_KEYS)("localizes %s in both catalogs without addressing the reader", (key) => {
    const en = translateCodingWorkbench("en", key, { completed: 1, total: 2 });
    const de = translateCodingWorkbench("de", key, { completed: 1, total: 2 });
    expect(en.length).toBeGreaterThan(0);
    expect(de.length).toBeGreaterThan(0);
    // "Skill", "Subagent" and the plan counter are the same word or number in both languages.
    if (!/\.tool\.(?:skill|subagent)$|plan\.progress$/u.test(key)) expect(de).not.toBe(en);
    expect(de).not.toMatch(/\b(?:Sie|Ihre?[mnrs]?|du|dich|dir|dein\w*)\b/u);
  });

  it("states grammatically correct German when a native ask names nothing", () => {
    expect(translateCodingWorkbench("de", "codingWorkbench.approval.native.noResources")).toBe(
      "Weder Befehl noch Pfad noch Adresse wurde genannt.",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.approval.native.unavailable")).toBe(
      "Die angeforderte Aktion ist nicht abrufbar. Fenster erneut koppeln, um sie vor der Entscheidung zu sehen.",
    );
  });

  it("counts completed plan steps in both catalogs", () => {
    expect(
      translateCodingWorkbench("en", "codingWorkbench.activity.plan.progress", {
        completed: 2,
        total: 5,
      }),
    ).toBe("2/5 completed");
    expect(
      translateCodingWorkbench("de", "codingWorkbench.activity.plan.progress", {
        completed: 2,
        total: 5,
      }),
    ).toBe("2/5 abgeschlossen");
  });

  it("limits the internet help to Full access and the shell help to the task workspace", () => {
    for (const locale of ["en", "de"] as const) {
      const internet = translateCodingWorkbench(
        locale,
        "codingWorkbench.approval.native.help.internet",
      );
      const shell = translateCodingWorkbench(locale, "codingWorkbench.approval.native.help.shell");
      expect(internet).toMatch(locale === "en" ? /Full access/u : /Vollzugriff/u);
      expect(internet).not.toMatch(/workspace|Workspace|Arbeitsbereich/u);
      expect(shell).toMatch(locale === "en" ? /task workspace/u : /Aufgaben-Workspace/u);
    }
  });

  // The three modes as the native OpenCode profile enforces them: what asks, what runs, where the
  // internet is, and what no mode ever allows (Keiko delivers through Git, never the agent's shell;
  // nothing outside the workspace; no secret files).
  it("describes each mode for the native profile in both catalogs", () => {
    const modes = ["governed-assist", "supervised-coding", "autonomous-delivery"] as const;
    for (const mode of modes) {
      for (const locale of ["en", "de"] as const) {
        const text = translateCodingWorkbench(locale, `codingWorkbench.mode.${mode}.description`);
        expect(text).toContain(".env");
        expect(text).toMatch(locale === "en" ? /Keiko/u : /Keiko/u);
        expect(text).toMatch(
          locale === "en" ? /never by the agent's shell/u : /nie die Shell des Agenten/u,
        );
        expect(text).toMatch(
          locale === "en" ? /outside the workspace/u : /außerhalb des Arbeitsbereichs/u,
        );
      }
    }
    expect(translateCodingWorkbench("en", "codingWorkbench.mode.governed-assist.short")).toBe(
      "Reads freely; asks before every file change and command",
    );
    expect(translateCodingWorkbench("en", "codingWorkbench.mode.supervised-coding.short")).toBe(
      "Routine edits and vetted project commands run; other commands ask",
    );
    expect(translateCodingWorkbench("en", "codingWorkbench.mode.autonomous-delivery.short")).toBe(
      "Works without asking within the task's authority; internet only here",
    );
    for (const mode of ["governed-assist", "supervised-coding"] as const) {
      expect(translateCodingWorkbench("en", `codingWorkbench.mode.${mode}.description`)).toContain(
        "no internet access",
      );
      expect(translateCodingWorkbench("de", `codingWorkbench.mode.${mode}.description`)).toContain(
        "Internetzugriff gibt es nicht",
      );
    }
  });

  // #4108: the windowed diff view names its totals, position and controls in both languages.
  it.each([
    "codingWorkbench.diffWindow.notice",
    "codingWorkbench.diffWindow.files",
    "codingWorkbench.diffWindow.fileMeta",
    "codingWorkbench.diffWindow.fileMetaBinary",
    "codingWorkbench.diffWindow.position",
    "codingWorkbench.diffWindow.positionEmpty",
    "codingWorkbench.diffWindow.pages",
    "codingWorkbench.diffWindow.previous",
    "codingWorkbench.diffWindow.next",
    "codingWorkbench.diffWindow.pageOf",
  ] as const)("localizes %s in both catalogs with the same placeholders", (key) => {
    const en = translateCodingWorkbench("en", key);
    const de = translateCodingWorkbench("de", key);
    expect(de.length).toBeGreaterThan(0);
    expect(de).not.toBe(en);
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/gu)].map((m) => m[1] ?? "").sort();
    expect(placeholders(de)).toEqual(placeholders(en));
  });
});
