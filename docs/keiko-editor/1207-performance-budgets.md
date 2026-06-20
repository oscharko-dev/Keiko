# Issue #1207 — Keiko Editor Performance, Memory, Bundle-Size, and Large-File Resilience

Parent epic: #1189. Governing architecture: [ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md)
(decision **D3.6**, "Initial performance budgets"). Release evidence against these budgets is recorded
separately by #1209.

## 1. Purpose and scope

This document is the single, audit-friendly reference for the Keiko Editor performance budgets: every
numeric target, who enforces it, how it is measured, the current observed value, and the pass/fail
gate. ADR-0042 D3.6 assigns #1207 to **"measure and enforce these budgets"** and #1209 to **"record
release evidence."** This document and the checks it references implement the #1207 half; the
browser-measured figures (cold-start latency, INP, worker memory) are gathered against the real
production build by #1209.

In scope (the issue Scope section): editor startup cost, typing latency with/without completion,
completion latency and cancellation, Monaco worker memory, bundle-size impact and code-splitting,
large-file rejection/degradation, and multi-card model/worker leak avoidance. Out of scope: a global
app performance rewrite.

## 2. Performance budget table (authoritative: ADR-0042 D3.6)

| #   | Budget                                                        | Threshold                                                                          | Owner / enforcement                                                                              | Status                                             |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| B1  | Monaco/editor code in the static-export first-load JavaScript | **0 bytes gzip**                                                                   | Host code-split (`next/dynamic(ssr:false)`) + source isolation gate (`check:editor-bundle-size`) | Enforced (#1207)                                   |
| B2  | Lazy editor + Monaco runtime total                            | **≤ 2.5 MB gzip**                                                                  | Production-bundle measurement                                                                    | Release evidence (#1209); footprint baseline in §6 |
| B3  | Per worker chunk                                              | **≤ 750 KB gzip**                                                                  | Production-bundle measurement                                                                    | Release evidence (#1209)                           |
| B4  | First editor-card open (open → interactive)                   | **p50 ≤ 1.5 s, p95 ≤ 2.5 s**                                                       | Browser performance smoke                                                                        | Release evidence (#1209); method in §10            |
| B5  | Per-keystroke main-thread work (completion enabled)           | **< 50 ms** (no long tasks)                                                        | Design (async/debounced bridges) + browser smoke                                                 | Enforced by design (§9); measured by #1209         |
| B6  | Editor Interaction to Next Paint (INP), completion enabled    | **≤ 200 ms at p75**                                                                | Browser performance smoke                                                                        | Release evidence (#1209)                           |
| B7  | Completion request latency (request pacing)                   | inline debounce **75 ms**; p50/p95 recorded content-free                           | Owned by #1200; telemetry route                                                                  | In place (#1200); recorded by #1209                |
| B8  | Large file → degraded mode                                    | **> 500 KB or > 10,000 lines**                                                     | Editor option degradation (`deriveLargeFileMode`)                                                | Enforced (#1207)                                   |
| B9  | Large file → hard editable limit (too-large path, no Monaco)  | **> 1,000,000 bytes**                                                              | Server (`files.ts`, `413 FILE_TOO_LARGE`)                                                        | Enforced (pre-#1207, #1191–#1206)                  |
| B10 | Editor package own-code footprint                             | **≤ 96 KiB gzip** (committed ceiling)                                              | `check:editor-bundle-size`                                                                       | Enforced (#1207)                                   |
| B11 | Monaco worker/model memory growth per open editor card        | **≤ 128 MiB** after warm start; **≤ 16 MiB** residual after card close + GC/settle | Browser memory smoke + deterministic disposal tests                                              | Ceiling owned here (#1207); browser evidence #1209 |

The B1/B2/B3/B5/B6 thresholds are quoted verbatim from ADR-0042 D3.6; B7 from Issue #1200 and the
#1207 Review Addendum; B8/B9 from ADR-0042 D3.6 and the server limits; B10 is the #1207 deterministic
own-code ceiling (rationale in §6).

## 3. Enforcement model — deterministic now, browser-measured at release

Two kinds of budget, two owners:

- **Deterministic, enforced in `ci` now (#1207).** Budgets that can be checked without a running
  browser are enforced mechanically and fail the build on regression: the editor package own-code
  gzip ceiling (B10), the Monaco version pin the runtime footprint was measured against, and the
  first-load code-split isolation (B1). See `scripts/editor-bundle-size.mjs`, run both standalone
  (`npm run check:editor-bundle-size`), inside `check:package-surface` (the `ci` prepack chain via
  `smoke:install`), and in the required PR `ci` job after `npm run build:ui` with
  `--require-static-export`. Disposal/leak avoidance (memory cleanup), explicit model disposal, large
  file degradation, and cancellation are enforced by unit tests in `npm run test:coverage:quality`.
- **Browser-measured release evidence (#1209).** Budgets that require a real browser and the
  production bundle — cold-start latency (B4), INP (B6), the bundled 2.5 MB / 750 KB chunk sizes
  (B2/B3), and the B11 worker/model memory measurements — are measured by #1209 against the
  static-export build. Gzipping individual Monaco ESM source files is **not** a faithful proxy for a
  tree-shaken, minified production chunk, so #1207 does not assert B2/B3 against the unbundled package;
  it pins the version and records the baseline (§6), and #1209 measures the real chunk.

## 4. Acceptance Criteria evidence ledger

| Acceptance Criterion                                                 | Verdict                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor package is code-split or lazy-loaded by the host              | Satisfied                           | `EditorWidget.tsx` is a first-load shell that dynamically imports `EditorRuntimeWidget` via `next/dynamic(..., { ssr:false })`; only `EditorRuntimeWidget.tsx`, `EditorSurface.tsx`, `EditorDiffSurface.tsx`, and `editorMonacoRuntime.ts` may value-import the editor runtime package or Monaco. Enforced by `check:editor-bundle-size -- --require-static-export`; covered by `EditorWidget.test.tsx`. |
| Typing remains responsive with completion enabled                    | Satisfied by design + degraded mode | Bridges are async + debounced (inline 75 ms, diagnostics 400 ms); the keystroke path does only controlled-state update; large buffers drop to degraded render mode (§9, B5/B8). Browser INP/keystroke numbers: #1209.                                                                                                                                                                                    |
| Completion cancellation prevents request pile-ups                    | Satisfied                           | Debounce coalesces keystrokes; starting a newer completion/inline-completion request aborts the previous bridge-owned `AbortController`; Monaco token cancellation also aborts in-flight host requests; stale responses are discarded (`shouldDiscardResponse`); the server adds a per-root rate limiter + token budget. Tests: `completion-bridge.test.ts`, `inline-completion-bridge.test.ts`. §8.     |
| Monaco models/providers are disposed when files/cards close          | Satisfied                           | `wireEditorOnMount` returns one disposer that tears down every provider/subscription/action; the unmount effect calls it (`use-editor-handlers.ts`); `<Editor keepCurrentModel={false}>` makes model disposal explicit. Tests: `on-mount.test.ts`, `KeikoCodeEditor.test.ts`, and `editor-memory-lifecycle.test.ts` (multi-card no-leak). §7.                                                            |
| Large files use existing limits or documented degradation            | Satisfied                           | > 1 MB → server `413 FILE_TOO_LARGE`; > 500 KB or > 10,000 lines → read-only degraded mode with completions, inline suggestions, diagnostics, hover, symbols, formatting, inline telemetry, and test generation absent; non-text → `400 UNSUPPORTED_FILE`. §5.                                                                                                                                           |
| Performance findings are fixed or documented as explicit limitations | Satisfied                           | Findings and dispositions: §11.                                                                                                                                                                                                                                                                                                                                                                          |

## 5. Large-file resilience matrix

| Buffer condition                            | Behaviour                                                                                                                                                                                                         | Source                                                                            | User-visible outcome                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| ≤ 500 KB and ≤ 10,000 lines                 | Full editor                                                                                                                                                                                                       | —                                                                                 | Normal editing                                                                                              |
| > 500 KB or > 10,000 lines (and ≤ 1 MB)     | **Degraded mode**: buffer is read-only; completion, inline completion, diagnostics, hover, symbols, formatting, inline telemetry, and test-generation props are omitted; render-heavy Monaco options are disabled | `EditorRuntimeWidget.tsx`, `large-file-mode.ts`, `editor-options.ts` (`degraded`) | Read-only buffer with live "Large file mode" status; analysis/completions disabled                          |
| Editor-tier read-only ceiling (no host max) | Read-only over `DEFAULT_MAX_SIZE_BYTES` (262,144 B)                                                                                                                                                               | `use-editor-view-model.ts`, `save-state.ts`                                       | Read-only buffer                                                                                            |
| > 1,000,000 bytes (read)                    | Server rejects with `413 FILE_TOO_LARGE`; Monaco never instantiated for the over-limit content                                                                                                                    | `files.ts` `readStableEditableContent`                                            | Editor shows "Editor failed to load: This file is too large to edit here (limit 1000000 bytes)." with Retry |
| > 1,000,000 bytes (write)                   | Server rejects with `413 FILE_TOO_LARGE`                                                                                                                                                                          | `files.ts` `writeResolvedFilesContent`                                            | Save fails with the limit message; buffer kept                                                              |
| Non-text / binary                           | Server rejects with `400 UNSUPPORTED_FILE`                                                                                                                                                                        | `files.ts` `readFilesContent`                                                     | Editor load error                                                                                           |

The host workspace read endpoint (`FilesContentResponse`) returns full content only for files within
the 1 MB limit, so the editor never receives a silently-truncated editable buffer; truncation is not a
data-loss path. The 1 MB hard limit is `MAX_TEXT_PREVIEW_BYTES` in `packages/keiko-server/src/files.ts`.

## 6. Bundle-size notes

**Methodology.** `scripts/editor-bundle-size.mjs` gzips (`zlib`, level 9) every `*.js` file under the
built `packages/keiko-editor/dist/` and sums them (the editor's own compiled code), asserts the total
is under the committed ceiling, asserts `monaco-editor` stays at the pinned version the runtime budget
was measured against, and asserts the first-load code-split isolation (B1). The source isolation gate
treats `monaco-editor`, `@monaco-editor/react`, and `@oscharko-dev/keiko-editor` as forbidden
first-load value imports outside the dynamic runtime allow-list. When run as
`npm run check:editor-bundle-size -- --require-static-export`, the gate also scans the initial
JavaScript files referenced by `packages/keiko-ui/out/index.html` after `npm run build:ui`. Budget
values live in `scripts/editor-bundle-size.budget.json`. The gate runs in `ci` directly and through
the prepack chain (`smoke:install` → `npm pack` → `prepack`) via `check:package-surface`; it is also
available standalone via `npm run check:editor-bundle-size`.

**Baselines (monaco-editor 0.55.1):**

- Editor package own code (`keiko-editor/dist/**/*.js`): **~67 KiB gzip** (observed 68,633 B across 50
  files). Committed ceiling **96 KiB** (`editorOwnCodeGzipBytesCeiling = 98304`) — ≈ 30 % headroom for
  routine growth while still catching the headline regression (a heavy dependency, or Monaco itself,
  accidentally bundled into the editor package's own code, which would balloon this by orders of
  magnitude). Re-baseline by updating `editorOwnCodeGzipBytesObserved` and, if intentional, the
  ceiling, with a rationale in the PR.
- Monaco runtime footprint (informational): the full installed `monaco-editor/esm` tree is ~26 MB raw
  / ~4.9 MB gzip across 1,227 files; the governed v1 production bundle ships only the tree-shaken
  editor runtime plus `editor.worker.js`. #1209 measures that shipped static export against B2
  (≤ 2.5 MB gzip) and B3 (≤ 750 KB gzip per worker). Keiko's server-governed TS/JS provider remains
  the language-intelligence source of truth; #1213 owns any future multi-language worker expansion.

**Why the editor package is bundle-excluded from the published product tarball.** `keiko-editor` is a
browser-tier workspace consumed by `keiko-ui`, whose runtime artifact is copied into `dist/ui/static`;
it is intentionally listed in `EXPECTED_BUNDLE_EXCLUSIONS` in `check-package-surface.mjs` and is not
published independently. Its footprint is therefore enforced against its built `dist/` directly, and
its contribution to the shipped UI bundle is the B2/B3 release-evidence measurement (#1209).

## 7. Memory cleanup / disposal

`wireEditorOnMount` (`on-mount.ts`) is the single mount aggregator: it registers the theme, save
action, keydown backstop, cursor/selection subscriptions, the completion / inline-completion /
diagnostics / hover / symbol / formatting providers, and the command actions, and returns **one
disposer** that releases all of them. The editor unmount effect (`use-editor-handlers.ts`
`useUnmountDisposal`) calls it; `<Editor keepCurrentModel={false}>` makes the Monaco model-disposal
contract explicit when `@monaco-editor/react` unmounts the editor instance. Language providers are
registered per editor mount (not module-global) and disposed with the mount, so multiple open cards do
not accumulate registrations.

The numeric worker/model memory ceiling is B11: after warm start, Monaco worker/model memory growth
must remain **≤ 128 MiB per simultaneously open editor card**, and post-close residual growth after GC
and settle must remain **≤ 16 MiB**. #1207 owns the ceiling and deterministic disposal proof; #1209
records the browser memory measurement against the production static export.

Tests:

- `on-mount.test.ts` — per-feature disposal (completion, inline, diagnostics, hover, symbols,
  formatting, command actions, cursor/selection, keydown backstop).
- `KeikoCodeEditor.test.tsx` — asserts `keepCurrentModel={false}` is passed to
  `@monaco-editor/react`.
- `editor-memory-lifecycle.test.ts` — the #1207 multi-card no-leak proof: an instrumented Monaco fake
  counts every live disposable; 25 open/close cycles and 8 simultaneously-open cards each return the
  live count to zero, and closing one card frees exactly that card's registrations.

## 8. Completion cancellation / anti-pile-up strategy

Request pile-ups are prevented by four composed mechanisms, no single-active-request semaphore needed:

1. **Debounce** — inline completion waits `DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS` (75 ms); rapid
   keystrokes reset the timer, so a burst yields one request, not one per keystroke.
2. **Cancellation on supersession** — starting a newer completion request aborts the previous
   bridge-owned `AbortController`; Monaco token cancellation also aborts the current in-flight host
   request, so host work is not left to complete after the editor has moved on.
3. **Stale-response discard** — `shouldDiscardResponse` drops any response whose identity is no longer
   the latest, so a late arrival never renders.
4. **Server-side limits** — the per-root rate limiter and per-window token budget (#1200/#1206) bound
   concurrent server work independently of the client.

Evidence: `completion-bridge.test.ts` and `inline-completion-bridge.test.ts` assert previous-request
abort, Monaco abort-on-cancel, listener disposal, and stale-discard; the server
rate-limiter/token-budget have their own unit tests.

## 9. Typing responsiveness (B5/B6)

The keystroke path is intentionally light: Monaco's controlled `onChange` emits a single
`onContentChange` (buffer text + byte length) and the host updates React state; completion, inline
completion, and diagnostics are all asynchronous and debounced, so no model call or retrieval runs on
the keystroke. Ghost text is rendered from a resolved promise on Monaco's own schedule, off the
keystroke, satisfying "ghost-text rendering yields to input." For large buffers, degraded mode (§5)
removes the per-render-expensive features to keep main-thread work within B5. The absolute INP and
per-keystroke long-task figures are browser-measured by #1209 (§10).

## 10. Release-evidence handoff (#1209)

#1209 records measured evidence against this table using the packaged CLI serving the production
static UI (`playwright.editor-performance.config.ts` + `tests/e2e/editor-performance.spec.ts`):

1. **Bundle (B1/B2/B3):** `npm run build:ui`, then from the static export measure (a) that the
   first-load/entry chunks contain no Monaco/editor code (B1), (b) the gzipped total of the lazy
   editor + Monaco chunks (B2 ≤ 2.5 MB), and (c) the largest gzipped worker chunk (B3 ≤ 750 KB).
2. **Cold start (B4):** open the first editor card; record open → interactive p50/p95 across repeated
   runs on a representative dev machine.
3. **Typing (B5/B6):** type into a source buffer with completion enabled; record per-keystroke
   main-thread work (no long task > 50 ms) and INP (≤ 200 ms at p75).
4. **Worker memory (B11):** open/close multiple editor cards; confirm growth remains ≤ 128 MiB per
   simultaneously open card after warm start and residual growth after card close + GC/settle remains
   ≤ 16 MiB (the deterministic disposal proof is `editor-memory-lifecycle.test.ts`).
5. **Completion latency (B7):** read p50/p95 from the content-free inline-completion telemetry.

Record each measured value beside its budget and mark each pass/fail; a regression is either fixed or
recorded here as an explicit, justified limitation.

## 11. Findings and dispositions

- **F1 — Incomplete large-file degraded mode (fixed).** ADR-0042 D3.6 mandates degraded mode above
  500 KB / 10,000 lines. Fixed: the host derives large-file mode, makes degraded buffers read-only,
  omits analysis/completion/test-generation provider props, shows a live degraded status, and keeps
  `buildEditorOptions({ degraded })` for render-heavy Monaco options.
- **F2 — Incomplete first-load/static-export bundle gate (fixed).** The B1/B10 budgets were
  documented but the gate only covered direct Monaco imports and did not run the static-export scan in
  PR `ci`. Fixed: `check:editor-bundle-size` now treats the editor root package as a forbidden
  first-load value import outside the runtime allow-list, scans static-export initial JS with
  `--require-static-export`, and runs in required `ci`.
- **F3 — No multi-card leak test (fixed).** Disposal was correct but only single-mount-tested. Fixed:
  `editor-memory-lifecycle.test.ts`.
- **F4 — Browser-measured budgets (B2/B3/B4/B6) deferred to #1209 (accepted).** These require the
  production bundle and a running browser; ADR-0042 D3.6 assigns the release evidence to #1209. #1207
  ships the budgets, the deterministic gates, and the measurement method (§10).
- **F5 — Previous completion request not aborted by a newer bridge request (fixed).** Stale responses
  were discarded and Monaco cancellation was honored, but the bridge-owned previous controller could
  continue until completion. Fixed: completion and inline-completion providers abort the previous
  active controller before starting a newer request.

## 12. Local verification

```bash
npm run build:packages                       # build keiko-editor dist for the gate
npm run build:ui
npm run check:editor-bundle-size -- --require-static-export  # B1, B10, Monaco version pin
npm --workspace @oscharko-dev/keiko-editor test   # disposal, cancellation, large-file, degraded mode
npx vitest run scripts/__tests__/editor-bundle-size.test.mjs
npm run typecheck && npm run lint && npm run arch:check && npm run arch:check:negative
```
