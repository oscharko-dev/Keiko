// Re-export shim: the harness session API lives in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019). HARNESS_VERSION itself comes from @oscharko-dev/keiko-contracts
// and is re-exported from the harness barrel.

export {
  createSession,
  HARNESS_VERSION,
  type AgentConfig,
  type AgentSession,
  type HarnessDeps,
} from "@oscharko-dev/keiko-harness";
