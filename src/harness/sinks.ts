// Re-export shim: harness event sinks live in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019).

export {
  CliEventSink,
  MemoryEventSink,
  type EventWriter,
  type ManifestSeed,
} from "@oscharko-dev/keiko-harness";
