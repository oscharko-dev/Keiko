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
  "generateTests",
  "previewPatch",
  "applyPatchReview",
];

const EXPECTED_IDS: readonly EditorCommandId[] = [
  "editor.save",
  "editor.triggerCompletion",
  "editor.triggerInlineCompletion",
  "editor.acceptInlineCompletion",
  "editor.generateTests",
  "editor.previewPatch",
  "editor.applyPatch",
  "editor.rejectPatch",
  "editor.requestContext",
];

const baseContext = (overrides: Partial<EditorCommandContext> = {}): EditorCommandContext => ({
  readOnly: false,
  dirty: false,
  hasSelection: false,
  inlineCompletionVisible: false,
  pendingPatchId: null,
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
  });

  it("read-only still allows reject, preview, generateTests, and requestContext", () => {
    const ctx = baseContext({ readOnly: true, pendingPatchId: "p" });
    expect(isCommandAvailable(command("editor.rejectPatch"), ctx)).toBe(true);
    expect(isCommandAvailable(command("editor.previewPatch"), ctx)).toBe(true);
    expect(isCommandAvailable(command("editor.generateTests"), ctx)).toBe(true);
    expect(isCommandAvailable(command("editor.requestContext"), ctx)).toBe(true);
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
      baseContext({ dirty: true, inlineCompletionVisible: true, pendingPatchId: "p1" }),
    ).map((entry) => entry.id);
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("drops capability-less and state-gated commands", () => {
    const ids = availableCommands(baseContext({ availableCapabilities: [] })).map(
      (entry) => entry.id,
    );
    expect(ids).toEqual([]);
  });

  it("threads both the capability and the state gate when only one capability is present", () => {
    const ids = availableCommands(
      baseContext({ availableCapabilities: ["saveDocument"], dirty: true }),
    ).map((entry) => entry.id);
    expect(ids).toEqual(["editor.save"]);
  });
});
