# ADR-0067: Language capability registry and editor mode map

## Status

Proposed (2026-06-25). Pending human review. Authored for Issue
[#1379](https://github.com/oscharko-dev/Keiko/issues/1379) (Parent Epic
[#1491](https://github.com/oscharko-dev/Keiko/issues/1491)).

## Date

2026-06-25

## Version

1

## Context

Issue #1379 (Epic #1491) asks for "the authoritative registry for language id, file-extension
matching, syntax support, diagnostics, hover, completion, symbols, formatting, code actions,
availability, and unavailable reason," with four acceptance criteria: (AC1) the editor UI no longer
relies on TypeScript/JavaScript-only gates; (AC2) every *known* language returns a structured
provider state; (AC3) an unsupported language degrades to syntax/plain-text without exceptions; and
(AC4) provider availability is consumable by future agent snapshots.

Most of this surface already exists end-to-end (Epic #1189 / #1198 / #1201, planned forward by
ADR-0045). This is therefore a **reuse-and-ratify** issue that closes a small number of real gaps,
not a build-new. The current state, confirmed by reading the code, is:

- **Contract (leaf, ADR-0019).** `keiko-contracts/src/language-service.ts` defines
  `LANGUAGE_SERVICE_SCHEMA_VERSION = "1"`, the executable operation union
  `LanguageServiceOperation = diagnostics | completion | hover | symbols | formatting` (no
  `codeActions`, no `syntax`), `LanguageProviderDescriptor` (`{ id, languages[], operations[],
  availability, unavailableReason? }`), `LanguageProviderAvailability = "available" | "unavailable"`,
  and `LanguageServiceCapabilities { schemaVersion, providers[] }`. The module is a strict leaf: pure
  types, frozen const tables, and throw-free validators only; no `@oscharko-dev/keiko-*` imports, no
  clock/crypto/randomness.
- **Server registry (single source of truth, ADR-0042 D4).**
  `keiko-server/src/editor/languageProvider.ts` defines `LanguageProviderRegistry`
  (`resolve(languageId)`, `describe()`) and `createLanguageProviderRegistry(providers,
  unavailableProviders = [])`. `languageService.ts` wires `defaultRegistry` (TypeScript + JSON +
  builtin-text providers, plus `unavailableExternalLspDescriptors()` for
  python/java/go/rust/shell/sql), exposes `describeLanguageCapabilities()`, and
  `runLanguageOperation()` returns `UNSUPPORTED_LANGUAGE` when no provider resolves and
  `UNSUPPORTED_OPERATION` when the operation is not advertised. `builtinLanguageProviders.ts` holds
  the JSON and builtin-text providers and the unavailable external LSP descriptors.
- **BFF route.** `languageRoutes.ts` `handleEditorLanguageCapabilities()` serves
  `GET /api/editor/language/capabilities`; `UNSUPPORTED_LANGUAGE` maps to HTTP 422.
- **Editor mode map (browser tier).** `keiko-editor/src/monaco/language-inference.ts` owns
  `MONACO_LANGUAGE_IDS` (16 ids including `plaintext`), `MONACO_LANGUAGE_BY_EXTENSION` (extension to
  id, with `tsx -> typescript` and `jsx -> javascript` folding), and `inferMonacoLanguageId` (with a
  `plaintext` fallback). `keiko-editor/src/languages.ts` derives `SUPPORTED_EDITOR_LANGUAGES`. The
  server does **not** import `keiko-editor` in production code, so any language universe the server
  needs cannot come from `keiko-editor`.
- **Capability-driven UI.** `EditorRuntimeWidget.tsx` already gates intelligence on the registry:
  `providerForLanguage(capabilities, languageId)`, `providerOperationEnabled(provider, op)`, the
  enabled gates for completion/diagnostics/hover/symbols/formatting, and the status-bar
  `languageService` field. It seeds `BOOTSTRAP_LANGUAGE_CAPABILITIES` (TypeScript-only) before the
  `GET` resolves.
- **Agent snapshot (AC4 target).** `keiko-contracts/src/editor-agent.ts` defines
  `EDITOR_AGENT_SCHEMA_VERSION = "1"` and `EditorAgentSessionSnapshot`, which has a
  `diagnosticsSummary` field but no provider/capability field; `isEditorAgentSessionSnapshot`
  validates declared optional fields with an `isUndefinedOr` precedent and tolerates extra keys. The
  snapshot is built UI-side in `registerAgentSnapshot`, posted, and round-tripped server-side through
  `parseEditorAgentSnapshotRequest` -> `registerSnapshot` (consumed by #1391-#1395).

The true state of the four acceptance criteria:

- **AC1 — effectively met.** The UI is registry-driven; the residuals are cosmetic: a stale comment
  ("intelligence remains TS/JS-gated below", now false), the TypeScript-only bootstrap seed, and an
  inline null-synthesis (`{ providerId: null, available: false, unavailableReason: "No provider
  configured" }`) used when `providerForLanguage` returns `null`.
- **AC2 — not met (central gap).** `registry.describe()` is **not exhaustive over the known-language
  universe**. A known editor mode-map language with no provider (notably `plaintext`, and any future
  mode-map id) yields `null` from `providerForLanguage`, so the UI must inline-synthesise a state.
  AC2 ("every known language returns a structured provider state") is false at the registry layer.
- **AC3 — structurally met.** `runLanguageOperation()` returns `UNSUPPORTED_LANGUAGE` with no throw;
  the editor renders Monaco syntax highlighting regardless. It lacks an explicit pinned test.
- **AC4 — not met (real gap).** No capability field exists on `EditorAgentSessionSnapshot`.

Forces: contract changes must be **additive** and must hold both schema versions at `"1"`; the leaf
rule and dependency direction (browser imports no Node-domain values; server does not import the
editor package) must not weaken; and we must not add speculative executable surface (no provider
implements code actions).

## Decision

### D1 — One canonical, frozen "editor language mode map" in the contracts leaf

We will add a single canonical, frozen const table to `keiko-contracts` describing the known
**source-language** universe shared by the browser and the server. New leaf module
`keiko-contracts/src/editor-language-mode-map.ts`:

```ts
export interface EditorLanguageMode {
  readonly languageId: string;                  // canonical source-language id (e.g. "typescript")
  readonly fileExtensions: readonly string[];   // lower-case, no leading dot ("ts","tsx",...)
  readonly syntaxHighlighting: boolean;         // editor can locally tokenise/colour this language
}

export const EDITOR_LANGUAGE_MODE_MAP: readonly EditorLanguageMode[];             // frozen
export const EDITOR_LANGUAGE_MODE_IDS: readonly string[];                         // derived, frozen
export const EDITOR_LANGUAGE_MODE_BY_EXTENSION: Readonly<Record<string, string>>; // derived, frozen
export function inferEditorLanguageModeId(pathOrName: string): string | null;     // pure; null = unknown
export function isEditorLanguageModeId(value: string): value is string;           // pure guard
```

The table is the authoritative answer to the issue's "language id," "file-extension matching," and
"syntax support" dimensions. It enumerates exactly the source languages the product knows:
`typescript`, `javascript`, `json`, `css`, `scss`, `less`, `html`, `markdown`, `yaml`, `python`,
`java`, `go`, `rust`, `sql`, `shell` — the present `MONACO_LANGUAGE_IDS` minus `plaintext`.
`plaintext` is deliberately **excluded** from the mode map (see D5): it is the editor's render
fallback, not a known source language the registry advertises. This module stays a strict leaf: pure
const tables and pure functions, no imports, no clock/crypto/randomness, fully type-only-importable
from the browser tier (ADR-0019).

### D2 — `keiko-editor` derives its mode map from the canonical table

We will consolidate the divergent map. `keiko-editor/src/monaco/language-inference.ts` will derive
`MONACO_LANGUAGE_BY_EXTENSION` and `MONACO_LANGUAGE_IDS` from `EDITOR_LANGUAGE_MODE_MAP` /
`EDITOR_LANGUAGE_MODE_BY_EXTENSION` (a value re-projection over the contract const), then append the
editor-only `plaintext` id and keep `inferMonacoLanguageId` returning the `plaintext` fallback. The
observable behaviour of `inferMonacoLanguageId`, `isMonacoLanguageId`, `fileExtension`, and
`SUPPORTED_EDITOR_LANGUAGES` is **unchanged** — the canonical table is seeded with exactly today's
extension set (including the `tsx -> typescript` / `jsx -> javascript` fold). A parity test pins
old-behaviour == new-behaviour for every current extension so the consolidation is mechanical and
cannot silently drift the tested inference.

### D3 — The server registry becomes exhaustive over the canonical mode map

We will make `describeLanguageCapabilities()` exhaustive so AC2 is true **at the registry layer**,
not by UI patching. The server derives its known-language universe from the same canonical contract
const (`EDITOR_LANGUAGE_MODE_IDS`) — not from `keiko-editor`, preserving the dependency direction. In
`keiko-server/src/editor/languageService.ts`, `describeLanguageCapabilities()` will:

1. collect the descriptors from `registry.describe()` (available providers + the unavailable external
   LSP descriptors) and the set of languages they already cover;
2. for every `EDITOR_LANGUAGE_MODE_ID` not covered by any descriptor, emit a synthetic
   `availability: "unavailable"` descriptor with a distinct, content-free `unavailableReason`
   (a new exported constant, e.g. `NO_PROVIDER_UNAVAILABLE_REASON = "No language provider is
   configured for this language."`), `id: "none"`, `operations: []`.

After D3, `providerForLanguage(capabilities, languageId)` returns a descriptor for **every** known
language id, never `null`. The synthesis is additive and read-only; it changes no operation-execution
path. `runLanguageOperation()` is untouched: an unmatched/`unavailable` language still yields
`UNSUPPORTED_LANGUAGE` (AC3), so the registry can advertise a language as "known but unavailable"
without ever fabricating an execution.

### D4 — UI: remove the inline null-synthesis and the stale gate language

We will:

- delete the inline null-synthesis branch in `EditorRuntimeWidget.tsx` (status-bar `languageService`
  field) and read provider state directly from the now-exhaustive descriptor (the `null` branch is
  retained only for the genuinely-unknown/`plaintext` case, which is intentionally not a registry
  language, D5);
- fix the stale comment at the `inferEditorLanguage` helper ("intelligence remains TS/JS-gated
  below" is false; intelligence is registry/capability-gated).

We deliberately **retain** the TypeScript-seeded `BOOTSTRAP_LANGUAGE_CAPABILITIES` rather than
reseeding it all-`unavailable`. Monaco language providers are registered **once per editor mount**
(`use-editor-handlers.ts`: the `provide*` resolvers are read at `onMount` and a newly-available
provider is picked up only on a fresh mount), and `editorSurfaceKey` includes the resolved provider
id, so the editing surface remounts when the provider id changes. Seeding the primary
TypeScript/JavaScript provider as available keeps the provider id stable across the bootstrap → `GET`
transition for the common case, so the primary surface registers its intelligence at first mount and
does not re-initialise Monaco when capabilities load. An all-`unavailable` seed would force that
remount on every TypeScript file open — a user-visible regression — for no acceptance-criteria gain:
AC1 is satisfied by `providerOperationEnabled` reading the exhaustive server registry, not by the
transient seed, which the `GET` response supersedes for every language within one round-trip.

`providerForLanguage` / `providerOperationEnabled` keep their signatures (they already tolerate a
descriptor return). This is a small UI tidy-up; no product behaviour changes.

### D5 — `plaintext` and unknown languages are the editor's safe-degrade fallback, not registry languages

We will keep the AC3 boundary explicit: a language that is **not** a canonical mode-map id (unknown
extension, dotfile, extension-less buffer, or `plaintext`) is rendered by Monaco as plain text and
receives no governed intelligence. `inferEditorLanguageModeId` returns `null` for these;
`inferMonacoLanguageId` returns `plaintext`. The server has no descriptor for them and
`runLanguageOperation()` returns `UNSUPPORTED_LANGUAGE` without throwing. AC2 ("every *known*
language") and AC3 ("*unsupported* degrades to plain text") are therefore disjoint and both true:
"known" is exactly the mode-map id set; everything else degrades. A new pinned test asserts the
degrade path raises no exception.

### D6 — AC4: additive, content-free `languageCapability` field on the agent snapshot

We will add one additive **optional** field to `EditorAgentSessionSnapshot`:

```ts
readonly languageCapability?: {
  readonly languageId: string;
  readonly providerId: string | null;     // null when no provider serves the language
  readonly available: boolean;
  readonly unavailableReason?: string | undefined; // short reason string only
} | null;
```

It mirrors `diagnosticsSummary`: additive, optional, content-free (ids/booleans/short reason strings
only — never buffer text). `EDITOR_AGENT_SCHEMA_VERSION` stays `"1"`. `isEditorAgentSessionSnapshot`
gains one clause, `isUndefinedOr(value.languageCapability, isLanguageCapability)`, following the
existing `isUndefinedOr` precedent, so old snapshots (field absent) still validate and round-trip
through `parseEditorAgentSnapshotRequest` -> `registerSnapshot` unchanged. The UI's
`registerAgentSnapshot` populates the field from the active descriptor it already computes
(`providerForLanguage` + `providerOperationEnabled`). Frozen consumers #1391-#1395 are unaffected
because the field is optional and additive.

### D7 — Code actions are reserved/deferred, not added as executable surface

We will **not** add `codeActions` to the executable `LanguageServiceOperation` union, and will **not**
add a declaration-only code-actions capability field, in this issue. Adding `codeActions` to the
union would force a `getCodeActions` method on every `LanguageProvider`, a `runOperation` switch
branch, a request envelope variant, and validation — a speculative executable path with no
implementor (no provider serves code actions today). Adding a declaration-only flag with no consumer
is also speculative surface. We document code actions as a **reserved future capability deferred to
the staged-LSP work (ADR-0045)**: when an LSP provider that implements code actions is registered, a
future issue adds `codeActions` to the union additively (as a new string member, bumping no existing
shape) alongside its real implementor. The scope boundary is intentional and stated here so reviewers
see it is a deliberate omission, not an oversight.

### D8 — Version discipline: all changes additive

Every contract change above is additive. `LANGUAGE_SERVICE_SCHEMA_VERSION` stays `"1"` (D1 adds a new
leaf module and D3 only adds synthetic descriptors at runtime — no shape change to
`LanguageServiceCapabilities` or `LanguageProviderDescriptor`). `EDITOR_AGENT_SCHEMA_VERSION` stays
`"1"` (D6 adds one optional field). If any implementor finds a change cannot be made additively, that
is a blocker to raise before proceeding — it must not be resolved by a non-additive contract edit.

## Consequences

### Positive

- AC2 becomes true **at the registry layer**: `describeLanguageCapabilities()` is exhaustive over the
  canonical mode map, so `providerForLanguage` never returns `null` for a known language and the UI's
  inline null-synthesis is removed (single source of truth restored — D3, D4).
- The "editor mode map" gains one canonical home (D1). The browser and the server agree on the
  known-language universe by construction, eliminating the divergent-map drift risk between
  `keiko-editor` and the server.
- AC4 is satisfied by a content-free, additive snapshot field (D6); agents can read provider
  availability without a schema bump and without any buffer content.
- The issue's "file-extension matching" and "syntax support" dimensions are answered by data in the
  canonical table (D1), not by code scattered across packages.
- AC3 gains an explicit pinned regression test (D5).
- Code actions are handled with zero speculative surface (D7).

### Negative

- `keiko-editor`'s mature, tested inference map is re-homed to derive from the contract (D2). This is
  the highest-risk change; it is contained by a parity test pinning current behaviour, but it touches
  a stable file.
- The capabilities payload grows by the count of synthetic `unavailable` descriptors (one per known
  language with no provider). This is a small, bounded list and is read-only.
- One more optional field on the agent snapshot widens the snapshot surface slightly (D6).

### Neutral

- The UI bootstrap seed is retained (TypeScript-seeded) to keep the primary editing surface from
  remounting when capabilities load, given Monaco's once-per-mount provider registration (D4). The
  seed is transient and superseded by the `GET` response for every language.
- `plaintext` remains an editor-only id, intentionally absent from the registry (D5).

## Out of Scope

- Implementing any new language provider or any LSP integration (ADR-0045 staged-LSP work).
- Adding `codeActions` as an executable operation or a declaration-only flag (D7; reserved for
  ADR-0045 follow-up).
- Changing `runLanguageOperation()` behaviour, the BFF route, or the 422 mapping.
- Any non-additive contract change or any schema-version bump (D8).
- Refactoring the existing TypeScript/JSON/builtin-text providers' logic.

## Alternatives Considered

### Alternative 1: Patch AC2 in the UI (keep returning null, synthesise state in the widget)

- **Pros**: smallest diff; no server or contract change.
- **Cons**: leaves AC2 false at the registry layer — "every known language returns a structured
  provider state" would be a UI fiction, not a registry guarantee; duplicates the unavailable-state
  shape in the browser; future agents (AC4) and any other consumer would each have to re-synthesise.
- **Why rejected**: the issue's intent is an *authoritative registry*. Making AC2 true only in one
  consumer violates single-source-of-truth and ADR-0042 D4; it would re-emerge as drift the next time
  a consumer reads capabilities.

### Alternative 2: Put the known-language universe in `keiko-editor` and have the server import it

- **Pros**: the mode map already lives in `keiko-editor`; no new contract module.
- **Cons**: the server does not (and per ADR-0042/ADR-0019 should not) depend on the browser editor
  package; this would invert the dependency direction and pull a Node-domain consumer onto a
  browser-tier package.
- **Why rejected**: violates dependency direction. The shared leaf (`keiko-contracts`) is the only
  correct home for a universe both tiers must agree on (D1).

### Alternative 3: Add `codeActions` to the executable operation union now

- **Pros**: literally satisfies the issue's enumerated "code actions" dimension in the executable
  contract; future-proofs the union.
- **Cons**: forces a `getCodeActions` on every provider, an orchestrator branch, a request envelope,
  and validation — all dead until an LSP provider implements code actions; this is speculative
  executable surface that the quality bar forbids (no implementor, designed for a hypothetical).
- **Why rejected**: premature; code actions are deferred to ADR-0045's staged-LSP work and can be
  added additively then, with their real implementor (D7).

### Alternative 4: Model `plaintext` as a registry language with an "available, syntax-only" descriptor

- **Pros**: makes `plaintext` symmetric with other languages; no special-case in the UI.
- **Cons**: blurs the AC2/AC3 boundary (every unknown buffer is "plaintext", so the registry would be
  asserting a provider for the catch-all fallback); risks an "available" descriptor that serves no
  operation, which the UI gates would still render as nothing.
- **Why rejected**: `plaintext` is the *fallback for unsupported*, which is exactly AC3's domain;
  keeping it out of the registry keeps "known" (AC2) and "unsupported" (AC3) disjoint and honest (D5).

## Related

- ADR-0019: Modular package architecture — leaf-package rules and browser/Node dependency direction.
- ADR-0042: keiko-editor package and boundaries — D4 (server language service is the single governed
  source of truth; the in-browser Monaco worker is disabled for governed features).
- ADR-0045: Staged multi-language LSP expansion — D1 (no new package; languages register as
  providers), D5 (`UNSUPPORTED_LANGUAGE` safe-degrade, per-language owner boundary); the home for the
  deferred code-actions capability.
- ADR-0059: Agent editor public contracts — `EDITOR_AGENT_SCHEMA_VERSION` discipline and additive
  optional fields.
- Issue #1379 (Epic #1491); Epic #1189 / #1198 / #1201 (the existing registry, providers, formatting).
