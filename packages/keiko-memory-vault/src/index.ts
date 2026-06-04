// Public surface of @oscharko-dev/keiko-memory-vault (Epic #204 child #206). Keeping this file
// the SOLE entry point prevents downstream packages from reaching into private modules
// (ADR-0019 trust rule 7). Subpath exports are intentionally absent; the package is small
// enough that a single barrel is the lowest-friction surface for #207-#214 consumers.

export { KEIKO_MEMORY_VAULT_VERSION } from "./version.js";
export { createMemoryVault } from "./vault.js";
export {
  MemoryStorageError,
  MemoryStorageValidationError,
  type MemoryStorageErrorCode,
  type MemoryStorageValidationFailure,
} from "./errors.js";
export {
  MEMORY_DB_FILENAME,
  MEMORY_DIR_NAME,
  DEFAULT_STATE_DIR,
  resolveMemoryDir,
  resolveMemoryDbPath,
} from "./paths.js";
export { MEMORY_VAULT_SCHEMA_VERSION } from "./schema.js";
export type {
  DeleteMemoryOptions,
  ListMemoriesOptions,
  MemoryEmbeddingInput,
  MemoryEmbeddingMetric,
  MemoryEmbeddingRow,
  MemoryEvent,
  MemoryTombstone,
  MemoryUpdatePatch,
  MemoryVaultFactoryOptions,
  MemoryVaultStore,
} from "./types.js";
