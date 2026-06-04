// Re-export shim: the harness state-machine loop lives in
// @oscharko-dev/keiko-harness (issue #164, ADR-0019). runLoop is a harness internal —
// kept on the package barrel only so this legacy shim resolves without
// subpath-importing into the package.

export { runLoop } from "@oscharko-dev/keiko-harness";
