// Re-export shim: the evidence layer now lives in @oscharko-dev/keiko-evidence (issue #163,
// ADR-0019). All existing import sites (`from "../audit/index.js"`) keep resolving unchanged via
// this barrel. Symbols enumerated explicitly to match the PRE-MOVE surface of src/audit/index.ts
// (per the keiko-tools / keiko-workspace precedent — never `export *` in a legacy shim).
export { buildEvidenceManifest } from "@oscharko-dev/keiko-evidence";
export { persistEvidence } from "@oscharko-dev/keiko-evidence";
export { createAuditRedactor, deepRedactStrings } from "@oscharko-dev/keiko-evidence";
export { aggregateUsage } from "@oscharko-dev/keiko-evidence";
export { listEvidence, loadEvidence } from "@oscharko-dev/keiko-evidence";
export { applyRetention } from "@oscharko-dev/keiko-evidence";
export { buildEvidenceReport, renderEvidenceReport, } from "@oscharko-dev/keiko-evidence";
export { assertValidRunId } from "@oscharko-dev/keiko-evidence";
export { buildWorkflowManifest, foldWorkflowUsage, persistWorkflowEvidence, } from "@oscharko-dev/keiko-evidence";
export { createInMemoryEvidenceStore, createNodeEvidenceStore, resolveEvidenceDir, } from "@oscharko-dev/keiko-evidence";
export { AUDIT_CODES, AuditError, EvidenceReadError, EvidenceSchemaError, EvidenceWriteError, InvalidRunIdError, } from "@oscharko-dev/keiko-evidence";
export { EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION, } from "@oscharko-dev/keiko-evidence";
