// Re-export shim: the investigate-bug task builder lives in
// @oscharko-dev/keiko-harness (issue #164, ADR-0019). buildInvestigateBug is a harness
// internal — kept on the package barrel only so this legacy shim resolves without
// subpath-importing into the package.

export { buildInvestigateBug } from "@oscharko-dev/keiko-harness";
