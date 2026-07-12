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
  KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
  isKnowledgePodEvidenceSafeText,
  validateKnowledgePodSummary,
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
  INFILLING_ALIGNMENTS,
  modelSupportsInfilling,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  validateCapsuleRowShape,
  redactPathInDiagnostic,
  normalizePdfCitationPreviewMarkerIndex,
  assertValidGatewaySamplingParameters,
  isValidGatewaySamplingParameters,
  validateGatewaySamplingParameters,
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
  ParserDependencyVersion,
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
  ModelCapability,
  InfillingAlignment,
  CompletionInteractionMode,
  CompletionDegradeReason,
  CompletionModelSelection,
  GatewayRequest,
  GitDeliveryActionEnvelope,
  GitDeliveryResolvedInputs,
  GitDeliveryConstraint,
  GitDeliveryPolicyDecision,
  GitDeliveryBranchProtection,
  GitDeliveryMergeReadiness,
  GitDeliveryPullRequestState,
  GitDeliveryActionSheet,
  GitDeliveryPreviewManifest,
  GitDeliveryApprovalSummary,
  GitDeliveryRecoveryHint,
  GitDeliveryExpectedBlocker,
  GitDeliveryActionSheetRequest,
  GitDeliveryWorktreeSnapshot,
} from "./index.js";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
  GIT_DELIVERY_ACTION_KINDS,
  GIT_DELIVERY_RISK_CLASSES,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  GIT_DELIVERY_ACTION_RISK_DEFAULTS,
  GIT_DELIVERY_BLOCK_REASONS,
  GIT_DELIVERY_PROVIDER_CAPABILITIES,
  GIT_DELIVERY_RULE_DECISIONS,
  GIT_DELIVERY_CHECKS_OVERALL_STATUSES,
  GIT_DELIVERY_PULL_REQUEST_STATUSES,
  GIT_DELIVERY_BRANCH_MATCH_KINDS,
  GIT_DELIVERY_EXECUTION_ERROR_CODES,
  GIT_DELIVERY_EXECUTION_OUTCOMES,
  GIT_DELIVERY_MERGE_BLOCK_REASONS,
  isGitDeliveryActionKind,
  isGitDeliveryRemoteTargetPolicy,
  gitDeliveryDefaultRiskClass,
  evaluateGitPolicy,
  parseGitDeliveryActionEnvelope,
  GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION,
  GIT_DELIVERY_ACTION_SHEET_STATES,
  GIT_DELIVERY_APPROVAL_NECESSITIES,
  GIT_DELIVERY_BLOCKED_CAUSES,
  GIT_DELIVERY_RECOVERY_ACTION_HINTS,
  isGitDeliveryActionSheet,
  buildGitDeliveryActionSheet,
  gitDeliverySuggestedRecoveryStrategy,
  GIT_DELIVERY_POLICY_DECISION_OUTCOMES,
  isGitDeliveryPolicyDecisionOutcome,
} from "./index.js";

describe("keiko-contracts package surface", () => {
  it("exposes the version constant pinned at 0.2.15", () => {
    expect(KEIKO_CONTRACTS_VERSION).toBe("0.2.15");
  });

  it("HARNESS_CODES.LIMIT_ITERATIONS is the canonical code string", () => {
    expect(HARNESS_CODES.LIMIT_ITERATIONS).toBe("HARNESS_LIMIT_ITERATIONS");
  });

  it("accepts legacy gateway requests without sampling parameters", () => {
    const request: GatewayRequest = {
      modelId: "plain-chat",
      messages: [{ role: "user", content: "hi" }],
    };
    expect(isValidGatewaySamplingParameters(request)).toBe(true);
    expect(validateGatewaySamplingParameters(request)).toEqual([]);
  });

  it("accepts deterministic gateway sampling parameters", () => {
    const request: GatewayRequest = {
      modelId: "deterministic-chat",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      topP: 1,
    };
    expect(isValidGatewaySamplingParameters(request)).toBe(true);
    expect(() => {
      assertValidGatewaySamplingParameters(request);
    }).not.toThrow();
  });

  it("rejects invalid gateway sampling parameters", () => {
    const issues = validateGatewaySamplingParameters({ temperature: -0.1, topP: 1.1 });
    expect(issues.map((issue) => issue.parameter)).toEqual(["temperature", "topP"]);
    expect(() => {
      assertValidGatewaySamplingParameters({ temperature: Number.NaN });
    }).toThrow(RangeError);
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
    expect(pin<SideFileWriteResult>()).toBeUndefined();
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
    expect(pin<ExpectedCheck>()).toBeUndefined();
  });

  it("FIM completion value re-exports are reachable through the barrel (#1210)", () => {
    const fastAligned: ModelCapability = {
      id: "fast-instruct",
      kind: "chat",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: true,
      costClass: "low",
      latencyClass: "fast",
      throughputHint: "test",
      preferredUseCases: ["completion"],
      knownLimitations: [],
      supportsInfilling: true,
      infillingAlignment: "instruct",
    };
    const fastBase: ModelCapability = {
      ...fastAligned,
      id: "fast-base",
      infillingAlignment: "base",
    };

    expect(INFILLING_ALIGNMENTS).toEqual(["base", "instruct", "edit-tuned"]);
    expect(modelSupportsInfilling(fastAligned)).toBe(true);
    expect(isAlignedInfillingModel(fastAligned)).toBe(true);
    expect(isAlignedInfillingModel(fastBase)).toBe(false);
    expect(isAsYouTypeCompletionModel(fastAligned)).toBe(true);
  });

  it("FIM completion type re-exports are reachable through the barrel (#1210)", () => {
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<InfillingAlignment>();
    pin<CompletionInteractionMode>();
    pin<CompletionDegradeReason>();
    expect(pin<CompletionModelSelection>()).toBeUndefined();
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
    expect(DOCUMENT_STATUSES).toContain("extracted-image");
    expect(PARSED_UNIT_KINDS).toContain("page");
    expect(PARSER_DIAGNOSTIC_SEVERITIES).toContain("error");
    expect(INDEXING_JOB_STATUSES).toContain("succeeded");
    expect(CAPSULE_REINDEX_MODES).toContain("changed-files");
    expect(typeof isSafeScopePath).toBe("function");
    expect(typeof isSafeStorageReference).toBe("function");
    expect(typeof isSafeDisplaySummary).toBe("function");
    expect(KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION).toBe("1");
    expect(typeof isKnowledgePodEvidenceSafeText).toBe("function");
    expect(typeof validateKnowledgePodSummary).toBe("function");
    expect(typeof validateEmbeddingModelIdentity).toBe("function");
    expect(typeof validateKnowledgeSourceScope).toBe("function");
    expect(typeof validateKnowledgeCapsule).toBe("function");
    expect(typeof validateCapsuleSet).toBe("function");
    expect(typeof validateCapsuleReindexRequest).toBe("function");
    expect(typeof validateConnectorGraphState).toBe("function");
    expect(typeof normalizePdfCitationPreviewMarkerIndex).toBe("function");
  });

  it("normalizes PDF citation preview marker indexes consistently", () => {
    expect(normalizePdfCitationPreviewMarkerIndex("[1]")).toBe(1);
    expect(normalizePdfCitationPreviewMarkerIndex("1")).toBe(1);
    expect(normalizePdfCitationPreviewMarkerIndex("［1］")).toBe(1);
    expect(normalizePdfCitationPreviewMarkerIndex("【1】")).toBe(1);
    expect(normalizePdfCitationPreviewMarkerIndex("[1】")).toBeUndefined();
    expect(normalizePdfCitationPreviewMarkerIndex("【1]")).toBeUndefined();
    expect(normalizePdfCitationPreviewMarkerIndex(0)).toBeUndefined();
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
    pin<ParserDependencyVersion>();
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
    expect(pin<LocalKnowledgeValidationFail>()).toBeUndefined();
  });

  it("knowledge-capsule schema value re-exports are reachable through the barrel (#265)", () => {
    expect(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION).toBe(29);
    // The string contract version and the integer DB version must remain distinct so the
    // contract surface and the on-disk DDL can evolve independently.
    expect(typeof LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION).toBe("number");
    expect(typeof LOCAL_KNOWLEDGE_SCHEMA_VERSION).toBe("string");
    expect(KNOWLEDGE_CAPSULE_DDL[0]).toBe("PRAGMA foreign_keys = ON;");
    expect(KNOWLEDGE_CAPSULE_TABLES).toContain("capsules");
    expect(KNOWLEDGE_CAPSULE_TABLES).toContain("document_blobs");
    expect(KNOWLEDGE_CAPSULE_TABLES).toContain("chunk_lexical_index");
    expect(KNOWLEDGE_CAPSULE_TABLES).toContain("vectors");
    expect(KNOWLEDGE_CAPSULE_INDEXES.length).toBeGreaterThan(0);
    expect(KNOWLEDGE_CAPSULE_INDEX_NAMES).toContain("idx_vectors_capsule_identity");
    expect(KNOWLEDGE_CAPSULE_INDEX_NAMES).toContain("idx_sections_document_section_path_hash");
    expect(KNOWLEDGE_CAPSULE_INDEX_NAMES).toContain("idx_document_blobs_created_document");
    expect(KNOWLEDGE_CAPSULE_INDEX_NAMES).toContain("idx_chunk_lexical_capsule_document");
    expect(KNOWLEDGE_CAPSULE_MIGRATIONS[0]?.version).toBe(1);
    expect(DELETE_CAPSULE_SQL).toContain("DELETE FROM capsules");
    expect(typeof validateCapsuleRowShape).toBe("function");
    expect(typeof redactPathInDiagnostic).toBe("function");
  });

  it("knowledge-capsule schema type re-exports are reachable through the barrel (#265)", () => {
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<KnowledgeCapsuleMigration>();
    pin<CapsuleRowShape>();
    expect(pin<RedactPathOptions>()).toBeUndefined();
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
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:workflow-omitted");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toContain("memory:workflow-write-candidate");
    expect(mod.MEMORY_AUDIT_EVENT_KINDS.length).toBe(13);
    const pin = <T>(_value?: T): T | undefined => undefined;
    type _MemoryAuditEvent = import("./index.js").MemoryAuditEvent;
    type _MemoryAuditEventKind = import("./index.js").MemoryAuditEventKind;
    pin<_MemoryAuditEvent>();
    pin<_MemoryAuditEventKind>();
  });

  it("memory audit event subpath is importable as @oscharko-dev/keiko-contracts/memory-audit-events (#214)", async () => {
    const subpath = await import("./memory-audit-events.js");
    expect(subpath.MEMORY_AUDIT_EVENT_SCHEMA_VERSION).toBe("1");
    expect(subpath.MEMORY_AUDIT_EVENT_KINDS.length).toBe(13);
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

  it("editor-agent contract value re-exports are reachable through the barrel (#1391)", async () => {
    const mod = await import("./index.js");
    // Compatibility pin for the schema version constant: the public agent-editor contract is v1.
    expect(mod.EDITOR_AGENT_SCHEMA_VERSION).toBe("1");
    expect(mod.EDITOR_AGENT_DIAGNOSTICS_MAX_ITEMS).toBe(128);
    expect(mod.EDITOR_AGENT_DIAGNOSTIC_MESSAGE_MAX_CHARS).toBe(1_024);
    expect(mod.EDITOR_AGENT_RESULT_MESSAGE_MAX_CHARS).toBe(1_024);
    expect(mod.DEFAULT_EDITOR_AGENT_ACTION_ORIGIN).toBe("agent");
    expect(mod.EDITOR_AGENT_ACTION_ORIGINS).toEqual(["agent", "chat"]);
    expect(mod.EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_BYTES).toBe(32);
    expect(mod.EDITOR_AGENT_BRIDGE_DECISION_CAPABILITY_ENCODED_CHARS).toBe(43);
    expect(mod.EDITOR_AGENT_ACTION_ID_MAX_BYTES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_SESSION_ID_MAX_BYTES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_IDEMPOTENCY_KEY_MAX_BYTES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_TARGET_PATH_MAX_BYTES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_WORKSPACE_ROOT_MAX_BYTES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_SNAPSHOT_MAX_PANES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_SNAPSHOT_MAX_OPEN_FILES_PER_PANE).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_SNAPSHOT_MAX_DIRTY_FILES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_SNAPSHOT_PATH_METADATA_MAX_BYTES).toBeGreaterThan(0);
    expect(mod.EDITOR_AGENT_SNAPSHOT_TEXT_MAX_BYTES).toBe(65_536);
    // AC1: the content-free default snapshot text mode is exported and is `none`.
    expect(mod.DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE).toBe("none");
    // AC3: the structured conflict-code taxonomy is exported in full, including PRECONDITION_REQUIRED
    // and the Issue #1392 NO_ACTIVE_BRIDGE liveness code.
    expect(mod.EDITOR_AGENT_CONFLICT_CODES).toContain("PRECONDITION_REQUIRED");
    expect(mod.EDITOR_AGENT_CONFLICT_CODES).toContain("NO_ACTIVE_BRIDGE");
    expect(mod.EDITOR_AGENT_CONFLICT_CODES).toContain("POLICY_DENIED");
    expect(mod.EDITOR_AGENT_CONFLICT_CODES).toContain("APPROVAL_REQUIRED");
    expect(mod.EDITOR_AGENT_CONFLICT_CODES.length).toBe(10);
    // Issue #1392: the lifecycle-failure taxonomy is exported alongside the conflict taxonomy.
    expect([...mod.EDITOR_AGENT_FAILURE_CODES].sort()).toEqual([
      "CANCELLED",
      "LIMIT_EXCEEDED",
      "PROVIDER_UNAVAILABLE",
      "QUEUE_FULL",
      "TIMED_OUT",
      "UNSUPPORTED_OPERATION",
    ]);
    // AC2: the write-action classification is exported as a single source of truth.
    expect([...mod.EDITOR_AGENT_WRITE_ACTION_TYPES].sort()).toEqual(
      ["applyChangeset", "applyPatch", "applyTextEdits", "format", "save"].sort(),
    );
    expect(typeof mod.isEditorAgentEvent).toBe("function");
    expect(typeof mod.isEditorAgentBridgeDecisionCapability).toBe("function");
    expect(typeof mod.isEditorAgentActiveBufferActionType).toBe("function");
    expect(typeof mod.isEditorAgentActionOrigin).toBe("function");
    expect(typeof mod.resolveEditorAgentActionOrigin).toBe("function");
    expect(typeof mod.isEditorAgentWriteActionType).toBe("function");
    expect(typeof mod.editorAgentWritePreconditionError).toBe("function");
    expect(typeof mod.editorAgentActionHasWritePrecondition).toBe("function");
    expect(typeof mod.isEditorAgentConflictCode).toBe("function");
    expect(typeof mod.isEditorAgentFailureCode).toBe("function");
    // Issue #2114 (ADR-0125 D3): the applyChangeset public contract surface — caps, changeset/
    // conflict/file-result guards, and the authority/approval reference guards — is re-exported
    // through the barrel so downstream packages import named symbols instead of re-deriving them.
    expect(mod.EDITOR_AGENT_CHANGESET_MAX_FILES).toBe(50);
    expect(mod.EDITOR_AGENT_CHANGESET_MAX_PATCH_BYTES).toBe(65_536);
    expect(mod.EDITOR_AGENT_PREPARED_CHANGESET_MAX_EDITS).toBe(2_000);
    expect(mod.EDITOR_AGENT_REFERENCE_ID_MAX_CHARS).toBe(128);
    expect(typeof mod.isEditorAgentChangeset).toBe("function");
    expect(typeof mod.isEditorAgentChangesetFile).toBe("function");
    expect(typeof mod.isEditorAgentConflictDetail).toBe("function");
    expect(typeof mod.isEditorAgentDiagnostic).toBe("function");
    expect(typeof mod.isEditorAgentDiagnosticsDetail).toBe("function");
    expect(typeof mod.isEditorAgentFileActionResult).toBe("function");
    expect(typeof mod.isEditorAgentGovernedAuthorityReference).toBe("function");
    expect(typeof mod.isEditorAgentOneUseApprovalReference).toBe("function");
    expect(typeof mod.isEditorAgentPreparedChangeset).toBe("function");
  });

  it("editor-agent contract type re-exports are reachable through the barrel (#1391)", () => {
    // Phantom generics pin the public contract types onto the barrel surface; a future refactor that
    // drops one of these names stops this test compiling (same guard pattern as #186/#205 above).
    const pin = <T>(_value?: T): T | undefined => undefined;
    type _Code = import("./index.js").EditorAgentConflictCode;
    type _Action = import("./index.js").EditorAgentAction;
    type _ActionOrigin = import("./index.js").EditorAgentActionOrigin;
    type _BridgeCapability = import("./index.js").EditorAgentBridgeDecisionCapability;
    type _Result = import("./index.js").EditorAgentActionResult;
    type _Event = import("./index.js").EditorAgentEvent;
    type _Diagnostic = import("./index.js").EditorAgentDiagnostic;
    type _DiagnosticsDetail = import("./index.js").EditorAgentDiagnosticsDetail;
    type _Snapshot = import("./index.js").EditorAgentSessionSnapshot;
    type _Request = import("./index.js").EditorAgentSnapshotRequest;
    // Issue #2114 (ADR-0125 D3): changeset / prepared-changeset / conflict / file-result types.
    type _Changeset = import("./index.js").EditorAgentChangeset;
    type _ChangesetFile = import("./index.js").EditorAgentChangesetFile;
    type _PreparedChangeset = import("./index.js").EditorAgentPreparedChangeset;
    type _PreparedChangesetFile = import("./index.js").EditorAgentPreparedChangesetFile;
    type _PreparedChangeKind = import("./index.js").EditorAgentPreparedChangeKind;
    type _PreparedTextEdit = import("./index.js").EditorAgentPreparedTextEdit;
    type _ConflictDetail = import("./index.js").EditorAgentConflictDetail;
    type _FileActionResult = import("./index.js").EditorAgentFileActionResult;
    type _FileActionStatus = import("./index.js").EditorAgentFileActionStatus;
    pin<_Code>();
    pin<_Action>();
    pin<_ActionOrigin>();
    pin<_BridgeCapability>();
    pin<_Result>();
    pin<_Event>();
    pin<_Diagnostic>();
    pin<_DiagnosticsDetail>();
    pin<_Snapshot>();
    pin<_Request>();
    pin<_Changeset>();
    pin<_ChangesetFile>();
    pin<_PreparedChangeset>();
    pin<_PreparedChangesetFile>();
    pin<_PreparedChangeKind>();
    pin<_PreparedTextEdit>();
    pin<_ConflictDetail>();
    pin<_FileActionResult>();
    pin<_FileActionStatus>();
    expect(true).toBe(true);
  });

  it("coding workbench mode-policy contracts are reachable through the barrel (#2091)", async () => {
    const mod = await import("./index.js");
    expect(mod.CODING_WORKBENCH_POLICY_EFFECTS).toEqual(["allowed", "approval-required", "denied"]);
    expect(mod.CODING_WORKBENCH_POLICY_RESOURCE_SCOPES).toEqual([
      "workspace-contained",
      "external-file",
      "internet",
      "delivery",
    ]);
    expect(mod.codingWorkbenchPolicyEffectFor("governed-assist", "internet", "low")).toBe(
      "approval-required",
    );
    expect(mod.strictestCodingWorkbenchPolicyEffect("allowed", "approval-required")).toBe(
      "approval-required",
    );

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").CodingWorkbenchPolicyEffect>();
    pin<import("./index.js").CodingWorkbenchPolicyResourceScope>();
    pin<import("./index.js").CodingWorkbenchModeDisplay>();
    pin<import("./index.js").CodingWorkbenchModeEffectMatrix>();
  });

  it("governed Git delivery contracts are reachable through the barrel (#471)", () => {
    // Schema versions.
    expect(GIT_DELIVERY_SCHEMA_VERSION).toBe("1");
    expect(GIT_DELIVERY_POLICY_SCHEMA_VERSION).toBe("1");
    expect(GIT_DELIVERY_PROVIDER_SCHEMA_VERSION).toBe("1");

    // Count assertions are intentional surface pins; bump deliberately when #472+ extends the surface.
    expect(GIT_DELIVERY_ACTION_KINDS.length).toBe(11);
    expect(GIT_DELIVERY_RISK_CLASSES.length).toBe(4);
    expect(GIT_DELIVERY_BLOCK_REASONS.length).toBe(6);
    expect(GIT_DELIVERY_PROVIDER_CAPABILITIES.length).toBe(5);
    expect(GIT_DELIVERY_RULE_DECISIONS.length).toBe(4);
    expect(GIT_DELIVERY_CHECKS_OVERALL_STATUSES.length).toBe(4);
    expect(GIT_DELIVERY_PULL_REQUEST_STATUSES.length).toBe(3);
    expect(GIT_DELIVERY_BRANCH_MATCH_KINDS.length).toBe(2);
    expect(GIT_DELIVERY_EXECUTION_ERROR_CODES.length).toBe(6);
    expect(GIT_DELIVERY_EXECUTION_OUTCOMES.length).toBe(4);
    expect(GIT_DELIVERY_MERGE_BLOCK_REASONS.length).toBe(6);

    // Risk severity and per-kind defaults cover every kind.
    expect(GIT_DELIVERY_RISK_CLASS_SEVERITY["local-mutation"]).toBe(1);
    expect(GIT_DELIVERY_RISK_CLASS_SEVERITY["recovery-or-rewrite"]).toBe(4);
    for (const kind of GIT_DELIVERY_ACTION_KINDS) {
      expect(GIT_DELIVERY_ACTION_RISK_DEFAULTS[kind]).toBeDefined();
    }

    // Value-level functions are reachable.
    expect(typeof isGitDeliveryActionKind).toBe("function");
    expect(typeof isGitDeliveryRemoteTargetPolicy).toBe("function");
    expect(typeof gitDeliveryDefaultRiskClass).toBe("function");
    expect(typeof evaluateGitPolicy).toBe("function");
    expect(typeof parseGitDeliveryActionEnvelope).toBe("function");
    expect(gitDeliveryDefaultRiskClass("unknown-future-kind")).toBe("recovery-or-rewrite");
    expect(isGitDeliveryActionKind("commit")).toBe(true);

    // Type pins (compile-time reachability).
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<GitDeliveryActionEnvelope>();
    pin<GitDeliveryResolvedInputs>();
    pin<GitDeliveryConstraint>();
    pin<GitDeliveryPolicyDecision>();
    pin<GitDeliveryBranchProtection>();
    pin<GitDeliveryMergeReadiness>();
    pin<GitDeliveryPullRequestState>();
  });

  it("governed Git action-sheet contracts are reachable through the barrel (#473)", () => {
    expect(GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION).toBe("1");
    // Count assertions are intentional surface pins; bump deliberately when the surface changes.
    expect(GIT_DELIVERY_ACTION_SHEET_STATES.length).toBe(3);
    expect(GIT_DELIVERY_APPROVAL_NECESSITIES.length).toBe(3);
    expect(GIT_DELIVERY_BLOCKED_CAUSES.length).toBe(3);
    expect(GIT_DELIVERY_RECOVERY_ACTION_HINTS.length).toBe(9);

    expect(typeof isGitDeliveryActionSheet).toBe("function");
    expect(typeof buildGitDeliveryActionSheet).toBe("function");
    expect(gitDeliverySuggestedRecoveryStrategy("commit", false)).toBe("soft-reset");
    expect(GIT_DELIVERY_POLICY_DECISION_OUTCOMES.length).toBe(4);
    expect(isGitDeliveryPolicyDecisionOutcome("approval-gated")).toBe(true);
    expect(isGitDeliveryPolicyDecisionOutcome("nonsense")).toBe(false);

    const sheet = buildGitDeliveryActionSheet({
      actionId: "act-1",
      resolvedInputs: {
        kind: "commit",
        messageByteLength: 8,
        stagedPathCount: 1,
        allowEmptyCommit: false,
      },
      policyDecision: { outcome: "allowed" },
      approvalRequirement: { required: false },
      providerReady: true,
      expectedBlockers: [],
      recovery: [],
    });
    expect(isGitDeliveryActionSheet(sheet)).toBe(true);
    expect(sheet.state).toBe("ready-to-execute");

    // Type pins (compile-time reachability).
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<GitDeliveryActionSheet>();
    pin<GitDeliveryPreviewManifest>();
    pin<GitDeliveryApprovalSummary>();
    pin<GitDeliveryRecoveryHint>();
    pin<GitDeliveryExpectedBlocker>();
    pin<GitDeliveryActionSheetRequest>();
    pin<GitDeliveryWorktreeSnapshot>();
  });

  it("governed GitHub pull request contracts are reachable through the barrel (#477)", async () => {
    const m = await import("./index.js");
    expect(m.GIT_PULL_REQUEST_SCHEMA_VERSION).toBe("1");
    // Count assertions are intentional surface pins; bump deliberately when the surface changes.
    expect(m.GIT_PR_CHANGE_TYPES.length).toBe(7);
    expect(m.GIT_PR_READINESS_BLOCKER_CODES.length).toBe(9);
    expect(m.GIT_PR_RECOMMENDATIONS.length).toBe(5);
    expect(m.GIT_PR_REJECTION_REASONS.length).toBe(9);

    expect(typeof m.synthesizePullRequestMetadata).toBe("function");
    expect(typeof m.gitPullRequestReadinessFor).toBe("function");
    expect(typeof m.gitPullRequestRecommendationFor).toBe("function");
    expect(m.gitPrRejectionToErrorCode("rate-limited")).toBe("network-failure");
    expect(m.gitPrRejectionToDisposition("validation-error")).toBe("user-fixable");

    const readiness = m.gitPullRequestReadinessFor({
      headBranchName: "claude/issue-477-x",
      baseBranchName: "dev",
      headPublished: true,
      baseExists: true,
    });
    expect(m.isGitPullRequestReadinessSummary(readiness)).toBe(true);
    expect(readiness.objectExists).toBe(false);
  });

  it("managed LSP activation contracts are reachable through the barrel (#2271)", async () => {
    const m = await import("./index.js");
    expect(m.MANAGED_LSP_ACTIVATION_SCHEMA_VERSION).toBe("1");
    expect(m.MANAGED_LSP_LANGUAGES).toEqual(["python", "go", "shell", "java", "rust"]);
    // Count assertions are intentional surface pins; bump deliberately when the surface changes.
    expect(m.MANAGED_LSP_EFFECTIVE_STATES).toHaveLength(9);
    expect(m.MANAGED_LSP_ACTIVATION_REASON_CODES).toHaveLength(16);
    expect(typeof m.parseManagedLspActivationInput).toBe("function");
    expect(typeof m.parseManagedLspActivationStatus).toBe("function");
    expect(typeof m.resolveManagedLspActivation).toBe("function");

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").ManagedLspLanguage>();
    pin<import("./index.js").ManagedLspEffectiveState>();
    pin<import("./index.js").ManagedLspActivationReasonCode>();
    pin<import("./index.js").ManagedLspProductSupport>();
    pin<import("./index.js").ManagedLspCanonicalState>();
    pin<import("./index.js").ManagedLspDeploymentPolicy>();
    pin<import("./index.js").ManagedLspProvisioning>();
    pin<import("./index.js").ManagedLspWorkspaceActivation>();
    pin<import("./index.js").ManagedLspLegacyEnvironment>();
    pin<import("./index.js").ManagedLspNegotiation>();
    pin<import("./index.js").ManagedLspRuntimeHealth>();
    pin<import("./index.js").ManagedLspPolicyResult>();
    pin<import("./index.js").ManagedLspActivationInput>();
    pin<import("./index.js").ManagedLspActivationStatus>();
    pin<import("./index.js").ManagedLspActivationDenied>();
    pin<import("./index.js").ManagedLspActivationResolution>();
    pin<import("./index.js").ManagedLspActivationParseResult<unknown>>();
  });

  it("managed LSP runtime configuration contracts are reachable through the barrel (#2271)", async () => {
    const m = await import("./index.js");
    expect(m.MANAGED_LSP_RUNTIME_SCHEMA_VERSION).toBe("1");
    expect(m.MANAGED_LSP_RUNTIME_ID_MAX_CHARS).toBe(128);
    expect(m.MANAGED_LSP_ETAG_MAX_CHARS).toBe(96);
    expect(m.MANAGED_LSP_BUILD_TAG_MAX_COUNT).toBe(32);
    expect(m.MANAGED_LSP_BUILD_TAG_MAX_CHARS).toBe(64);
    expect(m.MANAGED_LSP_PYTHON_EXTRA_PATH_MAX_COUNT).toBe(32);
    expect(m.MANAGED_LSP_GO_DIRECTORY_FILTER_MAX_COUNT).toBe(32);
    expect(m.MANAGED_LSP_SHELLCHECK_EXCLUDE_MAX_COUNT).toBe(32);
    expect(m.MANAGED_LSP_SHELL_INCLUDE_PATH_MAX_COUNT).toBe(32);
    expect(m.MANAGED_LSP_JAVA_CLASSPATH_MAX_COUNT).toBe(128);
    expect(m.MANAGED_LSP_JAVA_PROJECT_ROOT_MAX_COUNT).toBe(32);
    expect(m.MANAGED_LSP_RUST_FEATURE_MAX_COUNT).toBe(64);
    expect(m.MANAGED_LSP_RUST_CFG_MAX_COUNT).toBe(64);
    expect(m.MANAGED_LSP_RUST_LINKED_PROJECT_MAX_COUNT).toBe(32);
    expect(m.MANAGED_LSP_RUST_MAX_PROJECT_FILES).toBe(100_000);
    expect(m.MANAGED_LSP_RUST_MAX_CARGO_METADATA_BYTES).toBe(16_777_216);
    expect(m.MANAGED_LSP_RUST_MAX_MEMORY_MB).toBe(4_096);
    expect(m.MANAGED_LSP_RUST_MAX_INDEX_DEADLINE_MS).toBe(120_000);
    expect(m.MANAGED_LSP_SETTING_PRECEDENCE).toEqual([
      "builtInDefault",
      "legacyEnvironment",
      "operatorProvisioning",
      "workspace",
    ]);
    expect(typeof m.resolveManagedLspSetting).toBe("function");
    expect(typeof m.parseManagedLspRuntimeConfiguration).toBe("function");
    expect(typeof m.matchesManagedLspConfigurationPrecondition).toBe("function");

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").ManagedLspSettingSource>();
    pin<import("./index.js").ManagedLspPersistedSettingSource>();
    pin<import("./index.js").ManagedLspSettingLayers<unknown>>();
    pin<import("./index.js").ManagedLspResolvedSetting<unknown>>();
    pin<import("./index.js").ManagedLspWorkspaceActivationSetting>();
    pin<import("./index.js").ManagedLspApprovedRuntimeReference>();
    pin<import("./index.js").ManagedLspWorkspaceRelativePath>();
    pin<import("./index.js").ManagedLspConfigurationProvenance>();
    pin<import("./index.js").ManagedLspPythonSettings>();
    pin<import("./index.js").ManagedLspGoBuildFlags>();
    pin<import("./index.js").ManagedLspGoOperatingSystem>();
    pin<import("./index.js").ManagedLspGoArchitecture>();
    pin<import("./index.js").ManagedLspGoTarget>();
    pin<import("./index.js").ManagedLspGoDirectoryFilter>();
    pin<import("./index.js").ManagedLspGoSettings>();
    pin<import("./index.js").ManagedLspShellCheckSettings>();
    pin<import("./index.js").ManagedLspShellSettings>();
    pin<import("./index.js").ManagedLspJavaLanguageLevel>();
    pin<import("./index.js").ManagedLspJavaSettings>();
    pin<import("./index.js").ManagedLspRustCfg>();
    pin<import("./index.js").ManagedLspRustResourceBudget>();
    pin<import("./index.js").ManagedLspRustSettings>();
    pin<import("./index.js").ManagedLspRestartField>();
    pin<import("./index.js").ManagedLspPythonConfiguration>();
    pin<import("./index.js").ManagedLspGoConfiguration>();
    pin<import("./index.js").ManagedLspShellConfiguration>();
    pin<import("./index.js").ManagedLspJavaConfiguration>();
    pin<import("./index.js").ManagedLspRustConfiguration>();
    pin<import("./index.js").ManagedLspRuntimeConfiguration>();
    pin<import("./index.js").ManagedLspConfigurationPrecondition>();
    pin<import("./index.js").ManagedLspRuntimeParseResult>();
  });

  it("managed LSP capability negotiation contracts are reachable through the barrel (#2271)", async () => {
    const m = await import("./index.js");
    expect(m.MANAGED_LSP_CAPABILITY_SCHEMA_VERSION).toBe("1");
    expect(m.MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES).toBe(64);
    expect(m.MANAGED_LSP_SEMANTIC_TOKEN_MAX_MODIFIERS).toBe(16);
    expect(m.MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS).toBe(10_000);
    // Count assertions are intentional surface pins; bump deliberately when the surface changes.
    expect(m.MANAGED_LSP_SEMANTIC_TOKEN_TYPES).toHaveLength(23);
    expect(m.MANAGED_LSP_SEMANTIC_TOKEN_MODIFIERS).toHaveLength(10);
    expect(typeof m.parseManagedLspCandidateCapabilities).toBe("function");
    expect(typeof m.parseManagedLspNegotiatedCapabilitySnapshot).toBe("function");
    expect(typeof m.isManagedLspOperationNegotiated).toBe("function");
    expect(typeof m.parseManagedLspSemanticTokenLegend).toBe("function");
    expect(typeof m.parseManagedLspSemanticTokenData).toBe("function");
    expect(typeof m.managedLspSemanticTokensFitDocument).toBe("function");
    expect(typeof m.parseManagedLspSemanticTokenRequest).toBe("function");

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").ManagedLspProtocolVersion>();
    pin<import("./index.js").ManagedLspPositionEncoding>();
    pin<import("./index.js").ManagedLspTextSync>();
    pin<import("./index.js").ManagedLspCandidateCapabilities>();
    pin<import("./index.js").ManagedLspNegotiatedSemanticTokens>();
    pin<import("./index.js").ManagedLspNegotiatedCapabilitySnapshot>();
    pin<import("./index.js").ManagedLspSemanticTokenType>();
    pin<import("./index.js").ManagedLspSemanticTokenModifier>();
    pin<import("./index.js").ManagedLspSemanticTokenLegend>();
    pin<import("./index.js").ManagedLspSemanticTokenData>();
    pin<import("./index.js").ManagedLspSemanticTokenRequest>();
    pin<import("./index.js").ManagedLspSemanticTokenResponse>();
    pin<import("./index.js").ManagedLspCapabilityParseResult<unknown>>();
  });

  it("managed LSP evidence contracts are reachable through the barrel (#2271)", async () => {
    const m = await import("./index.js");
    expect(m.MANAGED_LSP_EVIDENCE_SCHEMA_VERSION).toBe("1");
    expect(m.MANAGED_LSP_EVIDENCE_ACTOR_CLASSES).toEqual([
      "localHuman",
      "operator",
      "policyEngine",
      "system",
    ]);
    expect(m.MANAGED_LSP_EVIDENCE_ACTIONS).toEqual([
      "activate",
      "deactivate",
      "configure",
      "reset",
      "rollback",
      "restart",
      "lifecycle",
    ]);
    expect(m.MANAGED_LSP_EVIDENCE_OUTCOMES).toEqual([
      "accepted",
      "denied",
      "noOp",
      "failed",
      "conflict",
    ]);
    expect(typeof m.parseManagedLspEvidence).toBe("function");

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").ManagedLspEvidenceActorClass>();
    pin<import("./index.js").ManagedLspEvidenceKind>();
    pin<import("./index.js").ManagedLspEvidenceAction>();
    pin<import("./index.js").ManagedLspEvidenceOutcome>();
    pin<import("./index.js").ManagedLspActivationEvidence>();
    pin<import("./index.js").ManagedLspLifecycleEvidence>();
    pin<import("./index.js").ManagedLspEvidence>();
    pin<import("./index.js").ManagedLspEvidenceParseResult>();
  });

  it("M7 editor platform contracts are reachable through the barrel (#2317)", async () => {
    const m = await import("./index.js");
    expect(m.EDITOR_M7_SCHEMA_VERSION).toBe("1");
    expect(m.EDITOR_M7_SETTING_REGISTRY.map((entry) => entry.id)).toContain("fontSize");
    expect(m.EDITOR_M7_COMMAND_REGISTRY.map((entry) => entry.id)).toContain("editor.save");
    expect(m.EDITOR_M7_KEYBINDING_OVERRIDE_VERSION).toBe("1");
    expect(m.defaultEditorM7Settings().inlineCompletion).toBe(false);
    expect(m.defaultEditorM7Settings().testGeneration).toBe(false);
    expect(m.defaultEditorM7Settings().patchApply).toBe(false);
    expect(m.parseEditorM7SettingPatch("workspace", { minimap: true })).toMatchObject({
      ok: false,
      reasonCode: "WORKSPACE_SCOPE_DENIED",
    });
    expect(
      m.resolveEditorM7AiActivation({
        schemaVersion: "1",
        feature: "inlineCompletion",
        productSupported: true,
        operatorCeiling: "allowed",
        explicitOptIn: false,
        modelCapability: "available",
        budget: "available",
        providerHealth: "healthy",
        securityPrerequisites: "satisfied",
      }),
    ).toMatchObject({ state: "available", reasonCode: "EXPLICIT_OPT_IN_REQUIRED" });

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").EditorM7SettingDefinition>();
    pin<import("./index.js").EditorM7WatchEvent>();
    pin<import("./index.js").EditorM7ModelEvictionPlan>();
    pin<import("./index.js").EditorM7CommandDefinition>();
    pin<import("./index.js").EditorM7SnippetCollection>();
    pin<import("./index.js").EditorM7AiActivationStatus>();
    pin<import("./index.js").EditorM7AiActivationSummary>();
  });
});
