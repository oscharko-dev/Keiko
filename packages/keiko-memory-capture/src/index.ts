// Public surface of @oscharko-dev/keiko-memory-capture (Epic #204 child #207).
// Keeping this file the SOLE entry point prevents downstream packages from reaching into
// private modules (ADR-0019 trust rule 7). The capture layer is the PRIMARY secret-rejection
// boundary: storage (#206) and audit (#214) treat the body as already-policy-gated.

export { KEIKO_MEMORY_CAPTURE_VERSION } from "./version.js";
