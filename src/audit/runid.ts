// Re-export shim: the runId validator lives in @oscharko-dev/keiko-evidence (issue #163,
// ADR-0019), which itself re-exports from @oscharko-dev/keiko-security.

export { assertValidRunId } from "@oscharko-dev/keiko-evidence";
