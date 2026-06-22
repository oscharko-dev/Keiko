import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isEditorAgentAction,
  isEditorAgentSessionSnapshot,
  parseEditorAgentActionsPostBody,
  parseEditorAgentSnapshotRequest,
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
