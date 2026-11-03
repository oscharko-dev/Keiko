import { describe, expect, it } from "vitest";
import {
  CODING_RUNTIME_PATCH_BUDGET_BYTES,
  EDITOR_AGENT_ACTION_MAX_BODY_BYTES,
  EDITOR_AGENT_CHANGESET_MAX_CHANGED_LINES,
  EDITOR_AGENT_CHANGESET_MAX_FILES,
  EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
  EDITOR_AGENT_CHANGESET_PATCH_LIMITS,
  EDITOR_AGENT_CHANGESET_PROJECTION_PATCH_LIMITS,
  EDITOR_AGENT_SCHEMA_VERSION,
  isEditorAgentAction,
  isEditorAgentChangeset,
  isEditorAgentPreparedChangeset,
  type EditorAgentAction,
} from "./editor-agent.js";

// Owner decision (2026-10-28): normal Coding Workbench work (a 66 KB data file, a generated
// fixture) is never refused. These numbers are policy this test owns, not arithmetic the producer
// owns: a drift of the constant is a decision, and has to be made here too.
const MIB = 1_048_576;
const HASH = "a".repeat(64);

function changesetActionWith(patch: string): EditorAgentAction {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId: "action-1",
    idempotencyKey: "idem-1",
    sessionId: "session-1",
    type: "applyChangeset",
    authorityRef: { runId: "run-size", envelopeDigest: HASH },
    changeset: { patch, files: [{ file: "src/data.json", expectedContentHash: HASH }] },
  };
}

function preparedWith(newText: string): unknown {
  return {
    files: [
      {
        file: "src/data.json",
        kind: "create",
        textEdits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText,
          },
        ],
      },
    ],
  };
}

describe("governed changeset size bounds", () => {
  it("allows 8 MiB per changeset and 64 MiB of patch budget per coding run", () => {
    expect(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES).toBe(8 * MIB);
    expect(CODING_RUNTIME_PATCH_BUDGET_BYTES).toBe(64 * MIB);
    expect(EDITOR_AGENT_CHANGESET_PATCH_LIMITS).toEqual({
      maxPatchBytes: EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
      maxChangedLines: EDITOR_AGENT_CHANGESET_MAX_CHANGED_LINES,
      maxFilesChanged: EDITOR_AGENT_CHANGESET_MAX_FILES,
    });
    // The run budget is a multiple of the per-changeset cap: one run can apply several of them.
    expect(CODING_RUNTIME_PATCH_BUDGET_BYTES).toBeGreaterThanOrEqual(
      EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES,
    );
  });

  it("leaves the projected re-rendering of a patch at the cap room to be applied", () => {
    // A hunk header of 12 bytes (`@@ -1 +1 @@\n`) over 2 bytes of content re-renders 4 bytes longer.
    const worstCaseGrowth = 4 / (12 + 2);
    expect(EDITOR_AGENT_CHANGESET_PROJECTION_PATCH_LIMITS.maxPatchBytes).toBeGreaterThanOrEqual(
      Math.ceil(EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES * (1 + worstCaseGrowth)),
    );
    expect(EDITOR_AGENT_CHANGESET_PROJECTION_PATCH_LIMITS).toMatchObject({
      maxChangedLines: EDITOR_AGENT_CHANGESET_MAX_CHANGED_LINES,
      maxFilesChanged: EDITOR_AGENT_CHANGESET_MAX_FILES,
    });
  });

  it("carries a changeset whose patch and prepared preview are both at the cap in one body", () => {
    // The wire body holds the patch AND the prepared whole-file preview, each JSON-escaped.
    expect(EDITOR_AGENT_ACTION_MAX_BODY_BYTES).toBeGreaterThanOrEqual(
      2 * EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES + MIB,
    );
  });

  it.each([66 * 1024, MIB, 8 * MIB])("accepts a %i-byte patch", (bytes) => {
    const patch = "x".repeat(bytes);
    expect(isEditorAgentAction(changesetActionWith(patch))).toBe(true);
    expect(isEditorAgentChangeset(changesetActionWith(patch).changeset)).toBe(true);
  });

  it("refuses a patch one byte over the cap", () => {
    const over = changesetActionWith("x".repeat(8 * MIB + 1));
    expect(isEditorAgentAction(over)).toBe(false);
    expect(isEditorAgentChangeset(over.changeset)).toBe(false);
  });

  it("measures UTF-8 bytes, not UTF-16 units, at the boundary", () => {
    // U+00E9 is two bytes, U+20AC three, U+1F600 four (a surrogate pair), a lone surrogate three.
    const twoByte = "é".repeat(4 * MIB);
    expect(isEditorAgentChangeset(changesetActionWith(twoByte).changeset)).toBe(true);
    expect(isEditorAgentChangeset(changesetActionWith(`${twoByte}x`).changeset)).toBe(false);
    const fourByte = "\u{1F600}".repeat(2 * MIB);
    expect(isEditorAgentChangeset(changesetActionWith(fourByte).changeset)).toBe(true);
    expect(isEditorAgentChangeset(changesetActionWith(`${fourByte}x`).changeset)).toBe(false);
    const threeByte = "€".repeat(Math.floor((8 * MIB) / 3));
    expect(isEditorAgentChangeset(changesetActionWith(threeByte).changeset)).toBe(true);
    expect(isEditorAgentChangeset(changesetActionWith(`${threeByte}€`).changeset)).toBe(false);
    const lone = "\ud800".repeat(Math.floor((8 * MIB) / 3));
    expect(isEditorAgentChangeset(changesetActionWith(lone).changeset)).toBe(true);
    expect(isEditorAgentChangeset(changesetActionWith(`${lone}\ud800`).changeset)).toBe(false);
  });

  it.each([MIB, 8 * MIB])("accepts a prepared preview of %i bytes", (bytes) => {
    expect(isEditorAgentPreparedChangeset(preparedWith("x".repeat(bytes)))).toBe(true);
  });

  it("refuses a prepared preview one byte over the cap", () => {
    expect(isEditorAgentPreparedChangeset(preparedWith("x".repeat(8 * MIB + 1)))).toBe(false);
  });

  it("accepts an applyPatch action at the cap and refuses one byte more", () => {
    const action = (patch: string): EditorAgentAction => ({
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: "action-2",
      idempotencyKey: "idem-2",
      sessionId: "session-1",
      type: "applyPatch",
      patch,
    });
    expect(isEditorAgentAction(action("x".repeat(8 * MIB)))).toBe(true);
    expect(isEditorAgentAction(action("x".repeat(8 * MIB + 1)))).toBe(false);
  });
});
