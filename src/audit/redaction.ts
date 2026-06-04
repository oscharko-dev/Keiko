// Re-export shim: the audit redactor lives in @oscharko-dev/keiko-evidence (issue #163, ADR-0019),
// which itself re-exports the primitives from @oscharko-dev/keiko-security.

export { createAuditRedactor, deepRedactStrings } from "@oscharko-dev/keiko-evidence";
