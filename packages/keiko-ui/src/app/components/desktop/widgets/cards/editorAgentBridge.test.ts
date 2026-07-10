/**
 * Pure unit tests for dispatchEditorAgentAction (Issue #1393, ADR-0061).
 *
 * No React, no FakeEventSource, no DOM. Every branch of the pure dispatcher is
 * exercised with a stub-filled EditorAgentActionControllers and a minimal action
 * object. Tests fail if the corresponding condition in the dispatcher is removed
 * or mutated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorAgentAction } from "../../../../../lib/types";
import { dispatchEditorAgentAction, type EditorAgentActionControllers } from "./editorAgentBridge";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
const ACTIVE_BUFFER_ACTIONS = new Set<EditorAgentAction["type"]>([
  "setSelection",
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
]);

function makeAction(
  type: EditorAgentAction["type"],
  target?: EditorAgentAction["target"],
  overrides: Partial<EditorAgentAction> = {},
): EditorAgentAction {
  seq += 1;
  const resolvedTarget = ACTIVE_BUFFER_ACTIONS.has(type)
    ? { file: "src/active.ts", paneId: "pane-1", ...target }
    : target;
  return {
    schemaVersion: "1",
    actionId: `action-${seq}`,
    idempotencyKey: `ik-${seq}`,
    sessionId: `session-${seq}`,
    type,
    ...(resolvedTarget !== undefined ? { target: resolvedTarget } : {}),
    ...overrides,
  };
}

function makeControllers(
  overrides: Partial<EditorAgentActionControllers> = {},
): EditorAgentActionControllers {
  return {
    paneId: "pane-1",
    activePaneId: "pane-1",
    activeFile: "src/active.ts",
    verifyActiveTarget: vi.fn(() => true),
    verifyWritePrecondition: vi.fn(() => true),
    onSelectOpenFile: vi.fn(),
    formattingEnabled: true,
    formatRequest: { increment: vi.fn() },
    persist: vi.fn().mockResolvedValue(true),
    currentText: () => "text",
    applyTextEdits: vi.fn(),
    applyPatch: vi.fn(),
    applyChangeset: vi.fn(),
    onSplitPane: vi.fn(),
    onMoveTab: vi.fn(),
    onRequestSelectionReveal: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
  vi.resetAllMocks();
});

// ─── openFile / focusTab ──────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — openFile / focusTab", () => {
  it("returns failed with 'Missing target file.' when target.file is absent (openFile)", () => {
    const controllers = makeControllers();
    const result = dispatchEditorAgentAction(makeAction("openFile"), controllers);
    expect(result).toEqual({ status: "failed", message: "Missing target file." });
    expect(controllers.onSelectOpenFile).not.toHaveBeenCalled();
  });

  it("returns failed with 'Missing target file.' when target.file is absent (focusTab)", () => {
    const controllers = makeControllers();
    const result = dispatchEditorAgentAction(makeAction("focusTab"), controllers);
    expect(result).toEqual({ status: "failed", message: "Missing target file." });
  });

  it("returns succeeded and calls onSelectOpenFile when target.file is present (openFile)", () => {
    const controllers = makeControllers();
    const result = dispatchEditorAgentAction(
      makeAction("openFile", { file: "src/main.ts" }),
      controllers,
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(controllers.onSelectOpenFile).toHaveBeenCalledWith("src/main.ts");
  });

  it("returns succeeded even when onSelectOpenFile is undefined (focusTab, no-op)", () => {
    const controllers = makeControllers({ onSelectOpenFile: undefined });
    const result = dispatchEditorAgentAction(
      makeAction("focusTab", { file: "src/main.ts" }),
      controllers,
    );
    expect(result).toEqual({ status: "succeeded" });
  });
});

// ─── format ──────────────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — format", () => {
  it("returns failed when formattingEnabled is false", () => {
    const controllers = makeControllers({ formattingEnabled: false });
    const result = dispatchEditorAgentAction(makeAction("format"), controllers);
    expect(result).toEqual({
      status: "failed",
      message: "Formatting is unavailable for this language.",
    });
    expect(controllers.formatRequest.increment).not.toHaveBeenCalled();
  });

  it("increments the nonce and returns succeeded when formattingEnabled is true", () => {
    const controllers = makeControllers({ formattingEnabled: true });
    const result = dispatchEditorAgentAction(makeAction("format"), controllers);
    expect(result).toEqual({ status: "succeeded" });
    expect(controllers.formatRequest.increment).toHaveBeenCalledTimes(1);
  });
});

// ─── save ─────────────────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — save", () => {
  it("returns async status immediately", () => {
    const controllers = makeControllers();
    const descriptor = dispatchEditorAgentAction(makeAction("save"), controllers);
    expect(descriptor.status).toBe("async");
  });

  it("the async promise resolves to succeeded when persist resolves true", async () => {
    const controllers = makeControllers({ persist: vi.fn().mockResolvedValue(true) });
    const descriptor = dispatchEditorAgentAction(makeAction("save"), controllers);
    if (descriptor.status !== "async") throw new Error("Expected async");
    const resolved = await descriptor.promise;
    expect(resolved).toEqual({ status: "succeeded" });
  });

  it("the async promise resolves to failed with 'Save failed.' when persist resolves false", async () => {
    const controllers = makeControllers({ persist: vi.fn().mockResolvedValue(false) });
    const descriptor = dispatchEditorAgentAction(makeAction("save"), controllers);
    if (descriptor.status !== "async") throw new Error("Expected async");
    const resolved = await descriptor.promise;
    expect(resolved).toEqual({ status: "failed", message: "Save failed." });
  });

  it("calls persist with the result of currentText()", () => {
    const controllers = makeControllers({
      currentText: () => "live buffer",
      persist: vi.fn().mockResolvedValue(true),
    });
    dispatchEditorAgentAction(makeAction("save"), controllers);
    expect(controllers.persist).toHaveBeenCalledWith("live buffer");
  });
});

// ─── applyTextEdits ──────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — applyTextEdits", () => {
  it("returns deferred and delegates to applyTextEdits controller", () => {
    const controllers = makeControllers();
    const action = makeAction("applyTextEdits");
    const result = dispatchEditorAgentAction(action, controllers);
    expect(result).toEqual({ status: "deferred" });
    expect(controllers.applyTextEdits).toHaveBeenCalledWith(action);
  });
});

// ─── applyPatch ───────────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — applyPatch", () => {
  it("returns deferred and delegates to applyPatch controller", () => {
    const controllers = makeControllers();
    const action = makeAction("applyPatch");
    const result = dispatchEditorAgentAction(action, controllers);
    expect(result).toEqual({ status: "deferred" });
    expect(controllers.applyPatch).toHaveBeenCalledWith(action);
  });
});

// ─── applyChangeset ───────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — applyChangeset", () => {
  it("returns deferred and delegates to the applyChangeset controller", () => {
    const controllers = makeControllers();
    const action = makeAction("applyChangeset");
    const result = dispatchEditorAgentAction(action, controllers);
    expect(result).toEqual({ status: "deferred" });
    expect(controllers.applyChangeset).toHaveBeenCalledWith(action);
  });

  it("fails closed when the changeset controller is unavailable", () => {
    const controllers = makeControllers({ applyChangeset: undefined });
    const result = dispatchEditorAgentAction(makeAction("applyChangeset"), controllers);
    expect(result).toEqual({ status: "failed", message: "Provider unavailable." });
  });
});

// ─── splitPane ────────────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — splitPane", () => {
  it("returns failed 'Provider unavailable.' when onSplitPane is undefined", () => {
    const controllers = makeControllers({ onSplitPane: undefined });
    const result = dispatchEditorAgentAction(makeAction("splitPane"), controllers);
    expect(result).toEqual({ status: "failed", message: "Provider unavailable." });
  });

  it("returns failed 'Missing target pane.' when paneId is undefined and no target.paneId", () => {
    const controllers = makeControllers({ paneId: undefined });
    const result = dispatchEditorAgentAction(makeAction("splitPane"), controllers);
    expect(result).toEqual({ status: "failed", message: "Missing target pane." });
    expect(controllers.onSplitPane).not.toHaveBeenCalled();
  });

  it("returns succeeded and calls onSplitPane with default 'row' direction", () => {
    const controllers = makeControllers({ paneId: "pane-1" });
    const result = dispatchEditorAgentAction(makeAction("splitPane"), controllers);
    expect(result).toEqual({ status: "succeeded" });
    expect(controllers.onSplitPane).toHaveBeenCalledWith("pane-1", "row");
  });

  it("passes explicit target.paneId and splitDirection to onSplitPane", () => {
    const controllers = makeControllers({ paneId: "default-pane" });
    const result = dispatchEditorAgentAction(
      makeAction("splitPane", { paneId: "target-pane", splitDirection: "column" }),
      controllers,
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(controllers.onSplitPane).toHaveBeenCalledWith("target-pane", "column");
  });
});

// ─── moveTab ──────────────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — moveTab", () => {
  it("returns failed 'Missing target file.' when target.file is absent", () => {
    const controllers = makeControllers();
    const result = dispatchEditorAgentAction(makeAction("moveTab"), controllers);
    expect(result).toEqual({ status: "failed", message: "Missing target file." });
    expect(controllers.onMoveTab).not.toHaveBeenCalled();
  });

  it("returns conflict OUT_OF_SCOPE when file escapes workspace root with '../'", () => {
    const controllers = makeControllers();
    const result = dispatchEditorAgentAction(
      makeAction("moveTab", { file: "../escape/secret.ts", toPaneId: "pane-2" }),
      controllers,
    );
    expect(result).toEqual({
      status: "conflict",
      conflictCode: "OUT_OF_SCOPE",
      message: "File target is outside the workspace root.",
    });
    expect(controllers.onMoveTab).not.toHaveBeenCalled();
  });

  it("returns conflict OUT_OF_SCOPE when file is an absolute path", () => {
    const controllers = makeControllers();
    const result = dispatchEditorAgentAction(
      makeAction("moveTab", { file: "/absolute/path.ts", toPaneId: "pane-2" }),
      controllers,
    );
    expect(result).toEqual({
      status: "conflict",
      conflictCode: "OUT_OF_SCOPE",
      message: "File target is outside the workspace root.",
    });
  });

  it("returns failed 'Provider unavailable.' when onMoveTab is undefined", () => {
    const controllers = makeControllers({ onMoveTab: undefined });
    const result = dispatchEditorAgentAction(
      makeAction("moveTab", { file: "src/valid.ts", toPaneId: "pane-2" }),
      controllers,
    );
    expect(result).toEqual({ status: "failed", message: "Provider unavailable." });
  });

  it("returns failed 'Missing pane target.' when toPaneId is absent", () => {
    const controllers = makeControllers({ paneId: "pane-1" });
    const result = dispatchEditorAgentAction(
      makeAction("moveTab", { file: "src/valid.ts" }),
      controllers,
    );
    expect(result).toEqual({ status: "failed", message: "Missing pane target." });
    expect(controllers.onMoveTab).not.toHaveBeenCalled();
  });

  it("returns failed 'Missing pane target.' when fromPaneId is absent (no target.paneId, no controllers.paneId)", () => {
    const controllers = makeControllers({ paneId: undefined });
    const result = dispatchEditorAgentAction(
      makeAction("moveTab", { file: "src/valid.ts", toPaneId: "pane-2" }),
      controllers,
    );
    expect(result).toEqual({ status: "failed", message: "Missing pane target." });
  });

  it("returns succeeded and calls onMoveTab with correct args when all inputs are valid", () => {
    const controllers = makeControllers({ paneId: "pane-1" });
    const result = dispatchEditorAgentAction(
      makeAction("moveTab", { file: "src/valid.ts", toPaneId: "pane-2" }),
      controllers,
    );
    expect(result).toEqual({ status: "succeeded" });
    expect(controllers.onMoveTab).toHaveBeenCalledWith("pane-1", "src/valid.ts", "pane-2");
  });

  it("uses target.paneId as fromPaneId when provided, overriding controllers.paneId", () => {
    const controllers = makeControllers({ paneId: "pane-default" });
    dispatchEditorAgentAction(
      makeAction("moveTab", { paneId: "pane-from", file: "src/x.ts", toPaneId: "pane-to" }),
      controllers,
    );
    expect(controllers.onMoveTab).toHaveBeenCalledWith("pane-from", "src/x.ts", "pane-to");
  });
});

// ─── setSelection ─────────────────────────────────────────────────────────────

describe("dispatchEditorAgentAction — setSelection", () => {
  it("returns failed 'Missing selection target.' when target.selection is absent", () => {
    const controllers = makeControllers();
    const result = dispatchEditorAgentAction(makeAction("setSelection"), controllers);
    expect(result).toEqual({ status: "failed", message: "Missing selection target." });
    expect(controllers.onRequestSelectionReveal).not.toHaveBeenCalled();
  });

  it("returns failed 'Provider unavailable.' when onRequestSelectionReveal is undefined", () => {
    const controllers = makeControllers({ onRequestSelectionReveal: undefined });
    const selection = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    };
    const result = dispatchEditorAgentAction(
      makeAction("setSelection", { selection }),
      controllers,
    );
    expect(result).toEqual({ status: "failed", message: "Provider unavailable." });
  });

  it("returns succeeded and calls onRequestSelectionReveal with actionId and selection", () => {
    const controllers = makeControllers();
    const selection = {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 5 },
    };
    const action = makeAction("setSelection", { selection });
    const result = dispatchEditorAgentAction(action, controllers);
    expect(result).toEqual({ status: "succeeded" });
    expect(controllers.onRequestSelectionReveal).toHaveBeenCalledWith({
      actionId: action.actionId,
      selection,
    });
  });
});

describe("dispatchEditorAgentAction — active-buffer target binding", () => {
  it.each(["format", "save", "applyTextEdits", "applyPatch", "setSelection"] as const)(
    "rejects %s before mutation when the claimed file differs from the active buffer",
    (type) => {
      const controllers = makeControllers();
      const action = makeAction(type, {
        file: "src/other.ts",
        selection:
          type === "setSelection"
            ? { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
            : undefined,
      });
      const result = dispatchEditorAgentAction(action, controllers);

      expect(result).toEqual({
        status: "conflict",
        conflictCode: "OUT_OF_SCOPE",
        message: "Action target does not match the active editor buffer.",
      });
      expect(controllers.verifyActiveTarget).not.toHaveBeenCalled();
      expect(controllers.persist).not.toHaveBeenCalled();
      expect(controllers.formatRequest.increment).not.toHaveBeenCalled();
      expect(controllers.applyTextEdits).not.toHaveBeenCalled();
      expect(controllers.applyPatch).not.toHaveBeenCalled();
      expect(controllers.onRequestSelectionReveal).not.toHaveBeenCalled();
    },
  );

  it("rejects a pane mismatch and invokes the Runtime verifier for a normalized match", () => {
    const controllers = makeControllers();
    const selection = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    };
    const mismatch = dispatchEditorAgentAction(
      makeAction("setSelection", { paneId: "pane-other", selection }),
      controllers,
    );
    const matching = makeAction("setSelection", {
      paneId: "pane-1",
      file: "./src/active.ts",
      selection,
    });
    const accepted = dispatchEditorAgentAction(matching, controllers);

    expect(mismatch.status).toBe("conflict");
    expect(accepted.status).toBe("succeeded");
    expect(controllers.verifyActiveTarget).toHaveBeenCalledWith(matching);
  });

  it("fails closed when the Runtime target verifier rejects a stale action", () => {
    const controllers = makeControllers({ verifyActiveTarget: vi.fn(() => false) });
    const result = dispatchEditorAgentAction(makeAction("save"), controllers);

    expect(result.status).toBe("conflict");
    expect(controllers.persist).not.toHaveBeenCalled();
  });

  it("fails closed when the Runtime write precondition rejects a stale action", () => {
    const controllers = makeControllers({ verifyWritePrecondition: vi.fn(() => false) });
    const result = dispatchEditorAgentAction(makeAction("applyPatch"), controllers);

    expect(result).toMatchObject({
      status: "conflict",
      conflictCode: "VERSION_MISMATCH",
    });
    expect(controllers.applyPatch).not.toHaveBeenCalled();
  });

  it("rejects the bound pane when the active buffer no longer has a pane id", () => {
    const controllers = makeControllers({ activePaneId: undefined });
    const result = dispatchEditorAgentAction(makeAction("format"), controllers);

    expect(result.status).toBe("conflict");
    expect(controllers.formatRequest.increment).not.toHaveBeenCalled();
  });

  it("rejects a claimed pane when the active buffer has no pane id", () => {
    const controllers = makeControllers({ activePaneId: undefined });
    const result = dispatchEditorAgentAction(
      makeAction("format", { paneId: "pane-unverified" }),
      controllers,
    );

    expect(result.status).toBe("conflict");
    expect(controllers.formatRequest.increment).not.toHaveBeenCalled();
  });

  it("rejects an active-buffer action missing its server-bound file or pane", () => {
    const controllers = makeControllers();
    const missingFile = makeAction("format", undefined, { target: { paneId: "pane-1" } });
    const missingPane = makeAction("format", undefined, { target: { file: "src/active.ts" } });

    expect(dispatchEditorAgentAction(missingFile, controllers).status).toBe("conflict");
    expect(dispatchEditorAgentAction(missingPane, controllers).status).toBe("conflict");
    expect(controllers.formatRequest.increment).not.toHaveBeenCalled();
  });
});
