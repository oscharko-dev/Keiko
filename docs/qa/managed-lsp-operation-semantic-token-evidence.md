# Managed LSP operation and semantic-token evidence

This document defines the release-evidence contract for Epic
[#2094](https://github.com/oscharko-dev/Keiko/issues/2094), child
[#2280](https://github.com/oscharko-dev/Keiko/issues/2280). It records the intended cross-language
operation matrix and semantic-token rollout decision. It does not itself prove implementation. Each
claim below becomes releasable only when the named implementation tests and required gates exist,
run against the current change, and pass without weakened assertions, limits, or coverage floors.

## Provider operation matrix

`Candidate` means the operation may be attempted after activation. Product support additionally
requires live capability negotiation, provider conformance, bounded sanitization, current health,
and a UI or agent consumer. `Out` is an explicit unsupported disposition and must degrade cleanly.

| Operation        | Python    | Go        | Shell     | Java      | Rust      |
| ---------------- | --------- | --------- | --------- | --------- | --------- |
| Diagnostics      | Candidate | Candidate | Candidate | Candidate | Candidate |
| Completion       | Candidate | Candidate | Candidate | Candidate | Candidate |
| Hover            | Candidate | Candidate | Candidate | Candidate | Candidate |
| Document symbols | Candidate | Candidate | Candidate | Candidate | Candidate |
| Formatting       | Out       | Candidate | Out       | Candidate | Candidate |
| Definition       | Candidate | Candidate | Candidate | Candidate | Candidate |
| Type definition  | Candidate | Candidate | Out       | Candidate | Candidate |
| Implementation   | Candidate | Candidate | Out       | Candidate | Candidate |
| References       | Candidate | Candidate | Candidate | Candidate | Candidate |
| Call hierarchy   | Candidate | Candidate | Out       | Candidate | Candidate |
| Inlay hints      | Candidate | Candidate | Out       | Candidate | Candidate |
| Prepare rename   | Candidate | Candidate | Out       | Candidate | Candidate |
| Rename           | Candidate | Candidate | Out       | Candidate | Candidate |
| Code actions     | Candidate | Candidate | Out       | Candidate | Candidate |
| Signature help   | Candidate | Candidate | Out       | Candidate | Candidate |

The matrix suite must iterate every cell. Every candidate must prove the correct LSP method,
capability intersection, dynamic registration and unregistration behavior where applicable,
sanitizer and size caps, malformed-response rejection, cancellation, stale-response handling, and
consumer mapping. Every `Out` cell must prove that an advertisement cannot widen the provider
surface and that the product presents a deterministic unsupported fallback. No standard LSP method
may be dispatched through a TypeScript-only branch.

The provider conformance suites are the source for candidate fidelity. Static descriptors, this
table, protocol readiness, and documentation are insufficient by themselves. A version change to a
provider invalidates its cells until fake-protocol conformance and the required offline real-server
measurement are refreshed.

## Review-only edit evidence

Rename and code-action tests must prove all of the following:

- every edit URI resolves to a canonical path inside the selected workspace;
- every changed document carries the expected-content hash used by the governed review path;
- file, edit, replacement, and aggregate byte caps fail closed and expose truncation explicitly;
- command-bearing actions and completion items cannot execute a command;
- create, rename, delete, and other resource operations are rejected;
- malformed, duplicate, overlapping, cross-workspace, symlink-escaping, and stale edits are rejected;
- results remain review artifacts until an explicit human-controlled save; and
- neither an LSP response nor `workspace/applyEdit` can modify or persist workspace files.

Mutation tests must fail when capability intersection, expected-content hash enforcement, response
caps, containment, truncation visibility, or review gating is removed.

## Semantic-token rollout

Only bounded full-document semantic-token responses are authorized. Delta requests, delta caches,
and partial response application remain out until measurements demonstrate value and a separate
stateful decoder contract is reviewed.

| Provider | Decision      | Required evidence                                                                                                                                                                                                                         |
| -------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust     | Enabled first | Provider conformance plus current sanitizer quality, latency, payload, large-file, cancellation, stale-version, and deterministic-fallback measurements within committed budgets; live use still requires negotiated real-server support. |
| Python   | Deferred      | Enable only after equivalent real Pyright measurements and provider-specific legend-quality evidence pass.                                                                                                                                |
| Go       | Deferred      | Enable only after equivalent real gopls measurements and provider-specific legend-quality evidence pass.                                                                                                                                  |
| Java     | Deferred      | Enable only after equivalent real JDT LS measurements and provider-specific legend-quality evidence pass under the Java safe-mode boundary.                                                                                               |
| Shell    | Out           | The proven Bash Language Server profile has no semantic-token candidate capability.                                                                                                                                                       |

Rust enablement is conditional on implementation evidence. If current conformance or sanitizer
measurement is absent, stale, over budget, or incompatible with the reviewed legend, the product
must report semantic tokens unsupported and retain syntax highlighting. Documentation cannot turn a
candidate or an unmeasured fake-server response into enabled production support.

## Full-response bounds and fallback

Implementation tests must cover, at minimum:

- empty and valid reviewed legends, unknown token types and modifiers, duplicate legend entries,
  excessive legend sizes, and malformed legend values;
- the five-integer token encoding, non-negative integer checks, arithmetic overflow, invalid line
  and start deltas, zero or excessive lengths, overlapping tokens, out-of-order positions, and
  tokens outside the current document;
- exact token-count, encoded-integer, response-byte, document-size, line-length, latency, and memory
  boundaries plus one unit beyond each limit;
- huge payloads that are rejected before unbounded allocation or editor registration;
- cancellation before dispatch, during the request, and during decode, with no late application;
- document-version changes before response, during decode, and before editor publication;
- timeout, process restart, capability removal, provider disablement, malformed response, large
  file, excessive payload, and unsupported-provider behavior; and
- replacement or clearing of an earlier semantic overlay when its capability or document version is
  no longer current.

Every failure discards the entire semantic response. The editor keeps its existing deterministic
syntax highlighting; it does not render a partial, stale, clipped, or last-known semantic overlay.
Fallback must be observable through a closed reason code and bounded counters, never through source
text or response content.

## Privacy and evidence shape

Semantic-token data, legends, document text, document URIs, source-derived token classifications,
request and response bodies, edit bodies, expected source contents, and provider diagnostics are not
persisted or emitted as evidence. No token cache survives the active document/version response.

Release evidence may contain only closed language and operation identifiers, provider and tool
versions, artifact hashes, fixture classes, bounded counts, durations, memory and payload sizes,
cancel/stale/fallback reason counters, gate names, and pass/fail outcomes. Measurements must avoid
workspace paths, endpoints, environment values, credentials, and customer content.

## Required implementation evidence

Acceptance requires failure-first regression tests for every #2280 acceptance criterion:

1. Shared dispatch tests prove type definition, implementation, call hierarchy, and inlay hints use
   standard negotiated LSP mappings and have bounded sanitizers.
2. The provider-by-operation matrix test proves every advertised cell and every explicit `Out`
   disposition.
3. Hostile rename and code-action tests prove containment, hash preconditions, visible truncation,
   review-only behavior, and no automatic save.
4. Contract, server, editor, and UI tests prove full-response semantic-token validation,
   cancellation, version safety, large-file fallback, and non-persistence.
5. The bounded Rust conformance and 10,000-token sanitizer profile supply current measured quality
   and budget evidence; the optional pinned real-provider smoke adds compatibility evidence. The
   other four providers retain the recorded decisions above.
6. Mutation tests prove that removing capability intersection, hash checks, token caps, version
   checks, containment, or review gating creates a test failure.

The implementation suites, not this document, own the assertions. Optional screenshots or manual
editor inspection may supplement but never replace deterministic contract, sanitizer, conformance,
performance, accessibility, and fallback tests.

## Required release gates

Before release or any push, the current change must pass all applicable local equivalents of the
required GitHub checks. The exact mandatory commands are:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run arch:check
npm run arch:check:negative
npm run test:coverage:quality
npm run test:coverage:ui
npm run test:e2e:smoke
npm run check:editor-release-evidence
```

The affected package tests must additionally include the provider-operation matrix, semantic-token
contract/parser/sanitizer, server dispatch, editor bridge, UI integration, mutation, performance,
bundle, accessibility, and internationalization suites. Repository script names for those targeted
gates are authoritative at implementation time and must be recorded exactly in the pull-request
verification log. Any changed public package surface also requires:

```bash
npm run build
npm run check:package-surface
```

The required GitHub `ci` check and all repository-required action, security, build, scan, SBOM,
dependency-review, and UI checks must pass on the immutable pull-request head. No coverage floor,
assertion, payload cap, timeout, accessibility rule, architecture boundary, release-evidence check,
or governance gate may be lowered to obtain a pass.

## Rollback

Semantic-token rollout can be rolled back independently by removing Rust from the proven enabled
set while preserving syntax highlighting and the operation matrix. Rollback must not enable another
provider, retain token bodies, reuse stale semantic state, alter provider activation policy, or
weaken review-only edit handling. Re-enablement requires fresh current-provider conformance and
measurement evidence under the same bounds.
