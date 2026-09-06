import { describe, it, expect } from "vitest";

import { createRequire } from "node:module";
import { KEIKO_CONTRACTS_VERSION } from "./version.js";
import {
  HARNESS_CODES,
  DEFAULT_LIMITS,
  HARNESS_VERSION,
  TERMINAL_STATES,
  isTerminalHarnessState,
} from "./harness.js";
import { EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION } from "./evidence.js";
import { DEFAULT_PATCH_LIMITS } from "./tools.js";
import { DEFAULT_VERIFICATION_LIMITS } from "./verification.js";
import { EVAL_SCORECARD_SCHEMA_VERSION } from "./evaluations.js";
import {
  WORKFLOW_HANDOFF_SCHEMA_VERSION,
  DEFAULT_PATCH_SCOPE_LIMITS,
  EXPECTED_CHECKS,
  WORKFLOW_KINDS,
  isApprovalTokenShape,
  checkPatchAgainstScope,
  validatePatchScope,
  validateWorkflowHandoffRequest,
} from "./workflow-handoff.js";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  MAX_OMITTED_CONTEXT_ENTRIES,
  SELECTED_SCOPE_KINDS,
  validateSelectedScope,
} from "./connected-context.js";
import {
  LOCAL_KNOWLEDGE_SCHEMA_VERSION,
  EMBEDDING_VECTOR_METRICS,
  KNOWLEDGE_SOURCE_SCOPE_KINDS,
  CAPSULE_LIFECYCLE_STATES,
  CAPSULE_RETRIEVAL_EFFORTS,
  CAPSULE_OUTPUT_MODES,
  CAPSULE_ANSWER_GROUNDING_POLICIES,
  CONNECTOR_NODE_KINDS,
} from "./local-knowledge.js";
import {
  DOCUMENT_STATUSES,
  PARSED_UNIT_KINDS,
  PARSER_DIAGNOSTIC_SEVERITIES,
  INDEXING_JOB_STATUSES,
  CAPSULE_REINDEX_MODES,
} from "./local-knowledge-records.js";
import { isSafeScopePath, isSafeStorageReference } from "./local-knowledge-paths.js";
import {
  isSafeDisplaySummary,
  validateEmbeddingModelIdentity,
  validateKnowledgeSourceScope,
  validateKnowledgeCapsule,
  validateCapsuleSet,
  validateCapsuleReindexRequest,
  validateConnectorGraphState,
} from "./local-knowledge-validation.js";
import {
  KNOWLEDGE_POD_SUMMARY_SCHEMA_VERSION,
  isKnowledgePodEvidenceSafeText,
  validateKnowledgePodSummary,
} from "./local-knowledge-pods.js";
import {
  LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION,
  KNOWLEDGE_CAPSULE_DDL,
  KNOWLEDGE_CAPSULE_INDEXES,
  KNOWLEDGE_CAPSULE_MIGRATIONS,
  KNOWLEDGE_CAPSULE_TABLES,
  KNOWLEDGE_CAPSULE_INDEX_NAMES,
  DELETE_CAPSULE_SQL,
} from "./local-knowledge-schema.js";
import {
  INFILLING_ALIGNMENTS,
  modelSupportsInfilling,
  isAlignedInfillingModel,
  isAsYouTypeCompletionModel,
  assertValidGatewaySamplingParameters,
  isValidGatewaySamplingParameters,
  validateGatewaySamplingParameters,
} from "./gateway.js";
import {
  validateCapsuleRowShape,
  redactPathInDiagnostic,
} from "./local-knowledge-schema-validation.js";
import { normalizePdfCitationPreviewMarkerIndex } from "./local-knowledge-preview.js";
import { MAX_ATTACHMENT_MIME_BYTES, normalizeAttachmentMime } from "./bff-wire.js";
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
  GitDeliveryBranchSwitchInputs,
} from "./index.js";
import {
  GIT_DELIVERY_SCHEMA_VERSION,
  GIT_DELIVERY_ACTION_KINDS,
  GIT_DELIVERY_RISK_CLASSES,
  GIT_DELIVERY_RISK_CLASS_SEVERITY,
  GIT_DELIVERY_ACTION_RISK_DEFAULTS,
  GIT_DELIVERY_BLOCK_REASONS,
  GIT_DELIVERY_PROVIDER_CAPABILITIES,
  GIT_DELIVERY_BRANCH_MATCH_KINDS,
  GIT_DELIVERY_EXECUTION_ERROR_CODES,
  GIT_DELIVERY_EXECUTION_OUTCOMES,
  GIT_DELIVERY_MERGE_BLOCK_REASONS,
  isGitDeliveryActionKind,
  gitDeliveryDefaultRiskClass,
  parseGitDeliveryActionEnvelope,
} from "./git-delivery.js";
import {
  GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  GIT_DELIVERY_RULE_DECISIONS,
  evaluateGitPolicy,
} from "./git-delivery-policy.js";
import {
  GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
  GIT_DELIVERY_CHECKS_OVERALL_STATUSES,
  GIT_DELIVERY_PULL_REQUEST_STATUSES,
  isGitDeliveryRemoteTargetPolicy,
} from "./git-delivery-provider.js";
import {
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
} from "./git-delivery-action-sheet.js";

// The packaged manifest owns the version; a literal here re-states it and goes
// stale on every release cut (KfQ findings on #3055).
const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

describe("keiko-contracts package surface", () => {
  it("exports governed attachment MIME normalization through the package entrypoint", () => {
    expect(MAX_ATTACHMENT_MIME_BYTES).toBe(255);
    expect(normalizeAttachmentMime(" IMAGE/PNG ; charset=binary ")).toBe("image/png");
  });

  it("exposes the version constant pinned at the package version", () => {
    expect(KEIKO_CONTRACTS_VERSION).toBe(packageVersion);
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

  it("DEFAULT_RETENTION bounds chat/RAG evidence within its own partition", () => {
    expect(DEFAULT_RETENTION).toEqual({
      maxRunsByPartition: { "chat-rag": 50, regulated: 50 },
    });
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
    expect(TERMINAL_STATES).toContain("completed");
    expect(TERMINAL_STATES).toContain("failed");
    expect(isTerminalHarnessState("completed")).toBe(true);
    expect(isTerminalHarnessState("failed")).toBe(true);
    expect(isTerminalHarnessState("planning")).toBe(false);
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

  it("workflow-handoff values remain available at their declared public surface (#186)", () => {
    expect(WORKFLOW_HANDOFF_SCHEMA_VERSION).toBe("1");
    expect(DEFAULT_PATCH_SCOPE_LIMITS.maxFileCount).toBeGreaterThan(0);
    expect(EXPECTED_CHECKS).toContain("verify");
    expect(WORKFLOW_KINDS).toContain("unit-test-generation");
    expect(typeof isApprovalTokenShape).toBe("function");
    expect(typeof validatePatchScope).toBe("function");
    expect(typeof validateWorkflowHandoffRequest).toBe("function");
    expect(typeof checkPatchAgainstScope).toBe("function");
  });

  it("workflow-handoff types remain available at their declared public surface (#186)", () => {
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

  it("FIM completion values remain available at their declared public surface (#1210)", () => {
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

  it("FIM completion types remain available at their declared public surface (#1210)", () => {
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<InfillingAlignment>();
    pin<CompletionInteractionMode>();
    pin<CompletionDegradeReason>();
    expect(pin<CompletionModelSelection>()).toBeUndefined();
  });

  it("local-knowledge values remain available at their declared public surface (#191)", () => {
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

  it("local-knowledge types remain available at their declared public surface (#191)", () => {
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

  it("knowledge-capsule schema values remain available at their declared public surface (#265)", () => {
    expect(LOCAL_KNOWLEDGE_DB_SCHEMA_VERSION).toBe(33);
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

  it("knowledge-capsule schema types remain available at their declared public surface (#265)", () => {
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

  it("memory contract values remain available at their declared public surface (#205)", async () => {
    const mod = await import("./memory.js");
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
    expect(typeof mod.hasPaymentCardPanShape).toBe("function");
    expect(typeof mod.hasStaleModelMetadata).toBe("function");
  });

  it("memory contract types remain available at their declared public surface (#205)", async () => {
    type Mod = typeof import("./memory.js");
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
    // The pins above are compile-time only: `pin<T>()` is erased, so the real check is that
    // `tsc` can resolve each re-export. What IS observable at runtime is whether the barrel
    // loads at all — a circular or broken re-export throws here. The previous
    // `expect(true).toBe(true)` asserted neither.
    await expect(import("./index.js")).resolves.toBeDefined();
  });

  it("memory subpath is importable as @oscharko-dev/keiko-contracts/memory (#205)", async () => {
    const subpath = await import("./memory.js");
    expect(subpath.MEMORY_SCHEMA_VERSION).toBe("1");
    expect(typeof subpath.validateMemoryRecord).toBe("function");
    expect(typeof subpath.isScopeReachable).toBe("function");
  });

  it("memory workflow-port contracts remain available at their declared public surface (#213)", async () => {
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
    // The pins above are compile-time only: `pin<T>()` is erased, so the real check is that
    // `tsc` can resolve each re-export. What IS observable at runtime is whether the barrel
    // loads at all — a circular or broken re-export throws here. The previous
    // `expect(true).toBe(true)` asserted neither.
    await expect(import("./index.js")).resolves.toBeDefined();
  });

  it("memory workflow port subpath is importable (#213)", async () => {
    const subpath = await import("./memory-workflow-port.js");
    // Pure type-only module: it should import cleanly with no runtime exports.
    expect(Object.keys(subpath)).toHaveLength(0);
  });

  it("memory audit-event contracts remain available at their declared public surface (#214)", async () => {
    const mod = await import("./memory.js");
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
    expect(mod.MEMORY_AUDIT_EVENT_KINDS).toHaveLength(13);
    const pin = <T>(_value?: T): T | undefined => undefined;
    type _MemoryAuditEvent = import("./index.js").MemoryAuditEvent;
    type _MemoryAuditEventKind = import("./index.js").MemoryAuditEventKind;
    pin<_MemoryAuditEvent>();
    pin<_MemoryAuditEventKind>();
  });

  it("memory audit event subpath is importable as @oscharko-dev/keiko-contracts/memory-audit-events (#214)", async () => {
    const subpath = await import("./memory-audit-events.js");
    expect(subpath.MEMORY_AUDIT_EVENT_SCHEMA_VERSION).toBe("1");
    expect(subpath.MEMORY_AUDIT_EVENT_KINDS).toHaveLength(13);
    expect(subpath.MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS).toBe(240);
  });

  it("connected-context contracts remain available at their declared public surface (#178)", () => {
    expect(CONNECTED_CONTEXT_SCHEMA_VERSION).toBe("1");
    expect(SELECTED_SCOPE_KINDS).toContain("files");
    // KEIKO-0849: the pack.omitted quadratic-scan cap is part of the public surface too.
    expect(MAX_OMITTED_CONTEXT_ENTRIES).toBeGreaterThan(0);
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

  it("editor-agent values remain available at their declared public surface (#1391)", async () => {
    const mod = {
      ...(await import("./editor-agent.js")),
      ...(await import("./editor-agent-governance.js")),
    };
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
    expect(mod.EDITOR_AGENT_CONFLICT_CODES).toContain("DECOMPOSE_PER_ROOT");
    expect(mod.EDITOR_AGENT_CONFLICT_CODES).toHaveLength(11);
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
    expect(typeof mod.isEditorAgentRootAttribution).toBe("function");
    expect(typeof mod.isEditorAgentRootBinding).toBe("function");
    expect(typeof mod.isEditorAgentSessionsRequest).toBe("function");
    expect(typeof mod.editorAgentRootBindingDenyReason).toBe("function");
  });

  it("editor-agent types remain available at their declared public surface (#1391)", async () => {
    // Phantom generics pin the public contract types onto the barrel surface; a future refactor that
    // drops one of these names stops this test compiling (same guard pattern as #186/#205 above).
    const pin = <T>(_value?: T): T | undefined => undefined;
    type _Code = import("./index.js").EditorAgentConflictCode;
    type _Action = import("./index.js").EditorAgentAction;
    type _ActionOrigin = import("./index.js").EditorAgentActionOrigin;
    type _Result = import("./index.js").EditorAgentActionResult;
    type _Event = import("./index.js").EditorAgentEvent;
    type _Diagnostic = import("./index.js").EditorAgentDiagnostic;
    type _DiagnosticsDetail = import("./index.js").EditorAgentDiagnosticsDetail;
    type _Snapshot = import("./index.js").EditorAgentSessionSnapshot;
    type _Request = import("./index.js").EditorAgentSnapshotRequest;
    type _RootAttribution = import("./index.js").EditorAgentRootAttribution;
    type _RootBinding = import("./index.js").EditorAgentRootBinding;
    type _SessionsRequest = import("./index.js").EditorAgentSessionsRequest;
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
    pin<_Result>();
    pin<_Event>();
    pin<_Diagnostic>();
    pin<_DiagnosticsDetail>();
    pin<_Snapshot>();
    pin<_Request>();
    pin<_RootAttribution>();
    pin<_RootBinding>();
    pin<_SessionsRequest>();
    pin<_Changeset>();
    pin<_ChangesetFile>();
    pin<_PreparedChangeset>();
    pin<_PreparedChangesetFile>();
    pin<_PreparedChangeKind>();
    pin<_PreparedTextEdit>();
    pin<_ConflictDetail>();
    pin<_FileActionResult>();
    pin<_FileActionStatus>();
    // The pins above are compile-time only: `pin<T>()` is erased, so the real check is that
    // `tsc` can resolve each re-export. What IS observable at runtime is whether the barrel
    // loads at all — a circular or broken re-export throws here. The previous
    // `expect(true).toBe(true)` asserted neither.
    await expect(import("./index.js")).resolves.toBeDefined();
  });

  it("coding-workbench mode-policy contracts remain available at their declared public surface (#2091)", async () => {
    const mod = await import("./coding-workbench.js");
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

  it("code-task acceptance contracts remain available at their declared public surface (#2385)", async () => {
    const mod = await import("./code-task-acceptance.js");
    expect(mod.CODE_TASK_ACCEPTANCE_SCHEMA_VERSION).toBe(1);
    expect(mod.CODE_TASK_ACCEPTANCE_CONTRIBUTION_KIND).toBe("code-task-acceptance-contribution");
    expect(mod.CODE_TASK_EVIDENCE_CLASSES).toHaveLength(5);
    expect(mod.CODE_TASK_EVIDENCE_PLATFORMS).toHaveLength(4);
    expect(mod.CODE_TASK_SCENARIO_OUTCOMES).toEqual(["passed", "failed", "blocked"]);
    expect(mod.CODE_TASK_SALVAGE_DISPOSITIONS).toEqual(["taken-verbatim", "reshaped", "rejected"]);
    expect(mod.validateCodeTaskAcceptanceContribution({}).ok).toBe(false);
    expect(mod.codeTaskAcceptanceQualificationFailures).toBeDefined();
    expect(mod.isCodeTaskGitCommitSha("a".repeat(40))).toBe(true);
    expect(mod.isCodeTaskGitTreeSha("b".repeat(40))).toBe(true);
    expect(mod.isCodeTaskSha256Digest("c".repeat(64))).toBe(true);
    expect(mod.isCodeTaskScenarioId("tracer-journey")).toBe(true);
    expect(mod.isCodeTaskIsoInstant("2026-07-16T12:00:00Z")).toBe(true);
    expect(mod.isCodeTaskRepoRelativePath("packages/keiko-contracts/src/index.ts")).toBe(true);
    expect(mod.isCodeTaskContentFreeNote("bounded note")).toBe(true);
    expect(mod.CODE_TASK_QUALIFICATION_FLOW_ARTIFACT_KIND).toBe(
      "code-task-qualification-flow-evidence",
    );
    expect(mod.CODE_TASK_QUALIFICATION_FLOW_TRANSITIONS).toHaveLength(10);
    expect(mod.validateCodeTaskQualificationFlowArtifact({}).ok).toBe(false);

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").CodeTaskAcceptanceContributionV1>();
    pin<import("./index.js").CodeTaskAcceptanceScenarioV1>();
    pin<import("./index.js").CodeTaskAcceptanceBinding>();
    pin<import("./index.js").CodeTaskSalvageRowV1>();
    pin<import("./index.js").CodeTaskCleanupResultV1>();
    pin<import("./index.js").CodeTaskFact<string>>();
    pin<import("./index.js").CodeTaskBranded<"Example", string>>();
    pin<import("./index.js").CodeTaskEvidenceClass>();
    pin<import("./index.js").CodeTaskEvidencePlatform>();
    pin<import("./index.js").CodeTaskScenarioOutcome>();
    pin<import("./index.js").CodeTaskSalvageDisposition>();
    pin<import("./index.js").CodeTaskScenarioId>();
    pin<import("./index.js").CodeTaskGitCommitSha>();
    pin<import("./index.js").CodeTaskGitTreeSha>();
    pin<import("./index.js").CodeTaskSha256Digest>();
    pin<import("./index.js").CodeTaskIsoInstant>();
    pin<import("./index.js").CodeTaskQualificationFlowArtifactV1>();
    pin<import("./index.js").CodeTaskQualificationFlowBindingV1>();
    pin<import("./index.js").CodeTaskQualificationFlowSpendV1>();
    pin<import("./index.js").CodeTaskQualificationFlowTransition>();
    pin<import("./index.js").CodeTaskQualificationFlowV1>();
    pin<import("./index.js").CodeTaskQualificationRequiredChecksV1>();
  });

  it("code-task governance contracts remain available at their declared public surface (#2386)", async () => {
    const mod = {
      ...(await import("./code-task-governance.js")),
      ...(await import("./code-task-run-control.js")),
    };
    expect(mod.CODE_TASK_GOVERNANCE_SCHEMA_VERSION).toBe(1);
    expect(mod.CODE_TASK_GRANT_SCOPES).toEqual(["once", "task"]);
    expect(mod.GOVERNED_ACTION_KIND).toBe("governed-action");
    expect(mod.GOVERNED_ACTION_DECISIONS).toContain("approval-required");
    expect(mod.GOVERNED_ACTION_ACTION_KINDS).toContain("authority-widening");
    expect(mod.GOVERNED_ACTION_UNGRANTABLE_KINDS).toContain("delivery");
    expect(mod.CODE_TASK_EXECUTION_KIND).toBe("code-task-execution");
    expect(mod.RUNTIME_GOVERNANCE_OPERATIONS).toContain("revoke");
    expect(mod.RUNTIME_GOVERNANCE_OUTCOME_STATUSES).toContain("unsupported");
    expect(mod.RUNTIME_GOVERNANCE_LIFECYCLE_KINDS).toContain("mutation-halted");
    expect(mod.RUN_CONTROL_SNAPSHOT_KIND).toBe("run-control-snapshot");
    expect(mod.resolveCodeTaskGrantScope(undefined)).toEqual({ ok: true, value: "once" });
    expect(mod.resolveCodeTaskGrantScope("forever").ok).toBe(false);
    expect(mod.isGovernedActionGrantable("dependency-operation")).toBe(false);
    expect(mod.isCodeTaskGrantScope("task")).toBe(true);
    expect(mod.isCodeTaskRunId("run-1")).toBe(true);
    expect(mod.isCodeTaskQuestionId("que_1")).toBe(true);
    expect(mod.isCodeTaskPolicyVersion("v1")).toBe(true);
    expect(mod.validateGovernedActionV1({}).ok).toBe(false);
    expect(mod.validateCodeTaskExecutionV1({}).ok).toBe(false);
    expect(mod.validateRunControlSnapshotV1({}).ok).toBe(false);
    expect(mod.validateRuntimeGovernanceRequestV1({}).ok).toBe(false);
    expect(mod.validateRuntimeGovernanceOutcomeV1({}).ok).toBe(false);

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").GovernedActionV1>();
    pin<import("./index.js").GovernedActionActionKind>();
    pin<import("./index.js").GovernedActionDecision>();
    pin<import("./index.js").GovernedActionGrantRef>();
    pin<import("./index.js").GovernedActionQuestionRef>();
    pin<import("./index.js").CodeTaskExecutionV1>();
    pin<import("./index.js").CodeTaskGrantScope>();
    pin<import("./index.js").CodeTaskGrantId>();
    pin<import("./index.js").CodeTaskRunId>();
    pin<import("./index.js").CodeTaskTaskId>();
    pin<import("./index.js").CodeTaskWorkspaceId>();
    pin<import("./index.js").CodeTaskIdempotencyKey>();
    pin<import("./index.js").CodeTaskPolicyVersion>();
    pin<import("./index.js").RunControlSnapshotV1>();
    pin<import("./index.js").RunControlGrantRefV1>();
    pin<import("./index.js").RuntimeGovernancePortV1>();
    pin<import("./index.js").RuntimeGovernanceRequestV1>();
    pin<import("./index.js").RuntimeGovernanceOutcomeV1>();
    pin<import("./index.js").RuntimeGovernanceLifecycleEventV1>();
  });

  it("governed Git-delivery contracts remain available at their declared public surface (#471)", () => {
    // Schema versions.
    expect(GIT_DELIVERY_SCHEMA_VERSION).toBe("1");
    expect(GIT_DELIVERY_POLICY_SCHEMA_VERSION).toBe("1");
    expect(GIT_DELIVERY_PROVIDER_SCHEMA_VERSION).toBe("1");

    // Count assertions are intentional surface pins; bump deliberately when #472+ extends the surface.
    // #3389 (epic #3384 correction 7): 11 -> 13 with "pr-description-apply" (#3399) and
    // "pr-mark-ready"; the same pin lives in git-delivery.test.ts and moves together with this one.
    expect(GIT_DELIVERY_ACTION_KINDS).toHaveLength(13);
    expect(GIT_DELIVERY_RISK_CLASSES).toHaveLength(4);
    // Includes the server-owned continuity guard's typed authority-denied audit outcome.
    expect(GIT_DELIVERY_BLOCK_REASONS).toHaveLength(9);
    expect(GIT_DELIVERY_PROVIDER_CAPABILITIES).toHaveLength(5);
    expect(GIT_DELIVERY_RULE_DECISIONS).toHaveLength(4);
    expect(GIT_DELIVERY_CHECKS_OVERALL_STATUSES).toHaveLength(4);
    expect(GIT_DELIVERY_PULL_REQUEST_STATUSES).toHaveLength(3);
    expect(GIT_DELIVERY_BRANCH_MATCH_KINDS).toHaveLength(2);
    expect(GIT_DELIVERY_EXECUTION_ERROR_CODES).toHaveLength(6);
    expect(GIT_DELIVERY_EXECUTION_OUTCOMES).toHaveLength(4);
    expect(GIT_DELIVERY_MERGE_BLOCK_REASONS).toHaveLength(6);

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

    // Type pins (compile-time reachability). GitDeliveryBranchSwitchInputs was the only per-kind
    // input interface missing from the public barrel (KEIKO-0654); adding it here fails the
    // typecheck if the barrel re-export is ever dropped again.
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<GitDeliveryActionEnvelope>();
    pin<GitDeliveryResolvedInputs>();
    pin<GitDeliveryConstraint>();
    pin<GitDeliveryPolicyDecision>();
    pin<GitDeliveryBranchProtection>();
    pin<GitDeliveryMergeReadiness>();
    pin<GitDeliveryPullRequestState>();
    pin<GitDeliveryBranchSwitchInputs>();
  });

  it("governed Git action-sheet contracts remain available at their declared public surface (#473)", () => {
    expect(GIT_DELIVERY_ACTION_SHEET_SCHEMA_VERSION).toBe("1");
    // Count assertions are intentional surface pins; bump deliberately when the surface changes.
    expect(GIT_DELIVERY_ACTION_SHEET_STATES).toHaveLength(3);
    expect(GIT_DELIVERY_APPROVAL_NECESSITIES).toHaveLength(3);
    expect(GIT_DELIVERY_BLOCKED_CAUSES).toHaveLength(3);
    expect(GIT_DELIVERY_RECOVERY_ACTION_HINTS).toHaveLength(9);

    expect(typeof isGitDeliveryActionSheet).toBe("function");
    expect(typeof buildGitDeliveryActionSheet).toBe("function");
    expect(gitDeliverySuggestedRecoveryStrategy("commit", false)).toBe("soft-reset");
    expect(GIT_DELIVERY_POLICY_DECISION_OUTCOMES).toHaveLength(4);
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

  it("governed GitHub pull-request contracts remain available at their declared public surface (#477)", async () => {
    const m = await import("./git-pull-request.js");
    expect(m.GIT_PULL_REQUEST_SCHEMA_VERSION).toBe("1");
    // Count assertions are intentional surface pins; bump deliberately when the surface changes.
    expect(m.GIT_PR_CHANGE_TYPES).toHaveLength(7);
    expect(m.GIT_PR_READINESS_BLOCKER_CODES).toHaveLength(9);
    // 6 since KEIKO-0479 added "keep-as-is" for an already-ready PR with nothing outstanding.
    expect(m.GIT_PR_RECOMMENDATIONS).toHaveLength(6);
    expect(m.GIT_PR_REJECTION_REASONS).toHaveLength(9);

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

  it("managed-LSP activation contracts remain available at their declared public surface (#2271)", async () => {
    const m = await import("./managed-lsp-activation.js");
    expect(m.MANAGED_LSP_ACTIVATION_SCHEMA_VERSION).toBe("1");
    expect(m.MANAGED_LSP_LANGUAGES).toEqual(["python", "go", "shell", "java", "rust"]);
    // Count assertions are intentional surface pins; bump deliberately when the surface changes.
    expect(m.MANAGED_LSP_EFFECTIVE_STATES).toHaveLength(9);
    expect(m.MANAGED_LSP_ACTIVATION_REASON_CODES).toHaveLength(17);
    expect(m.MANAGED_LSP_ACTIVATION_REASON_CODES).toContain("WORKSPACE_UNTRUSTED");
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

  it("managed-LSP runtime configuration remains available at its declared public surface (#2271)", async () => {
    const m = await import("./managed-lsp-runtime.js");
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

  it("managed-LSP capability negotiation remains available at its declared public surface (#2271)", async () => {
    const m = await import("./managed-lsp-capabilities.js");
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

  it("managed-LSP evidence contracts remain available at their declared public surface (#2271)", async () => {
    const m = await import("./managed-lsp-evidence.js");
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

  it("governed debug-lifecycle contracts remain available at their declared public surface (#2343)", async () => {
    const m = await import("./debug/debug-lifecycle.js");
    expect(m.DEBUG_LIFECYCLE_SCHEMA_VERSION).toBe("1");
    expect(typeof m.isDebugLifecycleEvidence).toBe("function");
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").DebugSessionState>();
    pin<import("./index.js").DebugLifecycleEventKind>();
    pin<import("./index.js").DebugLifecycleReason>();
    pin<import("./index.js").DebugProcessErrorCode>();
    pin<import("./index.js").DebugLifecycleEvidence>();
    pin<import("./index.js").DebugLifecycleEvent>();
  });

  it("governed debug-browser contracts remain available at their declared public surface (#2345)", async () => {
    const m = await import("./dap-debug.js");
    expect(m.DAP_DEBUG_CONTRACT_SCHEMA_VERSION).toBe("1");
    expect(m.DEBUG_SESSION_STATUSES).toContain("revoked");
    expect(m.DEBUG_EVENT_KINDS).toContain("output");
    expect(m.SOURCE_BREAKPOINT_KINDS).toEqual(["line", "conditional", "logpoint"]);
    expect(m.DEFAULT_DEBUG_PAYLOAD_LIMITS.maxGraphNodes).toBe(1_000);
    expect(typeof m.parseDebugSessionStartRequest).toBe("function");
    expect(typeof m.parseSetBreakpointsRequest).toBe("function");
    expect(typeof m.parseEvaluateWatchRequest).toBe("function");
    expect(typeof m.buildDebugVariableTree).toBe("function");
    expect(typeof m.buildDebugOutputEvent).toBe("function");

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").DebugSession>();
    pin<import("./index.js").DebugLaunchTarget>();
    pin<import("./index.js").SourceBreakpoint>();
    pin<import("./index.js").ExceptionBreakpointFilter>();
    pin<import("./index.js").StackFrame>();
    pin<import("./index.js").Scope>();
    pin<import("./index.js").DebugVariableNode>();
    pin<import("./index.js").WatchExpression>();
    pin<import("./index.js").WatchEvaluationResult>();
    pin<import("./index.js").InstrumentationSnapshot>();
    pin<import("./index.js").DebugEvent>();
    pin<import("./index.js").DebugBootstrapRequest>();
    pin<import("./index.js").DebugSessionStartRequest>();
    pin<import("./index.js").DebugSessionControlRequest>();
    pin<import("./index.js").SetBreakpointsRequest>();
    pin<import("./index.js").SetExceptionBreakpointsRequest>();
    pin<import("./index.js").StackTraceRequest>();
    pin<import("./index.js").ScopesRequest>();
    pin<import("./index.js").VariablesRequest>();
    pin<import("./index.js").SetVariableRequest>();
    pin<import("./index.js").SetWatchesRequest>();
    pin<import("./index.js").EvaluateWatchRequest>();
  });

  it("M7 editor-platform contracts remain available at their declared public surface (#2317)", async () => {
    const m = await import("./editor-m7.js");
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
    pin<import("./index.js").EditorM7WorkspaceSnippetCollection>();
    pin<import("./index.js").EditorM7AiActivationStatus>();
    pin<import("./index.js").EditorM7AiActivationSummary>();
  });

  it("HTML manual pod-job contracts remain available and fail closed at their public surface (#2063)", async () => {
    const m = await import("./html-manual-job.js");
    expect(m.HTML_MANUAL_POD_JOB_SCHEMA_VERSION).toBe("1");
    expect(m.HTML_MANUAL_POD_JOB_OPERATIONS).toStrictEqual(["create", "refresh"]);
    expect(m.HTML_MANUAL_POD_JOB_STATES).toContain("running");
    expect(m.HTML_MANUAL_POD_JOB_PHASES.length).toBeGreaterThan(0);

    // The validators must fail closed on hostile input and accept a well-formed request when reached
    // through the public entrypoint (not just the leaf module).
    const create = m.validateHtmlManualPodCreateRequest({
      displayName: "Vendor guide",
      origin: "https://manual.example.com",
      pathPrefix: null,
    });
    expect(create.ok).toBe(true);
    expect(m.validateHtmlManualPodCreateRequest({ displayName: "", origin: "ftp://x" }).ok).toBe(
      false,
    );

    const refresh = m.validateHtmlManualPodRefreshRequest({
      capsuleId: "cap_1",
      sourceId: "src_1",
    });
    expect(refresh.ok).toBe(true);
    expect(
      m.validateHtmlManualPodRefreshRequest({ capsuleId: "../escape", sourceId: "src_1" }).ok,
    ).toBe(false);

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").HtmlManualPodJob>();
    pin<import("./index.js").HtmlManualPodJobOperation>();
    pin<import("./index.js").HtmlManualPodJobState>();
    pin<import("./index.js").HtmlManualPodJobPhase>();
    pin<import("./index.js").HtmlManualPodJobCrawl>();
    pin<import("./index.js").HtmlManualPodJobIndexing>();
    pin<import("./index.js").HtmlManualPodJobRemediation>();
    pin<import("./index.js").HtmlManualPodRefreshRequest>();
    pin<import("./index.js").HtmlManualPodCreateRequest>();
  });

  it("M11 workspace-foundation contracts remain available at their declared public surface (#2520)", async (): Promise<void> => {
    const m = {
      ...(await import("./workspace-contract-primitives.js")),
      ...(await import("./task-workspace.js")),
      ...(await import("./workspace-trust.js")),
      ...(await import("./editor-local-history.js")),
      ...(await import("./workspace-manifest.js")),
      ...(await import("./editor-m11-settings.js")),
      ...(await import("./workspace-profile.js")),
    };
    expect(m.WORKSPACE_CONTRACT_SCHEMA_VERSION).toBe(1);
    expect(m.WORKSPACE_BINDING_V2_SCHEMA_VERSION).toBe("2");
    expect(m.WORKSPACE_TRUST_LEVELS).toEqual(["trusted", "restricted"]);
    expect(m.EDITOR_LOCAL_HISTORY_MAX_ENTRIES).toBe(512);
    expect(typeof m.validateWorkspaceManifest).toBe("function");
    expect(typeof m.validateWorkspaceRootDispatch).toBe("function");
    expect(typeof m.validateWorkspaceTrustRecord).toBe("function");
    expect(typeof m.resolveEditorM11Settings).toBe("function");
    expect(typeof m.validateWorkspaceProfileManifest).toBe("function");
    expect(m.EDITOR_M11_DEFAULT_PROFILE_REF).toBe("profile-default");
    expect(typeof m.isWorkspaceProfileDisplayName).toBe("function");
    expect(typeof m.isAssignableWorkspaceProfileDisplayName).toBe("function");
    expect(typeof m.isReservedWorkspaceProfileDisplayName).toBe("function");
    expect(typeof m.workspaceProfileDisplayNameKey).toBe("function");
    expect(typeof m.planEditorLocalHistoryRetention).toBe("function");
    expect(typeof m.validateWorkspaceBindingV2).toBe("function");

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").WorkspaceRootRef>();
    pin<import("./index.js").WorkspaceManifest>();
    pin<import("./index.js").WorkspaceRootDispatch>();
    pin<import("./index.js").WorkspaceTrustRecord>();
    pin<import("./index.js").WorkspaceTrustAssessment>();
    pin<import("./index.js").EditorM11ProfileSettingsLayer>();
    pin<import("./index.js").EditorM11RootSettingsLayer>();
    pin<import("./index.js").EditorM11ResolvedSetting>();
    pin<import("./index.js").EditorM11SettingLayerValues>();
    pin<import("./index.js").EditorM11ProfilesSnapshot>();
    pin<import("./index.js").EditorM11ProfileMutation>();
    pin<import("./index.js").EditorM11ProfileMutationResult>();
    pin<import("./index.js").WorkspaceProfileManifest>();
    pin<import("./index.js").WorkspaceProfileExportResult>();
    pin<import("./index.js").WorkspaceProfileImportPreview>();
    pin<import("./index.js").WorkspaceProfileImportApply>();
    pin<import("./index.js").EditorLocalHistoryEntry>();
    pin<import("./index.js").EditorLocalHistoryIndex>();
    pin<import("./index.js").WorkspaceBindingV1>();
    pin<import("./index.js").WorkspaceBindingV2>();
    pin<import("./index.js").VersionedWorkspaceBinding>();
  });

  it("the vector-index port remains available and fails closed at its public surface (#2556, ADR-0152 D1)", async () => {
    const m = await import("./vector-index-port.js");
    expect(m.VECTOR_INDEX_NAMESPACES).toStrictEqual(["knowledge", "memory", "repo"]);
    expect(Object.isFrozen(m.VECTOR_INDEX_NAMESPACES)).toBe(true);

    const identity = {
      provider: "openai",
      modelId: "text-embedding-3-small",
      vectorDimensions: 4,
      vectorMetric: "cosine",
    } as const;

    // The identity key is the fail-open guard: vectors from incompatible embedding spaces must not
    // compare as comparable. Pin the versioned collision-free format, since it is persisted and
    // compared across packages.
    expect(m.embeddingIdentityKey(identity)).toBe(
      'keiko-embedding-identity:v2:["openai","text-embedding-3-small",4,"cosine",null,null,null,null]',
    );
    // modelRevision is deliberately NOT part of the tuple: re-validating a capsule with a newer
    // revision must not orphan its vectors.
    expect(m.embeddingIdentityKey({ ...identity, modelRevision: "2026-07" })).toBe(
      m.embeddingIdentityKey(identity),
    );

    const query = {
      namespace: "knowledge",
      partitionKey: "cap_1",
      identity,
      queryVector: new Float32Array([0, 1, 0, 1]),
      candidateLimit: 8,
    } as const;
    expect(m.isValidVectorIndexQuery(query)).toBe(true);
    // An empty partition key must never read as "all partitions"; the permissive reading is the
    // dangerous one, so each of these is rejected rather than defaulted.
    expect(m.isValidVectorIndexQuery({ ...query, partitionKey: "" })).toBe(false);
    expect(m.isValidVectorIndexQuery({ ...query, candidateLimit: 0 })).toBe(false);
    expect(m.isValidVectorIndexQuery({ ...query, candidateLimit: 1.5 })).toBe(false);
    expect(m.isValidVectorIndexQuery({ ...query, queryVector: new Float32Array([1, 0]) })).toBe(
      false,
    );
    expect(m.isValidVectorIndexQuery({ ...query, candidateIds: [] })).toBe(true);
    expect(m.isValidVectorIndexQuery({ ...query, candidateIds: ["chunk-1"] })).toBe(true);
    expect(m.isValidVectorIndexQuery({ ...query, candidateIds: [""] })).toBe(false);
    expect(
      m.isValidVectorIndexQuery({
        ...query,
        candidateIds: Array.from({ length: 10_001 }, () => "chunk"),
      }),
    ).toBe(false);

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").VectorIndexNamespace>();
    pin<import("./index.js").VectorIndexQuery>();
    pin<import("./index.js").VectorIndexCandidateRef>();
    pin<import("./index.js").VectorIndexDiagnostics>();
    pin<import("./index.js").VectorIndexResult>();
    pin<import("./index.js").VectorIndexPort>();
  });

  it("pillar-neutral retrieval context stays body-free at its public surface (#2570, ADR-0152 D6)", async () => {
    const m = await import("./retrieval-context.js");
    expect(m.RETRIEVAL_CONTEXT_SCHEMA_VERSION).toBe("1");
    expect(m.RETRIEVAL_CONTEXT_PURPOSES.length).toBeGreaterThan(0);
    expect(m.RETRIEVAL_CONTEXT_SOURCE_KINDS.length).toBeGreaterThan(0);
    expect(m.RETRIEVAL_CONTEXT_SOURCE_TIERS.length).toBeGreaterThan(0);

    const purpose = m.RETRIEVAL_CONTEXT_PURPOSES[0];
    const kind = m.RETRIEVAL_CONTEXT_SOURCE_KINDS[0];
    if (purpose === undefined || kind === undefined) throw new Error("EMPTY_RETRIEVAL_CATALOG");
    expect(m.isRetrievalContextPurpose(purpose)).toBe(true);
    expect(m.isRetrievalContextPurpose("not-a-purpose")).toBe(false);
    expect(m.RETRIEVAL_CONTEXT_SOURCE_TIERS).toContain(m.tierForRetrievalContextSource(kind));
    const budget = m.RETRIEVAL_CONTEXT_BUDGETS[purpose];
    expect(budget.budgetBytes).toBeGreaterThan(0);
    expect(budget.maxBytesPerSource).toBeGreaterThan(0);
    expect(budget.maxBytesPerSource).toBeLessThanOrEqual(budget.budgetBytes);

    // A citation carrying a body is not a citation. This is the redaction boundary: the wire pack
    // is what leaves the process, so a shape with text/excerpt/content must be refused outright.
    const citation = {
      sourceKind: kind,
      sourceTier: m.tierForRetrievalContextSource(kind),
      id: "chunk_1",
      score: 0.87,
      rank: 1,
      citationRef: "doc#1",
      byteCount: 240,
      truncated: false,
    };
    expect(m.isRetrievalContextCitation(citation)).toBe(true);
    expect(m.isRetrievalContextCitation({ ...citation, truncated: "no" })).toBe(false);
    expect(m.isRetrievalContextCitation({ ...citation, text: "leaked body" })).toBe(false);
    expect(m.isRetrievalContextCitation({ ...citation, excerpt: "leaked body" })).toBe(false);
    expect(m.isRetrievalContextCitation({ ...citation, content: "leaked body" })).toBe(false);
    expect(m.isRetrievalContextCitation(null)).toBe(false);

    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<import("./index.js").RetrievalPurpose>();
    pin<import("./index.js").RetrievalContextPack<never, never>>();
    pin<import("./index.js").RetrievalContextWirePack<never, never>>();
    pin<import("./index.js").RetrievalContextBudget>();
    pin<import("./index.js").EvalBudget>();
    pin<import("./index.js").EvalFloorResult>();
    pin<import("./index.js").RegressionProbeResult>();
  });
});
