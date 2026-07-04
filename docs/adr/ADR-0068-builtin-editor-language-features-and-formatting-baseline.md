# ADR-0068: Built-in editor language features and deterministic formatting baseline

## Status

Accepted (2026-06-25). Pending human review. Authored for Issue
[#1380](https://github.com/oscharko-dev/Keiko/issues/1380) (Parent Epic
[#1491](https://github.com/oscharko-dev/Keiko/issues/1491)).

## Date

2026-06-25

## Version

1

## Context

Issue #1380 (Epic #1491) asks for a "built-in editor language features and deterministic formatting
baseline": correct language mode on open, stable theme/tokenization across reload, an explicit Format
command that applies only provider-returned deterministic edits, formatting failures that leave
content untouched, and provider status that "reflects unavailable formatting instead of hiding the
command inconsistently." The issue title scopes this to "Monaco-supported browser capabilities for
syntax, bracket behavior, JSON/CSS/HTML/TS/JS-style formatting where safe, and a consistent explicit
Format command model."

Most of the surface already exists (ADR-0042, ADR-0045, ADR-0067; Issues #1196, #1198, #1201, #1205,
#1379). This is therefore primarily a **wire-up-and-make-consistent** issue with one real correctness
gap, not a build-new. The current state, confirmed by reading the code:

- **Source-language universe (contract leaf, ADR-0067 D1).**
  `keiko-contracts/src/editor-language-mode-map.ts` holds `EDITOR_LANGUAGE_MODE_MAP` (15 source
  languages, each `syntaxHighlighting: true`), `EDITOR_LANGUAGE_MODE_IDS`, and
  `inferEditorLanguageModeId`. It is a strict leaf (no `keiko-*` imports, no clock/crypto). `plaintext`
  is deliberately excluded (render fallback). It answers "language id / extension matching / syntax
  support" — but it carries **no formatting-source semantics** and no browser-capability semantics.
- **Browser language inference.** `keiko-editor/src/monaco/language-inference.ts`
  (`inferMonacoLanguageId`) derives ids/extensions from the mode map; unknown → `plaintext`.
- **Monaco runtime bootstrap.** `keiko-ui/.../editorMonacoRuntime.ts` imports the `basic-languages`
  tokenizer contributions for go/java/javascript/markdown/python/rust/shell/sql/typescript/yaml and
  the rich-worker contributions `language/{css,html,json}/monaco.contribution.js`, and manually
  registers the `json` language id (`registerJsonLanguageId`). It imports **no** `basic-languages`
  contribution for css/scss/less/html. Per node_modules inspection, `language/css/monaco.contribution`
  only calls `monaco.languages.onLanguage('css'|'scss'|'less', …)` (lazy worker setup) and registers
  neither the language nor the Monarch tokenizer; the language registration + Monarch grammar for
  css/scss/less/html comes from `basic-languages/{css,scss,less,html}/*.contribution.js` (present in
  node_modules, **not imported**). So css/scss/less/html may not tokenize today, and their built-in
  formatters may be unreachable. This is the AC1/AC2 correctness gap.
- **Explicit Keiko formatting bridge (#1201, ADR-0042 D4).**
  `keiko-editor/src/components/formatting-bridge.ts` registers a Monaco
  `DocumentFormattingEditProvider` for `FORMATTING_ELIGIBLE_LANGUAGES = ["typescript","javascript"]`,
  backed by the host resolver → server language service (deterministic, model-free, deadline-bounded,
  cancellable). It returns `EMPTY_EDITS` on any error/cancellation/stale-buffer/superseding-edit. It is
  registered once per mount via `on-mount.ts` `installFormattingProvider`. AC3/AC4 are already
  satisfied and tested by this path.
- **Server providers.** `keiko-server/.../builtinLanguageProviders.ts` + `typescriptLanguageProvider.ts`
  hold deterministic formatters for ts/js/json/css/scss/less/html/yaml/markdown, and
  `describeLanguageCapabilities()` advertises `formatting` for all of them.
- **UI gating (the AC5 defect).** `EditorRuntimeWidget.tsx` gates the Format button with
  `formattingEnabled = providerOperationEnabled(languageProvider,"formatting") && !largeFileDegraded`,
  driven by the **server** capability set. So the button is advertised as available for **yaml** and
  **markdown** even though the browser has **no** registered Monaco formatter for them — pressing
  Format does nothing. The status bar's `EditorStatusLanguageService` field
  (`status-bar.ts`) is provider-wide (available/unavailable), **not** a per-operation
  formatting field. This is the core "command hidden inconsistently" inconsistency.
- **Bracket matching/colorization.** Already global in `editor-options.ts`
  (`bracketPairColorization`, `matchBrackets`), degraded only in large-file mode. No per-language work.

The mismatch is precise: **server formatting capability ≠ browser formatting reachability.** The
server can format yaml/markdown over a BFF round-trip, but no Monaco `DocumentFormattingEditProvider`
is registered for those languages in the browser, so Monaco's "Format Document" command — the only
thing the Format button triggers — has no provider to call. The product needs a **single editor-tier
source of truth for what formatting is actually reachable in the browser**, and the Format command +
status must derive from it.

Forces: contract changes must be additive and hold schema versions at `"1"`; the leaf rule and
dependency direction (browser imports no Node-domain values; server does not import `keiko-editor`)
must not weaken; no double-registration of a `DocumentFormattingEditProvider` (Monaco resolves only
one for "Format Document"); the failure-safe path (#1201) must be reused, not re-invented; and we must
stay inside scope (no format-on-save, no model-based/in-browser-worker governed formatting, no LSP
process startup).

There is one **open empirical question** the design must be correct under either answer: whether
css/scss/less/html currently tokenize and whether their built-in formatters are reachable. A browser
probe (D8) will answer it. The registry (D1) states which languages **should** have built-in syntax +
formatting; the runtime bootstrap (D5) imports whatever `basic-languages` contributions are required
to make that true. The design does not depend on the probe's current outcome.

## Decision

### D1 — One editor-tier "built-in capability registry" in a new strict contracts leaf

We will add a single canonical, frozen const table describing, per known source language, the
**browser** built-in editor capabilities. New leaf module
`keiko-contracts/src/editor-builtin-capabilities.ts`, sibling to `editor-language-mode-map.ts`,
exported from the contracts barrel:

```ts
// How a language's "Format Document" is served in the browser:
//  - "monaco-builtin":        Reserved for future ADR-approved browser formatters that do not ship
//                              extra Monaco language workers.
//  - "keiko-language-service": the Keiko formatting bridge calls the deterministic server service.
//  - "none":                   no in-browser document formatter is reachable for this language.
export type EditorBuiltinFormattingSource = "monaco-builtin" | "keiko-language-service" | "none";

export interface EditorBuiltinCapability {
  readonly languageId: string; // a canonical EDITOR_LANGUAGE_MODE_IDS id
  readonly syntaxHighlighting: boolean; // browser can tokenise/colour locally
  readonly bracketMatching: boolean; // bracket-pair colourisation / matching applies
  readonly documentFormatting: EditorBuiltinFormattingSource;
}

export const EDITOR_BUILTIN_CAPABILITIES: readonly EditorBuiltinCapability[]; // frozen
export const EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE: Readonly<
  Record<string, EditorBuiltinCapability>
>; // derived, frozen

// Pure helpers (null/`"none"` when the language is unknown or has no built-in formatter):
export function editorBuiltinCapability(languageId: string): EditorBuiltinCapability | null;
export function editorBuiltinDocumentFormatting(languageId: string): EditorBuiltinFormattingSource;
export function isBuiltinFormattingAvailable(languageId: string): boolean; // documentFormatting !== "none"
```

The table covers exactly `EDITOR_LANGUAGE_MODE_IDS` (D6 pins exhaustiveness). The
`documentFormatting` split:

- `typescript`, `javascript` → `"keiko-language-service"` (no Monaco TS worker is loaded; Keiko's
  bridge formats them deterministically server-side — #1198/#1201).
- `json`, `css`, `scss`, `less`, `html`, `markdown`, `yaml`, `python`, `java`, `go`, `rust`, `sql`,
  `shell` → `"none"` (no reachable in-browser document formatter).

Packaging update (Step 06 remediation, ADR-0042 D3.6): the original ADR-0068 plan allowed Monaco's
JSON/CSS/HTML workers for browser formatting. Release packaging now keeps those rich workers out of
the shipped static export to preserve the B2/B3 budgets, so the current registry advertises no
`"monaco-builtin"` languages.

This module is a strict leaf (ADR-0019): pure types, frozen const tables, pure functions; no
`keiko-*` imports, no clock/crypto/randomness; browser-importable.

### D2 — The registry lives beside, not inside, the mode map

We will **not** extend `EditorLanguageMode` with formatting-source / bracket fields. The mode map
(ADR-0067 D1) is the **shared source-language universe** the server and browser must agree on; the
server derives its known-language universe from `EDITOR_LANGUAGE_MODE_IDS`. Browser-only
formatting-reachability and Monaco bracket/syntax semantics are an **editor-tier** concern that the
server has no business consuming. Folding them into the mode map would: (a) push browser-only meaning
into a table the server reads, blurring the tier boundary; (b) risk a future server consumer treating
`documentFormatting` as server capability (the exact ts/js-vs-yaml confusion this ADR exists to end);
and (c) couple two independently-evolving universes. Keeping a sibling leaf gives one source of truth
for _each_ concern with no cross-contamination. The registry's `languageId` values are validated
against `EDITOR_LANGUAGE_MODE_IDS` in test (D6), so the two stay coherent without a runtime import
coupling.

### D3 — Format-command availability + the new status field derive from the registry (browser truth), gated by the server only where the source is the language service

We will redefine the Format gate as a function of the **registry** (browser reachability), not the
broad server capability set:

```text
builtinFormatting   = editorBuiltinDocumentFormatting(languageId)   // from the registry
formattingAvailable =
    builtinFormatting === "monaco-builtin"
  || (builtinFormatting === "keiko-language-service"
        && providerOperationEnabled(languageProvider, "formatting"))  // server must also be up
formattingEnabled   = formattingAvailable && !largeFileDegraded
canFormat           = hasTarget && loadState.status === "ready" && formattingEnabled
```

So `monaco-builtin` languages are available whenever Monaco has the worker (json/css/scss/less/html);
`keiko-language-service` languages (ts/js) additionally require the server provider to be available
(it always is, but the gate is honest); and `"none"` languages (yaml/markdown/python/…) are correctly
**unavailable** — fixing AC5. The existing `providerOperationEnabled(...,"formatting")` no longer
gates `monaco-builtin` languages, because the server is irrelevant to their browser formatter.

### D4 — A per-operation "formatting" status field, derived from the same registry

We will add one narrow, additive field to the status-bar view model so status and command agree.
`status-bar.ts` `EditorStatusBarInput` gains:

```ts
readonly formatting?: { readonly available: boolean; readonly source: EditorBuiltinFormattingSource }
  | undefined;
```

`deriveEditorStatusBar` emits a content-free `formatting` field (id `"formatting"`, non-live,
non-assertive) reading "Format ready" / "Format unavailable". The widget feeds it the **same**
`formattingAvailable` value that gates the button and the same dynamic `aria-disabled`/`aria-label` on
the Format button in `EditorRuntimeWidget.tsx`. One derivation drives the button-enabled state, the
button's aria, and the status field — there is no second source that can drift. This is the concrete
AC5 fix: the command is never shown as enabled while status says unavailable, and never silently does
nothing.

### D5 — Runtime bootstrap imports the `basic-languages` contributions every `syntaxHighlighting`/`monaco-builtin` language needs

We will add the missing `basic-languages` tokenizer-contribution imports to
`keiko-ui/.../editorMonacoRuntime.ts` so that **every** language the registry marks
`syntaxHighlighting: true` actually registers its language id + Monarch grammar, and every
`documentFormatting: "monaco-builtin"` language is registered so Monaco's worker formatter can attach.
Concretely, add the `basic-languages/{css,scss,less,html}` contributions (present in node_modules,
currently unimported) alongside the existing `language/{css,html,json}/monaco.contribution.js`
rich-worker imports. Without this, css/scss/less/html may not tokenize (AC1/AC2 fail) and their
built-in formatters never activate (AC5/D3 would advertise a formatter Monaco can't reach). The exact
set is pinned by a test asserting that for every registry language with `syntaxHighlighting: true`,
the bootstrap registers the Monaco language id, and for every `monaco-builtin` language the language
id is registered (D8 e2e confirms tokenization + theme stability end-to-end in the packaged app).

### D6 — Registry is exhaustive over the source-language universe; coherence is test-pinned

We will pin, in a contracts test, that `EDITOR_BUILTIN_CAPABILITIES` covers **exactly**
`EDITOR_LANGUAGE_MODE_IDS` (no missing id, no stray id), that every `syntaxHighlighting` value matches
the mode map's (all `true`), and that `documentFormatting` is one of the three legal sources. A new
language added to the mode map without a matching capability entry fails the test — the two leaves
cannot silently diverge. `plaintext` is intentionally absent from both (ADR-0067 D5): it is the
unknown/unsupported fallback, rendered as plain text with no governed intelligence and no formatter.

### D7 — No double-registration: the Keiko bridge stays language-service-only

We will keep `FORMATTING_ELIGIBLE_LANGUAGES` (the Keiko `DocumentFormattingEditProvider` selector) as
**exactly the `keiko-language-service` set** (ts/js). The Keiko bridge must **not** register for other
languages unless a future ADR adds an explicit governed provider; the release artifact no longer ships
Monaco's rich json/css/html workers. We make the coupling explicit and test-pinned:
`FORMATTING_ELIGIBLE_LANGUAGES` must equal `{ id : registry[id].documentFormatting ===
"keiko-language-service" }`. The bridge's failure-safe contract (AC3/AC4) is unchanged and unique to
the language-service path.

### D8 — Failure-safe path is reused, not re-built; AC3/AC4 need only added tests

We will **reuse** the #1201 bridge as the AC3/AC4 implementation for the language-service set: it
already returns only provider-returned edits and `EMPTY_EDITS` on any
error/cancellation/stale-buffer/superseding-edit, and is tested. For the `monaco-builtin` set, AC3/AC4
are satisfied by Monaco's own document-formatting contract (it applies the worker's returned edits or
none). We add explicit tests rather than new code:

1. **Contracts** — exhaustiveness/coherence (D6), `documentFormatting` split (D1),
   `FORMATTING_ELIGIBLE_LANGUAGES` ↔ registry coherence (D7), `isBuiltinFormattingAvailable` truth
   table.
2. **Editor (jsdom/node)** — `formattingAvailable` derivation (D3) per language; status `formatting`
   field wording + non-live (D4); the bridge still returns `EMPTY_EDITS` on the failure modes (AC3/AC4
   regression pins).
3. **UI (jsdom)** — Format button `aria-disabled`/`aria-label` and the status field agree for a
   `monaco-builtin`, a `keiko-language-service`, and a `"none"` language (AC5).
4. **Browser e2e (D4 deliverable)** — packaged-app Playwright spec: open a representative file per
   formatting source, assert (a) correct language mode on open (AC1) and stable tokenization/theme
   after reload (AC2), (b) Format applies deterministic edits for a `monaco-builtin` and the
   `keiko-language-service` set and the button is **disabled** for a `"none"` language with status
   reading unavailable (AC5), (c) a forced formatting failure leaves content byte-identical (AC4).
   Mirrors the editor-baseline e2e harness (separate playwright config, coordinator evidence; not a
   gating `@smoke` test unless promoted).

### D9 — Scope boundaries confirmed; all changes additive

We will **not**, in this issue: add format-on-save; enable any in-browser model-based governed
formatter; start an external LSP process; add deep semantic refactoring; or route yaml/markdown
formatting through a non-explicit path. No server change and no change to the language-service
capability **shape** are required: the registry is purely additive and editor-tier. Contract schema
versions stay `"1"` (D1 adds a new leaf module; no existing shape changes; D4 adds one optional input
field). If any implementor finds a change cannot be made additively, that is a blocker to raise — it
must not be resolved by a non-additive contract edit.

## Consequences

### Positive

- AC5 is fixed at its root: one registry-derived `formattingAvailable` value drives the button-enabled
  state, the button aria, and the new status field, so the command and status can never disagree and
  Format never silently no-ops (D3, D4).
- Browser formatting reachability gets one editor-tier source of truth, distinct from server
  capability — ending the "server can format yaml, browser can't" confusion (D1, D2).
- css/scss/less/html tokenize once the missing `basic-languages` imports are added (D5). Their
  browser formatters are no longer reachable in the current release artifact because Step 06 keeps
  the rich Monaco language workers out of the shipped static export.
- No double-registration risk: the Keiko bridge owns only the language-service set, pinned by a
  coherence test (D7).
- AC3/AC4 are satisfied by the proven #1201 failure-safe path for the language-service set — added
  tests, not new risk (D8).
- The two contract leaves cannot silently diverge (D6).

### Negative

- One new contracts leaf and one optional status-input field widen the surface slightly (D1, D4).
- The bootstrap gains four `basic-languages` imports, marginally increasing the editor chunk (D5).
  This is intrinsic to making css/scss/less/html actually tokenize — the cost buys AC1/AC2.
- The `documentFormatting` split is a curated judgement (which languages are "where safe"); a
  mis-classification surfaces as an over/under-advertised Format command, mitigated by D8's e2e per
  source.

### Neutral

- yaml/markdown (and python/java/go/rust/sql/shell) are now honestly `"none"` for browser formatting
  even though the server has a formatter — the explicit-browser-command scope of this issue (D9).
- `plaintext` remains an editor-only fallback, absent from both leaves (D6, ADR-0067 D5).
- The empirical css/html tokenization/formatter question (Context) is resolved operationally by D5 +
  D8 regardless of its current state; the design is correct either way.

## Out of Scope

- Format-on-save, model-based/in-browser governed formatting, external LSP process startup, deep
  semantic refactoring (issue scope, D9).
- Routing yaml/markdown/python/… browser formatting through any path (kept `"none"`, D1/D9).
- Any change to the server language-service capability shape or `runLanguageOperation()` (D9).
- Per-language bracket work — bracket matching/colourisation is already global (editor-options.ts).
- Any non-additive contract change or schema-version bump (D9).

## Acceptance-Criteria → decision mapping

- **AC1 (correct language mode on open)** — D5 (bootstrap registers every `syntaxHighlighting`
  language id, incl. css/scss/less/html) + existing `inferMonacoLanguageId`; D8 e2e pins it.
- **AC2 (theme/tokenization stable after reload)** — D5 (grammars registered once per session) + the
  existing on-mount theme registration (ADR-0042 D3); D8 e2e reload assertion.
- **AC3 (Format applies only provider-returned deterministic edits)** — already met by the #1201
  bridge for the language-service set and by Monaco's worker contract for the built-in set; D8 adds
  regression tests (D7, D8).
- **AC4 (formatting failure leaves content untouched)** — already met by the bridge's `EMPTY_EDITS`
  failure path; D8 adds a forced-failure e2e + jsdom pins (D8).
- **AC5 (status reflects unavailable formatting; command not hidden inconsistently)** — D1 registry +
  D3 gating + D4 single-derivation status/button/aria; D8 UI test pins agreement across all three
  sources.

### Deliverables

- **D1 (built-in provider capability entries)** → Decision D1 (the registry table).
- **D2 (explicit Format pipeline for available built-in providers)** → Decisions D3 + D7 (registry-
  gated command; Monaco built-in for json/css/html, Keiko bridge for ts/js, disjoint).
- **D3 (failure-safe edit application path)** → Decision D8 (reuse #1201 bridge + Monaco contract).
- **D4 (browser tests for language mode/theme stability)** → Decision D8 item 4 (packaged-app e2e).

## File ownership (disjoint, for parallel implementers)

| Area                     | Owner files (no overlap)                                                                                                                                                                             | Covers                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Contracts leaf           | `keiko-contracts/src/editor-builtin-capabilities.ts` (new); `keiko-contracts/src/index.ts` (barrel export block)                                                                                     | D1, D6 (table, helpers, exports) |
| Contracts tests          | `keiko-contracts/src/editor-builtin-capabilities.test.ts` (new)                                                                                                                                      | D1, D6, D7 coherence             |
| Editor status model      | `keiko-editor/src/components/status-bar.ts` (+ `.test.ts`)                                                                                                                                           | D4 status `formatting` field     |
| Editor formatting wiring | `keiko-editor/src/components/formatting-bridge.ts` (`FORMATTING_ELIGIBLE_LANGUAGES` ↔ registry coherence only) (+ `.test.ts`)                                                                        | D7 (no double-registration)      |
| UI gating + bootstrap    | `keiko-ui/.../cards/editorMonacoRuntime.ts` (basic-languages imports); `keiko-ui/.../cards/EditorRuntimeWidget.tsx` (`formattingAvailable` derivation, Format button aria, status `formatting` feed) | D3, D4, D5                       |
| UI tests                 | `keiko-ui/.../cards/EditorRuntimeWidget.*.test.tsx` (+ a bootstrap-registration test)                                                                                                                | D3, D4, D5 (jsdom)               |
| Browser e2e              | `tests/e2e/editor-formatting-1380.spec.ts` + `playwright.issue-1380-*.config.ts` (new)                                                                                                               | D8 item 4 (AC1/AC2/AC4/AC5)      |

Cross-cutting note: the registry is the single value all four consuming areas import; only the
contracts-leaf owner edits it. The `FORMATTING_ELIGIBLE_LANGUAGES` set and the registry's
`keiko-language-service` entries are kept equal by the coherence test (D7), so the editor-formatting
owner and the contracts owner do not need to coordinate beyond that pin.

## Alternatives Considered

### Alternative 1: Drive the Format command from the existing server capability set (status quo, fix nothing)

- **Pros**: zero new code; one capability source.
- **Cons**: this _is_ the AC5 defect — the server advertises formatting for yaml/markdown that the
  browser cannot reach, so the button is enabled and silently no-ops. Server capability is not browser
  reachability.
- **Why rejected**: it cannot satisfy AC5; the inconsistency is structural, not cosmetic.

### Alternative 2: Extend `EditorLanguageMode` (the mode map) with `documentFormatting`/bracket fields

- **Pros**: no new module; one editor-language table.
- **Cons**: the mode map is the **server-shared** source-language universe; adding browser-only
  formatting-reachability semantics pushes editor-tier meaning into a table the server reads and
  invites a future server consumer to misread `documentFormatting` as server capability — re-creating
  the very confusion this ADR removes. Couples two independently-evolving concerns.
- **Why rejected**: violates separation of concerns / single-reason-to-change; the sibling leaf (D2)
  keeps each universe honest. Coherence is preserved by test, not by conflation.

### Alternative 3: Register the Keiko formatting bridge for json/css/html too (one formatter path for everything)

- **Pros**: a single, uniformly-governed formatting path; one failure-safe implementation.
- **Cons**: would require either shipping rich Monaco json/css/html workers again or adding governed
  server providers for those languages; both are outside the current release packaging budget and
  explicit-command scope.
- **Why rejected**: it would reopen the language-worker packaging decision or add new governed
  provider scope. D7 keeps non-language-service languages out of the bridge until that work is
  explicitly accepted.

### Alternative 4: Lazily register css/scss/less/html grammars on first open instead of at bootstrap

- **Pros**: smaller initial editor chunk; pay only for languages actually opened.
- **Cons**: introduces an async/ordering window where the first open of a css file may mount before its
  grammar is registered (AC1 flake), and complicates the once-per-session theme/tokenization stability
  the bootstrap guarantees (AC2). The `basic-languages` contributions are small and the editor is
  already a heavy dynamic chunk.
- **Why rejected**: the determinism of AC1/AC2 (correct mode on open, stable after reload) is worth
  more than the marginal chunk saving; bootstrap registration is the proven pattern already used for
  the other ten languages (D5).

## Related

- ADR-0019: Modular package architecture — leaf-package rules and browser/Node dependency direction.
- ADR-0042: keiko-editor package and boundaries — D3 (no-CDN Monaco bootstrap), D4 (server language
  service is the governed source of truth; the in-browser governed worker is disabled, hence the Keiko
  bridge for ts/js).
- ADR-0045: Staged multi-language LSP expansion — per-language owner boundary; unsupported safe-degrade.
- ADR-0067: Language capability registry and editor mode map — D1 (`EDITOR_LANGUAGE_MODE_MAP`, the
  source-language universe this registry sits beside), D5 (`plaintext` is the fallback, not a registry
  language).
- Issue #1380 (Epic #1491); Issues #1196 (Monaco bootstrap), #1198/#1201 (deterministic formatting +
  the failure-safe bridge), #1205 (status bar).
