# ADR-0179: Activity Log package boundary

## Status

Accepted (2026-09-26, Issue #3558).

## Context

The Activity Log writer, segmented store, and support reader had been split between the server and
CLI packages. Loading an Activity Log-only command could therefore load the server graph, while a
source graph and a built graph could create separate writer singletons in one process. The persisted
segment format and the registry contracts are already shared product contracts and must remain
compatible across this relocation.

## Decision

`@oscharko-dev/keiko-activity-log` owns one implementation of the Activity Log writer, store, and
reader engine. Its root entry exports the writer/store surface; its `./reader` entry exports the
reader, query, analysis, and selective-export surface. Raw store-mutation primitives, the in-memory
test sink, and test reset hooks belong to neither entry.

The package may depend only on `@oscharko-dev/keiko-contracts` and
`@oscharko-dev/keiko-security`. `keiko-server` and `keiko-cli` compose it. Domain packages retain
their injected Activity Log ports, and `keiko-ui` and every domain package are prohibited from
depending on the package. HTTP routes, server diagnostics, CLI argument parsing, rendering, and
publication remain with their existing composition owners. The rule governs production source; the
package's own tests may import server fixtures, such as the real route-template reducer, to prove
the composed behavior.

The package continues the ADR-0173 persistence contract without changing segment names, line
shape, recovery, retention, pin, or policy semantics.

### One writer per process

A process runs exactly one writer instance, because orphan recovery treats any other instance id
under its own pid as an exited predecessor. The first module graph that opens a writer claims a
process-wide owner slot on `globalThis` under a `Symbol.for` key, so a source copy and a built copy
of the package evaluated in the same process see one owner. Every entry point that mutates the
Activity Log store or the SupportIncident store claims ownership before its first filesystem
mutation: opening a sink, creating or releasing a pin, appending a durable batch, and creating or
sweeping incidents. Ownership is never released for the lifetime of the process.

A second module graph fails closed with `ActivityLogWriterOwnershipError`, and the winning writer
persists the registered, body-free `activity-log.writer-rejected` event (`reason:
process-writer-owned`). A foreign or malformed owner slot and a `worker_threads` worker, which shares
the pid but not the main realm's slot, fail closed the same way; their rejection cannot reach the
winning writer and is counted in the loss ledger instead. A `vm` context cannot be detected this
way, so product code never opens a writer from one: worker and `vm` contexts hand their evidence to
the main thread.

### Route-template redaction

The route vocabulary stays with the server. The package's redaction replaces every path-shaped value
with `REDACTED_PATH` until a composition root installs a reducer through
`configureActivityLogRouteRedactor`; the server installs `redactRoutePath` when its observability
module loads. The first configuration wins: repeating it with the same reducer is a no-op, and a
different reducer throws `ActivityLogRouteRedactorConflictError` instead of silently replacing path
redaction. A process that never loads the server, such as the CLI support commands, keeps the
fail-closed default, so the operations it emits carry only closed values, counts, identifiers, and
digests, never a field that depends on route-template reduction.

### Composition boundaries

`keiko-server` keeps its `observability` barrel and its exported `./observability/server-log`
subpath as re-exports of this package, never as a second implementation. The CLI's static module
graph imports no `keiko-server` module; commands that need the server load it lazily. The Activity
Log-only support commands (`keiko support query`, `keiko support manifest`, and
`keiko support incident`) therefore load this package and never the server.

The generated operation catalog records the new package as the owner/emitter location. This changes
the catalog digest once while the persisted line format remains byte-compatible. Until the
registry-version-matched analyzer work lands, operators must analyze a log with the Keiko version
that wrote it.

## Enforcement

TypeScript project references, package exports, package-surface assembly, the coverage inventory,
and the dependency-cruiser rules `adr-0179-activity-log-only-contracts-security`,
`adr-0179-domain-not-activity-log`, and `adr-0019-direction-8a-ui-no-activity-log` enforce this
boundary; negative architecture fixtures prove that each rule fails on a violation. Executable
proofs pin the rest:

- the writer-ownership suite rejects a second graph in both load orders, a foreign owner slot, and
  a worker thread, and proves that the winner's live segment is never sealed;
- the route-redactor suite pins the fail-closed default and the first-wins configuration;
- a CLI import-graph test runs the built CLI entry for the support commands and fails on any
  `keiko-server` resolution;
- a checked-in fixture written before the extraction proves that reading, recovery, retention, pins,
  and the store policy are unchanged.

The generated catalog and failure-surface inventory are regenerated after source ownership settles;
they are never edited by hand.

## Consequences

- Activity Log-only CLI commands load the reader without loading `keiko-server`, which removes the
  server-graph load from their startup (measured in `docs/observability/README.md`).
- The server and CLI consume one owned writer/store/reader implementation.
- The one-writer rule is enforced, not only documented: a second module graph, a foreign owner slot,
  and a worker thread are refused before any filesystem mutation.
- The package is bundled in the product artifact; it is not a second customer installation or
  runtime service.
- Cross-version analysis can report an unsupported catalog digest at this release boundary even
  though the log's on-disk format is unchanged.

## Amends

- [ADR-0019](ADR-0019-modular-package-architecture.md): adds the Activity Log package as a
  contracts/security-only infrastructure leaf and constrains its consumers.
- [ADR-0173](ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md): relocates the
  implementation without changing its machine-reconstruction or persistence contract, and injects
  the server's route-template reducer into the relocated redaction.
