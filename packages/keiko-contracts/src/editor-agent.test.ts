import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_AGENT_ACTION_ORIGIN,
  DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE,
  EDITOR_AGENT_ACTION_ID_MAX_BYTES,
  EDITOR_AGENT_ACTION_ORIGINS,
  EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS,
  EDITOR_AGENT_CHANGESET_MAX_FILES,
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS,
  EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_FAILURE_CODES,
  EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES,
  EDITOR_AGENT_PREPARED_CHANGESET_MAX_EDITS,
  EDITOR_AGENT_RESULT_MESSAGE_MAX_CHARS,
  EDITOR_AGENT_QUERY_GIT_MACHINE_REASONS,
  EDITOR_AGENT_QUERY_GIT_OMISSION_REASONS,
  EDITOR_AGENT_QUERY_GIT_SCHEMA_VERSION,
  EDITOR_AGENT_QUERY_GIT_TARGET_BASENAME_MAX_CHARS,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_SESSION_ID_MAX_BYTES,
  EDITOR_AGENT_SNAPSHOT_MAX_DIRTY_FILES,
  EDITOR_AGENT_SNAPSHOT_MAX_OPEN_FILES_PER_PANE,
  EDITOR_AGENT_SNAPSHOT_MAX_PANES,
  EDITOR_AGENT_SNAPSHOT_PATH_METADATA_MAX_BYTES,
  EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES,
  EDITOR_AGENT_TARGET_PATH_MAX_BYTES,
  EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES,
  EDITOR_AGENT_WRITE_ACTION_TYPES,
  editorAgentActionHasWritePrecondition,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentActionOrigin,
  isEditorAgentActionResult,
  isEditorAgentActiveBufferActionType,
  isEditorAgentBridgeDecisionCapability,
  isEditorAgentChangeset,
  isEditorAgentConflictCode,
  isEditorAgentDiagnostic,
  isEditorAgentDiagnosticsDetail,
  isEditorAgentEvent,
  isEditorAgentFailureCode,
  isEditorAgentFileActionResult,
  isEditorAgentGovernedAuthorityReference,
  isEditorAgentOneUseApprovalReference,
  isEditorAgentPreparedChangeset,
  isEditorAgentSessionSnapshot,
  isEditorAgentVerificationRequest,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentQueryGitData,
  parseEditorAgentSnapshotRequest,
  resolveEditorAgentActionOrigin,
  validateAgentTextEdits,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentActionStatus,
  type EditorAgentActionType,
  type EditorAgentConflictCode,
  type EditorAgentEvent,
  type EditorAgentQueryGitData,
  type EditorAgentSessionSnapshot,
} from "./editor-agent.js";

const HASH = "a".repeat(64);
const BRIDGE_CAPABILITY = "A".repeat(EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS);

function snapshot(): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "session-1",
    windowId: "window-1",
    workspaceRoot: "/repo",
    activePaneId: "pane-1",
    panes: [{ paneId: "pane-1", activeFile: "src/a.ts", openFiles: ["src/a.ts"] }],
    dirtyFiles: [],
    activeFile: "src/a.ts",
    cursor: { line: 0, character: 1 },
    selection: null,
    diagnosticsSummary: { errors: 0, warnings: 0, infos: 0 },
    documentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
    activeFileContentHash: HASH,
    textMode: "none",
    updatedAt: 1,
  };
}

describe("editor agent contracts", () => {
  it("validates session snapshots and snapshot requests", () => {
    expect(isEditorAgentSessionSnapshot(snapshot())).toBe(true);
    expect(isEditorAgentSessionSnapshot({ ...snapshot(), activeFileContentHash: "bad" })).toBe(
      false,
    );
    expect(
      parseEditorAgentSnapshotRequest({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        textMode: "selection",
        maxBytes: 1024,
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseEditorAgentSnapshotRequest({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "snapshot",
        snapshot: snapshot(),
      }),
    ).toMatchObject({ ok: true });
  });

  it("validates queued actions and action results", () => {
    const action = {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "action-1",
      idempotencyKey: "idempotency-1",
      sessionId: "session-1",
      type: "save",
      expectedContentHash: HASH,
    };
    expect(isEditorAgentAction(action)).toBe(true);
    expect(parseEditorAgentActionsPostBody(action)).toMatchObject({ ok: true });
    expect(
      parseEditorAgentActionsPostBody({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "result",
        result: {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          actionId: "action-1",
          sessionId: "session-1",
          status: "succeeded",
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("validates the additive browser bridge decision capability envelopes", () => {
    expect(isEditorAgentBridgeDecisionCapability(BRIDGE_CAPABILITY)).toBe(true);
    expect(
      isEditorAgentBridgeDecisionCapability(
        "A".repeat(EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS - 1),
      ),
    ).toBe(false);
    expect(isEditorAgentBridgeDecisionCapability(`${BRIDGE_CAPABILITY.slice(1)}+`)).toBe(false);

    expect(
      parseEditorAgentSnapshotRequest({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "snapshot",
        snapshot: snapshot(),
        bridgeDecisionCapability: BRIDGE_CAPABILITY,
      }),
    ).toMatchObject({
      ok: true,
      value: { bridgeDecisionCapability: BRIDGE_CAPABILITY },
    });
    expect(
      parseEditorAgentActionsPostBody({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        kind: "result",
        bridgeDecisionCapability: BRIDGE_CAPABILITY,
        result: {
          schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
          actionId: "action-1",
          sessionId: "session-1",
          status: "succeeded",
        },
      }),
    ).toMatchObject({
      ok: true,
      value: { bridgeDecisionCapability: BRIDGE_CAPABILITY },
    });
    const bridgeAction = {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "action",
      action: baseAction({ type: "applyPatch", patch: "patch", origin: "agent" }),
      bridgeDecisionCapability: BRIDGE_CAPABILITY,
    };
    expect(parseEditorAgentActionsPostBody(bridgeAction)).toMatchObject({
      ok: true,
      value: { kind: "action", action: { origin: "agent" } },
    });
    expect(parseEditorAgentActionsPostBody({ ...bridgeAction, unknown: true })).toEqual({
      ok: false,
      errors: ["browser action request is invalid"],
    });
    expect(
      parseEditorAgentActionsPostBody({
        ...bridgeAction,
        bridgeDecisionCapability: "invalid",
      }),
    ).toEqual({ ok: false, errors: ["browser action request is invalid"] });
  });

  it("rejects snapshot and result wrappers with incompatible outer schemas", () => {
    const snapshotRequest = {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "snapshot",
      snapshot: snapshot(),
    } as const;
    const resultRequest = {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "result",
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "action-1",
        sessionId: "session-1",
        status: "succeeded",
      },
    } as const;

    for (const invalid of [
      { ...snapshotRequest, schemaVersion: undefined },
      { ...snapshotRequest, schemaVersion: "999" },
      { ...snapshotRequest, additional: true },
    ]) {
      expect(parseEditorAgentSnapshotRequest(invalid)).toMatchObject({ ok: false });
    }
    for (const invalid of [
      { ...resultRequest, schemaVersion: undefined },
      { ...resultRequest, schemaVersion: "999" },
      { ...resultRequest, additional: true },
    ]) {
      expect(parseEditorAgentActionsPostBody(invalid)).toMatchObject({ ok: false });
    }
  });

  it("rejects payload fields that do not belong to the declared action type", () => {
    const textEdit = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: "replacement",
    } as const;
    const foreignPatch = {
      ...baseAction({ type: "applyTextEdits" }),
      textEdits: [textEdit],
      patch: "secret",
    };
    const foreignEdits = {
      ...baseAction({ type: "save" }),
      textEdits: [textEdit],
    };

    expect(isEditorAgentAction(foreignPatch)).toBe(false);
    expect(isEditorAgentAction(foreignEdits)).toBe(false);
    expect(parseEditorAgentActionsPostBody(foreignPatch)).toMatchObject({ ok: false });
    expect(parseEditorAgentActionsPostBody(foreignEdits)).toMatchObject({ ok: false });
  });

  it("canonicalizes action and result envelopes before they cross the bridge boundary", () => {
    const canary = "CAPABILITY_AUTHORITY_CANARY";
    const action = changesetAction();
    const parsedAction = parseEditorAgentActionsPostBody({
      ...action,
      bridgeDecisionCapability: canary,
      authorityEnvelope: { canary },
      changeset: {
        ...action.changeset,
        authorityEnvelope: { canary },
        files: action.changeset?.files.map((file) => ({ ...file, capability: canary })),
      },
    });
    expect(parsedAction).toMatchObject({ ok: true });
    if (!parsedAction.ok) throw new Error("Expected the valid action to parse.");
    expect(JSON.stringify(parsedAction.value)).not.toContain(canary);

    const parsedResult = parseEditorAgentActionsPostBody({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      kind: "result",
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "action-1",
        sessionId: "session-1",
        status: "succeeded",
        authorityEnvelope: { canary },
        files: [{ file: "src/a.ts", status: "succeeded", capability: canary }],
      },
    });
    expect(parsedResult).toMatchObject({ ok: true });
    if (!parsedResult.ok) throw new Error("Expected the valid result to parse.");
    expect(JSON.stringify(parsedResult.value)).not.toContain(canary);
  });

  it("byte-bounds identifiers and target metadata at the wire boundary", () => {
    const oversizedActionId = "x".repeat(EDITOR_AGENT_ACTION_ID_MAX_BYTES + 1);
    const oversizedSessionId = "x".repeat(EDITOR_AGENT_SESSION_ID_MAX_BYTES + 1);
    const oversizedIdempotencyKey = "x".repeat(EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES + 1);
    const oversizedTarget = "x".repeat(EDITOR_AGENT_TARGET_PATH_MAX_BYTES + 1);
    expect(isEditorAgentAction({ ...baseAction(), actionId: oversizedActionId })).toBe(false);
    expect(isEditorAgentAction({ ...baseAction(), sessionId: oversizedSessionId })).toBe(false);
    expect(isEditorAgentAction({ ...baseAction(), idempotencyKey: oversizedIdempotencyKey })).toBe(
      false,
    );
    expect(isEditorAgentAction({ ...baseAction(), target: { file: oversizedTarget } })).toBe(false);
    expect(isEditorAgentSessionSnapshot({ ...snapshot(), activeFile: oversizedTarget })).toBe(
      false,
    );
    expect(
      isEditorAgentActionResult({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: oversizedActionId,
        sessionId: "session-1",
        status: "failed",
      }),
    ).toBe(false);
    expect(
      isEditorAgentAction({
        ...baseAction(),
        actionId: "\u{1f600}".repeat(Math.floor(EDITOR_AGENT_ACTION_ID_MAX_BYTES / 4) + 1),
      }),
    ).toBe(false);
  });

  it("bounds retained snapshot roots and metadata arrays", () => {
    const panesAtLimit = Array.from({ length: EDITOR_AGENT_SNAPSHOT_MAX_PANES }, (_, index) => ({
      paneId: `pane-${String(index)}`,
      activeFile: null,
      openFiles: [],
    }));
    const openFilesAtLimit = Array.from(
      { length: EDITOR_AGENT_SNAPSHOT_MAX_OPEN_FILES_PER_PANE },
      (_, index) => `src/open-${String(index)}.ts`,
    );
    const dirtyFilesAtLimit = Array.from(
      { length: EDITOR_AGENT_SNAPSHOT_MAX_DIRTY_FILES },
      (_, index) => `src/dirty-${String(index)}.ts`,
    );
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        workspaceRoot: "r".repeat(EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES),
        panes: panesAtLimit,
        activeFile: null,
      }),
    ).toBe(true);
    expect(
      isEditorAgentSessionSnapshot({ ...snapshot(), panes: [...panesAtLimit, panesAtLimit[0]] }),
    ).toBe(false);
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        panes: [{ ...snapshot().panes[0], openFiles: openFilesAtLimit }],
      }),
    ).toBe(true);
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        panes: [{ ...snapshot().panes[0], openFiles: [...openFilesAtLimit, "src/extra.ts"] }],
      }),
    ).toBe(false);
    expect(isEditorAgentSessionSnapshot({ ...snapshot(), dirtyFiles: dirtyFilesAtLimit })).toBe(
      true,
    );
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        dirtyFiles: [...dirtyFilesAtLimit, "src/extra.ts"],
      }),
    ).toBe(false);
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        workspaceRoot: "r".repeat(EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES + 1),
      }),
    ).toBe(false);
  });

  it("caps aggregate snapshot path metadata at the exact byte boundary", () => {
    const fullPath = "x".repeat(EDITOR_AGENT_TARGET_PATH_MAX_BYTES);
    const pathsAtLimit = Array.from(
      { length: EDITOR_AGENT_SNAPSHOT_PATH_METADATA_MAX_BYTES / fullPath.length },
      () => fullPath,
    );
    const bounded = {
      ...snapshot(),
      panes: [{ paneId: "pane-1", activeFile: null, openFiles: pathsAtLimit }],
      activeFile: null,
      dirtyFiles: [],
    };
    expect(isEditorAgentSessionSnapshot(bounded)).toBe(true);
    expect(
      isEditorAgentSessionSnapshot({
        ...bounded,
        panes: [{ ...bounded.panes[0], openFiles: [...pathsAtLimit, "x"] }],
      }),
    ).toBe(false);
  });

  it("caps retained snapshot text at 64 KiB of UTF-8", () => {
    const asciiAtLimit = "x".repeat(EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES);
    const emojiAtLimit = "\u{1f600}".repeat(EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES / 4);
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        textMode: "activeFile",
        text: asciiAtLimit,
      }),
    ).toBe(true);
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        textMode: "activeFile",
        text: `${asciiAtLimit}x`,
      }),
    ).toBe(false);
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        textMode: "activeFile",
        text: emojiAtLimit,
      }),
    ).toBe(true);
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        textMode: "activeFile",
        text: `${emojiAtLimit}x`,
      }),
    ).toBe(false);
  });

  it("bounds every action-result message field by Unicode code points", () => {
    const atLimit = "\u{1f600}".repeat(EDITOR_AGENT_RESULT_MESSAGE_MAX_CHARS);
    const oversized = `${atLimit}\u{1f600}`;
    const base = {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "action-1",
      sessionId: "session-1",
      status: "failed" as const,
    };
    expect(isEditorAgentActionResult({ ...base, message: atLimit })).toBe(true);
    expect(isEditorAgentActionResult({ ...base, message: oversized })).toBe(false);
    expect(
      isEditorAgentActionResult({
        ...base,
        status: "conflict",
        conflict: { code: "INVALID_EDITS", message: oversized },
      }),
    ).toBe(false);
    expect(
      isEditorAgentActionResult({
        ...base,
        failure: { code: "TIMED_OUT", message: oversized },
      }),
    ).toBe(false);
    expect(
      isEditorAgentActionResult({
        ...base,
        files: [{ file: "src/a.ts", status: "failed", message: oversized }],
      }),
    ).toBe(false);
  });
});

// Issue #1394 — new pure validators (ADR-0058 D1)

describe("validateAgentTextEdits (Issue #1394)", () => {
  it("returns null for an empty edit array (valid no-op)", () => {
    expect(validateAgentTextEdits([])).toBeNull();
  });

  it("returns null for a valid single edit with a non-inverted range", () => {
    expect(
      validateAgentTextEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          newText: "hello",
        },
      ]),
    ).toBeNull();
  });

  it("returns null for a zero-length range (insertion point)", () => {
    expect(
      validateAgentTextEdits([
        {
          range: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } },
          newText: "inserted",
        },
      ]),
    ).toBeNull();
  });

  it("returns null for valid multi-edit arrays (no overlap check here)", () => {
    expect(
      validateAgentTextEdits([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          newText: "abc",
        },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          newText: "def",
        },
      ]),
    ).toBeNull();
  });

  it("returns an error string for an inverted range (end line before start line)", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 5, character: 0 }, end: { line: 3, character: 0 } },
        newText: "",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/inverted/i);
  });

  it("returns an error string for an inverted range (same line, end char before start char)", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 2, character: 10 }, end: { line: 2, character: 3 } },
        newText: "",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/inverted/i);
  });

  it("returns an error string when start.line is negative", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } },
        newText: "",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/negative/i);
  });

  it("returns an error string when start.character is negative", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: -5 }, end: { line: 0, character: 5 } },
        newText: "",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/negative/i);
  });

  it("returns an error string when end.line is negative", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: -1, character: 0 } },
        newText: "",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/negative/i);
  });

  it("returns an error string when end.character is negative", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: -3 } },
        newText: "",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/negative/i);
  });

  it("reports the zero-based index of the first invalid edit in the error string", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "ok",
      },
      {
        range: { start: { line: 2, character: 9 }, end: { line: 2, character: 2 } },
        newText: "bad",
      },
    ]);
    expect(result).toBeTypeOf("string");
    // The second edit (index 1) is the bad one.
    expect(result).toMatch(/1/);
  });

  // ── Overlap detection (F7 server-authoritative gate) ─────────────────────────────────────────

  it("returns non-null for two overlapping edits on the same line", () => {
    // Edit 0 covers [0,0)..[0,10); edit 1 starts at char 5 (inside edit 0) => overlap.
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
        newText: "first",
      },
      {
        range: { start: { line: 0, character: 5 }, end: { line: 0, character: 15 } },
        newText: "second",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/overlap/i);
  });

  it("returns non-null for two edits where the second starts strictly before the first ends (cross-line overlap)", () => {
    // Edit 0 spans lines 0..2; edit 1 starts at line 1 (inside edit 0) => overlap.
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        newText: "block",
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } },
        newText: "inner",
      },
    ]);
    expect(result).toBeTypeOf("string");
    expect(result).toMatch(/overlap/i);
  });

  it("returns null for two adjacent (touching) edits — adjacency is NOT overlap", () => {
    // Edit 0 ends at [0,5); edit 1 starts at [0,5) — touching but not overlapping.
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "hello",
      },
      {
        range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } },
        newText: "world",
      },
    ]);
    expect(result).toBeNull();
  });

  it("returns null for two edits on different non-overlapping lines", () => {
    const result = validateAgentTextEdits([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        newText: "line-one",
      },
      {
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
        newText: "line-three",
      },
    ]);
    expect(result).toBeNull();
  });
});

describe("isContainedAgentPath (Issue #1394)", () => {
  it("returns false for an empty string", () => {
    expect(isContainedAgentPath("")).toBe(false);
  });

  it("returns false for an absolute Unix path starting with /", () => {
    expect(isContainedAgentPath("/etc/passwd")).toBe(false);
    expect(isContainedAgentPath("/")).toBe(false);
  });

  it("returns false for a Windows drive-letter path", () => {
    expect(isContainedAgentPath("C:\\file.ts")).toBe(false);
    expect(isContainedAgentPath("c:/windows/system32")).toBe(false);
    expect(isContainedAgentPath("Z:/secret")).toBe(false);
  });

  it("returns false for a path containing '..' as a segment", () => {
    expect(isContainedAgentPath("src/../../../etc")).toBe(false);
    expect(isContainedAgentPath("../sibling")).toBe(false);
    expect(isContainedAgentPath("..")).toBe(false);
    expect(isContainedAgentPath("a/b/..")).toBe(false);
  });

  it("returns false for a path containing a NUL byte", () => {
    expect(isContainedAgentPath("src/file\u0000evil")).toBe(false);
  });

  it("returns true for normal relative workspace paths", () => {
    expect(isContainedAgentPath("src/app.ts")).toBe(true);
    expect(isContainedAgentPath("src/components/Button.tsx")).toBe(true);
    expect(isContainedAgentPath("package.json")).toBe(true);
    expect(isContainedAgentPath("deep/nested/path/file.txt")).toBe(true);
  });

  it("does not reject a file named '...ts' (ellipsis in name, not a parent-dir traversal)", () => {
    // '...' is not '..', so it must not be rejected by the segment check.
    expect(isContainedAgentPath("src/...ts")).toBe(true);
  });

  it("does not reject a file with 'C' in the name that is not at the root", () => {
    expect(isContainedAgentPath("src/CButton.tsx")).toBe(true);
  });
});

describe("isEditorAgentConflictCode (Issue #1394)", () => {
  it("returns true for all eight valid conflict codes", () => {
    expect(isEditorAgentConflictCode("DIRTY")).toBe(true);
    expect(isEditorAgentConflictCode("VERSION_MISMATCH")).toBe(true);
    expect(isEditorAgentConflictCode("CONTENT_HASH_MISMATCH")).toBe(true);
    expect(isEditorAgentConflictCode("NO_ACTIVE_SESSION")).toBe(true);
    expect(isEditorAgentConflictCode("NO_ACTIVE_BRIDGE")).toBe(true);
    expect(isEditorAgentConflictCode("INVALID_EDITS")).toBe(true);
    expect(isEditorAgentConflictCode("OUT_OF_SCOPE")).toBe(true);
    expect(isEditorAgentConflictCode("PRECONDITION_REQUIRED")).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isEditorAgentConflictCode("")).toBe(false);
  });

  it("returns false for junk strings", () => {
    expect(isEditorAgentConflictCode("UNKNOWN")).toBe(false);
    expect(isEditorAgentConflictCode("dirty")).toBe(false);
    expect(isEditorAgentConflictCode("conflict")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isEditorAgentConflictCode(null)).toBe(false);
    expect(isEditorAgentConflictCode(undefined)).toBe(false);
    expect(isEditorAgentConflictCode(42)).toBe(false);
    expect(isEditorAgentConflictCode({ code: "DIRTY" })).toBe(false);
  });
});

// ─── Issue #1391: public contract foundation (snapshots, actions, results, events, taxonomy) ─────

const ALL_ACTION_TYPES: readonly EditorAgentActionType[] = [
  "openFile",
  "focusTab",
  "moveTab",
  "splitPane",
  "setSelection",
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
  "applyChangeset",
  "navigateSymbol",
  "searchWorkspace",
  "queryGit",
];

const NON_WRITE_ACTION_TYPES = [
  "openFile",
  "focusTab",
  "moveTab",
  "splitPane",
  "setSelection",
] as const;

function baseAction(overrides: Partial<EditorAgentAction> = {}): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "action-1",
    idempotencyKey: "idempotency-1",
    sessionId: "session-1",
    type: "openFile",
    ...overrides,
  };
}

function changesetAction(): EditorAgentAction {
  return baseAction({
    type: "applyChangeset",
    authorityRef: { runId: "run-2114", envelopeDigest: HASH },
    changeset: {
      patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      files: [{ file: "src/a.ts", expectedContentHash: HASH }],
    },
  });
}

function navigateSymbolAction(): EditorAgentAction {
  return baseAction({
    type: "navigateSymbol",
    target: {
      file: "src/a.ts",
      selection: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
    },
    navigateSymbol: {
      operation: "definition",
      document: { path: "src/a.ts", languageId: "typescript", text: "const a = 1;\na;" },
      position: { line: 1, character: 0 },
    },
  });
}

function searchWorkspaceAction(): EditorAgentAction {
  return baseAction({
    type: "searchWorkspace",
    searchWorkspace: { mode: "text", query: "needle", maxResults: 10 },
  });
}

function queryGitAction(): EditorAgentAction {
  return baseAction({
    type: "queryGit",
    target: { file: "src/a.ts" },
    queryGit: { path: "src/a.ts", aspects: ["status", "diff", "blame"] },
  });
}

function queryGitData(): EditorAgentQueryGitData {
  return {
    schemaVersion: EDITOR_AGENT_QUERY_GIT_SCHEMA_VERSION,
    target: { basename: "a.ts", pathHash: HASH },
    caps: { maxFiles: 8, maxHunks: 16, maxBlameLines: 32, maxResultBytes: 192 * 1024 },
    aspects: {
      status: {
        state: "available",
        available: true,
        branch: "dev",
        detached: false,
        clean: false,
        change: {
          indexStatus: "M",
          worktreeStatus: " ",
          staged: true,
          unstaged: false,
          untracked: false,
          conflicted: false,
        },
        truncated: false,
      },
      diff: {
        staged: {
          scope: "staged",
          layer: "staged",
          files: [
            {
              layer: "staged",
              status: "modified",
              binary: false,
              hunks: [
                {
                  header: "@@ -1 +1 @@",
                  oldStart: 1,
                  oldCount: 1,
                  newStart: 1,
                  newCount: 1,
                  lines: [
                    { kind: "del", oldLine: 1, newLine: null, text: "before" },
                    { kind: "add", oldLine: null, newLine: 1, text: "after" },
                  ],
                  truncated: false,
                },
              ],
              addedLines: 1,
              removedLines: 1,
              truncated: false,
            },
          ],
          truncated: false,
          totalFiles: 1,
          totalBytes: 128,
        },
        unstaged: {
          scope: "unstaged",
          layer: "worktree",
          files: [],
          truncated: false,
          totalFiles: 0,
          totalBytes: 0,
        },
      },
      blame: {
        startLine: 1,
        lines: [
          {
            line: 1,
            commitHash: "b".repeat(40),
            author: "Keiko",
            authorTime: "2026-07-11T10:00:00Z",
            summary: "Harden agent git context",
          },
        ],
        truncated: false,
        totalLines: 1,
        totalBytes: 96,
      },
    },
    omissions: [
      {
        aspect: "diff",
        scope: "unstaged",
        reason: "out-of-budget",
        machineReason: "git-error",
      },
    ],
  };
}

function validActionForType(type: EditorAgentActionType): EditorAgentAction {
  if (type === "applyChangeset") return changesetAction();
  if (type === "navigateSymbol") return navigateSymbolAction();
  if (type === "searchWorkspace") return searchWorkspaceAction();
  if (type === "queryGit") return queryGitAction();
  return baseAction({ type });
}

describe("navigateSymbol action validation (Issue #2281)", () => {
  it("accepts inlay hints with a range and no diagnostics", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "navigateSymbol",
          navigateSymbol: {
            operation: "inlayHints",
            document: { path: "src/a.ts", languageId: "typescript" },
            position: { line: 0, character: 0 },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          },
        }),
      ),
    ).toBe(true);
  });

  it("rejects inlay hints without a range", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "navigateSymbol",
          navigateSymbol: {
            operation: "inlayHints",
            document: { path: "src/a.ts", languageId: "typescript" },
            position: { line: 0, character: 0 },
          },
        }),
      ),
    ).toBe(false);
  });

  it("accepts code actions with both a range and diagnostics", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "navigateSymbol",
          navigateSymbol: {
            operation: "codeActions",
            document: { path: "src/a.ts", languageId: "typescript" },
            position: { line: 0, character: 0 },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
            diagnostics: [
              {
                severity: "error",
                message: "m",
                source: "s",
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it("rejects code actions missing diagnostics", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "navigateSymbol",
          navigateSymbol: {
            operation: "codeActions",
            document: { path: "src/a.ts", languageId: "typescript" },
            position: { line: 0, character: 0 },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects inlay hints carrying diagnostics", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "navigateSymbol",
          navigateSymbol: {
            operation: "inlayHints",
            document: { path: "src/a.ts", languageId: "typescript" },
            position: { line: 0, character: 0 },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
            diagnostics: [
              {
                severity: "error",
                message: "m",
                source: "s",
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              },
            ],
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects definition with a range or diagnostics attached", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "navigateSymbol",
          navigateSymbol: {
            operation: "definition",
            document: { path: "src/a.ts", languageId: "typescript" },
            position: { line: 0, character: 0 },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("queryGit action validation (Issue #2298)", () => {
  it("accepts a well-formed read-only git query", () => {
    expect(isEditorAgentAction(queryGitAction())).toBe(true);
    expect(
      isEditorAgentAction(
        baseAction({ type: "queryGit", queryGit: { path: "src/a.ts", aspects: ["status"] } }),
      ),
    ).toBe(true);
  });

  it("rejects an empty aspect list", () => {
    expect(
      isEditorAgentAction(
        baseAction({ type: "queryGit", queryGit: { path: "src/a.ts", aspects: [] } }),
      ),
    ).toBe(false);
  });

  it("rejects duplicate aspects", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "queryGit",
          queryGit: { path: "src/a.ts", aspects: ["status", "status"] },
        }),
      ),
    ).toBe(false);
  });

  it("rejects an unknown aspect", () => {
    expect(
      isEditorAgentAction(
        baseAction({
          type: "queryGit",
          queryGit: { path: "src/a.ts", aspects: ["history"] as never },
        }),
      ),
    ).toBe(false);
  });

  it("rejects a missing or empty path (workspace containment is enforced server-side)", () => {
    expect(
      isEditorAgentAction(
        baseAction({ type: "queryGit", queryGit: { path: "", aspects: ["status"] } as never }),
      ),
    ).toBe(false);
    expect(
      isEditorAgentAction(
        baseAction({ type: "queryGit", queryGit: { aspects: ["status"] } as never }),
      ),
    ).toBe(false);
  });

  it("requires a POSIX-canonical query path", () => {
    for (const path of [
      "src\\a.ts",
      "src//a.ts",
      "./src/a.ts",
      "src/./a.ts",
      "src/../a.ts",
      "/src/a.ts",
      "C:/src/a.ts",
      "src/a.ts/",
    ]) {
      expect(
        isEditorAgentAction(
          baseAction({ type: "queryGit", queryGit: { path, aspects: ["status"] } }),
        ),
      ).toBe(false);
    }
  });

  it("rejects unknown query fields", () => {
    expect(
      isEditorAgentAction({
        ...queryGitAction(),
        queryGit: { path: "src/a.ts", aspects: ["status"], root: "/repo" },
      }),
    ).toBe(false);
  });

  it("requires the queryGit payload exactly on the queryGit type", () => {
    expect(isEditorAgentAction(baseAction({ type: "queryGit" }))).toBe(false);
    expect(
      isEditorAgentAction(
        baseAction({ type: "openFile", queryGit: { path: "src/a.ts", aspects: ["status"] } }),
      ),
    ).toBe(false);
  });
});

describe("queryGit result data parsing (Issue #2298 hardening)", () => {
  it("accepts the strict schema-versioned basename/hash projection", () => {
    expect(EDITOR_AGENT_QUERY_GIT_OMISSION_REASONS).toEqual([
      "unavailable",
      "denied",
      "out-of-budget",
    ]);
    expect(EDITOR_AGENT_QUERY_GIT_MACHINE_REASONS).toEqual([
      "not-repository",
      "git-missing",
      "unsafe-repository",
      "git-error",
      "malformed-response",
    ]);
    expect(parseEditorAgentQueryGitData(queryGitData())).toEqual({
      ok: true,
      value: queryGitData(),
    });
  });

  it("rejects full paths at every projected layer", () => {
    const valid = queryGitData();
    const staged = valid.aspects.diff?.staged;
    const blame = valid.aspects.blame;
    expect(parseEditorAgentQueryGitData({ ...valid, path: "src/a.ts" })).toMatchObject({
      ok: false,
    });
    expect(
      parseEditorAgentQueryGitData({ ...valid, target: { ...valid.target, path: "src/a.ts" } }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: {
          ...valid.aspects,
          status: { ...valid.aspects.status, root: "/repo" },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: {
          ...valid.aspects,
          diff: {
            ...valid.aspects.diff,
            staged: {
              ...staged,
              files: [{ ...staged?.files[0], path: "src/a.ts", oldPath: "src/old.ts" }],
            },
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: { ...valid.aspects, blame: { ...blame, path: "src/a.ts" } },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects malformed nested values, mismatched layers, and invalid omissions", () => {
    const valid = queryGitData();
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        target: { basename: "src/a.ts", pathHash: HASH.toUpperCase() },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: {
          ...valid.aspects,
          diff: {
            ...valid.aspects.diff,
            staged: { ...valid.aspects.diff?.staged, layer: "worktree" },
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        omissions: [{ aspect: "status", scope: "staged", reason: "unavailable" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        omissions: [{ aspect: "blame", reason: "unavailable", machineReason: "timeout" }],
      }),
    ).toMatchObject({ ok: false });
  });

  it("enforces agent-wide file, hunk, blame, basename, and byte caps", () => {
    const valid = queryGitData();
    const stagedFile = valid.aspects.diff?.staged?.files[0];
    const stagedHunk = stagedFile?.hunks[0];
    const blameLine = valid.aspects.blame?.lines[0];
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        target: {
          ...valid.target,
          basename: "x".repeat(EDITOR_AGENT_QUERY_GIT_TARGET_BASENAME_MAX_CHARS + 1),
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: {
          ...valid.aspects,
          diff: {
            staged: { ...valid.aspects.diff?.staged, files: Array(9).fill(stagedFile) },
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: {
          ...valid.aspects,
          diff: {
            staged: {
              ...valid.aspects.diff?.staged,
              files: [{ ...stagedFile, hunks: Array(17).fill(stagedHunk) }],
            },
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: {
          ...valid.aspects,
          blame: { ...valid.aspects.blame, lines: Array(33).fill(blameLine) },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseEditorAgentQueryGitData({
        ...valid,
        aspects: {
          ...valid.aspects,
          diff: {
            staged: {
              ...valid.aspects.diff?.staged,
              files: [
                {
                  ...stagedFile,
                  hunks: [
                    {
                      ...stagedHunk,
                      lines: Array(20).fill({
                        kind: "meta",
                        oldLine: null,
                        newLine: null,
                        text: "x".repeat(12_000),
                      }),
                    },
                  ],
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("schema version compatibility (Issue #1391)", () => {
  it("pins EDITOR_AGENT_SCHEMA_VERSION to the literal '1'", () => {
    expect(EDITOR_AGENT_SCHEMA_VERSION).toBe("1");
  });
});

describe("bounded editor action origin (Issue #2119)", () => {
  it("accepts only the canonical agent and chat wire values", () => {
    expect(EDITOR_AGENT_ACTION_ORIGINS).toEqual(["agent", "chat"]);
    expect(isEditorAgentActionOrigin("agent")).toBe(true);
    expect(isEditorAgentActionOrigin("chat")).toBe(true);
    expect(isEditorAgentActionOrigin("harness")).toBe(false);
    expect(isEditorAgentActionOrigin("chat:conversation-1")).toBe(false);
    expect(isEditorAgentActionOrigin("chat".repeat(1_000))).toBe(false);
    expect(isEditorAgentActionOrigin({ producer: "chat" })).toBe(false);
  });

  it("keeps legacy origin-free actions valid and resolves them to the agent default", () => {
    const legacy = baseAction({ type: "applyPatch", patch: "patch" });
    expect("origin" in legacy).toBe(false);
    expect(isEditorAgentAction(legacy)).toBe(true);
    expect(DEFAULT_EDITOR_AGENT_ACTION_ORIGIN).toBe("agent");
    expect(resolveEditorAgentActionOrigin(legacy.origin)).toBe("agent");

    const parsed = parseEditorAgentActionsPostBody(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || "kind" in parsed.value) throw new Error("expected an action");
    expect(parsed.value.origin).toBe("agent");
  });

  it("preserves chat and rejects any out-of-enum origin", () => {
    const chatAction = baseAction({ type: "applyPatch", origin: "chat", patch: "patch" });
    expect(isEditorAgentAction(chatAction)).toBe(true);
    expect(resolveEditorAgentActionOrigin(chatAction.origin)).toBe("chat");
    expect(parseEditorAgentActionsPostBody(chatAction)).toMatchObject({
      ok: true,
      value: { origin: "chat" },
    });
    expect(isEditorAgentAction({ ...chatAction, origin: "automation" })).toBe(false);
  });
});

describe("snapshot text mode defaults to none (Issue #1391 AC1)", () => {
  it("exposes the content-free default mode constant", () => {
    expect(DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE).toBe("none");
  });

  it("defaults an omitted textMode to none on a read snapshot request", () => {
    const parsed = parseEditorAgentSnapshotRequest({ schemaVersion: EDITOR_AGENT_SCHEMA_VERSION });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected ok");
    if ("kind" in parsed.value) throw new Error("expected a read request, not a bridge snapshot");
    expect(parsed.value.textMode).toBe("none");
  });

  it("preserves an explicit opt-in textMode", () => {
    const parsed = parseEditorAgentSnapshotRequest({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      textMode: "activeFile",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected ok");
    if ("kind" in parsed.value) throw new Error("expected a read request, not a bridge snapshot");
    expect(parsed.value.textMode).toBe("activeFile");
  });

  it("still rejects a present-but-invalid textMode", () => {
    const parsed = parseEditorAgentSnapshotRequest({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      textMode: "everything",
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("action validator covers every action type (Issue #1391)", () => {
  it("accepts a minimal valid action for each action type", () => {
    for (const type of ALL_ACTION_TYPES) {
      expect(isEditorAgentAction(validActionForType(type))).toBe(true);
    }
  });

  it("rejects an unknown action type", () => {
    expect(
      isEditorAgentAction(baseAction({ type: "deleteEverything" as EditorAgentActionType })),
    ).toBe(false);
  });

  it("rejects an action missing its mandatory idempotency key", () => {
    expect(
      isEditorAgentAction({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "action-1",
        sessionId: "session-1",
        type: "openFile",
      }),
    ).toBe(false);
  });
});

describe("action result validator covers every status (Issue #1391)", () => {
  const statuses: readonly EditorAgentActionStatus[] = [
    "queued",
    "succeeded",
    "failed",
    "conflict",
  ];

  it("accepts a valid result for each status", () => {
    for (const status of statuses) {
      const result: EditorAgentActionResult = {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "action-1",
        sessionId: "session-1",
        status,
        ...(status === "conflict"
          ? { conflict: { code: "PRECONDITION_REQUIRED", message: "precondition missing" } }
          : {}),
      };
      expect(isEditorAgentActionResult(result)).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    expect(
      isEditorAgentActionResult({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "a",
        sessionId: "s",
        status: "pending",
      }),
    ).toBe(false);
  });

  it("rejects a result whose conflict carries an out-of-taxonomy code", () => {
    expect(
      isEditorAgentActionResult({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "a",
        sessionId: "s",
        status: "conflict",
        conflict: { code: "NONSENSE", message: "x" },
      }),
    ).toBe(false);
  });
});

describe("event validator covers every event kind (Issue #1391)", () => {
  const events: readonly EditorAgentEvent[] = [
    {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      eventId: "e1",
      type: "session",
      snapshot: snapshot(),
    },
    {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      eventId: "e2",
      type: "action",
      action: baseAction(),
    },
    {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      eventId: "e3",
      type: "result",
      result: {
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "a",
        sessionId: "s",
        status: "succeeded",
      },
    },
    { schemaVersion: EDITOR_AGENT_SCHEMA_VERSION, eventId: "e4", type: "heartbeat", updatedAt: 1 },
  ];

  it("accepts every well-formed event kind", () => {
    for (const event of events) {
      expect(isEditorAgentEvent(event)).toBe(true);
    }
  });

  it("rejects unknown type, missing id, or wrong schema version", () => {
    expect(
      isEditorAgentEvent({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        eventId: "e",
        type: "noise",
      }),
    ).toBe(false);
    expect(
      isEditorAgentEvent({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        eventId: "",
        type: "heartbeat",
        updatedAt: 1,
      }),
    ).toBe(false);
    expect(
      isEditorAgentEvent({ schemaVersion: "2", eventId: "e", type: "heartbeat", updatedAt: 1 }),
    ).toBe(false);
  });

  it("rejects an event whose payload is the wrong shape for its kind", () => {
    expect(
      isEditorAgentEvent({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        eventId: "e",
        type: "result",
        result: { status: "succeeded" },
      }),
    ).toBe(false);
  });
});

describe("write-action precondition rule (Issue #1391 AC2)", () => {
  it("lists exactly the five mutating action types", () => {
    expect([...EDITOR_AGENT_WRITE_ACTION_TYPES].sort()).toEqual(
      ["applyChangeset", "applyPatch", "applyTextEdits", "format", "save"].sort(),
    );
  });

  it("classifies write vs non-write action types", () => {
    for (const type of EDITOR_AGENT_WRITE_ACTION_TYPES) {
      expect(isEditorAgentWriteActionType(type)).toBe(true);
    }
    for (const type of NON_WRITE_ACTION_TYPES) {
      expect(isEditorAgentWriteActionType(type)).toBe(false);
    }
    expect(isEditorAgentWriteActionType("nonsense")).toBe(false);
  });

  it("flags a write action that pins no revision", () => {
    for (const type of EDITOR_AGENT_WRITE_ACTION_TYPES) {
      const action = baseAction({ type });
      expect(editorAgentActionHasWritePrecondition(action)).toBe(false);
      expect(editorAgentWritePreconditionError(action)).toBeTypeOf("string");
    }
  });

  it("accepts a write action pinned by version or by hash", () => {
    const byHash = baseAction({ type: "save", expectedContentHash: HASH });
    const byVersion = baseAction({
      type: "applyTextEdits",
      expectedDocumentVersion: { sizeBytes: 1, modifiedAt: 1, contentHash: HASH },
    });
    expect(editorAgentActionHasWritePrecondition(byHash)).toBe(true);
    expect(editorAgentWritePreconditionError(byHash)).toBeNull();
    expect(editorAgentActionHasWritePrecondition(byVersion)).toBe(true);
    expect(editorAgentWritePreconditionError(byVersion)).toBeNull();
    expect(editorAgentActionHasWritePrecondition(changesetAction())).toBe(true);
    expect(editorAgentWritePreconditionError(changesetAction())).toBeNull();
  });

  it("never requires a precondition for a non-write action", () => {
    for (const type of NON_WRITE_ACTION_TYPES) {
      expect(editorAgentWritePreconditionError(baseAction({ type }))).toBeNull();
    }
  });

  it("rejects a precondition that is not a real SHA-256 hash (no pseudo-hash blind write)", () => {
    // isEditorAgentAction validates expectedContentHash as a 64-char lowercase hex digest, so a
    // write cannot satisfy the precondition gate with an empty or malformed hash.
    expect(isEditorAgentAction(baseAction({ type: "save", expectedContentHash: "" }))).toBe(false);
    expect(
      isEditorAgentAction(baseAction({ type: "save", expectedContentHash: "a".repeat(63) })),
    ).toBe(false);
    expect(isEditorAgentAction(baseAction({ type: "save", expectedContentHash: HASH }))).toBe(true);
  });
});

describe("governed applyChangeset contract (Issue #2114)", () => {
  it("accepts only a boolean server-derived review requirement", () => {
    expect(isEditorAgentAction({ ...changesetAction(), requiresReview: true })).toBe(true);
    expect(isEditorAgentAction({ ...changesetAction(), requiresReview: false })).toBe(true);
    expect(isEditorAgentAction({ ...changesetAction(), requiresReview: "false" })).toBe(false);
    expect("requiresReview" in changesetAction()).toBe(false);
  });

  it("accepts bounded authority and one-use approval references bound to the action", () => {
    const authorityRef = { runId: "run-2114", envelopeDigest: HASH };
    const approvalRef = {
      approvalId: "approval-1",
      actionId: "action-1",
      approvalProofDigest: HASH,
      expiresAt: "2026-07-09T12:00:00Z",
    };
    expect(isEditorAgentGovernedAuthorityReference(authorityRef)).toBe(true);
    expect(isEditorAgentOneUseApprovalReference(approvalRef)).toBe(true);
    expect(isEditorAgentAction({ ...changesetAction(), approvalRef })).toBe(true);
    expect(
      isEditorAgentAction({
        ...changesetAction(),
        approvalRef: { ...approvalRef, actionId: "other" },
      }),
    ).toBe(false);
    expect(
      isEditorAgentGovernedAuthorityReference({ ...authorityRef, envelopeDigest: "raw" }),
    ).toBe(false);
  });

  it("accepts one bounded patch, per-file preconditions, and selected-file acceptance", () => {
    const action = changesetAction();
    const changeset = {
      ...action.changeset,
      files: [
        { file: "src/a.ts", expectedContentHash: HASH },
        {
          file: "src/b.ts",
          expectedDocumentVersion: { sizeBytes: 4, modifiedAt: 2, contentHash: HASH },
        },
      ],
      selectedFiles: ["src/b.ts"],
    };
    expect(isEditorAgentChangeset(changeset)).toBe(true);
    expect(isEditorAgentAction({ ...action, changeset })).toBe(true);
  });

  it("compares declared and selected file identity after path normalization", () => {
    const changeset = changesetAction().changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    expect(
      isEditorAgentChangeset({
        ...changeset,
        files: [
          { file: "src/a.ts", expectedContentHash: HASH },
          { file: "./src/a.ts", expectedContentHash: HASH },
        ],
      }),
    ).toBe(false);
    expect(isEditorAgentChangeset({ ...changeset, selectedFiles: ["./src/a.ts"] })).toBe(true);
  });

  it("accepts fractional filesystem modification times in document preconditions", () => {
    const changeset = changesetAction().changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    expect(
      isEditorAgentChangeset({
        ...changeset,
        files: [
          {
            file: "src/a.ts",
            expectedDocumentVersion: {
              sizeBytes: 4,
              modifiedAt: 1_700_000_000_000.125,
              contentHash: HASH,
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a bounded browser-safe prepared changeset preview", () => {
    const prepared = {
      files: [
        {
          file: "src/a.ts",
          kind: "modify",
          textEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
              newText: "b\n",
            },
          ],
        },
      ],
    } as const;
    const action = changesetAction();
    expect(isEditorAgentPreparedChangeset(prepared)).toBe(true);
    expect(
      isEditorAgentAction({
        ...action,
        changeset: { ...action.changeset, prepared },
      }),
    ).toBe(true);
  });

  it("rejects malformed or unbounded prepared changeset previews", () => {
    const edit = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: "x",
    } as const;
    const preparedFile = { file: "src/a.ts", kind: "modify", textEdits: [edit] } as const;
    expect(isEditorAgentPreparedChangeset({ files: [preparedFile] })).toBe(true);
    expect(isEditorAgentPreparedChangeset({ files: [{ ...preparedFile, kind: "rename" }] })).toBe(
      false,
    );
    expect(
      isEditorAgentPreparedChangeset({
        files: [
          {
            ...preparedFile,
            textEdits: Array.from(
              { length: EDITOR_AGENT_PREPARED_CHANGESET_MAX_EDITS + 1 },
              () => edit,
            ),
          },
        ],
      }),
    ).toBe(false);
    expect(
      isEditorAgentPreparedChangeset({
        files: [
          {
            ...preparedFile,
            textEdits: [
              { ...edit, newText: "x".repeat(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES + 1) },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it("fails closed for missing preconditions, nested idempotency, and invalid selections", () => {
    const changeset = changesetAction().changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    expect(isEditorAgentChangeset({ ...changeset, files: [{ file: "src/a.ts" }] })).toBe(false);
    expect(
      isEditorAgentChangeset({
        ...changeset,
        files: [{ ...changeset.files[0], idempotencyKey: "second-key" }],
      }),
    ).toBe(false);
    expect(isEditorAgentChangeset({ ...changeset, selectedFiles: ["src/missing.ts"] })).toBe(false);
    expect(isEditorAgentChangeset({ ...changeset, selectedFiles: [] })).toBe(false);
  });

  it("enforces named changeset file and patch caps", () => {
    const changeset = changesetAction().changeset;
    if (changeset === undefined) throw new Error("expected changeset");
    const files = Array.from({ length: EDITOR_AGENT_CHANGESET_MAX_FILES + 1 }, (_, index) => ({
      file: `src/${String(index)}.ts`,
      expectedContentHash: HASH,
    }));
    expect(isEditorAgentChangeset({ ...changeset, files })).toBe(false);
    expect(
      isEditorAgentChangeset({
        ...changeset,
        patch: "x".repeat(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES + 1),
      }),
    ).toBe(false);
  });

  it("keeps existing schema-version-1 actions valid without additive fields", () => {
    const legacy = baseAction({ type: "save", expectedContentHash: HASH });
    expect(legacy.schemaVersion).toBe("1");
    expect("authorityRef" in legacy).toBe(false);
    expect("approvalRef" in legacy).toBe(false);
    expect("changeset" in legacy).toBe(false);
    expect(isEditorAgentAction(legacy)).toBe(true);
  });
});

describe("bounded diagnostics detail and file-attributed results (Issue #2114)", () => {
  const diagnostic = {
    severity: "error",
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
    message: "Type mismatch",
  } as const;

  it("accepts bounded diagnostics and an explicit truncation marker", () => {
    const detail = { items: [diagnostic], truncated: true };
    expect(isEditorAgentDiagnostic(diagnostic)).toBe(true);
    expect(isEditorAgentDiagnosticsDetail(detail)).toBe(true);
    expect(isEditorAgentSessionSnapshot({ ...snapshot(), diagnosticsDetail: detail })).toBe(true);
  });

  it("rejects oversized diagnostic lists and messages", () => {
    expect(
      isEditorAgentDiagnosticsDetail({
        items: Array.from({ length: EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS + 1 }, () => diagnostic),
        truncated: true,
      }),
    ).toBe(false);
    expect(
      isEditorAgentDiagnostic({
        ...diagnostic,
        message: "x".repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS + 1),
      }),
    ).toBe(false);
  });

  it("bounds diagnostic messages by Unicode code points", () => {
    const emoji = "\u{1f600}";
    expect(
      isEditorAgentDiagnostic({
        ...diagnostic,
        message: emoji.repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS),
      }),
    ).toBe(true);
    expect(
      isEditorAgentDiagnostic({
        ...diagnostic,
        message: emoji.repeat(EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS + 1),
      }),
    ).toBe(false);
    expect(isEditorAgentDiagnostic({ ...diagnostic, message: "" })).toBe(false);
  });

  it("validates file-attributed conflicts and selected-file outcomes", () => {
    const fileResult = {
      file: "src/a.ts",
      status: "conflict",
      conflict: { code: "VERSION_MISMATCH", message: "stale", file: "src/a.ts" },
    } as const;
    expect(isEditorAgentFileActionResult(fileResult)).toBe(true);
    expect(
      isEditorAgentActionResult({
        schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
        actionId: "action-1",
        sessionId: "session-1",
        status: "conflict",
        files: [fileResult, { file: "src/b.ts", status: "not-selected" }],
      }),
    ).toBe(true);
    expect(isEditorAgentFileActionResult({ ...fileResult, file: "../outside.ts" })).toBe(false);
  });
});

describe("conflict-code taxonomy (Issue #1391 AC3)", () => {
  it("enumerates the full structured taxonomy including PRECONDITION_REQUIRED and NO_ACTIVE_BRIDGE", () => {
    expect(EDITOR_AGENT_CONFLICT_CODES).toContain("PRECONDITION_REQUIRED");
    expect(EDITOR_AGENT_CONFLICT_CODES).toContain("NO_ACTIVE_BRIDGE");
    expect(EDITOR_AGENT_CONFLICT_CODES).toContain("POLICY_DENIED");
    expect(EDITOR_AGENT_CONFLICT_CODES).toContain("APPROVAL_REQUIRED");
    expect(EDITOR_AGENT_CONFLICT_CODES.length).toBe(10);
    for (const code of EDITOR_AGENT_CONFLICT_CODES) {
      expect(isEditorAgentConflictCode(code)).toBe(true);
    }
  });

  it("recognises the new PRECONDITION_REQUIRED code", () => {
    const code: EditorAgentConflictCode = "PRECONDITION_REQUIRED";
    expect(isEditorAgentConflictCode(code)).toBe(true);
  });
});

describe("failure-code taxonomy (Issue #1392)", () => {
  it("enumerates exactly the lifecycle failure codes", () => {
    expect([...EDITOR_AGENT_FAILURE_CODES]).toEqual([
      "TIMED_OUT",
      "QUEUE_FULL",
      "CANCELLED",
      "PROVIDER_UNAVAILABLE",
      "UNSUPPORTED_OPERATION",
      "LIMIT_EXCEEDED",
    ]);
    for (const code of EDITOR_AGENT_FAILURE_CODES) {
      expect(isEditorAgentFailureCode(code)).toBe(true);
    }
  });

  it("keeps the conflict and failure taxonomies disjoint", () => {
    expect(isEditorAgentFailureCode("NO_ACTIVE_BRIDGE")).toBe(false);
    expect(isEditorAgentConflictCode("TIMED_OUT")).toBe(false);
    expect(isEditorAgentFailureCode("")).toBe(false);
    expect(isEditorAgentFailureCode(42)).toBe(false);
    expect(isEditorAgentFailureCode(null)).toBe(false);
  });

  it("validates a result carrying a structured failure detail", () => {
    const base = {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "action-1",
      sessionId: "session-1",
    } as const;
    expect(
      isEditorAgentActionResult({
        ...base,
        status: "failed",
        failure: { code: "TIMED_OUT", message: "timed out" },
      }),
    ).toBe(true);
    // An out-of-taxonomy failure code cannot pass the guard.
    expect(
      isEditorAgentActionResult({
        ...base,
        status: "failed",
        failure: { code: "NOPE", message: "bad" },
      }),
    ).toBe(false);
    // A failure detail missing its message is rejected.
    expect(
      isEditorAgentActionResult({ ...base, status: "failed", failure: { code: "QUEUE_FULL" } }),
    ).toBe(false);
  });
});
// Issue #1379 AC4 (ADR-0067 D6) — additive, content-free languageCapability field on the snapshot.
describe("languageCapability snapshot field (Issue #1379 AC4)", () => {
  it("validates a snapshot carrying a well-formed available languageCapability", () => {
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        languageCapability: {
          languageId: "typescript",
          providerId: "typescript",
          available: true,
        },
      }),
    ).toBe(true);
  });

  it("validates an unavailable languageCapability with a null provider and a reason", () => {
    expect(
      isEditorAgentSessionSnapshot({
        ...snapshot(),
        languageCapability: {
          languageId: "go",
          providerId: null,
          available: false,
          unavailableReason: "No language provider is configured for this language.",
        },
      }),
    ).toBe(true);
  });

  it("validates when the field is absent (back-compat) or explicitly null", () => {
    const base = snapshot();
    expect(isEditorAgentSessionSnapshot(base)).toBe(true);
    expect("languageCapability" in base).toBe(false);
    expect(isEditorAgentSessionSnapshot({ ...base, languageCapability: null })).toBe(true);
  });

  it("rejects a malformed languageCapability", () => {
    const base = snapshot();
    // available is not a boolean
    expect(
      isEditorAgentSessionSnapshot({
        ...base,
        languageCapability: {
          languageId: "typescript",
          providerId: "typescript",
          available: "yes",
        },
      }),
    ).toBe(false);
    // languageId is empty
    expect(
      isEditorAgentSessionSnapshot({
        ...base,
        languageCapability: { languageId: "", providerId: null, available: false },
      }),
    ).toBe(false);
    // providerId is a number (neither string nor null)
    expect(
      isEditorAgentSessionSnapshot({
        ...base,
        languageCapability: { languageId: "typescript", providerId: 7, available: true },
      }),
    ).toBe(false);
    // unavailableReason is the wrong type
    expect(
      isEditorAgentSessionSnapshot({
        ...base,
        languageCapability: {
          languageId: "go",
          providerId: null,
          available: false,
          unavailableReason: 42,
        },
      }),
    ).toBe(false);
  });
});

describe("gitContextSummary snapshot field (Issue #2234)", () => {
  it("accepts a content-free summary and remains backward compatible", () => {
    const legacy = snapshot();
    expect("gitContextSummary" in legacy).toBe(false);
    expect(isEditorAgentSessionSnapshot(legacy)).toBe(true);
    expect(isEditorAgentSessionSnapshot({ ...legacy, gitContextSummary: null })).toBe(true);
    expect(
      isEditorAgentSessionSnapshot({
        ...legacy,
        gitContextSummary: {
          hasConflictMarkers: true,
          changedFileCount: 7,
          truncated: false,
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed or content-bearing summaries", () => {
    const legacy = snapshot();
    expect(
      isEditorAgentSessionSnapshot({
        ...legacy,
        gitContextSummary: {
          hasConflictMarkers: true,
          changedFileCount: -1,
          truncated: false,
        },
      }),
    ).toBe(false);
    expect(
      isEditorAgentSessionSnapshot({
        ...legacy,
        gitContextSummary: {
          hasConflictMarkers: false,
          changedFileCount: 1,
          truncated: false,
          diff: "raw repository content",
        },
      }),
    ).toBe(false);
  });
});

describe("requestVerification action type (Issue #2210, ADR-0126 D5)", () => {
  it("is a recognized action type but not a write or active-buffer action", () => {
    // The type is a member of the action union, so the bare envelope validates...
    expect(isEditorAgentAction(baseAction({ type: "requestVerification" }))).toBe(true);
    // ...but it never joins the mutating write set or the active-buffer set (ADR-0126 D5).
    expect(isEditorAgentWriteActionType("requestVerification")).toBe(false);
    expect(isEditorAgentActiveBufferActionType("requestVerification")).toBe(false);
  });

  it("validates the verification request wire shape (kinds/targetPath/requestId)", () => {
    expect(isEditorAgentVerificationRequest({ kinds: ["typecheck", "lint"] })).toBe(true);
    expect(
      isEditorAgentVerificationRequest({ kinds: ["targeted-test"], targetPath: "src/a.test.ts" }),
    ).toBe(true);
    expect(isEditorAgentVerificationRequest({ kinds: [] })).toBe(false);
    expect(isEditorAgentVerificationRequest({ kinds: ["not-a-kind"] })).toBe(false);
    expect(isEditorAgentVerificationRequest(null)).toBe(false);
  });

  it("leaves existing schemaVersion-1 action fixtures parsing unchanged (additive)", () => {
    expect(isEditorAgentAction(baseAction({ type: "openFile" }))).toBe(true);
    expect(isEditorAgentAction(baseAction({ type: "applyPatch" }))).toBe(true);
  });
});
