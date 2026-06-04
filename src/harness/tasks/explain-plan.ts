// Re-export shim: the explain-plan task builder lives in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019). buildExplainPlan is a harness internal — kept on the package
// barrel only so this legacy shim resolves without subpath-importing into the package.

export { buildExplainPlan } from "@oscharko-dev/keiko-harness";
