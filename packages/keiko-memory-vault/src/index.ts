// Public surface of @oscharko-dev/keiko-memory-vault (Epic #204 child #206). Keeping this file
// the SOLE entry point prevents downstream packages from reaching into private modules
// (ADR-0019 trust rule 7). Subpath exports are intentionally absent; the package is small
// enough that a single barrel is the lowest-friction surface for #207-#214 consumers.

export { KEIKO_MEMORY_VAULT_VERSION } from "./version.js";
export { createMemoryVault } from "./vault.js";
export {
  MemoryStorageError,
  MemoryStoragePreconditionError,
  MemoryStorageValidationError,
  type MemoryStorageErrorCode,
  type MemoryStoragePreconditionField,
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
export { memoryBodySuppressionHash } from "./body-fingerprint.js";
// Read-only diagnostic seam for `keiko bundle export` (Wave 4a, epic #3233 §6.2): the exporter
// resolves the vault key and opens the store itself via `openMemoryDatabaseReadOnly` (rather than
// through `createMemoryVault`, whose returned `MemoryVaultStore` intentionally exposes no `db`
// handle or `keySource`, or through the mutating `openMemoryDatabase`) so it can call
// `computeStoreFingerprint` directly without migrating, re-encrypting, or quarantining the vault.
export {
  createMemoryContentCipher,
  resolveVaultKey,
  type MemoryContentCipher,
  type VaultKeySource,
} from "./cipher.js";
export { computeStoreFingerprint, openMemoryDatabase, openMemoryDatabaseReadOnly } from "./db.js";
export type {
  DeleteMemoryOptions,
  ListMemoriesOptions,
  MemoryAccessStat,
  MemoryBatchDelete,
  MemoryBatchUpdate,
  MemoryDeleteResult,
  MemoryEmbeddingInput,
  MemoryEmbeddingMetric,
  MemoryEmbeddingRow,
  MemoryEvent,
  MemoryGraphMutation,
  MemoryGraphPrecondition,
  MemoryGraphMutationResult,
  MemoryMetadata,
  MemoryTombstone,
  MemoryTombstoneCursor,
  MemoryTombstoneLedgerCursor,
  MemoryTombstonePage,
  MemoryUpdatePatch,
  MemoryVaultFactoryOptions,
  MemoryVaultStore,
} from "./types.js";
