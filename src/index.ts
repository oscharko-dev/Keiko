// Package-root boundary: the public surface is the agent harness, the model gateway, and
// the SDK version constant. The harness barrel already re-exports the session/run API the
// SDK surfaces, so we pull SDK_VERSION explicitly and avoid duplicate star re-exports.
export { SDK_VERSION } from "./sdk/index.js";
export * from "./harness/index.js";
export * from "./gateway/index.js";
export * from "./workspace/index.js";
export * from "./verification/index.js";
// Both the workspace and verification barrels expose a `summarizeForAudit`. An explicit re-export
// takes precedence over the two star exports and resolves the ambiguity at the package root: the
// canonical root `summarizeForAudit` is the workspace one (established by ADR-0005), and the
// verification audit projection is additionally surfaced under an unambiguous alias. Inside
// ./verification/index.js the function keeps its layer-local name `summarizeForAudit` (ADR-0007).
export { summarizeForAudit } from "./workspace/index.js";
export { summarizeForAudit as summarizeVerificationForAudit } from "./verification/index.js";
