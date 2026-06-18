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

### Current status (#1191-#1196)

The package now ships the browser-tier editor surface and is mounted by `keiko-ui` in the Workspace
card/window model (#1196). The public surface includes:

- `KEIKO_EDITOR_PACKAGE` — the package's stable identity.
- `EditorLanguageId`, `SUPPORTED_EDITOR_LANGUAGES`, `isSupportedEditorLanguage` — the supported
  language contract, aligned with the workspace `WorkspaceLanguage` contract.
- `EditorBuffer`, `EditorHostPort` — the typed host-integration seam the host implements and injects.
- `KeikoCodeEditor` — the controlled Monaco-backed editor component used by the Workspace editor
  card.
- `KeikoDiffEditor`, `buildPatchPreview` — the generated-change review surface and its pure render
  model adapter.

**Still out of scope** (tracked under the epic): server completion/diagnostics/test-generation
endpoints and any model-producing editor feature (#1197/#1198 and follow-ups). `keiko-ui` depends on
this package only for browser-tier editor rendering and host-injected intent callbacks; workspace
authority, file I/O, model access, patch application, evidence, and verification remain outside this
package.

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

**Host wiring recipe** (executed by the client-only mount in #1196, before the first editor render):

```ts
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import {
  configureMonacoLoader,
  createMonacoEnvironment,
  defaultMonacoWorkerFactories,
  installMonacoEnvironment,
  registerKeikoEditorTheme,
  resolveEditorThemeTokensFromDom,
} from "@oscharko-dev/keiko-editor";

installMonacoEnvironment(self, createMonacoEnvironment(defaultMonacoWorkerFactories));
configureMonacoLoader(loader, monaco);
monaco.typescript.typescriptDefaults.setModeConfiguration({
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
});
monaco.typescript.javascriptDefaults.setModeConfiguration({
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: false,
  signatureHelp: false,
  onTypeFormattingEdits: false,
  codeActions: false,
  inlayHints: false,
});
// One-shot resolve: reads the --ed-* tokens from the DOM and cleans up its probe. Re-call on theme
// or contrast switch. (For an advanced/long-lived path, use createDomEditorTokenResolverDeps +
// resolveEditorThemeTokens and call deps.dispose() when done.)
const tokens = resolveEditorThemeTokensFromDom(document.documentElement);
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

## Diff editor and patch preview (Issue #1195)

`#1195` adds the review surface for Keiko-generated changes: the `KeikoDiffEditor` React component and
the `buildPatchPreview` model adapter. It is **review-only** — a generated patch is inspected without
mutating workspace files, and apply/reject are host-owned (ADR-0042 D7).

| Concern               | Export                                                                                                                                  | Notes                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch-preview adapter | `buildPatchPreview(input)`, `DEFAULT_PATCH_PREVIEW_LIMITS`                                                                              | Pure, browser-safe. Projects an `EditorPreviewedPatch`/`EditorGeneratedPatch` (#1192 contract) + original buffers into a render-only model.     |
| Diff component        | `KeikoDiffEditor`                                                                                                                       | Thin shell over `@monaco-editor/react`'s `<DiffEditor>`: changed-file list, read-only side-by-side diff, hunk navigation, content-free summary. |
| Model types           | `PatchPreviewModel`, `PatchPreviewFile`, `PatchPreviewFileStatus`, `PatchPreviewSource`, `PatchPreviewLimits`, `BuildPatchPreviewInput` | The render model and its inputs. `DiffActionAvailability` / `KeikoDiffEditorProps` shape the component.                                         |

**Reuse boundary (Engineering Notes).** The editor does **not** introduce a parallel patch parser.
Unified-diff parsing/validation/application lives in `keiko-tools` (`parseUnifiedDiff`,
`computeFileContent`, `validatePatch`, `applyPatch`) — a Node-domain package the browser tier must not
value-import (ADR-0042 D2). Those run server-side and are reached only through host ports
(`previewPatch`/`applyPatchReview`). The editor consumes the already-structured `{range, newText}`
edit contract from `#1192` and applies it to the original text **in memory** for display via a small
pure helper (`applyTextEditsToText`); it parses nothing and writes nothing.

**Acceptance criteria mapping.** A generated patch is reviewed without mutating files because both
diff sides are read-only and no write API is called (AC1); the file list plus Monaco's built-in
`goToDiff` provide changed-file and hunk navigation (AC2); apply/reject/open/verify are emitted as
intent through host callbacks with host-computed availability (AC3); the accessible change summary
reports counts, file paths, and status words only — never diff content (AC4); and large patches are
bounded by per-file, total-byte, and file-count limits that report omissions and truncation
explicitly (AC5). Binary and unsupported files are surfaced with a content-free note instead of a
diff.

**Theming.** The diff editor uses the registered Keiko Monaco theme, whose inserted/removed
line/text colours come from the `#1212` `--ed-diff-*` tokens. The file-list status indicators use the
`--ed-diff-*-gutter` tokens directly (the diff gutter is a decoration, not a Monaco theme key — see
`monaco/theme.ts`), each with a `currentColor` fallback.

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
- **Known advisory — resolved for the host mount via a patched override (#1196); runtime sink stays
  closed.** `monaco-editor@0.55.1` declares `dompurify@3.2.7` as an npm dependency, which carries a set
  of **moderate** DOMPurify advisories (`npm audit` reports several distinct XSS / mutation-XSS /
  prototype-pollution items affecting `<= 3.4.10`), all rated moderate (0 high/critical). #1193 deferred
  any change before the host runtime path existed because the only `npm audit fix` was a semver-major
  downgrade. #1196 mounts the editor in `keiko-ui`, so the chain
  `keiko-ui → keiko-editor → monaco-editor → dompurify` now enters keiko-ui's audit closure and the
  `ui` CI job's `npm audit --audit-level=moderate --workspace @oscharko-dev/keiko-ui` gate fails. The
  resolution is a root `overrides: { dompurify: "3.4.11" }` entry:
  - **Patched version, not a silencing pin.** `3.4.11` is the fixed DOMPurify line (the advisories
    affect `<= 3.4.10`), so the override removes the vulnerable package from the installed npm tree
    rather than masking the warning. `monaco-editor` stays pinned at the ADR-0042-mandated `0.55.1`;
    `npm audit`'s own `fixAvailable` (a `0.53.0` downgrade) is still **not** taken.
  - **Runtime sink independently closed.** Monaco still bundles a **vendored** DOMPurify copy
    (`esm/vs/base/browser/dompurify/dompurify.js`) that the override does not replace; that copy is
    reached only through Markdown-rendering surfaces (hover tooltips, suggest-widget docs, parameter
    hints, other `IMarkdownString` sinks). The mounted editor disables every one of those surfaces in
    `buildEditorOptions` (`hover`, `suggest`, `parameterHints`, `inlineSuggest`, `codeLens`,
    `lightbulb`, `inlayHints`, and `links` are all off, and #1196 wires no completion/diagnostics
    provider). The #1196 host bootstrap also disables Monaco's built-in TypeScript/JavaScript
    `modeConfiguration` providers for completion, hover, diagnostics, formatting, symbols, code
    actions, rename, references, and inlay hints, so Monaco cannot re-enable productive local
    language-service flows behind the host's back. Runtime exposure is therefore nil — the same
    closed-sink basis #1193 relied on, now enforced by construction options and runtime defaults.
  - **Eventual fix unchanged.** The durable remediation is still upgrading `monaco-editor` to a release
    that vendors DOMPurify `>= 3.3.2`; as of #1196 no such release exists (the latest `0.56.0-dev`
    builds still vendor and pin `3.2.7`), so the patched override is the interim control. Revisit when a
    hover / completion-with-docs / parameter-hint / Markdown surface is wired (#1199/#1200) or a newer
    Monaco ships.
- `monaco-editor` and `@monaco-editor/react` are consumed by the #1193 runtime helpers and mounted by
  `keiko-ui` through the #1196 client-only Workspace editor surface.

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
