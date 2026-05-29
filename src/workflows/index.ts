// Public barrel for the reviewable developer-assist workflows layer (ADR-0008/0009). Re-exports
// the unit-test generation workflow (#8) and the bug-investigation workflow (#9) surfaces.
//
// The shared descriptor interfaces (WorkflowDescriptor/WorkflowInputSpec, ADR-0009 D12) are
// re-exported HERE EXACTLY ONCE from ./descriptor.js. Both sub-barrels also re-export them, so a
// plain `export *` on both would make TypeScript silently DROP the duplicated name from the
// combined export — breaking the `WorkflowDescriptor` import in src/index.ts and src/sdk/index.ts.
// An explicit re-export takes precedence over `export *` and resolves the ambiguity (same pattern
// the package root uses for the two `summarizeForAudit`s).
export type { WorkflowDescriptor, WorkflowInputSpec } from "./descriptor.js";

export * from "./unit-tests/index.js";
