// Re-export shim: the binary side-file writer lives in @oscharko-dev/keiko-evidence (issue #163,
// ADR-0019). `SideFileWriteResult` originates in @oscharko-dev/keiko-contracts (#162) and is
// re-exposed here so every existing `from "../audit/side-file.js"` import keeps resolving.

export {
  writeSideFile,
  type SideFileWriteResult,
  type SideFileWriterOptions,
} from "@oscharko-dev/keiko-evidence";
