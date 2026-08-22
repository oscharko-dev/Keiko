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
// handle or `keySource`) so it can call `computeStoreFingerprint` directly without migrating,
// re-encrypting, or quarantining the vault.
//
// `resolveVaultKey` (mutating: can mint and persist `vault.key`) and `openMemoryDatabase`
// (mutating: can migrate, re-encrypt, or quarantine-and-reopen a store) are deliberately NOT
// re-exported here (Finding: Thread 6). No package outside this one imports either — every
// external consumer that needs a fully-opened, writable vault goes through `createMemoryVault`,
// and the diagnostic seam above uses only the read-only twins. Keeping the write-capable
// primitives internal to this package (still available to `vault.ts`/`db.ts` via a direct
// `./cipher.js` / `./db.js` import) means a future external caller cannot reach past
// `createMemoryVault`'s validated construction by importing a lower-level primitive from the
// public barrel.
export {
  createMemoryContentCipher,
  resolveVaultKeyReadOnly,
  type MemoryContentCipher,
  type ResolvedVaultKeyReadOnly,
  type VaultKeySource,
} from "./cipher.js";
export { computeStoreFingerprint, openMemoryDatabaseReadOnly } from "./db.js";
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
