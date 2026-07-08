# ADR-0119: Language navigation and refactoring contract expansion

## Status

Accepted (Built-in editor M1 navigation and refactoring milestone)

## Version

0.1.0

## Context

Epic [#2089](https://github.com/oscharko-dev/Keiko/issues/2089) extends the built-in editor from a
text-oriented coding surface into an IDE-like surface for TypeScript and JavaScript. The existing
deterministic language-service contract in
[`language-service.ts`](../../packages/keiko-contracts/src/language-service.ts) covered five
operations: diagnostics, completion, hover, symbols, and formatting. It did not expose the operation
family required for go-to-definition, find references, rename, quick fixes, or signature help.

ADR-0042 decision D4 already places governed language intelligence on the server, model-free and
deterministic. ADR-0067 records the provider capability registry and source-language mode map.
ADR-0068 records browser built-in language features and formatting reachability. ADR-0058 governs
review-before-apply mutation. This ADR amends ADR-0067 and ADR-0068 only where the executable
language operation vocabulary grows; it does not relax any trust boundary.

## Decision

### D1 - Six operations are added to the existing provider-pluggable vocabulary

`LanguageServiceOperation` and `LANGUAGE_SERVICE_OPERATIONS` gain these additive members:
`definition`, `references`, `renamePrepare`, `renameApply`, `codeActions`, and `signatureHelp`.
The existing `LanguageProviderDescriptor.operations` list remains the capability advertisement
mechanism. A provider registers support by listing operations it actually serves; adding operation
members does not create a second registry or a TypeScript-only route.

The request contract stays a flat discriminated union. Definition, references, rename prepare,
rename apply, and signature help carry a source position. Code actions carry a source range and the
diagnostics already known for that range. Rename apply also carries `newName`.

### D2 - Cross-file results carry explicit root-relative locations

Definition and references results return `LanguageLocation` values with a root-relative `path` and a
`LanguageRange`. Consumers must never infer that a result belongs to the requesting document.
References additionally report whether declaration locations are included, matching the LSP
semantic that UI bridges need for Shift+F12 behavior.

### D3 - Rename is split into prepare and apply, and apply is review-only

Rename is deliberately modeled as two operations:

- `renamePrepare` validates whether a position is renameable and returns either a placeholder range
  plus display text or a negative result with no range and a reason.
- `renameApply` computes a `LanguageRenameChangeset`. It never writes to a file or buffer.

The changeset groups edits by root-relative file path, carries an `expectedContentHash` precondition
per file, and reports result truncation separately for dropped edits and dropped files. It also
carries returned/total file and edit counts so review surfaces and verification evidence can prove
that truncation occurred without exposing dropped content. This reuses the editor-agent precondition
and conflict model from ADR-0058 instead of creating a parallel stale write scheme. Any later accept
path must present the changeset for explicit human review before any buffer mutation; saving remains
a separate explicit user action.

### D4 - Resource caps are part of the contract

`LanguageServiceLimits` gains concrete caps for definition locations, reference locations, code
actions, signatures, rename changeset files, and rename changeset edits. Providers must truncate
with explicit flags rather than return unbounded payloads or silently omit results. Code actions and
signature help additionally carry returned/total counts, and rename changesets carry returned/total
file and edit counts, because these are the capped result families that feed review or user-visible
choice surfaces in the M1 milestone.

### D5 - Browser built-in capability tables and mode map are unaffected

`editor-language-mode-map.ts` remains the source-language identity and extension map. It answers
which language a file uses, not which executable language-service operations are available.

`editor-builtin-capabilities.ts` remains the browser-tier local capability table for syntax,
bracket behavior, and document-formatting reachability. None of the six new operations is a
Monaco-builtin operation in Keiko's governed model: Monaco registers browser-side provider bridges,
but the computation remains server-side. Therefore this ADR does not add fields to either table and
does not change their semantics.

### D6 - Deterministic, same-origin, model-free execution remains mandatory

All six operations continue through the same same-origin `/api/editor/language` family. The browser
tier gains no new network destination, does not run a language server, and does not call a model.
Future external LSP providers may advertise these same operation strings under ADR-0069, but this
milestone keeps TypeScript and JavaScript in process and default-off external LSP posture unchanged.

## Consequences

Positive:

- The language operation family is schema-first and shared by contracts, server dispatch, editor
  bridges, and tests.
- Cross-file navigation and rename can be represented without leaking absolute host paths.
- Multi-file rename is impossible to confuse with an immediate write because the only contract
  surface is a reviewable changeset.
- Later LSP providers can register the same operations without a second UI vocabulary.

Negative / neutral:

- The contract grows before every operation has end-to-end UI reachability. Capability advertisement
  and route dispatch must continue to reject unsupported operation/provider pairs.
- The resource caps are conservative defaults. A later performance closeout may tune them, but it
  must preserve bounded behavior and explicit truncation.

## Related

- [ADR-0042](ADR-0042-keiko-editor-package-and-boundaries.md) - server-side deterministic language
  intelligence and browser/package boundaries.
- [ADR-0058](ADR-0058-safe-apply-edits-and-patch-workflow.md) - review-before-apply mutation and
  conflict preconditions.
- [ADR-0067](ADR-0067-language-capability-registry-and-editor-mode-map.md) - language capability
  registry and mode map.
- [ADR-0068](ADR-0068-builtin-editor-language-features-and-formatting-baseline.md) - browser
  built-in language features and formatting baseline.
- Epic [#2089](https://github.com/oscharko-dev/Keiko/issues/2089) and child issue
  [#2099](https://github.com/oscharko-dev/Keiko/issues/2099).

## Date

2026-07-08
