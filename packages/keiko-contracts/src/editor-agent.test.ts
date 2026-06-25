import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE,
  EDITOR_AGENT_CONFLICT_CODES,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_WRITE_ACTION_TYPES,
  editorAgentActionHasWritePrecondition,
  editorAgentWritePreconditionError,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentActionResult,
  isEditorAgentConflictCode,
  isEditorAgentEvent,
  isEditorAgentSessionSnapshot,
  isEditorAgentWriteActionType,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
  validateAgentTextEdits,
  type EditorAgentAction,
  type EditorAgentActionResult,
  type EditorAgentActionStatus,
  type EditorAgentActionType,
  type EditorAgentConflictCode,
  type EditorAgentEvent,
  type EditorAgentSessionSnapshot,
} from "./editor-agent.js";

const HASH = "a".repeat(64);

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
  it("returns true for all six valid conflict codes", () => {
    expect(isEditorAgentConflictCode("DIRTY")).toBe(true);
    expect(isEditorAgentConflictCode("VERSION_MISMATCH")).toBe(true);
    expect(isEditorAgentConflictCode("CONTENT_HASH_MISMATCH")).toBe(true);
    expect(isEditorAgentConflictCode("NO_ACTIVE_SESSION")).toBe(true);
    expect(isEditorAgentConflictCode("INVALID_EDITS")).toBe(true);
    expect(isEditorAgentConflictCode("OUT_OF_SCOPE")).toBe(true);
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

describe("schema version compatibility (Issue #1391)", () => {
  it("pins EDITOR_AGENT_SCHEMA_VERSION to the literal '1'", () => {
    expect(EDITOR_AGENT_SCHEMA_VERSION).toBe("1");
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
      expect(isEditorAgentAction(baseAction({ type }))).toBe(true);
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
  it("lists exactly the four mutating action types", () => {
    expect([...EDITOR_AGENT_WRITE_ACTION_TYPES].sort()).toEqual(
      ["applyPatch", "applyTextEdits", "format", "save"].sort(),
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
  });

  it("never requires a precondition for a non-write action", () => {
    for (const type of NON_WRITE_ACTION_TYPES) {
      expect(editorAgentWritePreconditionError(baseAction({ type }))).toBeNull();
    }
  });
});

describe("conflict-code taxonomy (Issue #1391 AC3)", () => {
  it("enumerates the full structured taxonomy including PRECONDITION_REQUIRED", () => {
    expect(EDITOR_AGENT_CONFLICT_CODES).toContain("PRECONDITION_REQUIRED");
    expect(EDITOR_AGENT_CONFLICT_CODES.length).toBe(7);
    for (const code of EDITOR_AGENT_CONFLICT_CODES) {
      expect(isEditorAgentConflictCode(code)).toBe(true);
    }
  });

  it("recognises the new PRECONDITION_REQUIRED code", () => {
    const code: EditorAgentConflictCode = "PRECONDITION_REQUIRED";
    expect(isEditorAgentConflictCode(code)).toBe(true);
  });
});
