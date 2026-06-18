# @oscharko-dev/keiko-editor

Internal, unpublished workspace package for the **browser-tier Keiko Editor** surface
(Epic [#1189](https://github.com/oscharko-dev/Keiko/issues/1189), created by Issue
[#1191](https://github.com/oscharko-dev/Keiko/issues/1191)). The governing architecture decision is
[ADR-0042](../../docs/adr/ADR-0042-keiko-editor-package-and-boundaries.md); the full plan lives in
[the editor architecture blueprint](../../docs/planning/keiko-editor-architecture-blueprint.md).

## Scope of this package

The editor package owns **editor UI only**: the Monaco editor/diff lifecycle and rendering, editor
UI contracts, the typed host-integration port surface, completion/diagnostics provider _wiring_, the
editor theme, and editor-local view/keyboard/accessibility state.

It deliberately does **not** own — and must never value-import — repository search, knowledge or
memory retrieval, context assembly, model routing, the Model Gateway, patch application,
verification, evidence persistence, workspace authority, or any Keiko BFF route. Those remain
backend/workflow responsibilities reached only through host-injected ports. The package is reusable
outside `keiko-ui` and must not import `keiko-ui` internals (ADR-0019 browser-tier direction rule 8;
ADR-0042 D1/D2).

### v1 status (Issue #1191)

This release ships only a **minimal typed public API** so the package can be developed, built,
linted, tested, and governance-checked independently of `keiko-ui`:

- `KEIKO_EDITOR_PACKAGE` — the package's stable identity.
- `EditorLanguageId`, `SUPPORTED_EDITOR_LANGUAGES`, `isSupportedEditorLanguage` — the supported
  language contract, aligned with the workspace `WorkspaceLanguage` contract.
- `EditorBuffer`, `EditorHostPort` — the typed host-integration seam the host implements and injects.

**Out of scope for v1** (tracked under the epic): the Monaco runtime implementation and worker
strategy (#1193), UI card integration in `keiko-ui` (#1194/#1196), and server completion/diagnostics
endpoints (#1197/#1198). `keiko-ui` does not yet depend on this package.

## Dependency and license record

All dependencies are pinned and permissively licensed. The package manifest declares
`license: "Apache-2.0"` to match the workspace license gate
(`scripts/check-workspace-supply-chain.mjs`); third-party runtime dependencies are MIT.

| Dependency                      | Version        | License    | Role                                                                                                                                      |
| ------------------------------- | -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `monaco-editor`                 | `0.55.1`       | MIT        | Editor + diff editor + bundled language workers. Runtime wiring lands in #1193 (served same-origin, no CDN).                              |
| `@monaco-editor/react`          | `4.7.0`        | MIT        | React lifecycle wrapper for Monaco. Its default loader fetches Monaco from a CDN unless configured.                                       |
| `@monaco-editor/loader`         | `1.7.0`        | MIT        | Transitive loader used by `@monaco-editor/react`; pinned via a root `overrides` entry.                                                    |
| `@oscharko-dev/keiko-contracts` | workspace      | Apache-2.0 | Shared contracts. Imported **type-only** (`WorkspaceLanguage`, `FileContent`); no value import.                                           |
| `react`, `react-dom`            | `^18.3.1` peer | MIT        | Provided by the host (`keiko-ui` ships React 18.3.1). Declared as **peer** dependencies so React is never bundled as a duplicate runtime. |

Notes:

- **No CDN.** Monaco assets are served same-origin from the locally installed `monaco-editor`
  package. When the runtime lands (#1193), the host must call `loader.config({ monaco })` against the
  local package before first mount so `@monaco-editor/react`'s default CDN loader is never used.
- **Loader pin.** `@monaco-editor/loader` is pinned through a root `overrides` entry; `npm ci`
  enforces SHA-512 lockfile integrity for every Monaco artifact, and the resolved `monaco-editor`
  version is `0.55.1`.
- **Maintenance / bus-factor.** `@monaco-editor/react` and `@monaco-editor/loader` are
  community-maintained packages with a small maintainer base. The pinned versions, the lockfile
  integrity hashes, the SBOM + license gate (`npm run check:workspace-supply-chain`), and the
  no-CDN policy are the controls that bound this supply-chain exposure (blueprint §12, risk R1).
- **Known advisory (accepted).** `monaco-editor@0.55.1` pulls a transitive `dompurify@3.2.7` that
  carries **moderate** XSS advisories. This is below the `npm audit --audit-level=high` CI gate and
  is not reachable in v1 (no Monaco/`dompurify` runtime is loaded yet). `npm audit fix --force`
  would downgrade Monaco to `0.53.0`, breaking the ADR-0042-mandated `0.55.1` pin, so it is not
  taken. Revisit when the Monaco runtime lands (#1193) and a patched `dompurify`/Monaco ships.
- `monaco-editor` and `@monaco-editor/react` are declared and pinned now (per #1191 scope) but are
  not yet imported; the runtime that consumes them is added in #1193.

## Governance

- Browser-tier dependency direction is enforced by the `adr-0042-editor-not-node-domain-values` rule
  in `.dependency-cruiser.cjs`, proven live by a negative fixture under
  `tests/architecture/fixtures/editor-browser/` (`npm run arch:check:negative`).
- The workspace dependency allowlist (`scripts/check-package-graph.mjs`), the package-build solution
  (`tsconfig.packages.json`), the package-surface bundle policy
  (`scripts/check-package-surface.mjs`), and the coverage ratchet
  (`docs/qa/package-coverage-baseline.json`) all recognise this package.

## Scripts

- `npm --workspace @oscharko-dev/keiko-editor run build` — emit `dist/`.
- `npm --workspace @oscharko-dev/keiko-editor run typecheck` — `tsc -b`.
- `npm --workspace @oscharko-dev/keiko-editor test` — Vitest.
