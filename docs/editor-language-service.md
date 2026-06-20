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
| `GET /api/editor/language/capabilities` | Advertise the registered providers and the operations each serves.                          |

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

### Staged expansion to other languages (#1213, governed by ADR-0045)

Deep deterministic intelligence for additional languages is a **staged expansion**, not part of the
first release, tracked by [#1213](https://github.com/oscharko-dev/Keiko/issues/1213) and governed by
[ADR-0045](adr/ADR-0045-staged-multi-language-lsp-expansion.md) with its companion
[architecture blueprint](planning/keiko-editor-multi-language-expansion.md). Each
language attaches as a new provider over its standard Language Server Protocol (LSP 3.17) server,
bridged through the out-of-process LSP path the epic already flags for dependency review
(`monaco-languageclient` or an out-of-process LSP host):

| Language | Standard LSP server      |
| -------- | ------------------------ |
| Java     | `jdtls` (Eclipse JDT LS) |
| Python   | `pyright` / `pylsp`      |
| Rust     | `rust-analyzer`          |
| Go       | `gopls`                  |

Because the contracts are provider-pluggable, none of these require a contract change — only a new
provider registration. Monaco already provides multi-language syntax highlighting and editing today
([#1193](https://github.com/oscharko-dev/Keiko/issues/1193)), and AI completion is language-agnostic
through the Model Gateway
([#1199](https://github.com/oscharko-dev/Keiko/issues/1199)/[#1200](https://github.com/oscharko-dev/Keiko/issues/1200)).
The LSP bridge architecture (server-side, not browser-side), the provider-registration boundary, the
per-language security model, and the dependency-decision record are detailed in
[ADR-0045](adr/ADR-0045-staged-multi-language-lsp-expansion.md) and the companion
[architecture blueprint](planning/keiko-editor-multi-language-expansion.md).
