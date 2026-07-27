# ADR-0164 — One bounded in-memory USearch HNSW runtime

- Status: Accepted
- Date: 2026-07-27
- Epic: [#2556](https://github.com/oscharko-dev/Keiko/issues/2556)
- Amends:
  [ADR-0152](ADR-0152-substrate-ownership-and-unified-retrieval-spine.md) D1–D3 and
  [ADR-0019](ADR-0019-modular-package-architecture.md) v1.1
- Supersedes:
  [ADR-0153](ADR-0153-encrypted-store-ann-and-the-temp-store-guarantee.md)'s sqlite-vec mechanism,
  while preserving its bounded-memory and no-second-plaintext-copy properties
- Extends:
  [ADR-0157](ADR-0157-sharded-coverage-evidence-and-cached-provisioning.md) D4 to the USearch
  runtime cache and portable-product supply chain

## Context

The final audit of Epic #2556 found that the activated sqlite-vec `vec0` path was not approximate
nearest-neighbour search. It executed exhaustive KNN over the complete candidate partition. The
recorded recall was real, but calling the mechanism ANN and closing the epic against an ANN target
was false. It also left three structural gaps:

- production did not bundle or qualify the optional runtime, so the shipped path could remain exact;
- the repository and memory pillars were not both composed onto the shared service; and
- the repository semantic provider retained a whole-file ask-time embedding fallback, creating a
  second retrieval implementation and unplanned model egress when pod state was absent or stale.

The corrected design must provide genuine sublinear candidate generation at relevant scale without
weakening ADR-0047 encryption, widening SQLite extension authority, persisting a plaintext index,
or creating a second vector service.

## Decision

### D1 — One shared service owns exact crossover and HNSW candidate generation

`searchUsearchAnnIndex` in `keiko-local-knowledge` is the only vector-index service. Local Knowledge,
repository pods, and memory compose the contracts-owned `VectorIndexPort` onto that service under
the closed `knowledge | repo | memory` namespace union.

The port accepts an optional, bounded `candidateIds` allow-list. An allow-list only narrows the
partition; an empty list yields no candidates. This admits memory's already authorized/decrypted
candidate set without moving vault access, policy, final ranking, or bodies into the index.

Partitions at or below 20,000 rows use the deterministic exact implementation. Larger cosine
partitions use USearch HNSW with connectivity 32, add expansion 256, and search expansion 768.
HNSW overfetches candidates and the owning TypeScript service exactly re-scores that bounded set
against the original vectors before returning finite, deterministically tie-broken scores.
Unsupported metrics remain exact. Diagnostics name the truthful `exact` or `ann` search mode.

### D2 — Decrypted vectors are bounded, memory-only runtime material

Encrypted vector rows remain sealed in their owning store. The owner decrypts only the authorized
partition into bounded `SharedArrayBuffer` input; the reviewed worker builds an in-memory HNSW index
and receives no bodies. The native capability interface exposes only `add`, `search`, and `size`.
Calls to USearch persistence APIs (`save`, `load`, or `view`) are forbidden by an architecture
gate.

No SQLite extension is enabled or loaded. The sqlite-vec provisioner, TEMP-index implementation,
and `temp_store` authority are retired. This is stronger than ADR-0153's no-spill mechanism:
there is no native persistence capability and no SQLite TEMP index that could spill. The durable
`vector_index_state` table stores only cache lifecycle and redacted diagnostics, never vectors.
The canonical embedding-identity cache key uses an explicitly versioned JSON tuple with typed
`null` values for absent fields, so delimiter-bearing values and former free-text sentinels cannot
collide. Schema migration 31 discards only materialization state written with the old
collision-prone key; stored encrypted vectors remain intact and are reused for the next on-demand
runtime index build. Subsequent identity changes replace, rather than accumulate, state rows for
the same logical index. Runtime cache partitions and invalidation groups likewise use structured,
versioned, SHA-256-bound tuples instead of delimiter-concatenated opaque identifiers, preventing a
capsule or source identifier from aliasing another partition.

Schema migration 32 installs `vectors` insert/update/delete triggers that mark every affected
capsule's materialization state dirty. The trigger owner covers cascades, retention, encryption
migration, and package-internal maintenance, so a caller cannot accidentally omit cache
invalidation. A `ready` state is therefore a constant-time content-revision witness; a dirty,
missing, or unavailable state re-reads the bounded store stamp and revalidates every stored
embedding identity before rebuilding. This avoids both stale decrypted-vector reuse and a
full-table identity scan on every warm ANN query.

Each index has a 256 MiB default estimated-memory ceiling, and the aggregate cache is also capped at
256 MiB estimated so two individually valid large graphs cannot coexist. The separately qualified
process RSS delta ceiling is 512 MiB because native allocator and worker overhead are not captured
by the structural estimate. Caller configuration may tighten, never widen, the per-index limit.
Oversize, malformed, non-finite, identity-incompatible, or failed partitions fail closed before
their scores are used.

The Node.js main thread never performs a blocking `Atomics.wait`: build and query completion arrive
as correlated worker messages with bounded timeouts, while shared-memory waits remain isolated to
the worker thread. Per-index queries are serialized because their request and result buffers are
shared; unrelated request processing remains event-loop responsive during both index construction
and search.

### D3 — The reviewed native runtime is portable and independently verified

USearch 2.26.0 at commit `d92b5495b8451946c9d3e81d0b2d5cf9104579f8` is provisioned directly
because the npm package's license metadata is not accepted by the repository supply-chain policy.
The checked-in manifest pins the source tarball, license, and every supported native asset by
SHA-256 for:

- macOS arm64 and x64;
- Linux arm64 and x64; and
- Windows x64.

Provisioning verifies the source and selected asset. Portable staging verifies again, copies the
addon beside the bundled runtime, emits license/notice/provenance and CycloneDX component records,
and runs a real load/add/search smoke. The platform signing stages include the addon in the signed
inventory and repeat the smoke. A restored CI cache is never evidence: every consumer recomputes
the pinned digest.

The runtime resolver prefers the packaged `runtime/native/usearch.node`, then the verified
development cache. Before every ANN query, including a cache hit, it verifies target, version,
digest, file identity, size, and modification time. The worker repeats the digest/version/TOCTOU
check before loading the addon. A missing, moved, changed, unsupported, or mismatched runtime fails
closed.

The provisioned runtime must be a regular file and its immediate parent must be a directory; neither
may be a symlink. On POSIX both must be owned by the current user or root and deny group/world
writes. The worker opens the addon with `O_NOFOLLOW`, hashes the held descriptor, and rechecks
path/descriptor identity and the digest after native loading. This narrows the path-swap window
without claiming complete protection from a malicious same-UID process; Windows retains the
symlink, descriptor-identity, digest, signed-inventory, and isolated-smoke controls because POSIX
owner/mode bits cannot express Windows ACL authority.

### D4 — One narrow worker boundary isolates the addon

ADR-0019 v1.1 permits exactly two Local Knowledge files to import `node:worker_threads`: the
launcher and the checked-in USearch worker. The launcher may construct exactly one reviewed worker
entrypoint. The worker receives bounded shared buffers and verified runtime metadata; it has no
network, child-process, arbitrary worker, generated-code, or index-persistence authority.

The import-policy negative controls deny every other worker import. A second architecture gate pins
the single constructor, single launcher, search-only native interface, both pillar compositions,
SQLite-extension denial, sqlite-vec retirement, and removal of repository whole-file embedding.

### D5 — Repository semantic search is pod-only

The repository semantic provider queries only fresh, fingerprint-matched repository-pod chunks.
Missing, stale, escaped, unreadable, or failed pod state produces no semantic hits and a body-free
degradation observation. It never embeds candidate file bodies at ask time. The orchestrator's
existing bounded lexical lane remains the availability fallback.

### D6 — Qualification compares real HNSW with exact search in the same run

The closeout gate builds an encrypted 20,001-vector journey and proves ANN mode, candidate
restriction, dirty rebuild, runtime tamper/missing negative controls, extension denial, and zero
native-persistence references.

Its scale arm uses 50,000 vectors at 384 dimensions and ten held-out noisy queries. It separately
records build time, warm service latency, exact latency, recall@10, estimated index bytes, and RSS
delta. It must prove recall@10 at least 0.95, HNSW faster than exact in the same run, an index within
256 MiB, and a process delta within 512 MiB. The 2026-07-27 reference run recorded:

- recall@10: 1.000;
- warm HNSW median: 15.054 ms;
- exact median: 54.218 ms;
- build: 38,930.053 ms; and
- RSS delta: 404,242,432 bytes.

The small arm proves that 500 rows truthfully select `exact`; it is not reported as ANN evidence.
Non-finite measurements and degenerate injected outputs fail the gate closed.

## Consequences

- Epic #2556 now ships genuine HNSW candidate generation in the portable product at relevant scale,
  while small partitions retain a faster deterministic exact path.
- All three namespaces share one service without moving memory-vault or Local Knowledge ownership.
- The product gains a reviewed native addon inside the existing Node process. This does not create a
  public package, background service, distributed runtime, or multi-process deployment requirement.
- Repository semantic availability on missing/stale pod state is lexical rather than an implicit
  model-egress scan.
- ADR-0152's sqlite-vec activation text and memory deferral are historical. ADR-0153's mechanism is
  superseded; its security properties survive in the stronger memory-only, no-persistence design.

## Alternatives considered

- **Keep sqlite-vec and rename it exact.** Rejected: it does not satisfy the epic's ANN outcome and
  remains slower than the qualified HNSW path at the measured scale.
- **Build a bespoke TypeScript LSH.** Rejected: it creates unaudited index logic, weaker recall and
  tuning evidence, and a second subsystem where a mature HNSW implementation exists.
- **Use a persistent HNSW file.** Rejected: encrypted stores would gain a second plaintext vector
  copy and a new lifecycle/cleanup trust boundary.
- **Let each pillar own an index.** Rejected by ADR-0152 D1 and the epic's substrate-unification
  objective.
