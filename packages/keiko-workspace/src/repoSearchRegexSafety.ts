// Re-exports the canonical ReDoS gate from `keiko-contracts` (the leaf package, per ADR-0019)
// so this engine and the user-facing workspace-search route (`keiko-server`) share one
// catastrophic-backtracking detector instead of two copies that could drift apart.
export { regexSafetyIssue } from "@oscharko-dev/keiko-contracts";
