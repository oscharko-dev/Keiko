# Decision Summary

This page keeps only the product decisions needed by reviewers. It is not an implementation history.

## Current Decisions

| Area | Decision |
| ---- | -------- |
| Product surface | Keiko is delivered as an npm package with a local UI and CLI. |
| Runtime model access | Models are configured at runtime through an OpenAI-compatible gateway. |
| Local-first operation | The UI binds to loopback and stores runtime state locally. |
| User control | Keiko does not commit, push, open pull requests, merge, or apply patches without explicit local action. |
| Workspace boundary | Repository reads and writes are bounded by the selected project path. |
| Command boundary | Verification uses allowlisted commands without shell execution. |
| Patch safety | Generated patches are dry-run by default and must be reviewed before application. |
| Evidence | Supported surfaces write redacted local evidence for human review. |
| Credentials | API tokens are local secrets and are never logged, serialized, or returned to the browser. |
| Evaluation | Pilot decisions require offline thresholds plus human-reviewed live model runs. |
| Package architecture | [ADR-0019](ADR-0019-modular-package-architecture.md) defines the modular workspace package architecture while preserving one customer-facing npm product package. |
| Workspace tooling | [ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md) operationalises ADR-0019: npm workspaces under `packages/*`, shared TypeScript project references, and the architecture gate. |
| Publish strategy | [ADR-0021](ADR-0021-publish-strategy-bundled-monorepo-product.md) keeps workspace packages internal and the root tarball self-contained via `bundleDependencies`. |
| Connected context privacy | [ADR-0022](ADR-0022-connected-context-privacy.md) pins the privacy contract for grounded answers and evidence retention. |
| Installable PWA architecture | [ADR-0024](ADR-0024-installable-pwa-architecture.md) defines the supported browser/platform model, manifest contract, and local-secret boundary for installability. |
| Forward-only 0.2.0 modular baseline | [ADR-0025](ADR-0025-forward-only-0-2-0-modular-baseline.md) records the live package topology, bundled runtime contract, and error-severity gate posture. |
| Workspace substrate | [ADR-0026](ADR-0026-workspace-substrate.md) locks the existing `useWorkspace` as the workspace editor, DOM React tree as the renderer, `View { zoom, x, y }` as the camera, and the `WindowsRegistry` + `registerWindowRender` as the object registry; rejects an independent canvas / graph substrate. |
| Workspace state ownership and persistence | [ADR-0027](ADR-0027-workspace-state-ownership.md) partitions workspace state into eight classes with one owner package and one storage backend each; defines the closed `PersistenceExpectation` set used by object descriptors. |
| Workspace commands, events, selection, undo/redo | [ADR-0028](ADR-0028-workspace-commands-undo.md) defines the typed `Command` record contract, the conflict-at-startup keyboard substrate, and the typed `Action` discriminated union that compile-time refuses undo of evidence / patches / verification / model-call records. |
| Workspace object registry and extension contract | [ADR-0029](ADR-0029-workspace-object-registry.md) extends `WindowTypeDef` with `lifecycle`, `trustBoundary`, `authority`, `persistence` fields and adds a registration-time validator that rejects descriptors with inconsistent authority / trust / persistence declarations. |
| Workspace security, evidence, and trust boundaries | [ADR-0030](ADR-0030-workspace-security-evidence.md) records the current workspace trust-boundary rules and durable-state restrictions. |

## Historical Records

| Area | Record |
| ---- | ------ |
| Quality Intelligence implementation history | [ADR-0023](ADR-0023-quality-intelligence-migration-architecture.md) is retained as a historical Epic #270 decision record. Do not use it as the current repository baseline; use ADR-0025 and the active package/security docs instead. |

For operational details, use the README, the runtime-state contract, the security boundaries, and the packaged-surface summary.
