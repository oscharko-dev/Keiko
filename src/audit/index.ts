// Audit ledger barrel (ADR-0010 D12). Re-exports the public surface of the audit layer: the builder,
// the persist orchestration, the redactor, the store port + adapters, aggregation, the index/list
// API, retention, the report, and runId validation, plus the schema/types. None of these names
// collides with an existing layer export (D9) — in particular the layer does NOT export a bare
// `summarizeForAudit` or `redact` (it composes them internally).

export { buildEvidenceManifest } from "./build.js";
export { persistEvidence, type PersistResult } from "./persist.js";
export { createAuditRedactor } from "./redaction.js";
export { aggregateUsage, resolveCostClass } from "./aggregate.js";
export { listEvidence, loadEvidence, type EvidenceListEntry } from "./index-api.js";
export { applyRetention } from "./retention.js";
export { buildEvidenceReport, renderEvidenceReport, type EvidenceReport } from "./report.js";
export { assertValidRunId } from "./runid.js";
export {
  createInMemoryEvidenceStore,
  createNodeEvidenceStore,
  type EvidenceStore,
} from "./store.js";
export {
  AUDIT_CODES,
  AuditError,
  EvidenceReadError,
  EvidenceSchemaError,
  EvidenceWriteError,
  InvalidRunIdError,
  type AuditCode,
} from "./errors.js";
export {
  EVIDENCE_SCHEMA_VERSION,
  DEFAULT_RETENTION,
  type AuditRedactionConfig,
  type BuildOptions,
  type EvidenceBuildInput,
  type EvidenceCommandExecution,
  type EvidenceDeps,
  type EvidenceFailure,
  type EvidenceManifest,
  type EvidenceModel,
  type EvidencePatch,
  type EvidenceReasoningEntry,
  type EvidenceRunIdentity,
  type EvidenceStateTransition,
  type EvidenceToolCall,
  type EvidenceUsageTotals,
  type RetentionPolicy,
} from "./types.js";
