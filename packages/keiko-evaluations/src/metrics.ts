// ADR-0152 D5 (amended by Issue #2635): the deterministic retrieval-evaluation primitives moved to
// `@oscharko-dev/keiko-contracts` so the server retrieval eval and the gate script can reach the
// same math without an inward-pointing edge into this harness. This module remains the harness
// entry point for those symbols; it re-exports the canonical implementations so existing
// keiko-evaluations SDK consumers keep working unchanged.

export { binaryNdcgAtK, mean } from "@oscharko-dev/keiko-contracts";
