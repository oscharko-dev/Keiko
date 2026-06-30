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

### Current status (#1191-#1207)

The package ships the browser-tier editor surface and is mounted by `keiko-ui` in the Workspace
card/window model (#1196). The public surface includes:

- `KEIKO_EDITOR_PACKAGE` — the package's stable identity.
- `EditorLanguageId`, `SUPPORTED_EDITOR_LANGUAGES`, `isSupportedEditorLanguage` — the supported
  language contract, aligned with the workspace `WorkspaceLanguage` contract.
- `EditorBuffer`, `EditorHostPort` — the typed host-integration seam the host implements and injects.
- `KeikoCodeEditor` — the controlled Monaco-backed editor component used by the Workspace editor
  card.
- `KeikoDiffEditor`, `buildPatchPreview` — the generated-change review surface and its pure render
  model adapter.
- Monaco provider bridges to the governed server language service: completion (#1199), inline
  completion (#1200), and — added by #1201 — diagnostics markers (`registerKeikoDiagnostics`), hover
  / quick info (`registerKeikoHoverProvider`), document symbols / outline
  (`registerKeikoDocumentSymbolProvider`), and explicit, cancellable document formatting
  (`registerKeikoFormattingProvider`). Every bridge is pure wiring: it maps a Monaco call to a host
  request, hands the host resolver the live buffer, and renders host-resolved results with content-free
  provenance.
  The editor computes nothing and calls no model (ADR-0042 D4/D5).
- `deriveLargeFileMode` and the `LARGE_FILE_DEGRADED_BYTES` / `LARGE_FILE_DEGRADED_LINES` thresholds —
  the pure large-file degraded-mode policy (#1207) a host can reuse to keep its own large-file
  affordances consistent with the editor's Monaco-option degradation.
- The pure, browser-safe test-generation controllers (`buildTestGenerationContext`,
  `buildTestGenerationRequest`, the flow reducer, and the diff-review projection) for the host's
  governed "Generate Tests" action. The action's server endpoint ships **switched off** (see
  [Governed test generation](#governed-test-generation-wave-2-switched-off)).

**Still out of scope** (tracked under the epic): editor-driven test execution/verification and any
model-producing editor feature behind the wave-2 egress gate (ADR-0042 D7). `keiko-ui` depends on this
package only for browser-tier editor rendering and host-injected intent callbacks; workspace
authority, file I/O, model access, the language-service computation itself, patch application,
evidence, and verification remain outside this package.

### Documentation map

This README is the package-level entry point and standalone integration reference. Deeper,
deployment-facing material lives in the editor documentation set:

- [Keiko Editor architecture and operations runbook](../../docs/keiko-editor/runbook.md) — the
  consolidated guide for maintainers, host integrators, reviewers, and regulated deployment teams:
  architecture, the `keiko-ui` host-integration guide, the completion architecture, the
  test-generation flow, and security/privacy notes.
- [Keiko Editor troubleshooting](../../docs/keiko-editor/troubleshooting.md) — Monaco workers, CSP,
  unsupported files, completion failures, and verification failures.
- [Keiko Editor release note (draft)](../../docs/release/keiko-editor-0.2.0-release-note.md) — the
  user-facing summary of the delivered editor, grounded in implemented behaviour.
- Feature deep-dives: [deterministic language service](../../docs/editor-language-service.md),
  [inline completion](../../docs/editor-inline-completion.md),
  [completion model capability and degradation](../../docs/editor-completion-model-capability.md),
  and [VS Code-feeling UX](../../docs/editor-vscode-ux.md).

## Embedding the editor without `keiko-ui`

`@oscharko-dev/keiko-editor` is reusable outside `keiko-ui` (ADR-0042 D1): it owns editor rendering
only and reaches every governed capability through host-injected callbacks, so any React 18 host can
embed it. A standalone host performs three steps — install the local Monaco runtime once, implement
the host port, and render the controlled `KeikoCodeEditor`.

The package declares `react` and `react-dom` (`^18.3.1`) as **peer** dependencies and pins
`monaco-editor` (`0.55.1`) and `@monaco-editor/react` (`4.7.0`); the host installs all four. Monaco is
a browser-only module that imports CSS, so the editor surface must be loaded behind a client-only
boundary (for example `next/dynamic(..., { ssr: false })` or an equivalent lazy import) — never during
a server render. There is no CDN fallback by design (ADR-0042 D3).

**1. Install the local, no-CDN Monaco runtime once, before the first mount.** This points
`@monaco-editor/react`'s loader at the locally installed package, installs the same-origin ESM worker
factories, registers the Keiko theme from the live design tokens, and disables Monaco's built-in
TypeScript/JavaScript language services so the governed server language service is the single source
of truth (ADR-0042 D4).

```ts
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import {
  configureMonacoLoader,
  createMonacoEnvironment,
  defaultMonacoWorkerFactories,
  detectEditorRuntimeSupport,
  installMonacoEnvironment,
  probeEditorRuntime,
  registerKeikoEditorTheme,
  resolveEditorThemeTokensFromDom,
  type MonacoGlobalScope,
} from "@oscharko-dev/keiko-editor";

export function installKeikoMonacoRuntime(): boolean {
  const status = detectEditorRuntimeSupport(probeEditorRuntime(self));
  if (!status.supported) {
    return false; // No Web Worker / URL support: render the editor's controlled load-error state.
  }
  installMonacoEnvironment(
    self as unknown as MonacoGlobalScope,
    createMonacoEnvironment(defaultMonacoWorkerFactories),
  );
  configureMonacoLoader(loader, monaco);
  // Disable Monaco's in-browser TS/JS worker for governed features (completion, hover, diagnostics,
  // symbols, formatting); it stays only for local tokenisation/bracket matching.
  const off = {
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
  } satisfies monaco.typescript.ModeConfiguration;
  monaco.typescript.typescriptDefaults.setModeConfiguration(off);
  monaco.typescript.javascriptDefaults.setModeConfiguration(off);
  // Re-call resolveEditorThemeTokensFromDom + registerKeikoEditorTheme on theme/contrast switch.
  registerKeikoEditorTheme(
    monaco.editor,
    "dark",
    resolveEditorThemeTokensFromDom(document.documentElement),
  );
  return true;
}
```

**2. Implement the host port.** The editor never reads files, calls a model, or performs retrieval;
it asks the host. A minimal host provides `loadBuffer` and `saveDocument`; richer hosts add the
governed completion / inline-completion / diagnostics / hover / symbols / formatting resolvers, each
of which the host backs with its own server call. Every resolver is optional — the editor registers a
Monaco provider only for the resolvers the host supplies, so a read-only viewer can pass none. The
complete optional [`EditorHostPort`](src/host-port.ts) surface is `saveDocument`, `provideCompletions`,
`provideInlineCompletions`, `provideDiagnostics`, `provideContext`, `generateTests`,
`provideFormatting`, `previewPatch`, and `applyPatchReview`.

```ts
import type { EditorHostPort } from "@oscharko-dev/keiko-editor";

const hostPort: EditorHostPort = {
  loadBuffer: async (uri) => ({
    language: "typescript",
    content: await myWorkspace.readFile(uri), // FileContent contract, already redacted at the IO boundary
    readOnly: false,
  }),
  saveDocument: async (request) => myWorkspace.write(request),
  // Optional governed capabilities — omit any the host does not back:
  provideCompletions: (request, signal) => myServer.editorCompletion(request, signal),
  provideDiagnostics: (document, signal) => myServer.editorDiagnostics(document, signal),
};
```

**3. Render the controlled `KeikoCodeEditor`.** The component is fully controlled: the host owns the
buffer, the dirty/version bookkeeping (`fileModel`), the Monaco load state, and the save lifecycle.
The component emits intent (`onContentChange`, `onSaveRequested`, `onSelectionChange`,
`onCursorChange`) and renders host-computed state; it mutates nothing itself. The `provide*` props are
the resolvers from the host port. While `loadState.status` is not `"ready"` the editor is read-only.

```tsx
import { useState } from "react";
import { KeikoCodeEditor, createFileModel, type EditorBuffer } from "@oscharko-dev/keiko-editor";

function StandaloneEditor({ buffer }: { buffer: EditorBuffer }): JSX.Element {
  const [text, setText] = useState(buffer.content.text);
  return (
    <KeikoCodeEditor
      buffer={{ ...buffer, content: { ...buffer.content, text } }}
      fileModel={createFileModel({ uri: "file://example.ts", language: "typescript", version: 1 })}
      loadState={{ status: "ready" }}
      saveStatus="idle"
      ariaLabel="Example editor"
      onContentChange={(next) => setText(next.text)}
      onSaveRequested={(request) => hostPort.saveDocument?.(request)}
      provideCompletions={hostPort.provideCompletions}
      provideDiagnostics={hostPort.provideDiagnostics}
    />
  );
}
```

To review a generated change instead of editing, render `KeikoDiffEditor` over a `PatchPreviewModel`
built by `buildPatchPreview({ patch, originals })` (a pure, in-memory projection — it parses no
unified diff and writes nothing; apply/reject are host-owned intents). See
[Diff editor and patch preview](#diff-editor-and-patch-preview-issue-1195).

## Completion and model boundaries

The editor computes no completions and calls no model. It registers Monaco providers that bridge to
host resolvers; the host calls governed `keiko-server` BFF routes, which are the only place a model is
reached (always through the Model Gateway, never the browser). The boundaries are precise and
deterministic-first:

| Surface                             | Route (`keiko-server`)                                                  | Model boundary                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diagnostics, hover, symbols, format | `POST /api/editor/language`                                             | **Deterministic, model-free** TypeScript/JavaScript language service (#1198, ADR-0042 D4). Identical input → identical output. No Gateway, no network.                                                                                                                                              |
| Completion                          | `POST /api/editor/completion`                                           | **Two-tier** (#1199): Tier 1 deterministic language-service completion (always available); Tier 2 model-assisted via the Model Gateway, run only when the completion-model selection (#1210) elects an aligned, in-budget infilling model. Degrades to Tier 1 — never a silent ungoverned fallback. |
| Inline completion (ghost text)      | `POST /api/editor/inline-completion`                                    | **Model-only and gated** (#1200): runs only when a fast, aligned, suffix-aware (FIM) model is elected in budget and policy/rate limits allow; otherwise returns zero items and the editor falls back to the deterministic completion gateway.                                                       |
| Coding context                      | `POST /api/editor/context`, `/repo-search`, `/local-knowledge/retrieve` | **Query-only retrieval** (#1211) reusing existing workspace search, Local Knowledge, and memory. Returns content-free citations; excerpt text never leaves the process.                                                                                                                             |

Governing rules that the documentation and the code both hold to:

- **Aligned models only.** Model-assisted completion uses aligned (`instruct` / `edit-tuned`) models,
  never raw base-model FIM (prompt-injection risk; ADR-0042 D5).
- **Cost ceilings are server-owned.** A per-root request **rate limiter**
  (`inlineCompletionRateLimiter`: cooldown + sliding-window cap) and a per-root **token budget**
  (`editorModelTokenBudget`: a sliding-window prompt+completion token ceiling, OWASP LLM10:2025) bound
  how often and how much the model tier may run. On exceed, the route skips the model tier and degrades
  to deterministic completion; it never queues or blocks typing.
- **Content-free provenance and evidence.** The browser receives the opened buffer by design and sends
  live editor text plus request context to same-origin BFF routes through host resolvers. The
  content-free guarantee applies to derived metadata: prompts, retrieved excerpts, workspace roots,
  secrets, telemetry, and evidence do not expose those raw payloads back to the browser or persisted
  artifacts. Completion/inline/context responses expose reviewable insert text plus source labels,
  hashes, byte counts, ids, and omission reasons (ADR-0042 D6; #1206).

## Governed test generation (wave 2, switched off)

The editor exposes a "Generate Tests" action and ships the pure, browser-safe controllers for it
(target/mode selection, the run-flow reducer, and the diff-review projection that reuses
`buildPatchPreview` with apply disabled). The server endpoint `POST /api/editor/test-generation`
(#1202) is **shipped switched off** behind two independent, default-off gates (ADR-0042 D7), because
executing model-generated tests is untrusted-code execution and Keiko does not yet OS-enforce
network egress:

| Gate                                                 | Default | Behaviour when off                                                                                                          |
| ---------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `KEIKO_EDITOR_TEST_GENERATION` (feature)             | off     | `disabled`: no request parsing, no retrieval, no model, no execution. This is the v1 behaviour.                             |
| `KEIKO_EDITOR_TEST_GENERATION_EXECUTION` (candidate) | off     | `deferred`: governed discovery (#1211) runs for provenance, but **no model call** is made and **no candidate** is produced. |

No v1 flow executes model-generated code. A candidate this route could ever surface (only once both
gates are enabled on a deployment with an enforced egress boundary) is `unverified`; the assured
pre-filter that would execute and elevate it stays `not-run`. See the runbook's
[test-generation flow](../../docs/keiko-editor/runbook.md#governed-test-generation-flow).

## Verification and operational limitations

Deterministic, offline commands a maintainer or regulated operator can run to verify this package and
its boundaries (no model credentials required):

```bash
# Package build, typecheck, and unit/component tests (jsdom).
npm --workspace @oscharko-dev/keiko-editor run build
npm --workspace @oscharko-dev/keiko-editor run typecheck
npm --workspace @oscharko-dev/keiko-editor test

# Editor bundle-size budget: own-code gzip ceiling, the Monaco 0.55.1 pin, and first-load isolation
# (Monaco/editor value-imported only behind a client-only dynamic boundary). Add --require-static-export
# after `npm run build:ui` to also scan the static export's first-load JavaScript.
npm run check:editor-bundle-size

# Browser-tier dependency-direction boundary (the editor must not value-import Node-domain packages)
# and its negative fixture.
npm run arch:check
npm run arch:check:negative

# Supply chain: no high/critical advisories; the keiko-ui audit closure that includes Monaco is
# moderate-clean; SBOM + license gate.
npm audit --audit-level=high
npm run check:workspace-supply-chain

# Documentation: relative links and anchors in the editor doc set resolve.
npm run check:editor-doc-links
```

Operational limitations to plan around:

- **Governed language intelligence is TypeScript/JavaScript only.** Other languages get Monaco syntax
  highlighting/editing only; completion, inline completion, diagnostics, hover, symbols, and formatting
  are absent until their provider lands (#1213).
- **AI completion needs a capable model.** Inline ghost text requires a fast, aligned, suffix-aware
  (FIM) model; absent one, the editor uses manual-invoke and deterministic completion only
  (ADR-0042 D5). There is no silent ungoverned fallback.
- **Large-file degraded mode.** Files **> 500 KB or > 10,000 lines** open in read-only/degraded mode
  (expensive Monaco features off, `largeFileOptimizations` on); files **> 1,000,000 bytes** are
  rejected server-side and never instantiate Monaco (ADR-0042 D3.6, `deriveLargeFileMode`).
- **No editor-driven test execution in v1.** See
  [Governed test generation](#governed-test-generation-wave-2-switched-off).
- **No CDN, no direct browser provider egress.** Monaco core and workers are served same-origin; the
  editor issues no direct browser network calls to model/retrieval/analytics endpoints, and the server
  CSP is not widened for Monaco (ADR-0042 D3.4).

## Monaco runtime and worker strategy (Issue #1193)

`#1193` adds the local, no-CDN Monaco runtime as a set of standalone, individually testable helpers.
It does **not** mount the editor into a Workspace card — that is host integration (#1194/#1196). The
helpers are framework-free and node-testable; the only browser/bundler-only edge is the worker
constructor module (`src/monaco/worker-entries.ts`).

| Concern                       | Helper                                                                                                                                                                         | Notes                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| No-CDN loader                 | `configureMonacoLoader(loader, monaco)`                                                                                                                                        | Calls `loader.config({ monaco })` so `@monaco-editor/react`'s default jsDelivr loader is never used.               |
| Worker registration           | `createMonacoEnvironment(factories)`, `installMonacoEnvironment(self, env)`, `defaultMonacoWorkerFactories`                                                                    | Governed v1 factory emits only the same-origin ESM editor worker; #1213 owns any future language-worker expansion. |
| Language inference            | `inferMonacoLanguageId(path)`, `MONACO_LANGUAGE_IDS`, `isMonacoLanguageId`                                                                                                     | Extension → Monaco language id for local tokenisation; plaintext fallback. Distinct from `EditorLanguageId`.       |
| Theme registration            | `registerKeikoEditorTheme(monaco.editor, variant, tokens)`, `buildKeikoEditorMonacoTheme`, `resolveEditorThemeTokens`, `createDomEditorTokenResolverDeps`, `EDITOR_THEME_NAME` | Maps the #1212 `--ed-*` design tokens to Monaco `rules`/`colors`; dark/light/high-contrast; no colour literals.    |
| Capability detection / errors | `detectEditorRuntimeSupport(probe)`, `probeEditorRuntime(self)`, `describeEditorRuntimeError`, `editorRuntimeLoadFailure`                                                      | Controlled, actionable error states for unsupported workers / failed load; never a silent CDN fallback.            |

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
// Do not import the `monaco-editor` package root: it pulls the rich language-service contributions
// and their worker chunks. Keiko's governed TS/JS intelligence comes from host/server providers.
// One-shot resolve: reads the --ed-* tokens from the DOM and cleans up its probe. Re-call on theme
// or contrast switch. (For an advanced/long-lived path, use createDomEditorTokenResolverDeps +
// resolveEditorThemeTokens and call deps.dispose() when done.)
const tokens = resolveEditorThemeTokensFromDom(document.documentElement);
registerKeikoEditorTheme(monaco.editor, "dark", tokens);
```

**Worker setup, verified in build.** Monaco's worker module inventory
(`editor`, `typescript`, `json`, `css`, `html`) resolves from the locally installed `monaco-editor`
package (`monaco-editor/esm/vs/…/*.worker.js`), and the default governed v1 factory contains exactly
one static `new Worker(new URL(...))` entry point: `editor.worker.js`. TypeScript/JavaScript
intelligence is supplied by Keiko's server-governed provider, JSON/CSS/HTML deterministic
intelligence is deferred, and #1213 owns any future multi-language worker expansion. Tests assert the
inventory resolution, the editor-only shipped default, and the no-CDN invariant; browser release
evidence confirms worker requests stay same-origin.

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
    hints, the inline-suggest toolbar, other `IMarkdownString` sinks). The mounted editor keeps
    `suggest` docs, `parameterHints`, `codeLens`, `lightbulb`, `inlayHints`, and `links` off in
    `buildEditorOptions`. **Inline suggest** (`inlineSuggest.enabled`) is enabled only when a governed
    inline-completion provider is wired (#1200); even then it keeps `showToolbar: "never"` and
    `syntaxHighlightingEnabled: false`, and ghost text renders as plain text, so no Markdown sink is
    reached. **Hover** (`hover.enabled`) is enabled only when a governed hover provider is wired
    (#1201); the hover bridge (`hover-bridge.ts`) renders the server's plain-text quick info inside an
    inert Markdown code fence sized longer than any backtick run in the content (`toInertCodeFence`),
    so the Markdown renderer HTML-escapes the content and the vendored DOMPurify only ever processes
    inert, escaped text — never active markup a buffer's own type signatures could smuggle in. The
    #1196 host bootstrap also disables Monaco's built-in TypeScript/JavaScript `modeConfiguration`
    providers for completion, hover, diagnostics, formatting, symbols, code actions, rename,
    references, and inlay hints, so Monaco cannot re-enable productive local language-service flows
    behind the host's back; the #1201 providers are governed bridges to the deterministic server
    language service, not Monaco's local worker. Runtime exposure is therefore nil — the closed-sink
    basis #1193 relied on, now enforced for hover by inert rendering and for every other Markdown
    sink by construction options and runtime defaults.
  - **Eventual fix unchanged.** The durable remediation is still upgrading `monaco-editor` to a release
    that vendors DOMPurify `>= 3.3.2`; as of #1201 no such release exists (the latest `0.56.0-dev`
    builds still vendor and pin `3.2.7`), so the patched override plus inert hover rendering are the
    interim controls. Revisit when a suggest-docs / parameter-hint / other Markdown surface is wired or
    a newer Monaco ships.
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
