// Single-import target for the Governed Enterprise Memory Vault contract surface
// (Epic #204, Issue #205). Downstream packages import from
// `@oscharko-dev/keiko-contracts/memory` and reach every memory type, every const tuple,
// and every pure validator from here.
//
// Re-exports use the explicit `export type` form for type-only names and `export` for
// value-emitting symbols because verbatimModuleSyntax is on in tsconfig.base.json.

// ─── Core enums, branded IDs, schema version, status matrix ──────────────────
export type {
  ConversationId,
  EvidenceManifestId,
  MemoryAuditActionKind,
  MemoryAuditRecordId,
  MemoryEdgeId,
  MemoryEdgeKind,
  MemoryId,
  MemoryProposalId,
  MemoryReviewerId,
  MemoryScope,
  MemoryScopeKind,
  MemorySensitivity,
  MemorySourceKind,
  MemoryStatus,
  MemoryType,
  ProjectId,
  UserId,
  WorkflowDefinitionId,
  WorkflowRunId,
  WorkspaceId,
} from "./memory.js";
export {
  MEMORY_AUDIT_ACTION_KINDS,
  MEMORY_EDGE_KINDS,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_STATUS_TRANSITIONS,
  MEMORY_TYPES,
} from "./memory.js";

// ─── Record types ─────────────────────────────────────────────────────────────
export type {
  MemoryEdge,
  MemoryModelIdentity,
  MemoryProvenance,
  MemoryRecord,
  MemoryRetentionHint,
  MemoryStructuredPayload,
  MemoryStructuredPayloadKind,
  MemoryValidityInterval,
} from "./memory-records.js";
export { MEMORY_STRUCTURED_PAYLOAD_KINDS } from "./memory-records.js";

// ─── Operation envelopes ──────────────────────────────────────────────────────
export type {
  MemoryAcceptance,
  MemoryArchive,
  MemoryAuditAction,
  MemoryAuditInitiatorSurface,
  MemoryAuditRecord,
  MemoryForget,
  MemoryPin,
  MemoryProposal,
  MemoryRejection,
  MemoryRetrievalRequest,
  MemorySupersession,
  MemoryUnpin,
  MemoryUpdate,
  MemoryUpdateField,
} from "./memory-operations.js";
export { MEMORY_AUDIT_INITIATOR_SURFACES, MEMORY_UPDATE_FIELDS } from "./memory-operations.js";

// ─── Validators ───────────────────────────────────────────────────────────────
export type {
  MemoryValidation,
  MemoryValidationFail,
  MemoryValidationOk,
  StaleModelMetadataInput,
  StatusTransitionCheck,
} from "./memory-validation.js";
export {
  checkStatusTransition,
  hasStaleModelMetadata,
  looksLikeSecretShape,
  validateMemoryEdge,
  validateMemoryProvenance,
  validateMemoryScope,
  validateMemoryStructuredPayload,
  validateMemoryValidityInterval,
} from "./memory-validation.js";

// ─── Operation validators ─────────────────────────────────────────────────────
export {
  validateMemoryAcceptance,
  validateMemoryArchive,
  validateMemoryForget,
  validateMemoryPin,
  validateMemoryProposal,
  validateMemoryRejection,
  validateMemorySupersession,
  validateMemoryUnpin,
  validateMemoryUpdate,
} from "./memory-operations-validation.js";

// ─── Retrieval validator + scope reachability ────────────────────────────────
export { isScopeReachable, validateMemoryRetrievalRequest } from "./memory-retrieval-validation.js";

// ─── Audit record validator ──────────────────────────────────────────────────
export { validateMemoryAuditRecord } from "./memory-audit-validation.js";

// ─── Audit event surface (#214) ──────────────────────────────────────────────
export type { MemoryAuditEvent, MemoryAuditEventKind } from "./memory-audit-events.js";
export {
  MEMORY_AUDIT_EVENT_KINDS,
  MEMORY_AUDIT_EVENT_SCHEMA_VERSION,
  MEMORY_AUDIT_EVENT_SUMMARY_MAX_CHARS,
} from "./memory-audit-events.js";

// ─── Record validators + discriminator helpers ────────────────────────────────
export {
  assertNeverMemoryType,
  isMemoryEdge,
  isMemoryRecord,
  validateMemoryRecord,
} from "./memory-record-validation.js";
