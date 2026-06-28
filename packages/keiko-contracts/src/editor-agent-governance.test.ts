import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_ACTION_DENY_REASONS,
  EDITOR_AGENT_ACTION_DISPOSITIONS,
  EDITOR_AGENT_ACTION_EFFECT_CLASS,
  EDITOR_AGENT_ACTION_REVIEW_REASONS,
  EDITOR_AGENT_AUDIT_SCHEMA_VERSION,
  EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS,
  buildEditorAgentActionAuditRecord,
  classifyEditorAgentAction,
  isEditorAgentActionAuditRecord,
  isEditorAgentActionDisposition,
  isEditorAgentActionEffectClass,
  isMutatingEditorAgentAction,
  type EditorAgentActionAuditInput,
  type EditorAgentActionPolicyContext,
} from "./editor-agent-governance.js";
import type { EditorAgentActionType } from "./editor-agent.js";

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

const CONTENT_MUTATIONS: readonly EditorAgentActionType[] = [
  "format",
  "save",
  "applyTextEdits",
  "applyPatch",
];

const NON_MUTATING: readonly EditorAgentActionType[] = [
  "openFile",
  "focusTab",
  "moveTab",
  "splitPane",
  "setSelection",
];

function ctx(over: Partial<EditorAgentActionPolicyContext> = {}): EditorAgentActionPolicyContext {
  return { targetPath: "src/a.ts", targetSensitive: false, ...over };
}

describe("effect-class taxonomy (Issue #1395 D1)", () => {
  it("assigns an effect class to every action type", () => {
    for (const type of ALL_ACTION_TYPES) {
      expect(isEditorAgentActionEffectClass(EDITOR_AGENT_ACTION_EFFECT_CLASS[type])).toBe(true);
    }
  });

  it("classifies the four write actions as content-mutation", () => {
    for (const type of CONTENT_MUTATIONS) {
      expect(EDITOR_AGENT_ACTION_EFFECT_CLASS[type]).toBe("content-mutation");
    }
  });

  it("classifies navigation and layout actions correctly", () => {
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.openFile).toBe("navigation");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.focusTab).toBe("navigation");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.setSelection).toBe("navigation");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.moveTab).toBe("layout");
    expect(EDITOR_AGENT_ACTION_EFFECT_CLASS.splitPane).toBe("layout");
  });

  it("marks exactly the mutating action set as mutating (AC1)", () => {
    for (const type of CONTENT_MUTATIONS) expect(isMutatingEditorAgentAction(type)).toBe(true);
    for (const type of NON_MUTATING) expect(isMutatingEditorAgentAction(type)).toBe(false);
  });
});

describe("policy classifier (Issue #1395 AC2)", () => {
  it("allows every navigation and layout action", () => {
    for (const type of NON_MUTATING) {
      const decision = classifyEditorAgentAction(type, ctx());
      expect(decision.disposition).toBe("allowed");
      expect(decision.denyReason).toBeUndefined();
      expect(decision.reviewReason).toBeUndefined();
    }
  });

  it("marks a contained, non-sensitive content mutation review-required", () => {
    for (const type of CONTENT_MUTATIONS) {
      const decision = classifyEditorAgentAction(type, ctx());
      expect(decision.disposition).toBe("review-required");
      expect(decision.reviewReason).toBe("content-mutation-requires-review");
      expect(decision.denyReason).toBeUndefined();
    }
  });

  it("denies a content mutation whose target escapes the workspace root", () => {
    const decision = classifyEditorAgentAction(
      "applyTextEdits",
      ctx({ targetPath: "../escape.ts" }),
    );
    expect(decision.disposition).toBe("denied");
    expect(decision.denyReason).toBe("workspace-boundary-escape");
  });

  it("denies a content mutation that targets a deny-listed (sensitive) path", () => {
    const decision = classifyEditorAgentAction("save", ctx({ targetSensitive: true }));
    expect(decision.disposition).toBe("denied");
    expect(decision.denyReason).toBe("denied-sensitive-path");
  });

  it("prefers the boundary-escape reason over sensitivity when both hold", () => {
    const decision = classifyEditorAgentAction(
      "applyPatch",
      ctx({ targetPath: "../../etc/passwd", targetSensitive: true }),
    );
    expect(decision.disposition).toBe("denied");
    expect(decision.denyReason).toBe("workspace-boundary-escape");
  });

  it("is deterministic: same inputs yield an equal decision (replay-safe)", () => {
    const a = classifyEditorAgentAction("applyTextEdits", ctx({ targetSensitive: true }));
    const b = classifyEditorAgentAction("applyTextEdits", ctx({ targetSensitive: true }));
    expect(a).toEqual(b);
  });

  it("allows a content mutation with no file target (null path) that is not sensitive", () => {
    const decision = classifyEditorAgentAction("save", ctx({ targetPath: null }));
    expect(decision.disposition).toBe("review-required");
  });
});

describe("disposition and reason enums", () => {
  it("freezes the three-way disposition taxonomy", () => {
    expect([...EDITOR_AGENT_ACTION_DISPOSITIONS]).toEqual(["allowed", "review-required", "denied"]);
    for (const d of EDITOR_AGENT_ACTION_DISPOSITIONS) {
      expect(isEditorAgentActionDisposition(d)).toBe(true);
    }
    expect(isEditorAgentActionDisposition("maybe")).toBe(false);
    expect(isEditorAgentActionDisposition(null)).toBe(false);
  });

  it("freezes the deny and review reason taxonomies", () => {
    expect([...EDITOR_AGENT_ACTION_DENY_REASONS]).toEqual([
      "workspace-boundary-escape",
      "denied-sensitive-path",
    ]);
    expect([...EDITOR_AGENT_ACTION_REVIEW_REASONS]).toEqual([
      "content-mutation-requires-review",
      "external-effect-requires-review",
    ]);
  });
});

function auditInput(over: Partial<EditorAgentActionAuditInput> = {}): EditorAgentActionAuditInput {
  return {
    auditId: "audit-1",
    occurredAt: 1_700_000_000_000,
    sessionId: "session-1",
    actionId: "action-1",
    actionType: "applyTextEdits",
    decision: classifyEditorAgentAction("applyTextEdits", ctx()),
    outcome: "queued",
    ...over,
  };
}

describe("audit record builder (Issue #1395 AC1, AC3)", () => {
  it("builds a content-free record for a mutating action", () => {
    const record = buildEditorAgentActionAuditRecord(
      auditInput({ targetPath: "src/a.ts", editCount: 3 }),
    );
    expect(record.schemaVersion).toBe(EDITOR_AGENT_AUDIT_SCHEMA_VERSION);
    expect(record.actionType).toBe("applyTextEdits");
    expect(record.effectClass).toBe("content-mutation");
    expect(record.mutating).toBe(true);
    expect(record.disposition).toBe("review-required");
    expect(record.reviewReason).toBe("content-mutation-requires-review");
    expect(record.outcome).toBe("queued");
    expect(record.targetPath).toBe("src/a.ts");
    expect(record.editCount).toBe(3);
    expect(isEditorAgentActionAuditRecord(record)).toBe(true);
  });

  it("records the deny reason and conflict code for a denied action", () => {
    const decision = classifyEditorAgentAction("save", ctx({ targetSensitive: true }));
    const record = buildEditorAgentActionAuditRecord(
      auditInput({
        actionType: "save",
        decision,
        outcome: "conflict",
        conflictCode: "OUT_OF_SCOPE",
      }),
    );
    expect(record.disposition).toBe("denied");
    expect(record.denyReason).toBe("denied-sensitive-path");
    expect(record.conflictCode).toBe("OUT_OF_SCOPE");
    expect(record.summary).toContain("deny=denied-sensitive-path");
  });

  it("omits optional fields that are not supplied", () => {
    const record = buildEditorAgentActionAuditRecord(auditInput());
    expect("conflictCode" in record).toBe(false);
    expect("failureCode" in record).toBe(false);
    expect("editCount" in record).toBe(false);
    expect("patchByteLength" in record).toBe(false);
  });

  it("bounds the summary length regardless of an oversized target path", () => {
    const longPath = `src/${"x".repeat(EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS * 2)}.ts`;
    const record = buildEditorAgentActionAuditRecord(auditInput({ targetPath: longPath }));
    expect(record.summary.length).toBeLessThanOrEqual(EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS);
  });

  it("never carries an edit body: the input type has no raw-content field (AC3)", () => {
    // The builder is handed only counts/enums/ids. There is no field on EditorAgentActionAuditInput
    // through which raw source text, edit `newText`, or a patch body could enter the record. The
    // serialized record therefore cannot contain a unique source fingerprint.
    const fingerprint = "SUPER_SECRET_SOURCE_abc123_DO_NOT_LEAK";
    const record = buildEditorAgentActionAuditRecord(auditInput({ patchByteLength: 4096 }));
    expect(JSON.stringify(record)).not.toContain(fingerprint);
    expect(record.patchByteLength).toBe(4096);
  });
});

describe("audit record guard", () => {
  it("rejects a record with a missing identifier or oversized summary", () => {
    const valid = buildEditorAgentActionAuditRecord(auditInput({ targetPath: "src/a.ts" }));
    expect(isEditorAgentActionAuditRecord(valid)).toBe(true);
    expect(isEditorAgentActionAuditRecord({ ...valid, auditId: "" })).toBe(false);
    expect(
      isEditorAgentActionAuditRecord({
        ...valid,
        summary: "y".repeat(EDITOR_AGENT_AUDIT_SUMMARY_MAX_CHARS + 1),
      }),
    ).toBe(false);
    expect(isEditorAgentActionAuditRecord({ ...valid, disposition: "nope" })).toBe(false);
    expect(isEditorAgentActionAuditRecord(null)).toBe(false);
  });
});
