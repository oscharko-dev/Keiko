// Re-export shim: the verify task builder lives in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019). buildVerify is a harness internal — kept on the package
// barrel only so this legacy shim resolves without subpath-importing into the package.

export { buildVerify } from "@oscharko-dev/keiko-harness";
