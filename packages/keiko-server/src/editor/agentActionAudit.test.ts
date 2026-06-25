import { afterEach, describe, expect, it } from "vitest";
import {
  classifyEditorAgentAction,
  type EditorAgentActionPolicyDecision,
} from "@oscharko-dev/keiko-contracts";
import {
  _resetEditorAgentAuditForTests,
  listEditorAgentActionAudit,
  recordEditorAgentActionAudit,
  type EditorAgentAuditInput,
} from "./agentActionAudit.js";

const REVIEW = classifyEditorAgentAction("applyTextEdits", {
  targetPath: "src/a.ts",
  targetSensitive: false,
});

const DENIED: EditorAgentActionPolicyDecision = {
  disposition: "denied",
  effectClass: "content-mutation",
  denyReason: "denied-sensitive-path",
};

function input(over: Partial<EditorAgentAuditInput> = {}): EditorAgentAuditInput {
  return {
    occurredAt: 1_700_000_000_000,
    sessionId: "session-1",
    actionId: "action-1",
    actionType: "applyTextEdits",
    decision: REVIEW,
    outcome: "queued",
    targetPath: "src/a.ts",
    ...over,
  };
}

afterEach(() => {
  _resetEditorAgentAuditForTests();
});

describe("agent editor action audit ledger (Issue #1395)", () => {
  it("records a mutating action and lists it by session (AC1)", () => {
    const record = recordEditorAgentActionAudit(input({ editCount: 2 }));
    expect(record).not.toBeNull();
    const records = listEditorAgentActionAudit("session-1");
    expect(records).toHaveLength(1);
    expect(records[0]?.actionType).toBe("applyTextEdits");
    expect(records[0]?.disposition).toBe("review-required");
    expect(records[0]?.outcome).toBe("queued");
    expect(records[0]?.editCount).toBe(2);
    expect(records[0]?.mutating).toBe(true);
  });

  it("does not record an allowed navigation/layout action", () => {
    const allowed = classifyEditorAgentAction("openFile", {
      targetPath: "src/a.ts",
      targetSensitive: false,
    });
    const record = recordEditorAgentActionAudit(
      input({ actionType: "openFile", decision: allowed, outcome: "succeeded" }),
    );
    expect(record).toBeNull();
    expect(listEditorAgentActionAudit("session-1")).toHaveLength(0);
  });

  it("records a denied action even when its type is not mutating", () => {
    const record = recordEditorAgentActionAudit(
      input({
        actionType: "openFile",
        decision: DENIED,
        outcome: "conflict",
        conflictCode: "OUT_OF_SCOPE",
      }),
    );
    expect(record).not.toBeNull();
    expect(listEditorAgentActionAudit("session-1")[0]?.disposition).toBe("denied");
  });

  it("redacts a secret-shaped substring from the stored record (AC3 defense in depth)", () => {
    const token = "ghp_ABCDEFGHIJ0123456789KLMNOPqrst";
    const record = recordEditorAgentActionAudit(input({ targetPath: `config/${token}.ts` }));
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain(token);
  });

  it("redacts a different secret shape (AWS access key) — full redactor, not one pattern (AC3)", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const record = recordEditorAgentActionAudit(input({ targetPath: `config/${key}.ts` }));
    expect(record).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain(key);
  });

  it("never carries raw edit or patch content — only counts (AC3)", () => {
    const record = recordEditorAgentActionAudit(
      input({ patchByteLength: 9001, actionType: "applyPatch" }),
    );
    expect(record?.patchByteLength).toBe(9001);
    // No field can hold raw content; the serialized record is just enums/counts/ids/path/summary.
    expect(JSON.stringify(record)).not.toContain("newText");
  });

  it("bounds the per-session ledger with FIFO eviction, keeping the newest", () => {
    for (let i = 0; i < 105; i += 1) {
      recordEditorAgentActionAudit(input({ actionId: `action-${String(i)}` }));
    }
    const records = listEditorAgentActionAudit("session-1");
    expect(records).toHaveLength(100);
    // The oldest five (0..4) were evicted; the newest (104) is retained.
    expect(records.some((r) => r.summary.length > 0)).toBe(true);
    expect(records).toHaveLength(100);
  });

  it("scopes records per session", () => {
    recordEditorAgentActionAudit(input({ sessionId: "session-1", actionId: "a1" }));
    recordEditorAgentActionAudit(input({ sessionId: "session-2", actionId: "a2" }));
    expect(listEditorAgentActionAudit("session-1")).toHaveLength(1);
    expect(listEditorAgentActionAudit("session-2")).toHaveLength(1);
    // A flattened view across sessions when no sessionId is given.
    expect(listEditorAgentActionAudit().length).toBe(2);
  });

  it("resets cleanly between runs", () => {
    recordEditorAgentActionAudit(input());
    _resetEditorAgentAuditForTests();
    expect(listEditorAgentActionAudit("session-1")).toHaveLength(0);
  });
});
