# Public API surface — 1.1.8

This document summarizes the current approved customer-facing surface for
`@oscharko-dev/keiko`. It is current-state only: the heading names the product version whose surface
this describes, so a reader can tell at a glance whether it still applies. The stability notes below
keep every earlier release reason, including the compatibility-only symbols published at 0.2.15.

## Root product package — `@oscharko-dev/keiko`

| Surface                                     | Resolution                                                          | Contract                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `import { ... } from "@oscharko-dev/keiko"` | `package.json` `exports["."]` → `dist/index.js` / `dist/index.d.ts` | Stable public root barrel.                                                |
| `npx keiko ...` / installed `keiko` bin     | `package.json` `bin.keiko` → `dist/cli/index.js`                    | Stable CLI entrypoint.                                                    |
| Bundled UI static export                    | `dist/ui/static/**` served by `@oscharko-dev/keiko-server`          | Runtime artifact is stable; hashed filenames may change between releases. |

The root manifest exports only `"."`. There are no root subpath exports. This monolithic root
surface is the approved external install-time and import-time contract. The authoritative
machine-readable export allowlist lives in
[`scripts/root-package-surface.contract.json`](../scripts/root-package-surface.contract.json) and is enforced
against both the packaged JavaScript surface and the packaged declaration surface.

## Bundled internal workspace packages

The root product depends on and bundles the following private runtime packages as implementation
details of the shipped artifact:

```text
@oscharko-dev/keiko-cli
@oscharko-dev/keiko-connectors
@oscharko-dev/keiko-contracts
@oscharko-dev/keiko-evaluations
@oscharko-dev/keiko-evidence
@oscharko-dev/keiko-git
@oscharko-dev/keiko-harness
@oscharko-dev/keiko-local-knowledge
@oscharko-dev/keiko-memory-capture
@oscharko-dev/keiko-memory-consolidation
@oscharko-dev/keiko-memory-governance
@oscharko-dev/keiko-memory-retrieval
@oscharko-dev/keiko-memory-vault
@oscharko-dev/keiko-model-gateway
@oscharko-dev/keiko-quality-intelligence
@oscharko-dev/keiko-sandbox
@oscharko-dev/keiko-sdk
@oscharko-dev/keiko-security
@oscharko-dev/keiko-server
@oscharko-dev/keiko-tool-catalog
@oscharko-dev/keiko-tools
@oscharko-dev/keiko-verification
@oscharko-dev/keiko-workflows
@oscharko-dev/keiko-workspace
```

These package names document the composition of the shipped product for architecture and verification
purposes only. They are not an approved customer install-time API surface, and consumers should not
treat their package names or package-local `exports` maps as a supported contract. The supported
external contract remains the root `@oscharko-dev/keiko` surface, the `keiko` CLI, and the bundled
UI runtime assets listed above.

`@oscharko-dev/keiko-ui` is intentionally not bundled as a runtime package. The shipped runtime
artifact is the static export under `dist/ui/static/`.

## Programmatic SDK

`@oscharko-dev/keiko-sdk` owns the programmatic SDK implementation surface inside the monorepo. The
root product barrel may compose SDK-facing exports, but the approved external contract is still the
root `@oscharko-dev/keiko` import surface. The compatibility alias `SDK_VERSION` is defined by
`@oscharko-dev/keiko-sdk` and consumed internally by the CLI and server from that package directly.

## Version ownership

The single authoritative product version constant is `KEIKO_PRODUCT_VERSION` in
`@oscharko-dev/keiko-contracts`. `@oscharko-dev/keiko-sdk` re-exports that value as `SDK_VERSION`
for compatibility. The root `package.json` `"version"` field is kept in lockstep with
`KEIKO_PRODUCT_VERSION`.

## Stability notes

- Removing a root-barrel export or renaming a CLI flag is a breaking change.
- 1.0.0 (2026-09-12): the first stable major. The customer-facing surface is unchanged from
  0.3.17 — no root-barrel export, CLI flag, or package entry point was added, removed, or
  renamed by the bump itself. What changes is the promise around that surface: `1.x` is now the
  supported line (see SECURITY.md), so a breaking change to it requires a new major release.
- 1.0.1 (2026-09-14): the first published 1.x release, with the 1.0.0 surface unchanged. The
  v1.0.0 GitHub release could not receive its downloads under immutable releases, and its tag
  name can never carry another release, so 1.0.0 was never published.
- 1.0.2 through 1.0.5 (2026-09-15 through 2026-09-18): release automation, Coding Workbench
  reliability, update/install hardening and build-tool maintenance changed without adding, removing
  or renaming a root export, CLI flag or package entry point. The approved external surface remains
  the 1.0.1 surface described above.
- 1.1.0 (2026-09-20): Activity Log Wave 1 (machine-reconstruction contract, segments,
  readiness, loss, proofs, incidents, quality gate and queries), Workbench migration to
  OpenCode 2 with per-conversation task history, turn-based Digital Twin voice, one-button
  release automation, and various chat/workbench UX polish changed without adding, removing or
  renaming a root export, CLI top-level command, or package entry point. The approved external
  surface remains the 1.0.1 surface described above.
- 1.1.1 (2026-09-21): the customer patch for self-hosted LiteLLM gateways — the Coding Workbench
  admits every chat model with a fresh tool-calling proof, proves an undeclared context window
  and renews an expired tool-calling proof by itself, and Knowledge Pod indexing shortens an
  embedding input the endpoint rejects for its size — changed without adding, removing or
  renaming a root export, CLI top-level command, or package entry point. The approved external
  surface remains the 1.0.1 surface described above.
- 1.1.5 (2026-09-22, #3565): the Coding Workbench starts runs in repositories whose origin is not
  on github.com (a foreign-origin repository identity inside the server) — changed without adding,
  removing or renaming a root export, CLI top-level command, or package entry point. The approved
  external surface remains the 1.0.1 surface described above.
- 1.1.4 (2026-09-22, #3565): the Coding Workbench runtime failure-code union gains
  `model-unavailable` and `workspace-unqualified` (`CodingWorkbenchRuntimeFailureCode`,
  `CODING_WORKBENCH_RUNTIME_FAILURE_CODES` in `@oscharko-dev/keiko-contracts`), the codes a refused
  run start answers with instead of the generic `authority-resolution-failed`. Additive: no root
  export, CLI top-level command, or package entry point changes. The approved external surface
  remains the 1.0.1 surface described above.
- 1.1.3 (2026-09-22, #3565): the npm tarball is back in the 1.1.1 shape. 1.1.2 embedded the
  external runtime dependency closure (20 third-party packages) to repair `npm install -g`, which
  doubled the artefact, and a repository firewall in front of a customer's registry could not
  evaluate it. The publisher and the install smoke now stage the vendored workspaces only and
  declare third-party runtime dependencies — changed without adding, removing or renaming a root
  export, CLI top-level command, or package entry point. The approved external surface remains the
  1.0.1 surface described above.
- 1.1.2 (2026-09-21, PR #3577): the Coding Workbench runs on an npm installation through the
  digest-verified runtime packages, optional dependencies of the main package,
  `@oscharko-dev/keiko-coding-runtime-darwin-arm64` and `@oscharko-dev/keiko-coding-runtime-darwin-x64`,
  and binds repositories whose base branch uses parentheses or `+ @ = ,` — changed without adding,
  removing or renaming a root export, CLI top-level command, or package entry point of
  `@oscharko-dev/keiko`. The runtime packages export nothing; Keiko locates them by name and
  verifies their content. The approved external surface remains the 1.0.1 surface described above.
- 0.3.17 (2026-09-10, PR #3452): the root barrel gains `boundWorkspaceFs` from
  `@oscharko-dev/keiko-workspace` — the filesystem port a consumer should resolve paths through for a
  `WorkspaceInfo` (the owned-root port the managed-worktree prover bound to it, else the caller's
  fallback). Additive: it lets every spawn boundary that only holds a `WorkspaceInfo` act under a
  Keiko-managed root's own authority instead of re-admitting it under the user-workspace rules;
  minting that authority stays on the pinned internal subpath and is not part of the root surface.
- The published 0.2.15 realtime voice/default/tool symbols remain compatibility-only exports. The
  productive Twin pipeline requires explicit deployment aliases and never consumes those defaults,
  provider-native tools, voices, or assistant-response configuration.
- Internal workspace packages are private implementation details; adding, removing, renaming, or
  ceasing to expose a package-local export is not by itself a supported customer contract change
  unless the root product surface changes.
- The static UI export's internal filenames, hashes, and chunk layout are not part of the public contract.

## Verification

`npm run check:package-surface:assembled`, `npm run check:version-consistency`, and
`npm run smoke:install` enforce the packaged-surface baseline before publish. The assembled surface
command performs the build, CLI-mode preparation, static UI export, and required build-artifact and
host-native pruning before invoking the standalone fail-closed `check:package-surface` checker.
