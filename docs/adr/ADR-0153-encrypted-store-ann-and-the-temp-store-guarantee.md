# ADR-0153: Encrypted-store ANN, the temp-store guarantee, and the spill proof

## Status

Superseded by [ADR-0163](ADR-0163-one-bounded-in-memory-usearch-hnsw-runtime.md) (2026-07-27).
This record remains the historical proof that encrypted ANN requires bounded memory and no second
plaintext copy. Its sqlite-vec TEMP mechanism is retired: the current USearch service exposes no
persistence API and SQLite extension authority remains denied. Originally accepted for Issue #2630,
Epic #2556, Knowledge M2.

## Date

2026-07-20

## Version

0.1.0

## Context

ADR-0152 D2 activated the sqlite-vec ANN path and, in the same decision, held encrypted stores back:
`searchSqliteVecIndex` returned `fallback-encrypted-store` whenever
`store._internal.contentCipher.isEncrypted`. It recorded the consequence honestly and scoped the
remainder out: _"Encrypted-store ANN is outside M2 and requires a separate ADR; it may not be
inferred from this port."_

Every production capsule store is encrypted. `deps.ts` constructs a key provider unconditionally,
`localKnowledgeProtectionOptions` turns any provider into `mode: "encrypted-key-provider"`, and
`openKnowledgeStore` receives it on every production call. The ANN path was therefore not merely
opt-in, it was structurally unreachable in the shipped product, and the `recall@10 = 1.000` recorded
in the M2 closeout was measured on an ephemeral plaintext `:memory:` store built for the proof.
Epic #2556's Target Outcome 3 ("ANN is on — once") cannot be satisfied while that holds.

Re-examining the guard shows it was not protecting what its name suggests:

- **Decryption into process memory is already the norm.** Brute-force retrieval decrypts every
  candidate vector to compare it — `scoped-vector-search.ts` opens the sealed envelope and
  deliberately detaches the plaintext copy from the row buffer. An ANN index built from the same
  decrypted vectors exposes nothing brute force does not already expose.
- **The index already never persists.** The vec0 index is a TEMP virtual table, created per
  connection and discarded with it. A persisted plaintext index remains rejected (ADR-0152 D2, and
  the ADR-0047 no-second-copy rule it rests on).

One risk was genuinely unreconciled, and the guard was not addressing it. `temp_store` is set nowhere
in this repository, so SQLite is free to materialise its TEMP database into a file once the TEMP page
cache overflows. On an encrypted store those pages hold decrypted vectors, and that file is exactly
the second on-disk plaintext copy ADR-0047 forbids. It is also invisible after the fact: on POSIX
hosts SQLite unlinks the temp file immediately after opening it, so nothing is left to find.

This is not hypothetical at current scale. Measured on the existing 20,001-row / 4-dimension ANN
fixture with the production vec0 column layout, an unpinned connection spills; the same corpus on a
pinned connection does not. The spill threshold sits near the default 2 MB TEMP page cache, well
below any realistic capsule.

So the boundary that needed drawing was never "encrypted or not". It was "can this connection
guarantee TEMP pages stay in memory".

## Decision

### D1 — The ANN guard tests the TEMP-storage guarantee, not the encryption flag

`searchSqliteVecIndex` no longer refuses a store for being encrypted. It refuses a store that cannot
prove decrypted vectors will stay off disk:

```text
encrypted store  AND  temp_store is not MEMORY   →  refuse
```

The guarantee is **read from the live connection** (`PRAGMA temp_store`), never inferred from the
fact that some code path intended to set it. A build compiled with `SQLITE_TEMP_STORE=0` ignores the
pragma, and a caller may open a store without a vector runtime and supply one at search time; both
leave the condition unmet, and both must fail closed. An unreadable pragma is an unproven guarantee
and is treated as unpinned.

The refusal keeps the existing diagnostic vocabulary — status `fallback-encrypted-store`, brute force
answers the query — with a reason that now names the actual condition:
`encrypted-store-temp-store-unpinned`. The reason string changed because the old one
(`encrypted-store`) became untrue: encryption alone no longer refuses anything.

Plaintext stores carry no such condition. Their vectors are already on disk in the clear, so a TEMP
spill discloses nothing the database does not. The condition is scoped to where the invariant bites.

### D2 — A store that enables the vector index pins TEMP storage to memory

`openKnowledgeStore` applies `PRAGMA temp_store = MEMORY` under exactly the condition that already
grants `allowExtension: true` — a configured and validated vector-index runtime. The two are one
decision: a store that can build the index must also be unable to spill it. Every other store keeps
SQLite's default, so the shipped default configuration's memory profile is unchanged.

The pragma is applied at open, before anything creates a TEMP table, because changing `temp_store`
later drops existing TEMP tables.

### D3 — The index is size-bounded and falls closed to brute force

D2 buys the no-spill guarantee by making the index RAM-resident, which converts an unbounded index
into an unbounded allocation. The two must not be separated, so the same decision bounds it.

The bound is expressed in **decrypted vector bytes** (`vectorCount x dimensions x 4`), because that
is what actually occupies memory. The default is 256 MiB — roughly 43k vectors at 1536 dimensions,
comfortably above any local capsule and far below a heap that would destabilise the host process.

A capsule over the bound is not refused retrieval. It falls back to brute force, which streams
vectors instead of holding them, and reports status `fallback-index-too-large` with reason
`index-bytes-over-bound`. The runtime is not loaded and no rows are inserted.

`VectorIndexOptions.maxIndexedVectorBytes` may **only tighten** the bound: a supplied value above the
default is clamped back to it, and a non-finite or negative value resolves to the default. It is a
floor-lowering knob, never a widening one, so no caller and no operator can raise the amount of
decrypted payload the process will hold.

### D4 — The no-spill claim is proved executably, with a negative control

`vector-index-runtime.test.ts` builds a real ANN index, with the real provisioned sqlite-vec binary,
over an **encrypted** store, and asserts that no plaintext vector reached disk while it did.

The observable is the **temp directory's mtime**, not a directory listing. SQLite unlinks its temp
file immediately after opening it, so the file is never visible to a reader and only the two
directory mutations it causes survive. `SQLITE_TMPDIR` is set at module scope because SQLite memoises
its temp-directory choice on the first temp file it creates in a process.

The proof has two halves and neither is sufficient alone:

- a **negative control** drives the same vec0 column layout and the same corpus through an unpinned
  connection and asserts the directory mtime **did** change — so a future change that shrinks the
  corpus below the spill threshold fails the control rather than yielding a vacuously green proof;
- the **subject** asserts `PRAGMA temp_store` reads MEMORY on the live encrypted store, that the
  temp directory's mtime is unchanged and it holds no file, and that the store directory gains no
  new file.

The proof was falsified before being trusted. With the D1 guard deleted and the D2 pin absent — the
naive activation this ADR exists to prevent — the temp-directory mtime changes and the test fails.
Reverting the pin alone, the decryption step, or the D3 bound each fails its own assertion.

### D5 — Quality parity is asserted against the brute-force baseline, on an encrypted store

The encrypted ANN run is held to the same floors as the plaintext baseline, by running the same
journey assertions: identical reference ordering versus the exact brute-force pipeline, recall
>= 0.95 at candidate limits 5 and 10, per-candidate score agreement, and a `ready` index state at the
expected vector count.

### D6 — Evidence stays content-free

Every diagnostic added here carries counts, statuses, and index names only. The bound diagnostic
reports the vector count, never the byte budget's provenance, a path, or anything derived from the
vectors. A vector that fails to open yields status `fallback-query-error` with reason
`stored-vector-decrypt-failed` and no detail of the failure — indexing the sealed bytes instead would
build an index over ciphertext and answer from it, so this fails closed rather than degrading.

## Consequences

- Encrypted-store ANN is reachable, which makes Epic #2556 Target Outcome 3 achievable on the stores
  the product actually ships. Turning the vector index on by default remains a separate, independent
  switch and is **not** decided here.
- ADR-0152 D2's statement that "encrypted stores return `fallback-encrypted-store` and use brute
  force by design" is superseded. Its surviving locks are unchanged: the mode still defaults to
  `disabled`, no binary is bundled, and the runtime stays operator-provisioned.
- ADR-0047's no-second-plaintext-copy invariant is strengthened rather than relaxed. Before this
  decision the TEMP database could spill decrypted vectors to a file on any store, with nothing
  detecting it; now the connections that can build a vector index cannot spill, and a test proves it.
- The ANN index is bounded by memory rather than disk. Large capsules answer through brute force,
  which is slower but correct, and say so in their diagnostics.
- A host whose SQLite ignores `temp_store` gets brute force on encrypted stores, exactly as today.

## Alternatives considered

- **Keep the encryption flag as the guard.** Rejected: it refuses a safe configuration and permits an
  unsafe one. It blocks encrypted stores whose TEMP pages are pinned in memory, while a plaintext
  store — and, before D2, any store — could spill freely without the guard noticing.
- **Encrypt the TEMP database instead of preventing it.** Rejected: no crypto seam exists below the
  pager, it would mean new crypto rather than the audited primitive (ADR-0047), and it protects a
  file that does not need to exist.
- **Persist the vec0 index.** Rejected, unchanged from ADR-0152 D2: a persisted plaintext index is
  precisely the second on-disk copy ADR-0047 forbids.
- **Pin `temp_store` for every store.** Rejected as out of proportion: stores that cannot build a
  vector index gain no guarantee from it and would take an unbounded memory profile in exchange for
  nothing.
- **Prove no-spill by scanning the temp directory for files.** Rejected as unsound: SQLite unlinks
  the file immediately, so the scan passes whether or not a spill happened.
