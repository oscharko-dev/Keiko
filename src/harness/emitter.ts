// Re-export shim: the harness Emitter now lives in @oscharko-dev/keiko-harness
// (issue #164, ADR-0019). Emitter is a harness internal — kept on the package barrel
// only so this legacy shim resolves without subpath-importing into the package.

export { Emitter } from "@oscharko-dev/keiko-harness";
