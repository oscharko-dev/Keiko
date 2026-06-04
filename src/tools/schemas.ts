// Re-export shim: the model-facing tool-definitions table lives in @oscharko-dev/keiko-tools
// (issue #162, ADR-0019). All existing import sites (`from "../tools/schemas.js"`) keep resolving
// unchanged via this barrel.

export { TOOL_DEFINITIONS } from "@oscharko-dev/keiko-tools";
