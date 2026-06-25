import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isContainedAgentPath,
  isEditorAgentAction,
  isEditorAgentConflictCode,
  isEditorAgentSessionSnapshot,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
  validateAgentTextEdits,
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
