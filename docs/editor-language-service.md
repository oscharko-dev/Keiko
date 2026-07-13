# Deterministic editor language service

Issue [#1198](https://github.com/oscharko-dev/Keiko/issues/1198) · Parent epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189) · Decision record
[ADR-0042 D4](adr/ADR-0042-keiko-editor-package-and-boundaries.md).

The Keiko Editor needs a reliable, model-free baseline for completion, diagnostics, hover, and symbol
features before AI assistance is layered on top. This document describes the deterministic language
service that provides that baseline.

## What it is

A **keiko-server module** (`packages/keiko-server/src/editor/`) — not a new package — that is the
single governed source of truth for deterministic language intelligence (ADR-0042 D4). It never calls
a model and never routes through the Model Gateway. The in-browser Monaco `ts.worker` stays disabled
for governed features; this server module answers them.

The module exposes one BFF route family:

| Method + path                           | Purpose                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /api/editor/language`             | Run one operation (`diagnostics`, `completion`, `hover`, `symbols`) over an editor overlay. |
| `GET /api/editor/language/capabilities` | Advertise a structured provider state for every known language (exhaustive — see below).    |

The wire contracts live in `@oscharko-dev/keiko-contracts` (`language-service.ts`) and are imported
type-only by the browser tier. They are kept disjoint from the editor-session namespace
([#1197](https://github.com/oscharko-dev/Keiko/issues/1197)).

## Guarantees

- **Deterministic and model-free.** Given the same overlay and position, the result is identical. No
  model call, no network, no Gateway. (Acceptance criterion: completion works for TypeScript/
  JavaScript without a model call.)
- **Overlay-aware.** Analysis runs over the in-editor buffer supplied in the request, so diagnostics
  reflect unsaved edits rather than the on-disk file.
- **Workspace-contained.** The workspace root is resolved through the same realpath + deny-list guard
  the files routes use (`resolveRoot`), and every file the language service reads is forced through
  the audited `keiko-workspace` filesystem port behind a `containedRealPathInfo` check. A path that
  escapes the registered root — including via a symlink — is denied; the only files read outside the
  root are the TypeScript compiler's own `lib.*.d.ts` runtime libraries.
- **Bounded and cancellable.** Each operation runs under a wall-clock deadline and an `AbortSignal`;
  a pathological program yields `TIMED_OUT` and a disconnected client yields `CANCELLED` rather than
  blocking the loopback BFF. Document size, completion/diagnostic/symbol counts, and per-string
  lengths are all capped (`DEFAULT_LANGUAGE_SERVICE_LIMITS`).
- **Sanitised for display.** Every string crossing to the browser is stripped of bidi, zero-width,
  and control characters and clipped to its cap, then run through the BFF live-payload redactor.
- **Reuses workspace search policy.** The first release is document-anchored and performs no
  repository search. Any future repository search added for language intelligence (for example a
  workspace-symbol index) must go through the existing `keiko-workspace` search policy, limits,
  ignore rules, and diagnostics (`searchText` / `findFiles`) — it must not re-implement repository
  search inside the editor or language-service module.

## Provider-pluggable architecture

The contracts name no concrete language. A **provider** declares the `languages` and `operations` it
serves (`LanguageProviderDescriptor`); a registry resolves a request's `languageId` to its provider.
Adding a language is a registration, never a contract change.

```
LanguageServiceRequest ──▶ registry.resolve(languageId) ──▶ LanguageProvider ──▶ sanitised result
```

### First release: TypeScript / JavaScript

The first deterministic provider is backed by the TypeScript language service and serves
`typescript`, `typescriptreact`, `javascript`, and `javascriptreact`. It discovers the nearest
`tsconfig.json` inside the workspace root (following `extends` through the contained reader, without
enumerating the project) and runs completion, diagnostics, hover/quick info, and document symbols
over the overlay.

`typescript` therefore becomes a runtime dependency of the bundled product (it was previously a
build-time-only dependency). It is declared in both `@oscharko-dev/keiko-server` and the root package
so it is present in the published closure (the root uses `bundleDependencies`, which does not bundle a
package's third-party dependencies — ADR-0021 D1). The compiler runs server-side only, model-free and
offline.

During the TypeScript 7 transition, this runtime dependency remains the stable TypeScript 6
programmatic API. Root and package-reference compilation use the separate development-only native
TypeScript 7 compiler. The role split, identity gate, upgrade sequence, and rollback procedure are
defined in the [TypeScript toolchain contract](typescript-toolchain.md).

### Staged expansion to other languages (#1213/#1381/#1382, governed by ADR-0045 and ADR-0069)

Deep deterministic intelligence for additional languages is a **staged expansion** tracked by
[#1213](https://github.com/oscharko-dev/Keiko/issues/1213), [#1381](https://github.com/oscharko-dev/Keiko/issues/1381),
and [#1382](https://github.com/oscharko-dev/Keiko/issues/1382), governed by
[ADR-0045](adr/ADR-0045-staged-multi-language-lsp-expansion.md), [ADR-0069](adr/ADR-0069-governed-lsp-process-manager.md),
and the companion [architecture blueprint](planning/keiko-editor-multi-language-expansion.md). Each
language attaches as a provider over its standard Language Server Protocol (LSP) server, bridged
through the server-side governed process manager. Keiko does not install or bundle these tools; see
the [host language provider setup guide](keiko-editor/host-language-providers.md) for operator
prerequisites and enterprise setup.

| Language | Standard LSP server                      |
| -------- | ---------------------------------------- |
| Java     | `jdtls` (Eclipse JDT LS)                 |
| Python   | `pyright-langserver`                     |
| Rust     | `rust-analyzer`                          |
| Go       | `gopls`                                  |
| Shell    | `bash-language-server` plus `shellcheck` |

Because the contracts are provider-pluggable, none of these require a contract change — only a new
provider registration. Monaco already provides multi-language syntax highlighting and editing today
([#1193](https://github.com/oscharko-dev/Keiko/issues/1193)), and AI completion is language-agnostic
through the Model Gateway
([#1199](https://github.com/oscharko-dev/Keiko/issues/1199)/[#1200](https://github.com/oscharko-dev/Keiko/issues/1200)).
The LSP bridge architecture (server-side, not browser-side), the provider-registration boundary, the
per-language security model, and the dependency-decision record are detailed in
[ADR-0045](adr/ADR-0045-staged-multi-language-lsp-expansion.md) and the companion
[architecture blueprint](planning/keiko-editor-multi-language-expansion.md).

## Capability registry and editor mode map (#1379)

Issue [#1379](https://github.com/oscharko-dev/Keiko/issues/1379) · Parent epic
[#1491](https://github.com/oscharko-dev/Keiko/issues/1491) · Decision record
[ADR-0067](adr/ADR-0067-language-capability-registry-and-editor-mode-map.md).

So that the UI and future agents stay provider-agnostic, the capability registry is the **single
authoritative source** for what each language supports — modelled at the contract boundary the way
LSP and VS Code model language features as capabilities.

### Canonical editor language mode map

The known **source-language** universe is a single frozen const table in `@oscharko-dev/keiko-contracts`
(`editor-language-mode-map.ts`, `EDITOR_LANGUAGE_MODE_MAP`). Each entry carries the canonical
`languageId`, its `fileExtensions` (the authoritative file-extension matching), and a
`syntaxHighlighting` flag (syntax support). It is a strict leaf — pure const tables and pure functions,
no other `keiko-*` imports. The browser editor's Monaco language inference
(`keiko-editor/src/monaco/language-inference.ts`) **derives** its extension map and id set from this
table (plus the editor-only `plaintext` render fallback), so the browser and the server agree on the
known-language universe by construction rather than through two divergent maps.

### Exhaustive capabilities — every known language returns a structured provider state

`GET /api/editor/language/capabilities` is **exhaustive** over the mode map. The server registry first
contributes the real providers (TypeScript/JavaScript, JSON, builtin-text) and the unavailable external
LSP descriptors (Python/Java/Go/Rust/shell/SQL); then, for every known mode-map language that no
descriptor already covers, `describeLanguageCapabilities()` synthesises a structured
`{ id: "none", operations: [], availability: "unavailable", unavailableReason }` descriptor. As a
result a consumer resolving a known `languageId` always receives a structured provider state, never a
missing entry. The UI gates each language action (completion, diagnostics, hover, symbols, formatting)
on the resolved descriptor's `availability` and advertised `operations` — never on a hard-coded
TypeScript/JavaScript check.

### Unsupported languages degrade safely

`plaintext` and any unknown extension are deliberately **not** registry languages: they are the
editor's plain-text render fallback. Monaco still tokenises/colours the buffer locally, every governed
operation is disabled (no provider resolves), and `runLanguageOperation()` returns
`UNSUPPORTED_LANGUAGE` without throwing. "Known" (a mode-map id) and "unsupported" (everything else)
are disjoint by design.

### Provider availability in agent snapshots

`EditorAgentSessionSnapshot` (`editor-agent.ts`) carries an additive, optional, **content-free**
`languageCapability` field — `{ languageId, providerId, available, unavailableReason? }` (ids, a
boolean, and a short reason string only; never buffer text) — so a future agent can read the active
file's provider availability from the snapshot without calling the capabilities route itself. The
field is additive and the agent-snapshot schema version is unchanged.

### Host provider detection (#1382)

The capabilities route is workspace-aware when called with a `root` query parameter. For Java, Python,
Go, Rust, and Shell providers, Keiko requires an explicit per-provider enable flag, detects the
required bare executable names on `PATH`, rejects workspace-local or symlink-escaped executables, and
reports a structured unavailable descriptor when a tool is missing, disabled, or blocked by policy.
Core editing remains available in every unavailable state.

Code-action capabilities are **not** modelled as an executable operation yet: no provider implements
them, so adding one would be speculative surface. They are reserved for the staged-LSP work
([ADR-0045](adr/ADR-0045-staged-multi-language-lsp-expansion.md)), to be added additively alongside a
real implementor.
