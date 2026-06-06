# Public API surface — 0.2.0 forward baseline

Authoritative summary of the surfaces the `@oscharko-dev/keiko` 0.2.0 product baseline commits to. Companion to ADR-0019, ADR-0021, and ADR-0025. Owned by Epic #423 child issue #432.

## Root package — `@oscharko-dev/keiko`

| Surface                                         | Resolution                                                                          | Stability                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `import { … } from "@oscharko-dev/keiko"`       | `package.json` `exports["."]` → `dist/index.js` / `dist/index.d.ts`                 | Stable. Every symbol surfaced through `src/index.ts` is an approved public name.      |
| `npx keiko …` and the installed `keiko` bin     | `package.json` `bin["keiko"]` → `dist/cli/index.js`                                 | Stable. CLI flag set is governed by ADR-0008 / ADR-0009 / ADR-0012 surface contracts. |
| Bundled UI static export at `dist/ui/static/**` | Bundled at build time via `scripts/build-ui.mjs`; the BFF (keiko-server) serves it. | Stable. Internal layout (filenames, hashes) may change between releases.              |

The root manifest exposes one entry in `exports` (`"."`). Subpath exports (`./contracts`, `./harness`, etc.) are intentionally NOT enumerated. Consumers who need narrower access reach the workspace packages directly through their own package names.

## Workspace packages

Every package under `packages/keiko-<name>/` is private (`"private": true`) and is bundled into the root tarball via `bundleDependencies`. Within the same install they remain importable by package name through the workspace symlink:

```
@oscharko-dev/keiko-contracts
@oscharko-dev/keiko-security
@oscharko-dev/keiko-model-gateway
@oscharko-dev/keiko-quality-intelligence
@oscharko-dev/keiko-workspace
@oscharko-dev/keiko-tools
@oscharko-dev/keiko-verification
@oscharko-dev/keiko-evidence
@oscharko-dev/keiko-local-knowledge
@oscharko-dev/keiko-memory-vault
@oscharko-dev/keiko-memory-capture
@oscharko-dev/keiko-memory-consolidation
@oscharko-dev/keiko-memory-governance
@oscharko-dev/keiko-memory-retrieval
@oscharko-dev/keiko-harness
@oscharko-dev/keiko-workflows
@oscharko-dev/keiko-evaluations
@oscharko-dev/keiko-server
@oscharko-dev/keiko-cli
```

The browser-tier package `@oscharko-dev/keiko-ui` is the Next.js source for the static export. It is deliberately NOT in `bundleDependencies` because the packed product carries `dist/ui/static/` as the runtime artifact instead.

Each package's own `exports` map is the authoritative surface for that package. Subpath exports under `./internal/<name>` (e.g. `@oscharko-dev/keiko-workspace/internal/fs`) are intentional port-injection seams per ADR-0019 and are documented as part of each package's role.

## Declaration types

Every workspace package ships `.d.ts` and `.d.ts.map` files alongside its `.js` emit under its own `dist/`. The root package re-uses each workspace package's declarations through the workspace symlink — there is no aggregated `.d.ts` bundle. Consumers therefore see the real package boundaries in their tooling rather than a flattened API surface.

## `peerDependencies`

The root and every workspace package intentionally declare zero `peerDependencies`. Internal packages are bundled and resolved through the workspace symlink; no consumer-side coordination on a shared dependency is required.

## Product version

The single authoritative product version constant lives at `KEIKO_PRODUCT_VERSION` in `@oscharko-dev/keiko-contracts`. The SDK re-exports it as `SDK_VERSION`; the CLI re-exports it as `_sdk-version`; the BFF re-exports it as `_sdk-version`. The root `package.json` `"version"` field is bumped in lockstep with `KEIKO_PRODUCT_VERSION` as part of every release (issue #433).

## API doc artifact

There is no automated `typedoc` / `api-extractor` artifact at the 0.2.0 baseline. The TypeScript declaration files emitted into each package's `dist/` are the API documentation; IDE tooling and `tsc --traceResolution` are the authoritative reference. Adding automated doc generation is out of scope for Epic #423 and is tracked as a separate follow-up if user demand emerges.

## Stability guarantees

- The root package's exports may add new symbols in minor releases without prior notice.
- Removing a symbol from the root `exports` or renaming a CLI flag is a breaking change and requires a major-version bump.
- Internal workspace package surfaces may shift across patch releases when they do not affect the root composition; the root barrel pinning blocks downstream breakage.
- The bundled static UI export's internal filenames and hash bytes are not part of the contract.

## Verification

`scripts/check-package-surface.mjs` runs in the `prepack` and `prepublishOnly` chains and asserts:

- The tarball lists `dist/cli/index.js`, `dist/ui/static/`, `dist/ui/csp-hashes.json`, and `dist/index.{d.ts,js}`.
- The CLI bin is executable.
- No source maps, `.env` files, workspace `packages/keiko-ui/` source, or absolute local paths leak into the tarball.
- The workspace-handoff types from `@oscharko-dev/keiko-contracts` are present in the bundled dependency layout.
- The CSP-hash audit (inline-script SHA-256) covers every emitted `<script>` tag in the bundled static export.

Per ADR-0019 the architecture gate continues to enforce the dependency-direction rules at error severity, which is the structural counterpart to this surface contract.
