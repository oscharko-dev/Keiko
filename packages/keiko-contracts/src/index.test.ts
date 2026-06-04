import { describe, it, expect } from "vitest";
import {
  KEIKO_CONTRACTS_VERSION,
  HARNESS_CODES,
  DEFAULT_LIMITS,
  HARNESS_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  DEFAULT_RETENTION,
  DEFAULT_PATCH_LIMITS,
  DEFAULT_VERIFICATION_LIMITS,
  EVAL_SCORECARD_SCHEMA_VERSION,
  TERMINAL_STATES,
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  DEFAULT_PATCH_SCOPE_LIMITS,
  EXPECTED_CHECKS,
  WORKFLOW_KINDS,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  SELECTED_SCOPE_KINDS,
  isApprovalTokenShape,
  checkPatchAgainstScope,
  validateSelectedScope,
  validatePatchScope,
  validateWorkflowHandoffRequest,
} from "./index.js";
import type {
  ConnectedContextPack,
  ToolPort,
  ToolCallRequest,
  ToolCallResult,
  ToolCallMetadata,
  SideFileWriteResult,
  EvidenceDeps,
  EvidenceConnectedContextAudit,
  EvidenceConnectedContextExcerpt,
  EvidenceConnectedContextFile,
  EvidenceConnectedContextOmitted,
  EvidenceConnectedContextQuery,
  EvidenceConnectedContextScope,
  EvidenceConnectedContextUncertainty,
  PatchScope,
  PatchScopeLimits,
  PatchScopeViolation,
  PatchScopeViolationKind,
  PatchScopeCheck,
  ProposedPatchEntry,
  WorkflowHandoffRequest,
  UserApprovalTokenInput,
  ExpectedCheck,
  SelectedScope,
} from "./index.js";

describe("keiko-contracts package surface", () => {
  it("exposes the version constant pinned at 0.4.0", () => {
    expect(KEIKO_CONTRACTS_VERSION).toBe("0.4.0");
  });

  it("HARNESS_CODES.LIMIT_ITERATIONS is the canonical code string", () => {
    expect(HARNESS_CODES.LIMIT_ITERATIONS).toBe("HARNESS_LIMIT_ITERATIONS");
  });

  it("DEFAULT_LIMITS.maxIterations is 10", () => {
    expect(DEFAULT_LIMITS.maxIterations).toBe(10);
  });

  it("HARNESS_VERSION is the literal '0.1.7'", () => {
    expect(HARNESS_VERSION).toBe("0.1.7");
  });

  it("EVIDENCE_SCHEMA_VERSION is the literal string '1'", () => {
    expect(EVIDENCE_SCHEMA_VERSION).toBe("1");
  });

  it("DEFAULT_RETENTION.maxRuns is 50", () => {
    expect(DEFAULT_RETENTION.maxRuns).toBe(50);
  });

  it("DEFAULT_PATCH_LIMITS has a positive maxFilesChanged", () => {
    expect(DEFAULT_PATCH_LIMITS.maxFilesChanged).toBeGreaterThan(0);
  });

  it("DEFAULT_VERIFICATION_LIMITS has a positive wallTimeMs", () => {
    expect(DEFAULT_VERIFICATION_LIMITS.wallTimeMs).toBeGreaterThan(0);
  });

  it("EVAL_SCORECARD_SCHEMA_VERSION is the literal string '1'", () => {
    expect(EVAL_SCORECARD_SCHEMA_VERSION).toBe("1");
  });

  it("TERMINAL_STATES contains 'completed' and 'failed'", () => {
    expect(TERMINAL_STATES.has("completed")).toBe(true);
    expect(TERMINAL_STATES.has("failed")).toBe(true);
  });

  it("each new type-only export added by #162 is reachable by name at compile time", () => {
    // verbatimModuleSyntax requires the type imports above to be used in a type position. A
    // phantom generic `pin<T>()` references the type argument at the call site without producing
    // any runtime value, so each symbol stays load-bearing on the public surface.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<ToolPort>();
    pin<ToolCallRequest>();
    pin<ToolCallResult>();
    pin<ToolCallMetadata>();
    pin<SideFileWriteResult>();
  });

  it("workflow-handoff value re-exports are reachable through the barrel (#186)", () => {
    expect(WORKFLOW_HANDOFF_SCHEMA_VERSION).toBe("1");
    expect(DEFAULT_PATCH_SCOPE_LIMITS.maxFileCount).toBeGreaterThan(0);
    expect(EXPECTED_CHECKS).toContain("verify");
    expect(WORKFLOW_KINDS).toContain("unit-test-generation");
    expect(typeof isApprovalTokenShape).toBe("function");
    expect(typeof validatePatchScope).toBe("function");
    expect(typeof validateWorkflowHandoffRequest).toBe("function");
    expect(typeof checkPatchAgainstScope).toBe("function");
  });

  it("workflow-handoff type re-exports are reachable through the barrel (#186)", () => {
    // Phantom generic keeps verbatimModuleSyntax happy without producing runtime values; if a
    // future refactor drops one of the names from the package surface, this test stops
    // compiling — the same guard pattern used for the #162 tool ports above.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<PatchScope>();
    pin<PatchScopeLimits>();
    pin<PatchScopeViolation>();
    pin<PatchScopeViolationKind>();
    pin<PatchScopeCheck>();
    pin<ProposedPatchEntry>();
    pin<WorkflowHandoffRequest>();
    pin<UserApprovalTokenInput>();
    pin<ExpectedCheck>();
  });

  it("EvidenceDeps.costClassResolver (#163) is an optional injection port shape", () => {
    // Pin the new optional field added in issue #163 so a future refactor that drops it from the
    // EvidenceDeps surface fails this test instead of silently weakening the evidence layer's
    // dependency-direction posture (ADR-0019 rule 3d). Phantom assignment proves the function
    // signature compiles; absence path is the runtime default the package contract guarantees.
    const deps: EvidenceDeps = { costClassResolver: (_modelId) => "unknown" };
    expect(deps.costClassResolver?.("any")).toBe("unknown");
    const empty: EvidenceDeps = {};
    expect(empty.costClassResolver).toBeUndefined();
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<EvidenceConnectedContextAudit>();
    pin<EvidenceConnectedContextExcerpt>();
    pin<EvidenceConnectedContextFile>();
    pin<EvidenceConnectedContextOmitted>();
    pin<EvidenceConnectedContextQuery>();
    pin<EvidenceConnectedContextScope>();
    pin<EvidenceConnectedContextUncertainty>();
  });

  it("connected-context barrel exports are reachable through the root surface (#178)", () => {
    expect(CONNECTED_CONTEXT_SCHEMA_VERSION).toBe("1");
    expect(SELECTED_SCOPE_KINDS).toContain("files");
    const scope: SelectedScope = {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      scopeId: "scope-1",
      workspaceRoot: "/repo",
      kind: "workspace-root",
      relativePaths: [],
      conversationId: undefined,
      connectedAtMs: 1,
    };
    expect(validateSelectedScope(scope)).toEqual({ ok: true });
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<ConnectedContextPack>();
  });
});
