# Keiko Editor architecture and operations runbook

Epic [#1189](https://github.com/oscharko-dev/Keiko/issues/1189) · Issue
[#1208](https://github.com/oscharko-dev/Keiko/issues/1208) · Decision record
[ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md) · Plan
[editor architecture blueprint](../planning/keiko-editor-architecture-blueprint.md).

This runbook is the single operational reference for the Keiko Editor for four audiences:

- **Maintainers** extending the editor package or its server routes.
- **Host integrators** embedding `@oscharko-dev/keiko-editor` (inside `keiko-ui` or a standalone host).
- **Reviewers** checking that a change keeps the governed boundaries.
- **Regulated deployment teams** assessing the editor's privacy, egress, and audit posture.

It documents **implemented behaviour only**. Every capability is labelled `shipped`, `gated-off`, or
`deferred`, and the deep feature notes it integrates remain authoritative for their topic:
[deterministic language service](../editor-language-service.md),
[inline completion](../editor-inline-completion.md),
[completion model capability](../editor-completion-model-capability.md),
[VS Code-feeling UX](../editor-vscode-ux.md),
[language-intelligence audit](1201-language-intelligence-audit.md),
[security hardening review](1206-security-hardening-review.md), and
[performance budgets](1207-performance-budgets.md). The package-level API reference and the standalone
embedding recipe live in the [`@oscharko-dev/keiko-editor` README](../../packages/keiko-editor/README.md).

## Architecture at a glance

The editor is split across two trust tiers. The **browser tier** (`@oscharko-dev/keiko-editor`,
mounted by `@oscharko-dev/keiko-ui`) renders Monaco and registers providers. The **server tier**
(`keiko-server` editor module) owns every governed computation. The browser never reaches a model, a
retrieval index, or the filesystem directly; it asks the host, and the host calls a `keiko-server`
BFF route over the loopback origin.

```
 Browser tier (keiko-editor + keiko-ui)        │  Server tier (keiko-server, loopback BFF)
 ──────────────────────────────────────────────┼────────────────────────────────────────────────
 KeikoCodeEditor / KeikoDiffEditor             │  POST /api/editor/language        (deterministic #1198)
   registers Monaco providers (wiring only)    │  POST /api/editor/completion      (two-tier #1199)
        │ provide* resolvers (host-injected)   │  POST /api/editor/inline-completion(model-only #1200)
        ▼                                       │  POST /api/editor/context|repo-search|
 keiko-ui host (lib/editor-*.ts)  ── fetch ──▶  │       local-knowledge/retrieve    (retrieval #1211)
   shapes the content-free wire request        │  POST /api/editor/test-generation (switched off #1202)
                                                │        │
                                                │        ▼ Model Gateway (#1210 FIM) · workspace search ·
                                                │          Local Knowledge · memory · evidence store
```

Governing decisions (ADR-0042): D1 editor owns UI only; D2 browser tier must not value-import
Node-domain packages; D3 no-CDN Monaco runtime and unchanged CSP; D4 server language service is the
single source of truth; D5 all completion is governed and FIM is a Model Gateway extension; D6 coding
context is assembled by existing backend retrieval; D7 patches stay reviewable and code execution is
deferred behind enforced egress; D8 human-in-the-loop merge gates.

## Package surface and boundaries

`@oscharko-dev/keiko-editor` owns Monaco editor/diff lifecycle and rendering, editor UI contracts, the
typed host-integration port, provider **wiring** (never computation), the Keiko Monaco theme bound to
the `--ed-*` design tokens (#1212), and editor-local view/keyboard/accessibility state. It must not own
— and never value-imports — repository search, knowledge/memory retrieval, context assembly, model
routing, the Model Gateway, patch application, verification, evidence persistence, workspace authority,
or any concrete BFF route (ADR-0042 D1/D2). The boundary is enforced by the
`adr-0042-editor-not-node-domain-values` dependency-cruiser rule and a negative fixture
(`npm run arch:check:negative`).

The host implements the `EditorHostPort` seam
([`host-port.ts`](../../packages/keiko-editor/src/host-port.ts)): a required `loadBuffer` plus optional
`saveDocument`, `provideCompletions`, `provideInlineCompletions`, `provideDiagnostics`,
`provideContext`, `generateTests`, `provideFormatting`, `previewPatch`, and `applyPatchReview`. Each
optional port is feature-gated: the editor registers a Monaco provider only for the resolvers the host
supplies, so a read-only viewer can pass none.

## Host integration guide

`keiko-ui` is the reference host. Its integration lives in
`packages/keiko-ui/src/app/components/desktop/widgets/cards/` (`EditorWidget`, `EditorSurface`,
`EditorRuntimeWidget`, `editorMonacoRuntime.ts`) and `packages/keiko-ui/src/lib/editor-*.ts`. A
standalone host follows the same three steps; the
[README embedding recipe](../../packages/keiko-editor/README.md#embedding-the-editor-without-keiko-ui)
has the complete code.

### 1. Install the no-CDN Monaco runtime once

Before the first mount, the host points `@monaco-editor/react`'s loader at the locally installed
`monaco-editor` (`configureMonacoLoader`), installs the same-origin ESM worker factories
(`installMonacoEnvironment(self, createMonacoEnvironment(defaultMonacoWorkerFactories))`), and disables
Monaco's built-in TypeScript/JavaScript language services so the governed server language service is
authoritative (ADR-0042 D4). In `keiko-ui` this is `ensureMonacoRuntime()` in `editorMonacoRuntime.ts`,
called from the client-only `EditorSurface` (`next/dynamic(..., { ssr: false })`). There is no CDN
fallback; when Web Workers or the `URL` API are unavailable the runtime stays unconfigured and the
editor renders its controlled load-error state.

### 2. Implement the host port and back it with BFF routes

The host resolvers shape a **content-free** wire request and `fetch` a `keiko-server` route. The route
map:

| Host capability                        | Route                                                                   | Tier / state                                      |
| -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| File load / save                       | `GET` / `PATCH /api/files/content` (+ `baseVersion` for save)           | Workspace I/O; `409 STALE_SESSION` on stale write |
| Diagnostics / hover / symbols / format | `POST /api/editor/language`                                             | Deterministic, model-free (#1198) `shipped`       |
| Completion                             | `POST /api/editor/completion`                                           | Two-tier governed (#1199) `shipped`               |
| Inline completion                      | `POST /api/editor/inline-completion` (+ `/telemetry`)                   | Model-only, gated (#1200) `shipped`               |
| Coding context                         | `POST /api/editor/context`, `/repo-search`, `/local-knowledge/retrieve` | Query-only retrieval (#1211) `shipped`            |
| Generate tests                         | `POST /api/editor/test-generation`                                      | Wave 2 (#1202) `gated-off`                        |

File load and save use the workspace-owned `/api/files/content` routes (not editor-specific routes):
the editor imports neither, and reaches them only through the host-injected `loadBuffer` and
`saveDocument` ports on `EditorHostPort`. Every governed response is redacted at the BFF boundary and
content-free apart from the reviewable insert text or patch `newText` (see
[Security and privacy](#security-and-privacy-notes-for-regulated-deployments)).

### 3. Mount the controlled editor

`KeikoCodeEditor` is fully controlled: the host owns the buffer, the dirty/version bookkeeping
(`fileModel`), the Monaco `loadState`, and the save lifecycle (`saveStatus`). The component emits
intent (`onContentChange`, `onSaveRequested`, `onSelectionChange`, `onCursorChange`) and renders
host-computed state. `provide*` props bind the host resolvers. While `loadState.status` is not
`"ready"` the editor is read-only.

### File load, save, and optimistic concurrency

Save is version-aware. The host sends the loaded `baseVersion`; the server rejects a write whose base
no longer matches the persisted version with HTTP `409` (`STALE_SESSION`, superseding the legacy
`WRITE_CONFLICT`). The component surfaces this as the terminal-until-resolved `saveStatus: "conflict"`
state, which keeps the buffer dirty and never silently overwrites. `detectSaveConflict` and
`saveStatusReducer` (`save-state.ts`) let a host drive the lifecycle deterministically.

### Theme and large-file degraded mode

The theme variant (`dark` / `light` / `high-contrast`) is host-selected; `KeikoCodeEditor` registers
the Keiko Monaco theme on mount from the live `--ed-*` DOM tokens. Files **> 500 KB or > 10,000 lines**
open in degraded mode — expensive Monaco features (bracket-pair colourisation, folding, occurrence
highlighting, whitespace rendering) are disabled and `largeFileOptimizations` is on, keeping
per-keystroke work within budget. Files **> 1,000,000 bytes** are rejected server-side and never
instantiate Monaco. The pure `deriveLargeFileMode` /
`LARGE_FILE_DEGRADED_BYTES` / `LARGE_FILE_DEGRADED_LINES` exports let the host mirror this policy
(ADR-0042 D3.6).

## Completion architecture

Completion is deterministic-first and governed end to end. The editor computes nothing; it registers
Monaco providers that bridge to host resolvers, and the host calls a BFF route that is the only place a
model is reached — always through the Model Gateway.

### Deterministic language service (#1198) — `shipped`

`POST /api/editor/language` runs one model-free operation (`diagnostics`, `completion`, `hover`,
`symbols`) over the in-editor overlay; `GET /api/editor/language/capabilities` advertises providers.
The first provider serves TypeScript/JavaScript (`typescript`, `typescriptreact`, `javascript`,
`javascriptreact`) via the TypeScript language service. It is deterministic, overlay-aware,
workspace-contained (realpath + deny-list), bounded and cancellable (`TIMED_OUT` / `CANCELLED`), and
sanitised for display. Document formatting joins this surface as an explicit, cancellable "Format
Document" operation (#1201). Other languages get Monaco syntax highlighting/editing now and
deterministic intelligence as their provider lands (#1213).

### Two-tier completion (#1199) — `shipped`

`POST /api/editor/completion` returns:

- **Tier 1 (always):** deterministic language-service completion — the source of truth and the
  always-available default.
- **Tier 2 (gated):** model-assisted completion routed through the Model Gateway, run only when the
  completion-model selection (#1210) elects an aligned (`instruct` / `edit-tuned`) infilling model in
  budget. The as-you-type tier may run on a trigger character; the manual tier runs only on an explicit
  invoke. When no governed model is usable the route degrades to Tier 1 and records a content-free
  degrade reason — never a silent ungoverned fallback.

### Inline completion / ghost text (#1200) — `shipped`

`POST /api/editor/inline-completion` is **model-only** — there is no deterministic ghost-text tier. It
runs the model only when the completion-model selection elects an aligned, suffix-aware (FIM) model in
budget and the interaction mode fits the trigger: an `automatic` (as-you-type) request requires a
**fast** FIM model; an `explicit` request also accepts a slower manual-invoke FIM model. When no model
is usable, the feature is disabled by policy, or a ceiling is hit, the route returns **zero items** and
the editor falls back to the deterministic completion gateway (#1199).

| Setting                                         | Default | Meaning                                                                  |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `KEIKO_EDITOR_INLINE_COMPLETION`                | on      | Set to `0`/`false`/`off`/`no`/`disabled` to turn the feature off.        |
| `KEIKO_EDITOR_INLINE_COMPLETION_MAX_COST_CLASS` | `low`   | Caps the cost class of an eligible inline model (`low`/`medium`/`high`). |

A content-free acceptance/rejection telemetry pair is posted to
`POST /api/editor/inline-completion/telemetry` (counts only; never ghost text).

### Completion-model selection and FIM (#1210) — `shipped`

The Model Gateway gained an optional suffix-aware FIM/infilling capability and `selectCompletionModel`
(as-you-type → manual → deterministic), mirroring the Quality Intelligence capability-gate pattern.
The as-you-type query requires both the FIM capability and `latencyClass: "fast"`, so a `standard`/
`slow` model is never elected for per-keystroke ghost text. Models must be aligned/instruct, not raw
base-model FIM (base-model FIM is a prompt-injection vector; ADR-0042 D5).

### Coding context retrieval (#1211) — `shipped`

Model-assisted completion enriches its prompt with governed coding context assembled **server-side**
by reusing existing systems (repository search, and — when a capsule/connector is selected and the
budget allows — Local Knowledge and retained memory). Per-keystroke surfaces use only the cheapest
context (`purpose: "inline"`, repository search only; embedding-cost providers are excluded); heavier
providers serve explicit requests (`purpose: "completion"` / `"test-generation"`). The browser receives
only the content-free wire pack (citations + tier + accounting); excerpt text never leaves the process.

### Cost ceilings — `shipped`

Two server-owned, per-workspace-root ceilings bound model spend (OWASP LLM10:2025 denial-of-wallet),
independent of any browser-side debounce:

| Control                                      | Default                                   | Behaviour on exceed                            |
| -------------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| Request rate (`inlineCompletionRateLimiter`) | 60 ms min interval, 600 calls / 60 s      | Skip the model tier; return no ghost text.     |
| Token budget (`editorModelTokenBudget`)      | 1,000,000 prompt+completion tokens / 60 s | Skip the model tier; degrade to deterministic. |

Both reserve before the provider call and settle to actual usage afterwards, so concurrent requests
cannot race the check. Neither queues nor blocks typing. The token budget is shared across the inline
and completion model tiers for the same root.

### Degradation matrix

| Condition                            | Result                                                               |
| ------------------------------------ | -------------------------------------------------------------------- |
| No Gateway configured / no FIM model | Deterministic completion only; inline returns zero items.            |
| Only a slow FIM model (no `fast`)    | Manual-invoke inline allowed; as-you-type ghost text suppressed.     |
| Over per-call cost ceiling           | Model tier skipped; deterministic completion returned.               |
| Rate limit or token budget exhausted | Model tier skipped; deterministic completion returned.               |
| Model or retrieval error             | Content-free degrade reason recorded; deterministic result returned. |
| Unsupported language                 | Monaco editing only; no governed diagnostics/hover/symbols.          |

## Governed test generation flow

`POST /api/editor/test-generation` (#1202) is **shipped switched off** (ADR-0042 D7). Executing
model-generated tests is untrusted-code execution, and Keiko does not yet OS-enforce network egress, so
the route exposes two independent, default-off gates:

| Gate                              | Env var                                  | Off (default) behaviour                                                                                                     |
| --------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A — surfaces the feature          | `KEIKO_EDITOR_TEST_GENERATION`           | `disabled`: no request parsing, retrieval, model, or execution. The v1 behaviour.                                           |
| B — permits producing a candidate | `KEIKO_EDITOR_TEST_GENERATION_EXECUTION` | `deferred`: governed discovery (#1211) runs for provenance, but **no model call** is made and **no candidate** is produced. |

No v1 flow executes model-generated code. Even with both gates enabled (only justified once an
enforced, deny-by-default egress boundary exists and is proven by an automated test), a produced
candidate is `unverified`; the assured pre-filter that would execute and elevate it stays `not-run`.
The editor ships only the pure, browser-safe controllers (`buildTestGenerationContext`,
`buildTestGenerationRequest`, the flow reducer, and the diff-review projection that reuses
`buildPatchPreview` with apply disabled).

## Security and privacy notes for regulated deployments

The editor's threat model and hardening are detailed in the
[security hardening review](1206-security-hardening-review.md); this is the operational summary.

### Content-free provenance posture

Across completion, inline completion, diagnostics, and context, the browser receives the opened file
buffer by design and sends live editor text plus request context to same-origin BFF routes through host
resolvers. The content-free guarantee applies to the derived surfaces: prompts, retrieved excerpts,
workspace roots, secrets, telemetry, and persisted evidence do not expose those raw payloads back to the
browser or evidence artifacts. Responses expose only reviewable insert text (or patch `newText`),
source-kind labels (`deterministic-language-service`, `model-assisted`, `repository-context`,
`local-knowledge`, `memory`, `connected-context`), a SHA-256 prompt hash, byte counts, provenance ids,
and omission reasons. A compile-time content-free guard (`content-free-guard.ts`) and the cross-route
`editorSecurityBoundary.test.ts` hold this invariant.

### No CDN, no direct browser provider egress, CSP unchanged

Monaco core and all five language workers (`editor`, `typescript`, `json`, `css`, `html`) are served
same-origin from the locally installed `monaco-editor` (pinned `0.55.1`); no editor asset is fetched
from a CDN. The editor issues no direct browser network calls to model/retrieval/analytics/provider
endpoints. The server CSP (`packages/keiko-server/src/csp.ts`) is not widened for Monaco: `script-src
'self'` with SHA-256 hashes (no `'unsafe-inline'`), `worker-src 'self'`, `connect-src 'self'`,
`style-src 'self' 'unsafe-inline'` (pre-existing, for Tailwind), `default-src 'none'`. Same-origin ESM
workers and Monaco's runtime style injection satisfy this with no relaxation (ADR-0042 D3.4).

### Supply chain

`monaco-editor@0.55.1` declares `dompurify@3.2.7` (moderate advisories affecting `<= 3.4.10`). The
control is a root `overrides: { dompurify: "3.4.11" }` that installs the patched line — not a silencing
pin — while Monaco stays at `0.55.1`. Monaco also bundles a vendored DOMPurify copy reachable only
through Markdown-rendering sinks; the mounted editor keeps those sinks off (suggest docs, parameter
hints, code lens, lightbulb, inlay hints, links) and renders hover quick-info as an inert, escaped code
fence, so the vendored sanitiser never processes active markup. The lockfile integrity hashes, the SBOM

- license gate (`npm run check:workspace-supply-chain`), and the no-CDN policy bound the supply-chain
  exposure.

### Audit evidence

Every governed editor route records content-free evidence: a completion-model evidence atom, a
coding-context evidence atom, inline-completion telemetry, and a test-generation funnel. These carry
provenance, hashes, counts, and policy decisions only, and are redacted at the BFF boundary (ADR-0042
D6/D9).

### Untrusted retrieval and prompt injection

Retrieved repository text, Local Knowledge chunks, memory, and Quality Intelligence evidence are
treated as **untrusted model input**. The #1206/#1211 fixtures prove that retrieved content cannot
grant tool authority, request secrets, bypass review/evidence gates, apply patches, or execute tests.
This is why test execution stays deferred behind enforced egress (D7) and why model-assisted completion
uses aligned models only (D5).

## Verification commands

Deterministic, offline commands — no model credentials required:

```bash
# Editor package: build, typecheck, unit/component tests (jsdom).
npm --workspace @oscharko-dev/keiko-editor run build
npm --workspace @oscharko-dev/keiko-editor run typecheck
npm --workspace @oscharko-dev/keiko-editor test

# Server editor routes: typecheck + tests for the BFF surface.
npm --workspace @oscharko-dev/keiko-server test

# Browser-tier dependency-direction boundary and its negative fixture.
npm run arch:check
npm run arch:check:negative

# Editor bundle-size budget (own-code gzip ceiling, Monaco pin, first-load isolation).
npm run check:editor-bundle-size            # add --require-static-export after `npm run build:ui`

# Supply chain and documentation links.
npm audit --audit-level=high
npm run check:workspace-supply-chain
npm run check:editor-doc-links
```

Browser-measured release evidence — first-card-open latency (p50/p95), per-keystroke INP, memory under
multi-card load, and the 2.5 MB-gzip lazy-runtime / 750 KB-gzip per-worker budgets against the real
production bundle — is recorded as release evidence by [#1209], not by this runbook.

## Operational limitations

- Deterministic language intelligence is TypeScript/JavaScript only until #1213.
- AI ghost text requires a fast, aligned, suffix-aware FIM model; otherwise manual-invoke and
  deterministic completion only.
- Large files degrade or are rejected as above; very large files never instantiate Monaco.
- No editor-driven test execution in v1 (test generation switched off).
- No CDN and no direct browser provider egress; the CSP is not widened for Monaco.

## Related documentation

- [`@oscharko-dev/keiko-editor` README](../../packages/keiko-editor/README.md) — package API and
  standalone embedding.
- [Keiko Editor troubleshooting](troubleshooting.md) — failure-to-resolution entries.
- [Keiko Editor release note (draft)](../release/keiko-editor-0.2.0-release-note.md).
- [ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md) and the
  [architecture blueprint](../planning/keiko-editor-architecture-blueprint.md).
- [Security and audit boundaries](../security-and-audit-boundaries.md) — product-wide trust boundaries.

[#1209]: https://github.com/oscharko-dev/Keiko/issues/1209
