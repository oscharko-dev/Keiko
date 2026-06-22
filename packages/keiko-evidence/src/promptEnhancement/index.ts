// Public barrel for the PromptEnhancement sub-module of `@oscharko-dev/keiko-evidence`
// (Epic #1307, Issue #1313; ADR-0044 §1/§5). Re-exports the manifest schema, the redactor, and the
// local-store + builder API. The package barrel re-exports this directory under the
// `PromptEnhancement` namespace plus flat-named symbols, mirroring the QualityIntelligence layout.

// ─── Manifest schema ─────────────────────────────────────────────────────────────────
export {
  PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION,
  validatePromptEnhancementEvidenceManifest,
} from "./manifestSchema.js";
export type {
  PromptEnhancementEvidenceStatus,
  PromptEnhancementRedactionSummary,
  PromptEnhancementCandidateScoreRow,
  PromptEnhancementSafetyRecord,
  PromptEnhancementModelMetadata,
  PromptEnhancementIntegrityHashes,
  PromptEnhancementManifestTotals,
  PromptEnhancementEvidenceManifest,
  PromptEnhancementSchemaValidationResult,
} from "./manifestSchema.js";

// ─── Redaction ───────────────────────────────────────────────────────────────────────
export { redactPromptEnhancementEvidence } from "./redaction.js";
export type {
  PromptEnhancementRedactionOptions,
  PromptEnhancementRedactionResult,
} from "./redaction.js";

// ─── Local-state store + builder + CRUD ────────────────────────────────────────────
export {
  PE_SUBDIR,
  buildPromptEnhancementEvidenceManifest,
  createInMemoryPromptEnhancementLocalStore,
  createNodePromptEnhancementLocalStore,
  recordPromptEnhancementRun,
  loadPromptEnhancementRun,
  listPromptEnhancementRuns,
} from "./store.js";
export type {
  PromptEnhancementRecordInput,
  PromptEnhancementRecordOptions,
  PromptEnhancementRecordResult,
  PromptEnhancementLocalStore,
  PromptEnhancementNodeStoreOptions,
  PromptEnhancementLoadOptions,
} from "./store.js";
