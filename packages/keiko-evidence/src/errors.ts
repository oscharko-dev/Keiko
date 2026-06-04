// Re-export shim: the audit error taxonomy now lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). All existing import sites (`from "./errors.js"`) keep resolving
// unchanged via this barrel.

export {
  AUDIT_CODES,
  AuditError,
  InvalidRunIdError,
  EvidenceWriteError,
  EvidenceReadError,
  EvidenceSchemaError,
} from "@oscharko-dev/keiko-security/errors/audit";
export type { AuditCode } from "@oscharko-dev/keiko-security/errors/audit";
