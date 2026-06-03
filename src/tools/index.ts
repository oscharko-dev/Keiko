// Re-export shim: the safe tool-execution layer lives in @oscharko-dev/keiko-tools
// (issue #162, ADR-0019). All existing import sites (`from "../tools/index.js"`) keep
// resolving unchanged via this barrel.

export * from "@oscharko-dev/keiko-tools";
