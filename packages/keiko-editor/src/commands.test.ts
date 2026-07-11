import { describe, expect, it } from "vitest";

import { EDITOR_COMMANDS, availableCommands, isCommandAvailable } from "./commands.js";
import type {
  EditorCommand,
  EditorCommandContext,
  EditorCommandId,
  EditorHostCapability,
} from "./commands.js";

const ALL_CAPABILITIES: readonly EditorHostCapability[] = [
  "saveDocument",
  "provideCompletions",
  "provideInlineCompletions",
  "provideDiagnostics",
  "provideContext",
  "askKeikoAboutSelection",
  "generateTests",
  "previewPatch",
  "applyPatchReview",
  "formatDocument",
  "runVerification",
  "runWorkspaceVerification",
  "renameSymbol",
];

const EXPECTED_IDS: readonly EditorCommandId[] = [
  "editor.save",
  "editor.triggerCompletion",
  "editor.triggerInlineCompletion",
  "editor.acceptInlineCompletion",
  "editor.rejectInlineCompletion",
  "editor.generateTests",
  "editor.askKeikoAboutSelection",
  "editor.runVerification",
  "editor.runFileTests",
  "editor.runTypecheck",
  "editor.runLint",
  "editor.runBuild",
  "editor.cancelVerification",
  "editor.previewPatch",
  "editor.openDiff",
  "editor.applyPatch",
  "editor.rejectPatch",
  "editor.format",
  "editor.find",
  "editor.requestContext",
  "editor.renameSymbol",
];

const baseContext = (overrides: Partial<EditorCommandContext> = {}): EditorCommandContext => ({
  readOnly: false,
  dirty: false,
  hasSelection: false,
  inlineCompletionVisible: false,
  pendingPatchId: null,
  verificationRunning: false,
  activeFileVerifiable: false,
  availableCapabilities: ALL_CAPABILITIES,
  ...overrides,
});

const command = (id: EditorCommandId): EditorCommand => {
  const found = EDITOR_COMMANDS.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`missing command ${id}`);
  }
  return found;
};

describe("EDITOR_COMMANDS", () => {
  it("has exactly one entry per command id", () => {
    const ids = EDITOR_COMMANDS.map((entry) => entry.id);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every command a human-readable title", () => {
    for (const entry of EDITOR_COMMANDS) {
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });
});

describe("isCommandAvailable capability gate", () => {
  it("is unavailable when a required capability is missing", () => {
    const ctx = baseContext({
      dirty: true,
      availableCapabilities: ALL_CAPABILITIES.filter((c) => c !== "saveDocument"),
    });
    expect(isCommandAvailable(command("editor.save"), ctx)).toBe(false);
  });

  it("requires applyPatchReview for both apply and reject", () => {
    const ctx = baseContext({
      pendingPatchId: "p1",
      availableCapabilities: ALL_CAPABILITIES.filter((c) => c !== "applyPatchReview"),
    });
    expect(isCommandAvailable(command("editor.applyPatch"), ctx)).toBe(false);
    expect(isCommandAvailable(command("editor.rejectPatch"), ctx)).toBe(false);
  });

  it("allows acceptInlineCompletion without any capability", () => {
    const ctx = baseContext({ inlineCompletionVisible: true, availableCapabilities: [] });
    expect(isCommandAvailable(command("editor.acceptInlineCompletion"), ctx)).toBe(true);
  });
});

describe("isCommandAvailable state gates", () => {
  it("save needs dirty and writable", () => {
    expect(isCommandAvailable(command("editor.save"), baseContext({ dirty: false }))).toBe(false);
    expect(isCommandAvailable(command("editor.save"), baseContext({ dirty: true }))).toBe(true);
    expect(
      isCommandAvailable(command("editor.save"), baseContext({ dirty: true, readOnly: true })),
    ).toBe(false);
  });

  it("read-only blocks editing commands", () => {
    const ctx = baseContext({ readOnly: true, inlineCompletionVisible: true, pendingPatchId: "p" });
    expect(isCommandAvailable(command("editor.triggerCompletion"), ctx)).toBe(false);
    expect(isCommandAvailable(command("editor.triggerInlineCompletion"), ctx)).toBe(false);
    expect(isCommandAvailable(command("editor.acceptInlineCompletion"), ctx)).toBe(false);
    expect(isCommandAvailable(command("editor.applyPatch"), ctx)).toBe(false);
    expect(isCommandAvailable(command("editor.renameSymbol"), ctx)).toBe(false);
  });

  it("read-only still allows reject, preview, Generate Tests, Ask Keiko, and context", () => {
    const ctx = baseContext({ readOnly: true, hasSelection: true, pendingPatchId: "p" });
    expect(isCommandAvailable(command("editor.rejectPatch"), ctx)).toBe(true);
    expect(isCommandAvailable(command("editor.previewPatch"), ctx)).toBe(true);
    expect(isCommandAvailable(command("editor.generateTests"), ctx)).toBe(true);
    expect(isCommandAvailable(command("editor.askKeikoAboutSelection"), ctx)).toBe(true);
    expect(isCommandAvailable(command("editor.requestContext"), ctx)).toBe(true);
  });

  it("offers Ask Keiko only when the host capability and a non-empty selection are present", () => {
    const askCommand = command("editor.askKeikoAboutSelection");
    expect(isCommandAvailable(askCommand, baseContext())).toBe(false);
    expect(isCommandAvailable(askCommand, baseContext({ hasSelection: true }))).toBe(true);
    expect(
      isCommandAvailable(
        askCommand,
        baseContext({ hasSelection: true, availableCapabilities: [] }),
      ),
    ).toBe(false);
  });

  it("gates the #1205 UX commands on capability and state", () => {
    // Find is editor-intrinsic: always available once mounted, even read-only with no capabilities.
    const bare = baseContext({ readOnly: true, availableCapabilities: [] });
    expect(isCommandAvailable(command("editor.find"), bare)).toBe(true);
    // Format rewrites the buffer: needs the formatDocument capability and a writable document.
    expect(isCommandAvailable(command("editor.format"), baseContext({ readOnly: true }))).toBe(
      false,
    );
    expect(
      isCommandAvailable(
        command("editor.format"),
        baseContext({ availableCapabilities: ["formatDocument"] }),
      ),
    ).toBe(true);
    // Reject suggestion needs a visible inline completion.
    expect(isCommandAvailable(command("editor.rejectInlineCompletion"), baseContext())).toBe(false);
    expect(
      isCommandAvailable(
        command("editor.rejectInlineCompletion"),
        baseContext({ inlineCompletionVisible: true }),
      ),
    ).toBe(true);
    // Open diff maps to the previewPatch capability; run verification needs a pending patch + cap.
    expect(
      isCommandAvailable(
        command("editor.openDiff"),
        baseContext({ availableCapabilities: ["previewPatch"] }),
      ),
    ).toBe(true);
    expect(
      isCommandAvailable(
        command("editor.runVerification"),
        baseContext({ availableCapabilities: ["runVerification"] }),
      ),
    ).toBe(false);
    expect(
      isCommandAvailable(
        command("editor.runVerification"),
        baseContext({ availableCapabilities: ["runVerification"], pendingPatchId: "p1" }),
      ),
    ).toBe(true);
  });

  it("acceptInlineCompletion needs a visible inline completion", () => {
    expect(isCommandAvailable(command("editor.acceptInlineCompletion"), baseContext())).toBe(false);
    expect(
      isCommandAvailable(
        command("editor.acceptInlineCompletion"),
        baseContext({ inlineCompletionVisible: true }),
      ),
    ).toBe(true);
  });

  it("apply and reject need a pending patch", () => {
    expect(isCommandAvailable(command("editor.applyPatch"), baseContext())).toBe(false);
    expect(isCommandAvailable(command("editor.rejectPatch"), baseContext())).toBe(false);
    const withPatch = baseContext({ pendingPatchId: "p1" });
    expect(isCommandAvailable(command("editor.applyPatch"), withPatch)).toBe(true);
    expect(isCommandAvailable(command("editor.rejectPatch"), withPatch)).toBe(true);
  });
});

describe("availableCommands", () => {
  it("returns the filtered subset for a writable dirty patch context", () => {
    const ids = availableCommands(
      baseContext({
        dirty: true,
        hasSelection: true,
        inlineCompletionVisible: true,
        pendingPatchId: "p1",
        activeFileVerifiable: true,
      }),
    ).map((entry) => entry.id);
    // editor.cancelVerification is available only while a run IS active (verificationRunning), the
    // inverse of the idle state that makes the four run commands available, so no single context can
    // offer both — it is excluded from this idle-state maximal set.
    const expected = EXPECTED_IDS.filter((id) => id !== "editor.cancelVerification");
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it("keeps only intrinsic always-on commands when no capability is present", () => {
    // `editor.find` requires no capability and has no extra state gate, so it survives an empty
    // capability set; every capability- or state-gated command is dropped.
    const ids = availableCommands(baseContext({ availableCapabilities: [] })).map(
      (entry) => entry.id,
    );
    expect(ids).toEqual(["editor.find"]);
  });

  it("threads both the capability and the state gate when only one capability is present", () => {
    const ids = availableCommands(
      baseContext({ availableCapabilities: ["saveDocument"], dirty: true }),
    ).map((entry) => entry.id);
    // Save (capability + dirty) plus the intrinsic, always-available Find.
    expect([...ids].sort()).toEqual(["editor.find", "editor.save"]);
  });
});

describe("run affordances (Issue #2212, ADR-0126)", () => {
  const RUN_COMMANDS: readonly EditorCommandId[] = [
    "editor.runFileTests",
    "editor.runTypecheck",
    "editor.runLint",
    "editor.runBuild",
  ];

  it("gates the four run commands on the runWorkspaceVerification capability being present", () => {
    const withCap = baseContext({ activeFileVerifiable: true });
    const withoutCap = baseContext({
      activeFileVerifiable: true,
      availableCapabilities: ALL_CAPABILITIES.filter((c) => c !== "runWorkspaceVerification"),
    });
    for (const id of RUN_COMMANDS) {
      expect(isCommandAvailable(command(id), withCap)).toBe(true);
      expect(isCommandAvailable(command(id), withoutCap)).toBe(false);
    }
  });

  it("offers the run commands only while idle and cancel only while running (mutually exclusive)", () => {
    const idle = baseContext({ verificationRunning: false, activeFileVerifiable: true });
    const running = baseContext({ verificationRunning: true, activeFileVerifiable: true });
    for (const id of RUN_COMMANDS) {
      expect(isCommandAvailable(command(id), idle)).toBe(true);
      expect(isCommandAvailable(command(id), running)).toBe(false);
    }
    expect(isCommandAvailable(command("editor.cancelVerification"), idle)).toBe(false);
    expect(isCommandAvailable(command("editor.cancelVerification"), running)).toBe(true);
  });

  it("gates runFileTests additionally on a resolvable target (activeFileVerifiable)", () => {
    expect(
      isCommandAvailable(
        command("editor.runFileTests"),
        baseContext({ activeFileVerifiable: false }),
      ),
    ).toBe(false);
    expect(
      isCommandAvailable(
        command("editor.runFileTests"),
        baseContext({ activeFileVerifiable: true }),
      ),
    ).toBe(true);
    // The workspace-wide kinds do NOT depend on a resolvable file target.
    expect(
      isCommandAvailable(
        command("editor.runTypecheck"),
        baseContext({ activeFileVerifiable: false }),
      ),
    ).toBe(true);
  });

  it("leaves editor.runVerification's shape and patch-review gate unchanged", () => {
    const runVerification = command("editor.runVerification");
    expect(runVerification.title).toBe("Run Verification");
    expect(runVerification.requiredCapabilities).toEqual(["runVerification"]);
    // Still gated to a pending patch (not the new runWorkspaceVerification state).
    expect(isCommandAvailable(runVerification, baseContext({ pendingPatchId: "p1" }))).toBe(true);
    expect(isCommandAvailable(runVerification, baseContext({ pendingPatchId: null }))).toBe(false);
  });
});
