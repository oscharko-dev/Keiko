// Public barrel for the reviewable developer-assist workflows layer (ADR-0008/0009). Re-exports
// the unit-test generation workflow (#8) and the bug-investigation workflow (#9) surfaces.
//
// The shared descriptor interfaces (WorkflowDescriptor/WorkflowInputSpec, ADR-0009 D12) are
// re-exported HERE EXACTLY ONCE from ./descriptor.js. The unit-tests sub-barrel ALSO re-exports
// them (its #8 surface), so a plain `export *` on it would otherwise surface the names a second
// time; the bug-investigation sub-barrel deliberately does NOT re-export them. An explicit
// re-export here takes precedence over `export *` and resolves the ambiguity so the
// `WorkflowDescriptor` import in src/index.ts and packages/keiko-sdk/src/index.ts keeps resolving
// (same pattern the package root uses for the two `summarizeForAudit`s).
export type { WorkflowDescriptor, WorkflowInputSpec } from "./descriptor.js";

export * from "./unit-tests/index.js";
export * from "./bug-investigation/index.js";

// ─── Exploration planner & budget governor (Issue #181 / Epic #177) ──────────
export * from "./planner/index.js";

// ─── Candidate ranking & negative context filter (Issue #182 / Epic #177) ────
export * from "./ranking/index.js";

// ─── Context-pack assembler & micro-index (Issue #183 / Epic #177) ──────────
export * from "./contextpack/index.js";

// ─── Quality Intelligence workflow execution (Epic #270, Issue #273/#279) ────
// Scripted + model-routed run entries, descriptors, cancellation, and the run-lifecycle types.
export * from "./qualityIntelligence/index.js";
