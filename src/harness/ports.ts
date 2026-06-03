// Re-export shim: harness hexagonal ports live in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019). The tool ports (ToolPort, ToolCallRequest, ToolCallResult,
// ToolCallMetadata) themselves originate in @oscharko-dev/keiko-contracts (issue #162)
// and are re-exported from the harness barrel for one-import-source.

export type {
  EventSink,
  Fingerprinter,
  FingerprintInput,
  IdSource,
  ModelPort,
  ToolCallMetadata,
  ToolCallRequest,
  ToolCallResult,
  ToolPort,
} from "@oscharko-dev/keiko-harness";
