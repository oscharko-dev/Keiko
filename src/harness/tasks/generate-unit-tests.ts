// Re-export shim: the generate-unit-tests task builder lives in
// @oscharko-dev/keiko-harness (issue #164, ADR-0019). buildGenerateUnitTests is a
// harness internal — kept on the package barrel only so this legacy shim resolves
// without subpath-importing into the package.

export { buildGenerateUnitTests } from "@oscharko-dev/keiko-harness";
