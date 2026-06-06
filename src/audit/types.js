// Re-export shim: all Evidence* interfaces, the retention/redaction config tables, and the frozen
// EVIDENCE_SCHEMA_VERSION / DEFAULT_RETENTION constants live in @oscharko-dev/keiko-contracts
// (#158) and reach @oscharko-dev/keiko-evidence's public surface in #163 (ADR-0019).
export { EVIDENCE_SCHEMA_VERSION, DEFAULT_RETENTION } from "@oscharko-dev/keiko-evidence";
