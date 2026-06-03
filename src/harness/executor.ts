// Re-export shim: harness model + tool-call handlers live in
// @oscharko-dev/keiko-harness (issue #164, ADR-0019). These are harness internals —
// kept on the package barrel only so this legacy shim resolves without
// subpath-importing into the package.

export { handleModelCall, handleToolCall } from "@oscharko-dev/keiko-harness";
