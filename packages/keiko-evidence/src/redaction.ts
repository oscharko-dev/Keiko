// Re-export shim: the audit-redaction layer (createAuditRedactor + deepRedactStrings) now lives in
// @oscharko-dev/keiko-security (issue #159, ADR-0019). All existing import sites
// (`from "./redaction.js"`) keep resolving unchanged via this barrel.

export { createAuditRedactor, deepRedactStrings } from "@oscharko-dev/keiko-security";
