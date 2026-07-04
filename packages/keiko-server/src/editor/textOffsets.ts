// Pure conversion between zero-based {line, character} positions (LSP 3.17) and absolute UTF-16
// code-unit offsets in a source buffer (Issue #1198). Deterministic: it maps an editor position
// onto the TypeScript offset model and maps analysis spans back to wire ranges. The TypeScript
// language service speaks in offsets; the editor wire contract speaks in line/character.
//
// The mapping itself now lives in the domain-neutral, DOM-free leaf `line-offsets.ts` inside
// `@oscharko-dev/keiko-contracts` and is shared with the browser patch-preview path
// (GEN-DUP-SEMANTIC-017): a single line-terminator policy (LF, CRLF, and lone-CR aware) drives both
// consumers, so the server and the editor can never diverge on a CR/CRLF buffer. It lives in the
// dependency-free contracts leaf both tiers already depend on, so neither the server nor the browser
// editor takes a package edge on the other (ADR-0019 package graph). This module re-exports the leaf
// so the server's existing call sites are unchanged.
export {
  computeLineStarts,
  offsetToPosition,
  positionToOffset,
  spanToRange,
} from "@oscharko-dev/keiko-contracts/line-offsets";
