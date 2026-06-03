// Re-export shim: harness port adapters live in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019).

export {
  DryRunToolPort,
  GatewayModelPort,
  type ChatModel,
  type RecordedToolCall,
} from "@oscharko-dev/keiko-harness";
