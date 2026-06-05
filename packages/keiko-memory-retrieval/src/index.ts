// Public surface of @oscharko-dev/keiko-memory-retrieval (Epic #204 child #210).
// Keeping this file the SOLE entry point prevents downstream packages from reaching into
// private modules (ADR-0019 trust rule 7). Internal modules are package-private.
//
// Every function in this barrel is pure: same input + same MemoryQueryPort responses =>
// byte-identical output. The package never reads a clock, never invokes randomness, never
// touches the filesystem. The caller supplies nowMs through MemoryRetrievalRequest and
// owns the vault behind the MemoryQueryPort seam.

export { KEIKO_MEMORY_RETRIEVAL_VERSION } from "./version.js";
