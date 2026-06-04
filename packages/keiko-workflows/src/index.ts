// Public barrel for the reviewable developer-assist workflows layer (ADR-0008/0009). Re-exports
// the unit-test generation workflow (#8) and the bug-investigation workflow (#9) surfaces.
//
// The shared descriptor interfaces (WorkflowDescriptor/WorkflowInputSpec, ADR-0009 D12) are
// re-exported HERE EXACTLY ONCE from ./descriptor.js. The unit-tests sub-barrel ALSO re-exports
// them (its #8 surface), so a plain `export *` on it would otherwise surface the names a second
// time; the bug-investigation sub-barrel deliberately does NOT re-export them. An explicit
// re-export here takes precedence over `export *` and resolves the ambiguity so the
// `WorkflowDescriptor` import in src/index.ts and src/sdk/index.ts keeps resolving (same pattern
// the package root uses for the two `summarizeForAudit`s).
export type { WorkflowDescriptor, WorkflowInputSpec } from "./descriptor.js";

export * from "./unit-tests/index.js";
export * from "./bug-investigation/index.js";

// ─── Exploration planner & budget governor (Issue #181 / Epic #177) ──────────
export * from "./planner/index.js";
