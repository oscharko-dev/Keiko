// Public surface of @oscharko-dev/keiko-memory-vault (Epic #204 child #206). Scaffold barrel —
// types, errors, the path resolver, the factory, and the store port are wired in across the
// remaining tasks. Keeping this file the SOLE entry point prevents downstream packages from
// reaching into private modules (ADR-0019 trust rule 7).

export { KEIKO_MEMORY_VAULT_VERSION } from "./version.js";
