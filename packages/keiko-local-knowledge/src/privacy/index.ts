// Public surface of the privacy / retention / audit layer (Epic #189, Issue #201). The
// package barrel re-exports this module so consumers can import retention and audit
// helpers from the top-level `@oscharko-dev/keiko-local-knowledge` entry point.

export type {
  CapsuleRetentionPolicy,
  CapsuleAuditEvent,
  AuditEventSink,
  RetentionApplyResult,
} from "./types.js";

export { redactDiagnosticMessage } from "./diagnostic-redactor.js";
export { applyRetentionToCapsule } from "./retention-applier.js";
export { emitCapsuleAuditEvent, createSqliteAuditSink } from "./audit-emitter.js";
