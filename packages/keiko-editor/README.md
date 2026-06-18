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

**Out of scope for v1** (tracked under the epic): UI card integration in `keiko-ui` (#1194/#1196)
and server completion/diagnostics endpoints (#1197/#1198). `keiko-ui` does not yet depend on this
package; the editor tokens it consumes are surfaced as CSS only (see below).

## Monaco runtime and worker strategy (Issue #1193)

`#1193` adds the local, no-CDN Monaco runtime as a set of standalone, individually testable helpers.
It does **not** mount the editor into a Workspace card — that is host integration (#1194/#1196). The
helpers are framework-free and node-testable; the only browser/bundler-only edge is the worker
constructor module (`src/monaco/worker-entries.ts`).

| Concern                       | Helper                                                                                                                                                                         | Notes                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| No-CDN loader                 | `configureMonacoLoader(loader, monaco)`                                                                                                                                        | Calls `loader.config({ monaco })` so `@monaco-editor/react`'s default jsDelivr loader is never used.                      |
| Worker registration           | `createMonacoEnvironment(factories)`, `installMonacoEnvironment(self, env)`, `defaultMonacoWorkerFactories`                                                                    | ESM `new Worker(new URL("monaco-editor/esm/…", import.meta.url), { type: "module" })`; same-origin, Turbopack-compatible. |
| Language inference            | `inferMonacoLanguageId(path)`, `MONACO_LANGUAGE_IDS`, `isMonacoLanguageId`                                                                                                     | Extension → Monaco language id for local tokenisation; plaintext fallback. Distinct from `EditorLanguageId`.              |
| Theme registration            | `registerKeikoEditorTheme(monaco.editor, variant, tokens)`, `buildKeikoEditorMonacoTheme`, `resolveEditorThemeTokens`, `createDomEditorTokenResolverDeps`, `EDITOR_THEME_NAME` | Maps the #1212 `--ed-*` design tokens to Monaco `rules`/`colors`; dark/light/high-contrast; no colour literals.           |
| Capability detection / errors | `detectEditorRuntimeSupport(probe)`, `probeEditorRuntime(self)`, `describeEditorRuntimeError`, `editorRuntimeLoadFailure`                                                      | Controlled, actionable error states for unsupported workers / failed load; never a silent CDN fallback.                   |

**Host wiring recipe** (executed by the client-only mount in #1194, before the first editor render):

```ts
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  configureMonacoLoader,
  createMonacoEnvironment,
  defaultMonacoWorkerFactories,
  installMonacoEnvironment,
  registerKeikoEditorTheme,
  resolveEditorThemeTokens,
  createDomEditorTokenResolverDeps,
} from "@oscharko-dev/keiko-editor";

installMonacoEnvironment(self, createMonacoEnvironment(defaultMonacoWorkerFactories));
configureMonacoLoader(loader, monaco);
const tokens = resolveEditorThemeTokens(createDomEditorTokenResolverDeps(document.documentElement));
registerKeikoEditorTheme(monaco.editor, "dark", tokens);
```

**Worker setup, verified in build.** The five worker bundles
(`editor`, `typescript`, `json`, `css`, `html`) resolve from the locally installed `monaco-editor`
package (`monaco-editor/esm/vs/…/*.worker.js`); a test asserts each specifier resolves under
`node_modules/monaco-editor` and that no runtime module references a CDN host. The end-to-end browser
network-intercept smoke (worker URLs are same-origin under `next dev` Turbopack and the static
`output: export` build) runs once the editor is mounted in the host and is delivered with that
integration (#1194/#1206/#1207, per ADR-0042 D3.5), which extends the no-CDN proof to the
worker-backed features.

**Design-token integration.** The `--ed-*` / `--ed-syn-*` editor theme tokens (#1212) are surfaced
into the keiko-ui runtime by lifting them into `packages/keiko-ui/src/app/globals.css` (CSS only,
following the existing token-lift convention; no `@import`, no CSP change, no Monaco mount). The
theme resolver reads those custom properties from the live DOM at registration time.

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
- **Known advisory (accepted, documented non-exploitable).** `monaco-editor@0.55.1` carries a
  **moderate** transitive `dompurify@3.2.7` advisory set — headlined by **CVE-2026-0540** (XSS via
  rawtext elements, CVSS 5.1, affected `>=3.1.3 <=3.3.1`, fixed `3.3.2`). Per #1193's supply-chain
  review:
  - **A dependency override does not fix it.** Monaco does not consume the npm `dompurify` package at
    runtime: it ships a **vendored copy** and imports it relatively
    (`esm/vs/base/browser/domSanitize.js` → `import purify from "./dompurify/dompurify.js"`, banner
    `DOMPurify 3.2.7`); there is no `from "dompurify"` import anywhere in Monaco. An
    `overrides: { dompurify }` entry would bump only the unused hoisted copy and silence `npm audit`
    while the vulnerable vendored code still runs — a false fix. (`npm audit`'s own `fixAvailable`
    points to downgrading Monaco to `0.53.0`, a semver-major change that breaks the
    ADR-0042-mandated `0.55.1` pin, so that is not taken either.) The override is therefore
    deliberately **not** applied.
  - **Not reachable in #1193.** Monaco's only DOMPurify-backed path is its markdown sanitiser
    (`markdownRenderer.js`), imported solely by hover tooltips and suggest-widget documentation.
    `#1193` ships the runtime, worker strategy, themes, and language inference and registers **no**
    hover, completion, parameter-hint, or markdown-rendering provider, so no `IMarkdownString`
    reaches a Monaco widget and the path is unreachable. The advisory is also moderate, below the
    `npm audit --audit-level=high` CI gate.
  - **Revisit trigger.** When a later issue registers a hover / completion-with-docs / markdown
    provider (e.g. #1199/#1200), the path becomes reachable; the real remediation is upgrading
    `monaco-editor` to a release that vendors DOMPurify `>= 3.3.2` (prefer `>= 3.4.9` to also clear
    the later ADD_ATTR / USE_PROFILES advisories).
- `monaco-editor` and `@monaco-editor/react` are consumed by the #1193 runtime helpers; the editor is
  not yet mounted by `keiko-ui` (host integration is #1194/#1196).

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
