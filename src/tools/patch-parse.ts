// Re-export shim: the unified-diff parser lives in @oscharko-dev/keiko-tools (issue #162,
// ADR-0019). All existing import sites (`from "../tools/patch-parse.js"`) keep resolving
// unchanged via this barrel.

export { parseUnifiedDiff, PatchParseError, type ParsedPatch } from "@oscharko-dev/keiko-tools";
