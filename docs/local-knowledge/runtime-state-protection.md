# Local Knowledge runtime-state protection

Status: shipped in 0.2.0 (Issue #1322, Epic #1319). See
[ADR-0047](../adr/ADR-0047-local-knowledge-content-encryption.md) for the decision record.

## What is protected

The Local Knowledge capsule store is a `node:sqlite` database at
`<runtime-state>/local-knowledge/<namespace>/capsules.db`. It can hold the full extracted text and
the embedding vectors of regulated customer documents (requirements, Fachkonzepte, design material,
repository documents). On a local developer machine, file permissions alone do not protect that
content from a copied `.keiko` directory, a synced backup, or a loose host permission.

When a key provider is configured (the default for `keiko ui` / the BFF; see below), the store seals
its **reconstructive content columns** with AES-256-GCM at rest, using the shared
`@oscharko-dev/keiko-security` `secretbox` primitive — the same audited primitive as the Memory Vault
(ADR-0035) and the credential vault (ADR-0046).

### Sealed content columns

| Table                   | Column              | Why it is content                                                      |
| ----------------------- | ------------------- | ---------------------------------------------------------------------- |
| `document_texts`        | `normalized_text`   | Full extracted text of a small document.                               |
| `document_text_windows` | `normalized_text`   | One bounded window of a progressively extracted large document.        |
| `vectors`               | `embedding`         | Packed Float32 embedding bytes of a chunk (reconstructive of content). |
| `sections`              | `section_path_json` | Document-derived section labels.                                       |
| `parsed_units`          | `section_path_json` | Parsed-unit section labels used for chunking/citations.                |
| `parsed_units`          | `heading_path_json` | Parsed-unit heading labels used for HTML citations.                    |

### Cleartext metadata (and why it is safe)

Everything else stays cleartext because deterministic retrieval depends on it and it cannot
reconstruct document content:

- **Identifiers** — `capsule_id`, `document_id`, `chunk_id`, `source_id`, `id`, storage references,
  and safe display names.
- **Offsets and structure keys** — `character_start` / `character_end`, page numbers/labels,
  JSON pointers, table names, and row indexes. These index into the sealed text but do not carry
  section or heading label content.
- **Hashes** — `content_hash`, `safe_excerpt_hash`, and `section_path_hash` (one-way digests,
  already non-reversible). `section_path_hash` preserves duplicate-section uniqueness after
  randomized encryption seals the actual section path JSON.
- **Embedding identity** — `embedding_model_provider`, `embedding_model_id`, `vector_dimensions`,
  `vector_metric`. Retrieval dispatch and stale-vector detection scan these without a join; during
  migration only, the cleartext `vector_dimensions` tells the sweep the expected plaintext vector
  length before the row is sealed.
- **Lifecycle** — `status`, `lifecycle_state`, timestamps, indexing-job counters, audit metadata.

This split mirrors the Memory Vault's content-vs-metadata model (ADR-0035).

## Key resolution

The store key is resolved per store-open through the shared `resolveLocalVaultKey` seam with a
Local-Knowledge namespace (distinct from the credential and memory vaults so a ciphertext sealed for
one store cannot open with another's key):

1. `KEIKO_LOCAL_KNOWLEDGE_KEY` — base64 of exactly 32 bytes. Explicit operator override (strongest;
   the key lives outside the state directory). Use this to pin a deterministic key in CI/tests.
2. macOS Keychain — generic password under service `keiko-local-knowledge-vault` (the OS protects the
   key; darwin only).
3. Keyfile — `local-knowledge-vault.key` (mode `0600`) co-located with `capsules.db`. Documented
   weakest tier: the key sits next to the store, so an attacker with the directory has both halves.

On non-darwin hosts (e.g. Linux CI) the keychain tier is unavailable and resolution falls through to
the keyfile tier automatically; no configuration is required.

**Operator guidance for regulated deployments.** The keyfile tier stores the key next to the
ciphertext, so an attacker who can read the state directory has both halves. For regulated banking and
insurance deployments, prefer tier 1 (`KEIKO_LOCAL_KNOWLEDGE_KEY`, e.g. injected from a secrets
manager) or tier 2 (macOS Keychain). The keyfile tier is appropriate only on a single-user developer
machine or a corporate laptop with full-disk encryption.

## Migration of existing plaintext stores

Opening a legacy plaintext store with a key provider performs a one-time, crash-aware, idempotent
forward migration before any content read:

1. Every not-yet-sealed content row is sealed inside a single transaction: small-document text,
   large-document text windows, vectors, section paths, parsed-unit section paths, and parsed-unit
   heading paths. Text rows are skipped only when they authenticate with the current key; a legacy
   plaintext value that merely starts with `kv1.` is still sealed and later reads back unchanged.
   Vector plaintext-length tolerance is used only during this migration.
2. A sealed key-verification probe is written so a later open with a wrong or missing key fails
   clearly.
3. `PRAGMA wal_checkpoint(TRUNCATE)` then `VACUUM` rewrite the file so plaintext that lingered in the
   WAL or on freed pages does not remain on disk.

If a sealed probe exists without the completion marker, the store treats it as an incomplete
encrypted migration: no-key opens fail, wrong-key opens fail before any mutation, and same-key opens
finish the idempotent sweep. User-visible capsule behavior is unchanged; retrieval, grounding,
diagnostics, and incremental refresh keep working through the existing public APIs.

## Failure diagnostics (fail-closed)

- Opening an **encrypted** store with the **wrong key** throws a clear `KnowledgeStoreError`
  ("wrong key or tampered content") at open time — it never returns partial plaintext or drops
  indexed content.
- Opening an **encrypted** store with **no key provider** throws
  ("this Local Knowledge store is encrypted; a key provider is required to open it").
- A tampered or missing key-verification probe throws ("corrupt store or incomplete migration").
- A plaintext or tampered content row injected into an already marked encrypted store throws on
  read/retrieval; strict encrypted reads never return unsealed text or plaintext-length vectors.

## Performance guardrails

Encryption is column-level AES-256-GCM applied only at the store boundary, so the cost is bounded and
local:

- **Steady state** — one `seal`/`open` per content row touched. A 2 KiB text seal+open round trip
  stays well under 200 µs on CI-class hardware (asserted by a regression test); embedding seal/open is
  a single GCM pass over `dimensions * 4` bytes (≤ ~6 KiB for the largest in-scope model) with a direct
  regression guard. Retrieval keeps ciphertext vector rows in the normal row set and decrypts each row
  only while scoring, so it does not retain a second decrypted vector array.
- **Bounded memory preserved** — the Issue #1286 large-document guarantee holds: a citation span read
  decrypts exactly one bounded unit (a small-document row or a single ~16-page window), never a whole
  large document. The plaintext path keeps its in-SQL `SUBSTR`; only the encrypted path decrypts a
  bounded unit and slices in JS.
- **One-time migration** — enabling encryption on an existing store pays a single seal sweep plus one
  `VACUUM`, proportional to store size. This runs once; subsequent opens only verify the probe.

## Enabling and disabling

Encryption is enabled by `keiko-server` for every production store open by injecting a key provider
(`createLocalKnowledgeKeyProvider`). A store opened without a key provider (the in-package evaluation
harness, unit tests, or a custom embedder) stays plaintext and behaves exactly as before — encryption
is opt-in per store-open, never a silent global toggle.
