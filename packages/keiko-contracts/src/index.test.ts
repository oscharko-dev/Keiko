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
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  EMBEDDING_VECTOR_METRICS,
  KNOWLEDGE_SOURCE_SCOPE_KINDS,
  CAPSULE_LIFECYCLE_STATES,
  CAPSULE_RETRIEVAL_EFFORTS,
  CAPSULE_OUTPUT_MODES,
  CAPSULE_ANSWER_GROUNDING_POLICIES,
  CONNECTOR_NODE_KINDS,
  DOCUMENT_STATUSES,
  PARSED_UNIT_KINDS,
  PARSER_DIAGNOSTIC_SEVERITIES,
  INDEXING_JOB_STATUSES,
  CAPSULE_REINDEX_MODES,
  isSafeScopePath,
  isSafeStorageReference,
  isSafeDisplaySummary,
  validateEmbeddingModelIdentity,
  validateKnowledgeSourceScope,
  validateKnowledgeCapsule,
  validateCapsuleSet,
  validateCapsuleReindexRequest,
  validateConnectorGraphState,
  LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
  KNOWLEDGE_CAPSULE_DDL,
  KNOWLEDGE_CAPSULE_INDEXES,
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_TABLES,
  KNOWLEDGE_CAPSULE_INDEX_NAMES,
  DELETE_CAPSULE_SQL,
  validateCapsuleRowShape,
  redactPathInDiagnostic,
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
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  CapsuleSetId,
  DocumentId,
  ChunkId,
  VectorId,
  EmbeddingModelIdentity,
  ParserIdentity,
  KnowledgeSource,
  KnowledgeSourceScope,
  KnowledgeCapsule,
  CapsuleSet,
  ConnectorGraphState,
  ConnectorNode,
  ConnectorNodeRef,
  ConnectorEdge,
  DocumentRecord,
  PageRecord,
  SectionRecord,
  ParsedUnit,
  ChunkRecord,
  VectorRecord,
  CitationReference,
  RetrievalReference,
  ParserResult,
  ParserDiagnostic,
  CapsuleReindexRequest,
  IndexingJobRecord,
  CapsuleHealth,
  CapsuleDeleteRequest,
  LocalKnowledgeValidation,
  LocalKnowledgeValidationOk,
  LocalKnowledgeValidationFail,
  KnowledgeCapsuleMigration,
  CapsuleRowShape,
  RedactPathOptions,
  SelectedScope,
} from "./index.js";

describe("keiko-contracts package surface", () => {
  it("exposes the version constant pinned at 0.8.0", () => {
    expect(KEIKO_CONTRACTS_VERSION).toBe("0.8.0");
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

  it("local-knowledge value re-exports are reachable through the barrel (#191)", () => {
    expect(LOCAL_KNOWLEDGE_SCHEMA_VERSION).toBe("1");
    expect(EMBEDDING_VECTOR_METRICS).toContain("cosine");
    expect(KNOWLEDGE_SOURCE_SCOPE_KINDS).toContain("folder");
    expect(KNOWLEDGE_SOURCE_SCOPE_KINDS).toContain("repository");
    expect(KNOWLEDGE_SOURCE_SCOPE_KINDS).toContain("files");
    expect(CAPSULE_LIFECYCLE_STATES).toContain("ready");
    expect(CAPSULE_RETRIEVAL_EFFORTS).toContain("default");
    expect(CAPSULE_OUTPUT_MODES).toContain("answers");
    expect(CAPSULE_ANSWER_GROUNDING_POLICIES).toContain("require-citations");
    expect(CONNECTOR_NODE_KINDS).toContain("local-knowledge");
    expect(DOCUMENT_STATUSES).toContain("extracted");
    expect(PARSED_UNIT_KINDS).toContain("page");
    expect(PARSER_DIAGNOSTIC_SEVERITIES).toContain("error");
    expect(INDEXING_JOB_STATUSES).toContain("succeeded");
    expect(CAPSULE_REINDEX_MODES).toContain("changed-files");
    expect(typeof isSafeScopePath).toBe("function");
    expect(typeof isSafeStorageReference).toBe("function");
    expect(typeof isSafeDisplaySummary).toBe("function");
    expect(typeof validateEmbeddingModelIdentity).toBe("function");
    expect(typeof validateKnowledgeSourceScope).toBe("function");
    expect(typeof validateKnowledgeCapsule).toBe("function");
    expect(typeof validateCapsuleSet).toBe("function");
    expect(typeof validateCapsuleReindexRequest).toBe("function");
    expect(typeof validateConnectorGraphState).toBe("function");
  });

  it("local-knowledge type re-exports are reachable through the barrel (#191)", () => {
    // Phantom generic pins each new local-knowledge type onto the barrel surface; a future
    // refactor that drops one of these names fails this test at compile time. See #186 above
    // for the same pattern. The lineage pins below assert KnowledgeCapsuleId, KnowledgeSourceId,
    // and DocumentId are reachable as distinct branded names — the Foundry-IQ contract that no
    // record can collapse capsule/source/document lineage into a single global pool.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<KnowledgeCapsuleId>();
    pin<KnowledgeSourceId>();
    pin<CapsuleSetId>();
    pin<DocumentId>();
    pin<ChunkId>();
    pin<VectorId>();
    pin<EmbeddingModelIdentity>();
    pin<ParserIdentity>();
    pin<KnowledgeSource>();
    pin<KnowledgeSourceScope>();
    pin<KnowledgeCapsule>();
    pin<CapsuleSet>();
    pin<ConnectorGraphState>();
    pin<ConnectorNode>();
    pin<ConnectorNodeRef>();
    pin<ConnectorEdge>();
    pin<DocumentRecord>();
    pin<PageRecord>();
    pin<SectionRecord>();
    pin<ParsedUnit>();
    pin<ChunkRecord>();
    pin<VectorRecord>();
    pin<CitationReference>();
    pin<RetrievalReference>();
    pin<ParserResult>();
    pin<ParserDiagnostic>();
    pin<CapsuleReindexRequest>();
    pin<IndexingJobRecord>();
    pin<CapsuleHealth>();
    pin<CapsuleDeleteRequest>();
    pin<LocalKnowledgeValidation<KnowledgeCapsule>>();
    pin<LocalKnowledgeValidationOk<KnowledgeCapsule>>();
    pin<LocalKnowledgeValidationFail>();
  });

  it("knowledge-capsule schema value re-exports are reachable through the barrel (#265)", () => {
    expect(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION).toBe(9);
    // The string contract version and the integer DB version must remain distinct so the
    // contract surface and the on-disk DDL can evolve independently.
    expect(typeof LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION).toBe("number");
    expect(typeof LOCAL_KNOWLEDGE_SCHEMA_VERSION).toBe("string");
    expect(KNOWLEDGE_CAPSULE_DDL[0]).toBe("PRAGMA foreign_keys = ON;");
    expect(KNOWLEDGE_CAPSULE_TABLES).toContain("capsules");
    expect(KNOWLEDGE_CAPSULE_TABLES).toContain("vectors");
    expect(KNOWLEDGE_CAPSULE_INDEXES.length).toBeGreaterThan(0);
    expect(KNOWLEDGE_CAPSULE_INDEX_NAMES).toContain("idx_vectors_capsule_identity");
    expect(KNOWLEDGE_CAPSULE_MIGRATIONS[0]?.version).toBe(1);
    expect(DELETE_CAPSULE_SQL).toContain("DELETE FROM capsules");
    expect(typeof validateCapsuleRowShape).toBe("function");
    expect(typeof redactPathInDiagnostic).toBe("function");
  });

  it("knowledge-capsule schema type re-exports are reachable through the barrel (#265)", () => {
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<KnowledgeCapsuleMigration>();
    pin<CapsuleRowShape>();
    pin<RedactPathOptions>();
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

  it("memory contract value re-exports are reachable through the barrel (#205)", async () => {
    const mod = await import("./index.js");
    expect(mod.MEMORY_SCHEMA_VERSION).toBe("1");
    expect(mod.MEMORY_SCOPE_KINDS).toContain("user");
    expect(mod.MEMORY_SCOPE_KINDS).toContain("global");
    expect(mod.MEMORY_TYPES).toContain("preference");
    expect(mod.MEMORY_TYPES).toContain("correction");
    expect(mod.MEMORY_SENSITIVITIES).toEqual(["public", "confidential", "restricted"]);
    expect(mod.MEMORY_STATUSES).toContain("proposed");
    expect(mod.MEMORY_STATUSES).toContain("forgotten");
    expect(mod.MEMORY_SOURCE_KINDS).toContain("accepted-correction");
    expect(mod.MEMORY_EDGE_KINDS).toContain("supersedes");
    expect(mod.MEMORY_AUDIT_ACTION_KINDS).toContain("retrieved");
    expect(mod.MEMORY_AUDIT_INITIATOR_SURFACES).toContain("memory-center");
    expect(mod.MEMORY_UPDATE_FIELDS).toContain("body");
    expect(mod.MEMORY_STRUCTURED_PAYLOAD_KINDS).toContain("string-list");
    expect(mod.MEMORY_STATUS_TRANSITIONS.proposed).toContain("accepted");
    expect(typeof mod.checkStatusTransition).toBe("function");
    expect(typeof mod.validateMemoryRecord).toBe("function");
    expect(typeof mod.validateMemoryProposal).toBe("function");
    expect(typeof mod.validateMemoryAuditRecord).toBe("function");
    expect(typeof mod.isMemoryRecord).toBe("function");
    expect(typeof mod.isMemoryEdge).toBe("function");
    expect(typeof mod.isScopeReachable).toBe("function");
    expect(typeof mod.assertNeverMemoryType).toBe("function");
    expect(typeof mod.looksLikeSecretShape).toBe("function");
    expect(typeof mod.hasStaleModelMetadata).toBe("function");
  });

  it("memory contract type re-exports are reachable through the barrel (#205)", () => {
    type Mod = typeof import("./index.js");
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<Mod["MEMORY_SCOPE_KINDS"]>();
    // Phantom imports to pin the type-only surface added by #205. A future refactor that
    // drops one of these names stops this test compiling.
    type _MemoryRecord = import("./index.js").MemoryRecord;
    type _MemoryEdge = import("./index.js").MemoryEdge;
    type _MemoryProposal = import("./index.js").MemoryProposal;
    type _MemoryAcceptance = import("./index.js").MemoryAcceptance;
    type _MemoryRejection = import("./index.js").MemoryRejection;
    type _MemoryUpdate = import("./index.js").MemoryUpdate;
    type _MemorySupersession = import("./index.js").MemorySupersession;
    type _MemoryPin = import("./index.js").MemoryPin;
    type _MemoryUnpin = import("./index.js").MemoryUnpin;
    type _MemoryArchive = import("./index.js").MemoryArchive;
    type _MemoryForget = import("./index.js").MemoryForget;
    type _MemoryRetrievalRequest = import("./index.js").MemoryRetrievalRequest;
    type _MemoryAuditRecord = import("./index.js").MemoryAuditRecord;
    type _MemoryScope = import("./index.js").MemoryScope;
    type _MemoryProvenance = import("./index.js").MemoryProvenance;
    type _MemoryValidityInterval = import("./index.js").MemoryValidityInterval;
    type _MemoryRetentionHint = import("./index.js").MemoryRetentionHint;
    type _MemoryModelIdentity = import("./index.js").MemoryModelIdentity;
    type _MemoryStructuredPayload = import("./index.js").MemoryStructuredPayload;
    type _MemoryValidation = import("./index.js").MemoryValidation<_MemoryRecord>;
    pin<_MemoryRecord>();
    pin<_MemoryEdge>();
    pin<_MemoryProposal>();
    pin<_MemoryAcceptance>();
    pin<_MemoryRejection>();
    pin<_MemoryUpdate>();
    pin<_MemorySupersession>();
    pin<_MemoryPin>();
    pin<_MemoryUnpin>();
    pin<_MemoryArchive>();
    pin<_MemoryForget>();
    pin<_MemoryRetrievalRequest>();
    pin<_MemoryAuditRecord>();
    pin<_MemoryScope>();
    pin<_MemoryProvenance>();
    pin<_MemoryValidityInterval>();
    pin<_MemoryRetentionHint>();
    pin<_MemoryModelIdentity>();
    pin<_MemoryStructuredPayload>();
    pin<_MemoryValidation>();
    expect(true).toBe(true);
  });

  it("memory subpath barrel is importable as @oscharko-dev/keiko-contracts/memory (#205)", async () => {
    const subpath = await import("./memory-barrel.js");
    expect(subpath.MEMORY_SCHEMA_VERSION).toBe("1");
    expect(typeof subpath.validateMemoryRecord).toBe("function");
    expect(typeof subpath.isScopeReachable).toBe("function");
  });

  it("memory workflow port re-exports are reachable through the barrel (#213)", () => {
    const pin = <T>(_value?: T): T | undefined => undefined;
    type _MemoryWorkflowPort = import("./index.js").MemoryWorkflowPort;
    type _MemoryWorkflowContext = import("./index.js").MemoryWorkflowContext;
    type _MemoryUsedEvent = import("./index.js").MemoryUsedEvent;
    type _MemoryOmittedEvent = import("./index.js").MemoryOmittedEvent;
    type _MemoryWriteCandidateEvent = import("./index.js").MemoryWriteCandidateEvent;
    pin<_MemoryWorkflowPort>();
    pin<_MemoryWorkflowContext>();
    pin<_MemoryUsedEvent>();
    pin<_MemoryOmittedEvent>();
    pin<_MemoryWriteCandidateEvent>();
    expect(true).toBe(true);
  });

  it("memory workflow port subpath is importable (#213)", async () => {
    const subpath = await import("./memory-workflow-port.js");
    // Pure type-only module: it should import cleanly with no runtime exports.
    expect(Object.keys(subpath).length).toBe(0);
  });

  it("memory audit event surface re-exports are reachable through the barrel (#214)", async () => {
    const mod = await import("./index.js");
    expect(mod.MEMORY_AUDIT_EVENT_SCHEMA_VERSION).toBe("1");
    expect(mod.MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS).toBe(240);
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:proposed");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:accepted");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:rejected");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:updated");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:superseded");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:pinned");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:unpinned");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:archived");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:forgotten");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:retrieved");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:workflow-used");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS.length).toBe(11);
    const pin = <T>(_value?: T): T | undefined => undefined;
    type _MemoryAuditEvent = import("./index.js").MemoryAuditEvent;
    type _MemoryAuditEventKind = import("./index.js").MemoryAuditEventKind;
    pin<_MemoryAuditEvent>();
    pin<_MemoryAuditEventKind>();
  });

  it("memory audit event subpath is importable as @oscharko-dev/keiko-contracts/memory-audit-events (#214)", async () => {
    const subpath = await import("./memory-audit-events.js");
    expect(subpath.MEMORY_AUDIT_EVENT_SCHEMA_VERSION).toBe("1");
    expect(subpath.MEMORY_AUDIT_EVENT_KINDS.length).toBe(11);
    expect(subpath.MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS).toBe(240);
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
