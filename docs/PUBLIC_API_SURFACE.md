# Public API surface — 0.2.0 baseline

This document summarizes the current customer-visible and bundled package surfaces for
`@oscharko-dev/keiko`. It is current-state only.

## Root product package — `@oscharko-dev/keiko`

| Surface                                    | Resolution                                                           | Contract |
| ------------------------------------------ | -------------------------------------------------------------------- | -------- |
| `import { ... } from "@oscharko-dev/keiko"` | `package.json` `exports["."]` → `dist/index.js` / `dist/index.d.ts` | Stable public root barrel. |
| `npx keiko ...` / installed `keiko` bin     | `package.json` `bin.keiko` → `dist/cli/index.js`                    | Stable CLI entrypoint. |
| Bundled UI static export                    | `dist/ui/static/**` served by `@oscharko-dev/keiko-server`          | Runtime artifact is stable; hashed filenames may change between releases. |

The root manifest exports only `"."`. There are no root subpath exports.

## Bundled workspace packages

The root product depends on and bundles the following internal runtime packages. Within an installed
root product, each package remains resolvable by its own package name and its own `exports` map is
the authoritative surface for that package:

```text
@oscharko-dev/keiko-cli
@oscharko-dev/keiko-contracts
@oscharko-dev/keiko-evaluations
@oscharko-dev/keiko-evidence
@oscharko-dev/keiko-harness
@oscharko-dev/keiko-local-knowledge
@oscharko-dev/keiko-memory-capture
@oscharko-dev/keiko-memory-consolidation
@oscharko-dev/keiko-memory-governance
@oscharko-dev/keiko-memory-retrieval
@oscharko-dev/keiko-memory-vault
@oscharko-dev/keiko-model-gateway
@oscharko-dev/keiko-quality-intelligence
@oscharko-dev/keiko-sdk
@oscharko-dev/keiko-security
@oscharko-dev/keiko-server
@oscharko-dev/keiko-tools
@oscharko-dev/keiko-verification
@oscharko-dev/keiko-workflows
@oscharko-dev/keiko-workspace
```

`@oscharko-dev/keiko-ui` is intentionally not bundled as a runtime package. The shipped runtime
artifact is the static export under `dist/ui/static/`.

## Programmatic SDK

`@oscharko-dev/keiko-sdk` owns the programmatic SDK surface. The root product barrel may compose
SDK-facing exports, but the compatibility alias `SDK_VERSION` is defined by
`@oscharko-dev/keiko-sdk` and consumed by the CLI and server from that package directly.

## Version ownership

The single authoritative product version constant is `KEIKO_PRODUCT_VERSION` in
`@oscharko-dev/keiko-contracts`. `@oscharko-dev/keiko-sdk` re-exports that value as `SDK_VERSION`
for compatibility. The root `package.json` `"version"` field is kept in lockstep with
`KEIKO_PRODUCT_VERSION`.

## Stability notes

- Removing a root-barrel export or renaming a CLI flag is a breaking change.
- Internal workspace packages may add exports without changing the root package.
- The static UI export's internal filenames, hashes, and chunk layout are not part of the public contract.

## Verification

`npm run check:package-surface`, `npm run check:version-consistency`, and `npm run smoke:install`
enforce the packaged-surface baseline before publish.
