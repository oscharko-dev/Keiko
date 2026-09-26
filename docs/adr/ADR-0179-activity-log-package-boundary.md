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
reader, query, analysis, and selective-export surface.

The package may depend only on `@oscharko-dev/keiko-contracts` and
`@oscharko-dev/keiko-security`. `keiko-server` and `keiko-cli` compose it. Domain packages retain
their injected Activity Log ports, and `keiko-ui` and every domain package are prohibited from
depending on the package. HTTP routes, server diagnostics, CLI argument parsing, rendering, and
publication remain with their existing composition owners.

The package continues the ADR-0173 persistence contract without changing segment names, line
shape, recovery, retention, pin, or policy semantics. Its process-global writer registration fails
closed when a second implementation attempts to open a writer in the same process; the rejection
is body-free Activity Log evidence and is counted by the existing loss ledger when an event drops.

The generated operation catalog records the new package as the owner/emitter location. This changes
the catalog digest once while the persisted line format remains byte-compatible. Until the
registry-version-matched analyzer work lands, operators must analyze a log with the Keiko version
that wrote it.

## Enforcement

TypeScript project references, package exports, package-surface assembly, coverage inventory,
dependency-cruiser, and import-policy checks enforce this boundary. Negative architecture fixtures
must prove both the forbidden package dependency and the forbidden domain-package import rules.
The generated catalog and failure-surface inventory are regenerated after source ownership settles;
they are never edited by hand.

## Consequences

- Activity Log-only CLI paths can load the reader without loading `keiko-server`.
- The server and CLI consume one owned writer/store/reader implementation.
- The package is bundled in the product artifact; it is not a second customer installation or
  runtime service.
- Cross-version analysis can report an unsupported catalog digest at this release boundary even
  though the log's on-disk format is unchanged.

## Amends

- [ADR-0019](ADR-0019-modular-package-architecture.md): adds the Activity Log package as a
  contracts/security-only infrastructure leaf and constrains its consumers.
- [ADR-0173](ADR-0173-server-activity-log-v2-machine-reconstruction-contract.md): relocates the
  implementation without changing its machine-reconstruction or persistence contract.
