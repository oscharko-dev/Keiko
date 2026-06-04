// Re-export shim: the audit error taxonomy lives in @oscharko-dev/keiko-evidence (issue #163,
// ADR-0019), which itself re-exports the classes from @oscharko-dev/keiko-security.

export {
  AUDIT_CODES,
  AuditError,
  InvalidRunIdError,
  EvidenceWriteError,
  EvidenceReadError,
  EvidenceSchemaError,
  type AuditCode,
} from "@oscharko-dev/keiko-evidence";
