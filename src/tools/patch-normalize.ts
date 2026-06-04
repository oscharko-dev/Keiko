// Re-export shim: unified-diff normalization lives in @oscharko-dev/keiko-tools (issue #162,
// ADR-0019). All existing import sites (`from "../tools/patch-normalize.js"`) keep resolving
// unchanged via this barrel.

export { normalizeUnifiedDiffHunks } from "@oscharko-dev/keiko-tools";
