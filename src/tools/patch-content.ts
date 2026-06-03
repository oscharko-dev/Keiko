// Re-export shim: patch-content helpers live in @oscharko-dev/keiko-tools (issue #162, ADR-0019).
// All existing import sites (`from "../tools/patch-content.js"`) keep resolving unchanged via this
// barrel.

export {
  computeFileContent,
  type ApplyOutcome,
  type HunkConflict,
} from "@oscharko-dev/keiko-tools";
