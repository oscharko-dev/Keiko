// Re-export shim: the gateway redaction engine now lives in @oscharko-dev/keiko-security (issue
// #159, ADR-0019). All existing import sites (`from "../gateway/redaction.js"`) keep resolving
// unchanged via this barrel.

export { redact } from "@oscharko-dev/keiko-security";
