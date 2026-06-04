// Re-export shim: the runId validator now lives in @oscharko-dev/keiko-security
// (issue #159, ADR-0019). All existing import sites (`from "./runid.js"`) keep resolving
// unchanged via this barrel.

export { assertValidRunId } from "@oscharko-dev/keiko-security";
