# ADR-0035: Memory vault encryption-at-rest

## Status

Accepted (Epic #204, 2026-06-07). Hardens the local Enterprise Memory Vault introduced in [ADR-0019](ADR-0019-modular-package-architecture.md) (`keiko-memory-vault`, `node:sqlite`, ADR-0013 storage shape).

## Context

The memory vault stores governed enterprise memory CONTENT — what the product remembers about a user, workspace, project, or workflow — in a local SQLite database at `~/.keiko/memory/keiko-memory.db`. The files were already `chmod 0600` (dir `0700`), but the column values themselves were plaintext: a `strings` dump of the DB revealed memory bodies, tags, structured payloads, and capture rationales verbatim. For an enterprise pilot this is unacceptable — a stolen laptop, a stray backup, or a synced cloud folder leaks remembered content with no key required.

The product owner's hard requirement: **no plaintext memory content may sit on disk; memory files must be encrypted at rest.** Constraints carried over from the platform baseline:

- **Zero new runtime dependencies** (ADR-0011/0013). Only Node built-ins. No SQLCipher, no `better-sqlite3`, no `node:sqlite` replacement.
- **Transparent and automatic.** `createMemoryVault(...)` must resolve its cipher internally; no caller in `keiko-server` changes, and the public factory signature stays callable as before.
- The rest of the system (retrieval, capture, consolidation, governance, server, UI) must continue to see decrypted `MemoryRecord`s exactly as today. Lexical search runs in JS over `record.body` on decrypted records (`keiko-memory-retrieval/relevance.ts`), so decrypting on read keeps search working with no SQL/content-index changes.

## Decision

### Authenticated encryption primitive (`keiko-security/secretbox.ts`)

A new leaf primitive provides AES-256-GCM authenticated encryption with two envelope formats sharing one key and one domain-pinning AAD (`"keiko-memory-v1"`):

- **String envelope** `kv1.<base64url(nonce12)>.<base64url(ciphertext||tag16)>` via `sealString` / `openString`.
- **Binary envelope** `0x01 || nonce12 || ciphertext || tag16` via `sealBytes` / `openBytes`, for the embedding vector BLOB.
- A fresh random 12-byte nonce per call (GCM-safe size, well clear of the birthday bound for local single-DB write volume).
- `isSealed(value)` (prefix check `kv1.`) so reads can detect legacy plaintext.
- Decryption failures (tampered ciphertext, wrong key, malformed envelope) funnel through a typed `SecretboxError` — never silent corruption. "Wrong key" and "tampered" are intentionally indistinguishable (no oracle).

### Content-vs-metadata split

Only the columns that carry remembered TEXT/vector content are sealed. Index, query, and UI-display columns stay cleartext so SQL indexes and scope rendering work without a key.

| Sealed (content)                                                                                              | Cleartext (index / metadata)                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memories.body`, `payload_json`, `tags_json`, `capture_rationale`, `stale_reason`; `memory_edges.provenance_summary`; `memory_tombstones.reason`; `memory_embeddings.vector` (BLOB) | all ids, `schema_version`, `type`, `scope_kind`, `scope_coordinate`, `status`, `sensitivity`, `pinned`, `confidence`, all timestamps, `source_*`, `model_*`, `retention_*`, `vector_dimensions`, `vector_metric` |

Crypto is confined to two wrapper functions in `serialize.ts` (and the per-table seal/open in `edges.ts`, `embeddings.ts`, `tombstones.ts`); the pure row↔record builders operate on plaintext exactly as before. The cipher is threaded as an explicit parameter through the row layer (keeping those modules pure and unit-testable) and resolved once, internally, in `createMemoryVault`.

### Key resolution tiers (`keiko-memory-vault/cipher.ts`)

`resolveVaultKey(env, memoryDir)` resolves a 32-byte key with this precedence (highest first):

1. **`KEIKO_MEMORY_KEY`** — base64 of exactly 32 bytes; throws if the length is wrong. Explicit operator override; the deterministic tier for live/CI runs.
2. **macOS Keychain** (`process.platform === "darwin"`) — OS-gated generic password `keiko-memory-vault` via the `security` CLI (`find-generic-password`; generate + `add-generic-password` on first use). The OS protects the key. The `security` spawn is the only OS boundary and is the only code wrapped in try/catch: any failure (no binary, locked/headless keychain, non-darwin) falls through to the keyfile tier rather than bricking the vault. The reader is injectable so CI and non-darwin hosts deterministically use the keyfile tier without touching a real keychain.
3. **Keyfile** `<memoryDir>/vault.key`, mode `0600`, base64 of 32 random bytes, generated on first use (directory hardened to `0700` first). This is the documented **weaker** tier: the key sits next to the DB, so an attacker with the directory has both halves.

The factory accepts optional `cipher?` / `vaultKey?` injection **for tests only**; production callers pass neither and get the tiered resolver.

### Eager migration to `user_version = 2`

`MEMORY_VAULT_SCHEMA_VERSION` is bumped from 1 to 2. On `openMemoryDatabase`, if `user_version < 2`, a transactional sweep re-encrypts every existing plaintext content value across all four tables and sets `user_version = 2`. The sweep is **idempotent**: a value already sealed (kv1.* for strings, `0x01`-prefixed for the embedding BLOB) is skipped, so a fresh DB is a no-op and a re-run (or a run interrupted before COMMIT — `user_version` stays `< 2`) re-sweeps cleanly. After upgrading an EXISTING DB, the migration runs `PRAGMA wal_checkpoint(TRUNCATE)` so superseded plaintext pages are purged from the WAL immediately rather than lingering until the next close. Reads also tolerate legacy plaintext (`openString` returns a non-`kv1.` value unchanged), so a half-migrated DB still reads.

## Threat model

**Defeats:** casual disk inspection (`strings`/hex dump), stray or synced backups, and a stolen-at-rest DB file — none reveal memory content without the key. Tampering with a sealed value fails the GCM auth tag and throws loudly.

**Does not defeat (honest limitations):**

- A local attacker who has BOTH the keyfile-tier `vault.key` and the DB can decrypt — the keyfile tier is convenience, not a hardware boundary. The keychain tier raises this bar (OS-gated); `KEIKO_MEMORY_KEY` moves the secret out of the directory entirely.
- Content is decrypted in process memory while the vault is open (required — retrieval and the UI consume plaintext records). This protects data at rest, not a live memory dump of a running process.
- Metadata columns (scope, type, timestamps, sensitivity) are cleartext by design; they leak the SHAPE of memory (how many, which scopes, when) but not its content.

## Consequences

- **One-way migration.** A `user_version = 2` DB is unreadable by pre-encryption (v1) code. For local single-user state this is acceptable; rollback is "revert the branch," and an already-migrated DB would then need re-creation. This is the documented trade for an atomic, dependency-free upgrade.
- **No new dependencies; no public API change.** `keiko-server` and every downstream package compile and run unchanged.
- **Negligible runtime cost.** One AES-GCM seal/open per content field per row op (microseconds); the migration is a one-time O(rows) sweep.
