# ADR-0047: Local Knowledge extracted-text and vector encryption at rest

## Status

Accepted (Issue #1322, Epic #1319, 2026-06-20). Extends the content-vs-metadata
encryption-at-rest pattern of [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md)
and the generalized local key-resolution seam of
[ADR-0046](ADR-0046-local-credential-vault.md) to the Local Knowledge capsule store,
sealing the only columns that can reconstruct customer document content.

## Date

2026-06-20

## Version

0.2.0

## Context

The Local Knowledge capsule store (`packages/keiko-local-knowledge`, a `node:sqlite`
database under `<runtime-state>/local-knowledge/<namespace>/capsules.db`) persists the
full extracted text of every indexed document plus the embedding vector of every chunk.
Three columns carry reconstructive customer content:

- `document_texts.normalized_text` — the full normalized text of a small document.
- `document_text_windows.normalized_text` — one bounded window of a progressively
  extracted large document (Issue #1286).
- `vectors.embedding` — the packed Float32 embedding bytes of a chunk.

Local Knowledge can hold requirements, Fachkonzepte, design material, and other
regulated customer context. As with credentials (ADR-0046), `0600` file permissions
are useful but are not encryption: a copied `.keiko` directory, a synced backup, or a
loose host permission exposes every extracted document verbatim to a `strings` dump of
the SQLite file. Epic #1319's hard requirement for regulated banking and insurance
pilots is that **no extracted document text or vector byte persists as plaintext in the
local Local Knowledge SQLite store.**

The `KnowledgeStoreProtectionOptions` contract already declared an
`encrypted-key-provider` mode and a `KnowledgeStoreKeyProvider` seam, but the store
actively rejected it (`rejectUnsupportedProtection`). This issue implements that mode.

Constraints carried over from the platform baseline:

- **Reuse the audited primitive.** The AES-256-GCM `secretbox`
  (`sealString`/`openString`/`sealBytes`/`openBytes`/`isSealed` from
  `@oscharko-dev/keiko-security`) and the env → OS-keychain → `0600`-keyfile resolution
  seam (`resolveLocalVaultKey`, ADR-0046) already exist and are audited. No new crypto.
- **Stay local-first.** No hosted vector database, hosted search, or cloud KMS.
- **Preserve the data model.** No parallel capsule store; the on-disk schema and the
  public Local Knowledge APIs (indexing, retrieval, grounding, diagnostics, incremental
  refresh) are unchanged.
- **Preserve bounded ingestion.** The Issue #1286 bounded-memory guarantee for large
  documents must survive encryption: a citation span read must never materialize a whole
  document.
- **Keep encryption at the store boundary.** Crypto must not spread into retrieval,
  parsing, or UI layers.

## Decision

### D1 — A single store content cipher at the store boundary

`keiko-local-knowledge/src/store-content-cipher.ts` is the only module that touches
crypto. It binds the resolved 32-byte key into a `StoreContentCipher`:

```
interface StoreContentCipher {
  readonly isEncrypted: boolean;
  readonly sealText:   (plaintext: string) => string;
  readonly openText:   (stored: string) => string;
  readonly sealVector: (plaintext: Uint8Array) => Uint8Array;
  readonly openVector: (stored: Uint8Array, plaintextByteLength: number) => Uint8Array;
}
```

The cipher is resolved once at `openKnowledgeStore` and carried on the package-private
`store._internal.contentCipher` capability, exactly as `keiko-memory-vault` threads its
`MemoryContentCipher` (ADR-0035). Plaintext mode binds an identity cipher
(`PLAINTEXT_CONTENT_CIPHER`), so every read/write call site is byte-for-byte unchanged
when no key provider is supplied. The row-layer accessors
(`insertDocumentTextRow`, `readDocumentTextRow`, `insertDocumentTextWindowRow`,
`readDocumentTextSpan`, `insertVectorRow`, and the retrieval/grounding/QI readers) take
the cipher explicitly and call `sealText`/`openText`/`sealVector`/`openVector` at the
column boundary. No crypto knowledge leaves this module.

`openText` tolerates legacy plaintext (`isSealed(value) ? openString : value`) so a read
during the migration window never fails. `openVector` distinguishes plaintext from
sealed bytes by length: the cleartext `vector_dimensions` column gives the expected
plaintext byte length (`dimensions * 4`); a stored blob of exactly that length is legacy
plaintext, anything else is a sealed binary envelope and is authenticated by `openBytes`,
which throws loudly on a wrong key or tampered data rather than returning plaintext.

### D2 — Encryption is opt-in per store-open via the key provider

`openKnowledgeStore` keeps **plaintext as the default**: a store opened without a
`keyProvider` behaves exactly as before. `keiko-server` turns encryption on for all
production store opens by injecting a `KnowledgeStoreKeyProvider`
(`createLocalKnowledgeKeyProvider`) that resolves the key through the shared
`resolveLocalVaultKey` seam with a Local-Knowledge namespace
(`KEIKO_LOCAL_KNOWLEDGE_KEY` env → `keiko-local-knowledge-vault` keychain service →
`local-knowledge-vault.key` keyfile, co-located with the store under
`dirname(capsules.db)`). Key separation — a distinct env var, keychain service, and
keyfile — prevents a ciphertext sealed for one vault from opening with another's key.
The model gateway is untouched; only the store boundary gains the cipher.

### D3 — Sealed content columns; cleartext deterministic-retrieval metadata

Only the three reconstructive columns above are sealed. Index and lineage metadata stay
cleartext because deterministic retrieval depends on it and it cannot reconstruct
document content: identifiers (`capsule_id`, `document_id`, `chunk_id`, `source_id`),
character offsets (`character_start`/`character_end`), page/section structure, content
hashes (`content_hash`, `safe_excerpt_hash`), embedding identity
(`embedding_model_provider`/`embedding_model_id`/`vector_dimensions`/`vector_metric`),
status, and timestamps. The cleartext-metadata split mirrors ADR-0035 and is documented
in `docs/local-knowledge/runtime-state-protection.md`.

### D4 — Idempotent, crash-aware forward migration with WAL/freelist hygiene

When an encrypted store opens, a one-time content-encryption migration runs before any
read, gated on a `schema_meta` marker so it is idempotent and skipped once complete:

1. Seal every not-yet-sealed `document_texts.normalized_text`,
   `document_text_windows.normalized_text`, and plaintext `vectors.embedding` row inside
   a single transaction (legacy plaintext rows are detected by `isSealed` for text and by
   exact `dimensions * 4` byte length for vectors).
2. Write a sealed probe sentinel into `schema_meta` so a later open with a wrong or
   missing key fails clearly instead of returning ciphertext as text.
3. `PRAGMA wal_checkpoint(TRUNCATE)` then `VACUUM` so plaintext pages that lingered in the
   WAL or on the freelist after the in-place `UPDATE` are rewritten out of the file.

On every subsequent encrypted open, the store verifies the sealed probe: a wrong key, a
tampered probe, or an encrypted store opened **without** a key provider throws a clear
`KnowledgeStoreError` (`fail-closed`) rather than silently returning partial plaintext or
dropping indexed content. A legacy plaintext store opened without a provider stays
plaintext; opened with a provider, it migrates forward without data loss and without any
user-visible capsule behavior change.

## Consequences

- A fresh encrypted store never writes plaintext extracted text or vector bytes to disk;
  a migrated store is rewritten (VACUUM) so prior plaintext does not linger. Verified by
  raw-SQLite / `strings`-equivalent on-disk assertions over known fixture text and vector
  bytes, by a migration round-trip test, and by a wrong-key fail-closed test.
- Retrieval, hybrid lexical recall, citation excerpts, grounding, QI corpus ingestion,
  diagnostics, and incremental refresh continue to work unchanged through existing APIs;
  the cipher decrypts transparently at the row boundary.
- Bounded ingestion is preserved: small documents decrypt one bounded `document_texts`
  row; large documents decrypt exactly one bounded `document_text_windows` row per
  citation span. No path materializes a whole large document.
- `keiko-local-knowledge` gains a direct `@oscharko-dev/keiko-security` dependency. This
  is a leaf package already in the Local Knowledge transitive closure through
  `keiko-model-gateway → keiko-security`, so the direct edge adds no new package to the
  bundle and introduces no cycle; the `arch:check` package-graph allowlist is updated to
  record it.
- Encryption is per-open: callers that open a store without a key provider (the in-package
  evaluation harness and tests) remain plaintext, so existing behavior and tests are
  unaffected. Production server opens are encrypted by default.
- One-time migration cost: enabling encryption on an existing large store pays a single
  seal-sweep plus `VACUUM`. The overhead budget and steady-state per-row seal/open cost
  are documented in `docs/local-knowledge/runtime-state-protection.md`.

## Alternatives considered

- **Whole-file / SQLCipher encryption.** `node:sqlite` has no SQLCipher binding, and a
  decrypt-to-tempfile scheme would break the WAL single-writer model and the Issue #1286
  bounded-memory guarantee. Rejected in favor of column-level sealing at the store
  boundary.
- **In-SQL `SUBSTR` over an encrypted column.** A GCM envelope cannot be partially
  decrypted, so SQL `SUBSTR` cannot read a span of sealed text. The encrypted span reader
  instead decrypts exactly one bounded unit (a small-document row or a single large-
  document window) and slices in JS, preserving the memory bound. The plaintext path keeps
  the original SQL `SUBSTR`.
- **Deterministic / order-preserving encryption** to keep `SUBSTR` and `LIKE` working in
  SQL. Rejected: it leaks structure and is weaker than AES-256-GCM, contradicting the
  regulated-deployment goal.
