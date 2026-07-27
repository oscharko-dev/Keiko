# USearch HNSW runtime and supply-chain evidence

This body-free record qualifies the native runtime adopted by
[ADR-0163](../adr/ADR-0163-one-bounded-in-memory-usearch-hnsw-runtime.md). The executable sources of
truth are:

- `packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts`;
- `scripts/provision-usearch.mjs`;
- `scripts/stage-portable-runtime.mjs`;
- `scripts/smoke-portable-usearch.mjs`; and
- `scripts/lib/knowledge-m2-closeout.mjs`.

## Pinned upstream

| Field           | Value                                                              |
| --------------- | ------------------------------------------------------------------ |
| Version         | 2.26.0                                                             |
| Source commit   | `d92b5495b8451946c9d3e81d0b2d5cf9104579f8`                         |
| Source SHA-256  | `30ea2585723dfa1a4868657a82e33a6497c02551db0403ec9338cb97066d0f72` |
| License SHA-256 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| License         | Apache-2.0                                                         |

USearch is provisioned directly rather than added to `package.json`: the upstream npm metadata
spells the license in a form rejected by the repository's fail-closed dependency policy.
Provisioning does not trust that metadata. It verifies the pinned tarball, the license body, and
the selected native asset before extraction.

## Platform assets

| Runtime target | Native SHA-256                                                     |
| -------------- | ------------------------------------------------------------------ |
| macOS arm64    | `3ec1cc10dd85b0ec4d40808dab3c6eda1e8abf6c6297611609dd1d2c4670d98a` |
| macOS x64      | `3ec1cc10dd85b0ec4d40808dab3c6eda1e8abf6c6297611609dd1d2c4670d98a` |
| Linux arm64    | `fbb272981cf28425091205a80cb976c4caeee647a5e4e15f505d646d9184c517` |
| Linux x64      | `cf0e422433d03c8f7f9a1f1d58f369b9dd0d29a9549cd6e3fe87973a29ef6637` |
| Windows x64    | `bd470f8543e99b4260f75f325bf2ae8c92b367d513630db3e35dcfdb2b25a9af` |

A cache hit is never qualification. Every cache consumer reruns `provision:usearch`, which
recomputes the platform digest. Portable staging repeats the verification, adds the runtime to
provenance, third-party notices and CycloneDX, and executes a real native add/search smoke.
Platform signing inventories cover `runtime/native/usearch.node`; the signed archive is rebound to
the final runtime hash and smoke-tested again.

## Runtime trust boundary

Before every HNSW query, the resolver verifies platform target, SHA-256, version, file identity,
size, and modification time. The isolated worker repeats the digest, version and TOCTOU checks
before loading the addon. Missing, replaced, mismatched, unsupported, or tampered binaries return a
content-free unavailable/integrity result.

The reviewed native interface exposes `add`, `search`, and `size` only. An architecture gate rejects
`save`, `load`, or `view` index calls; a second guard rejects SQLite extension authority and the
retired sqlite-vec integration. Encrypted rows are decrypted only by their owner into bounded
memory. There is no persistent native index or SQLite TEMP index.

## Qualification result

The latest local closeout:

- built and queried an encrypted 20,001-vector ANN partition;
- proved runtime missing/tampered/disabled and extension-denial negative controls;
- measured 50,000 vectors at 384 dimensions with ten held-out noisy queries;
- recorded recall@10 1.000, HNSW median 15.054 ms, exact median 54.218 ms;
- recorded build time 38,930.053 ms and RSS delta 404,242,432 bytes; and
- proved a 500-row partition truthfully selects exact search.

See
[`knowledge-m2-substrate-evidence.md`](knowledge-m2-substrate-evidence.md) for deterministic
evidence and
[`knowledge-m2-ann-latency-characterization.md`](knowledge-m2-ann-latency-characterization.md) for
the non-golden wall-clock characterization. Re-run with
`npm run check:knowledge-m2-closeout`; regenerate the deterministic artifacts only with `--write`.
