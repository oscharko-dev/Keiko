# Public API surface — 1.0.0 baseline

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
