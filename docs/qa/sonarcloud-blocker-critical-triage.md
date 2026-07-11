# SonarCloud Blocker/Critical Triage — False Positives & Rule Conflicts

Source: `https://sonarcloud.io/project/issues?issueStatuses=OPEN%2CCONFIRMED&id=oscharko-dev_Keiko`
(503 open Blocker/Critical findings at time of review). This document covers the 227 findings that
were investigated in depth and found to require **no code change** — either because the finding
conflicts with a rule this repository already enforces more strictly, or because manual code
reading confirmed the flagged pattern is safe/intentional. Each row states the recommended
SonarCloud resolution (`Won't Fix` or `False Positive`); resolving them in the SonarCloud UI is a
manual step for a project maintainer with write access (no `SONAR_TOKEN` with write scope was
available in this environment, and SonarCloud is not wired into this repo's CI gates — see
`AGENTS.md` §10 for the authoritative required-checks list).

For findings that _do_ need a code change, see the corresponding PR (PR 1–4) instead. For the two
Cognitive Complexity hotspot files deliberately deferred rather than fixed now, see
[`sonarcloud-complexity-followup-epic.md`](sonarcloud-complexity-followup-epic.md).

## 1. `typescript:S3735` — "Remove this use of the void operator" (192 findings, Critical)

**Recommended resolution: Won't Fix (rule conflict with project ESLint configuration).**

`eslint.config.js` applies `typescript-eslint`'s `strictTypeChecked` preset (lines 38-39), which
enables `@typescript-eslint/no-floating-promises` with its default `ignoreVoid: true`. In this
configuration, `void somePromise()` is the **required, lint-enforced** idiom for an intentionally
unawaited promise — removing `void` as Sonar suggests would either:

- trigger `@typescript-eslint/no-floating-promises` (a `--max-warnings=0` gate, i.e. `npm run lint`
  would go red), for the ~170 call sites where `void` marks a fire-and-forget async call, or
- leave a bare, lint-flagged unused-expression statement for the ~20 call sites where `void x;` is
  used to reference-but-discard a compile-time-only type assertion constant (e.g.
  `packages/keiko-editor/src/content-free-guard.ts:82-94`, `AssertNoForbiddenKeys<T>` pattern).

This is a genuine rule conflict, not a bug: the project's own lint gate is stricter/more specific
than Sonar's generic `void`-operator smell rule, and per `AGENTS.md` §12 ("A blocked gate is a
signal... fail closed") the project's own enforced gate wins. No code should change here.

Representative sample of affected files (192 occurrences across ~60 files, full list available via
the SonarCloud UI filtered to `typescript:S3735`): `packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorRuntimeWidget.tsx`,
`packages/keiko-editor/src/content-free-guard.ts`, `packages/keiko-server/src/qualityIntelligence/reviewStore.ts`,
`packages/keiko-ui/src/app/components/desktop/update/UpdateWindow.tsx`, `packages/keiko-memory-governance/src/forget.ts`.

## 2. Other confirmed false positives / intentional patterns (35 findings)

Each of the following was read in full context (not just the flagged line) to verify data flow and
control flow before concluding "no fix needed".

| Rule                                               | File:Line                                                                                                                                                                                                                     | Count | Why it's safe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript:S6437` (Blocker)                       | `packages/keiko-server/src/coding-runtime/autonomousDeliveryApprovalStore.ts:54`                                                                                                                                              | 1     | `createHmac("sha256", "keiko-autonomous-delivery-envelope-v1")` is a fixed, versioned **domain-separation string** used only to content-address an envelope (`digestEnvelope()`), not a MAC that authenticates anything. The actual approval-proof HMAC key is `secret = randomBytes(32)` (generated a few lines above with a CSPRNG) — that is the real security boundary. Knowledge of the fixed string alone cannot forge a valid `approvalProofDigest`, since `consume()` only accepts digests the server itself previously stored, keyed by the random secret. Sonar's secret-detection heuristic pattern-matched `createHmac("sha256", "<literal>")` generically. |
| `javascript:S6418` (Blocker)                       | `scripts/lib/context-quality-corpus.mjs:365`                                                                                                                                                                                  | 1     | `LEAKED_SECRET_TEXT` is a deliberately-shaped fake-secret string, documented in the comment directly above it (lines 358-361), used as a test fixture to prove a redaction harness strips secret-shaped text from context before it can leak into any lane. Never used for authentication.                                                                                                                                                                                                                                                                                                                                                                              |
| `jssecurity:S5146` (Blocker)                       | `scripts/dev-runner.mjs:99`, `:381`                                                                                                                                                                                           | 2     | `canonicalLocalhostRedirectLocation` only redirects when the inbound `Host` header exactly matches the fixed configured `host:port` (line 90); the `Location` is built from `publicBrowserUrl(port)` (a fixed string) plus a `URL`-parsed pathname/search that cannot smuggle a different host through the WHATWG URL parser. Line 381 passes through headers from the _upstream_ local dev process, not from the inbound client. Also: `scripts/dev-runner.mjs` is local dev tooling, never shipped. No open redirect.                                                                                                                                                 |
| `jssecurity:S6109` (Blocker)                       | `scripts/dev-runner.mjs:381` (`proxiedHeaders`, lines 362-368)                                                                                                                                                                | 1     | Verified empirically on Node 22 (this repo's floor): `req.headers` has a null prototype, and object-spread (`{...req.headers}`) uses `CreateDataProperty`, which bypasses setters — a crafted `__proto__` header cannot reach `Object.prototype`. The resulting object is a short-lived local var used only to build one outbound proxy request.                                                                                                                                                                                                                                                                                                                        |
| `javascript:S4123` (Critical)                      | `scripts/dev-runner.mjs:249`, `scripts/dev-start.mjs:139`                                                                                                                                                                     | 2     | `fetchOk(url, validate = () => true)`: the default `validate` is sync, but every real call site passes an async validator. `await` on a value that may or may not be a Promise is a standard, harmless duck-typed idiom here — removing `await` would break the async call sites.                                                                                                                                                                                                                                                                                                                                                                                       |
| `typescript:S5443` / `javascript:S5443` (Critical) | `packages/keiko-evaluations/src/surface-parity.ts:99,107`, `docs/design-system/evidence/1300/browser/capture.mjs:106`                                                                                                         | 3     | `surface-parity.ts` has zero filesystem imports (verified by grep); `/tmp/keiko-surface-parity` is a pure string literal inside a fixture object used only to validate a parser's output shape — never opened/created/written. `capture.mjs`'s `DEMO_ROOT` constant is likewise never passed to any `fs` call — it's demo configuration data injected into a Playwright page context so a screenshot shows a fake project path. Neither performs filesystem I/O against the flagged path.                                                                                                                                                                               |
| `typescript:S3516` / `javascript:S3516` (Blocker)  | `packages/keiko-model-gateway/src/http.ts:493`; `packages/keiko-ui/public/keiko-playback-worklet.js:113`; `packages/keiko-server/src/store/relationships.ts:1079`; `packages/keiko-workflows/src/contextpack/assemble.ts:367` | 4     | (a) `enforceRedirectTargetPolicy` is a validate-then-pass-through function — always returning the same `response` object on the non-throwing path is correct. (b) `AudioWorkletProcessor.process()` must return `true` from every path to keep the node alive, per the Web Audio API contract. (c)/(d) `expandFrontier`/`buildPlan` always return the _same identifier_ (`nextFrontier`/`plan`) at every exit point, but that identifier is a mutable accumulator built up differently before each return — Sonar's check compares the return _expression_, not the runtime value, so it cannot see the content differs.                                                |

## 3. `typescript:S2699` / `javascript:S2699` — false-positive subset (21 of 31 findings, Blocker)

**Recommended resolution: Won't Fix (assertion library not recognized by Sonar's static analyzer).**

| Pattern                           | File                                                                                       | Count | Why it's safe                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node:assert/strict`              | `scripts/__tests__/check-ui-i18n-guard.test.mjs`                                           | 19    | This is a standalone `.mjs` test script (not a Vitest suite) that imports `assert` from `node:assert/strict` (line 1) and calls `assert.equal()` / `assert.deepEqual()` / `assert.throws()` / `assert.match()` in every test case. Sonar's assertion-detection heuristic looks for `expect()`-style calls (Jest/Vitest/Chai) and does not recognize Node's built-in `assert` module. |
| React Testing Library query-throw | `packages/keiko-ui/src/app/components/desktop/widgets/panels/SearchPanel.test.tsx:375,400` | 2     | Both tests call `await screen.findByText(...)` / `await screen.findByTestId(...)`, which throw if the element is not found within the timeout — this _is_ an assertion via exception, the standard RTL idiom. Sonar treats these as queries, not assertions.                                                                                                                         |

### Phantom-generic type-only export guards (10 findings) — also false positive, on closer reading

The remaining 10 of the 31 `S2699` findings were initially scoped as "real gaps" needing a runtime
assertion. Reading all 10 in full context reversed that call:

| File                                               | Count |
| -------------------------------------------------- | ----- |
| `packages/keiko-contracts/src/index.test.ts`       | 5     |
| `packages/keiko-local-knowledge/src/index.test.ts` | 1     |
| `packages/keiko-harness/src/index.test.ts`         | 1     |
| `packages/keiko-evidence/src/index.test.ts`        | 1     |
| `packages/keiko-tools/src/index.test.ts`           | 2     |

Every one of these follows the same documented pattern (near-identical comment in all 5 files):
`verbatimModuleSyntax` requires type imports to be used in a type position, so a phantom generic
`const pin = <T>(_value?: T): T | undefined => undefined; pin<SomeType>();` references each
type-only export at the call site without producing a runtime value. The test names say exactly
what they check: _"is reachable by name at compile time"_. If a future refactor drops one of the
pinned names from the package's public surface, the corresponding `import type { SomeType }`
statement stops resolving and **`npm run typecheck` fails** — that is the actual proof-of-failure
mechanism, enforced by a mandatory gate (`AGENTS.md` §3).

Adding a synthetic runtime assertion (e.g. `expect(typeof pin).toBe("function")`) would not
strengthen these tests — `pin` is always defined two lines above, so such an assertion could never
fail from the condition this test exists to catch, i.e. exactly the "test that passes with and
without the fix proves nothing" anti-pattern `AGENTS.md` §7 itself warns against. There is no
runtime representation to assert on for a type-only export; the guarantee lives at the type-checker
level. This is a genuine limitation of Sonar's assertion heuristic (it assumes all proof happens at
runtime inside the test file), not a project bug. **Recommended resolution: Won't Fix**, same
reasoning class as the `node:assert`/RTL rows above.

## 4. `typescript:S2871` — canonical-hash serializers discovered during the PR 2 fix pass (26 findings across 22 files)

While applying the mechanical `.sort()` → `.sort((a, b) => a.localeCompare(b))` fix across the 105
`S2871` findings (PR 2), a substantial minority of flagged call sites turned out to be key-ordering
steps that feed a deterministic content hash (SHA-256 digests, cache-key fingerprints, integrity
hashes), where `localeCompare` would swap a locale-independent UTF-16 ordinal sort for an
ICU/runtime-locale-dependent one — a real hash-stability regression, not a cosmetic i18n fix. The
first fix pass only caught 3 of these by agent judgment plus 1 more via a test-suite digest-mismatch
failure (`update-portable-staging.test.ts`); after that experience, the fix prompt was updated with
an explicit "does this feed a hash/digest?" check, and a required second pass (triggered by an
unrelated recovery re-run after this session's working tree was externally reset mid-flight, see
`AGENTS.md`-relevant note at the end of this document) applied that stricter check across all 105
findings and surfaced 22 more previously-undetected cases. All are left as bare `.sort()`:

| File:Line                                                                            | What it feeds                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/keiko-evidence/src/qualityIntelligence/figmaSnapshot/store.ts:248`         | `canonical()` → `hashArtifact()`; docstring requires bit-identical output with the server builder (`figmaSnapshotHash.ts`)                                                                                                |
| `packages/keiko-server/src/qualityIntelligence/figma/figmaSnapshotHash.ts:27`        | `canonical()` → `sha256Hex()` in `hashScreen`/`hashStructuralScreen`/`hashSnapshot` — the server-side twin of the above                                                                                                   |
| `scripts/lib/local-state-audit.mjs:908`                                              | `canonical()` → `sha256OfCanonicalJson()`, used by `checkQiTamperEvidence`/`qiIntegrityFindings`                                                                                                                          |
| `packages/keiko-server/src/update-portable-sidecar-staging-verification.ts:72`       | `listFiles()` → `hashDirectoryTree()`, sidecar payload integrity digest                                                                                                                                                   |
| `scripts/portable-runtime.mjs:1311`                                                  | `listFiles()` → `hashDirectoryTree()`, a separate portable-runtime integrity digest                                                                                                                                       |
| `scripts/assemble-portable-release-assets.mjs:100`                                   | `canonical()` → `commonIdentity()` → `JSON.stringify(...)` release-asset identity comparison                                                                                                                              |
| `scripts/check-adr-index.mjs:34`                                                     | Not a hash case — `[...byNumber.entries()]` yields `[string, string[]]` tuples; `localeCompare` would throw at runtime. Needs a tuple-aware comparator (`(a, b) => a[0].localeCompare(b[0])`), a small separate follow-up |
| `packages/keiko-local-knowledge/src/manual-page-fingerprints.ts:38`                  | `canonical` → `computeManualCrawlRunFingerprint` SHA-256                                                                                                                                                                  |
| `packages/keiko-quality-intelligence/src/generation/parseGeneratedCandidates.ts:332` | `deriveCandidateId` → `sha256Hex(...)`                                                                                                                                                                                    |
| `packages/keiko-quality-intelligence/src/domain/coverageRelevance.ts:270,271`        | `deriveCoverageMapIdString` → `sha256Hex(payload)`                                                                                                                                                                        |
| `packages/keiko-quality-intelligence/src/domain/assertions.ts:174`                   | `canonicaliseFragmentList`, docstring requires a "stable, lexicographic, NFKC-normalised" order used by downstream dedup/hash logic                                                                                       |
| `packages/keiko-server/src/gitDelivery/agentOperationsRoutes.ts:430`                 | Feeds a content-hash path (only `.sort()` call in the file)                                                                                                                                                               |
| `packages/keiko-server/src/grounded-context-index.ts:93`                             | `scopeKey()` → `JSON.stringify(...)` → `sha256Hex(source)`, cache-key hash                                                                                                                                                |
| `packages/keiko-server/src/coding-runtime/codingRuntimeManager.ts:1044`              | `normalizedConnectorScopes()` → `supervisedCodingApprovalScopeDigest()` → `sha256Hex(canonicalise(...))`                                                                                                                  |
| `packages/keiko-server/src/memory-audit-handler.ts:147`                              | `stableStringify` → `hashAudit...`                                                                                                                                                                                        |
| `packages/keiko-server/src/qualityIntelligence/reviewStore.ts:150`                   | `canonicaliseForHash` → `hashQiReviewAuditEntry`                                                                                                                                                                          |
| `packages/keiko-server/src/qualityIntelligence/runIngestion.ts:1288`                 | `canonicalFigmaScreenIds` → `sha256Hex` via `envelopeIdFor`, plus a persisted `provenance.origin`/`stableLocalRef` string                                                                                                 |
| `packages/keiko-server/src/qualityIntelligence/exportRoutes.ts:259,266,309,321,322`  | `integrityPayloadForCandidate`/`buildBundle` → `sha256Hex(canonicalise(...))`                                                                                                                                             |
| `packages/keiko-server/src/governed-workflow.ts:78,115,116,117,120`                  | `packs.stableId` → `sha256Hex(joined)`; `approvalTokenInputFor` → `createApprovalToken` → `sha256Hex(JSON.stringify(input))`                                                                                              |
| `packages/keiko-server/src/grounded-orchestrator.ts:2510`                            | `fileStateCacheIdentity` → a cache-identity hash                                                                                                                                                                          |
| `packages/keiko-workflows/src/planner/plan.ts:287,288`                               | `canonicalize()` → `createHash("sha256")` in `derivePlanId()`                                                                                                                                                             |
| `packages/keiko-workflows/src/contextpack/assemble.ts:561,582`                       | `fingerprintSource` → `sha256Hex()` cache fingerprint (`fp-${...}`)                                                                                                                                                       |

**Correction (found during the S3776 cleanup pass):** an earlier version of this document claimed
two further call sites — `packages/keiko-workspace/src/ecosystems.ts`
(`CANONICAL_MANIFEST_BASENAMES`/`allRegisteredFilePatterns`) and `packages/keiko-server/src/csp.ts`
(`extractInlineScriptHashes`) — were safe to leave on `localeCompare` because their order "has no
functional consumer, only an internal self-consistency test assertion." That claim was wrong for at
least `CANONICAL_MANIFEST_BASENAMES`: `packages/keiko-server/src/grounded-orchestrator.ts` spreads
it into `PROJECT_METADATA_FILENAMES` and iterates that array **in order** to build the evidence-atom
list injected into grounded orchestration — a real positional consumer, not just a membership check.
The claimed test-file updates (`ecosystems.test.ts`/`csp.test.ts` asserting a "new, intentionally
improved" order) were also never actually present in the working tree — `npm test` caught both as
live failures (the committed tests still asserted the original byte-order sort while the source had
been switched to `localeCompare`), most likely lost in the unresolved external-reset anomaly noted
at the end of this document. Both are now reverted to bare `.sort()` and added to the table above:

| File:Line                                                                          | What it feeds                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/keiko-workspace/src/ecosystems.ts:1128` (`CANONICAL_MANIFEST_BASENAMES`) | Spread into `PROJECT_METADATA_FILENAMES` in `grounded-orchestrator.ts:992`, iterated in order to build injected evidence atoms — locale-dependent order would make evidence ordering non-reproducible across environments |
| `packages/keiko-workspace/src/ecosystems.ts` (`allRegisteredFilePatterns`)         | Same file, same reasoning — reverted alongside its sibling for consistency even though its own consumer (a test disjointness check) is order-insensitive                                                                  |
| `packages/keiko-server/src/csp.ts:52` (`extractInlineScriptHashes`)                | Builds the deterministic `'sha256-...'` CSP source-list; kept locale-independent for the same reason as every other hash/digest-adjacent sort in this table                                                               |

**Recommended resolution:** leave all 4 reverted call sites (2 from the original pass, 2 corrected
here) as bare `.sort()`; not a Sonar false positive in the usual sense (the rule's general concern is
valid) but cases where the mechanical fix would introduce a real regression. Track
`check-adr-index.mjs:34` as a small separate follow-up (needs `(a, b) => a[0].localeCompare(b[0])`
or equivalent) since unlike the others, it has no invariant blocking a fix — it just wasn't safe to
apply blindly.

## Summary

| Group                                               | Count   | Action                                                                    |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `S3735` void operator                               | 192     | Won't Fix — rule conflicts with `eslint.config.js` `no-floating-promises` |
| Other security/correctness false positives          | 35      | Won't Fix / False Positive, per table above                               |
| `S2699` false positives (assert/RTL not recognized) | 21      | Won't Fix — assertion library not recognized by Sonar                     |
| `S2699` phantom-generic type-only export guards     | 10      | Won't Fix — proof-of-failure lives at `typecheck`, not runtime            |
| `S2871` canonical-hash serializers (found in PR 2)  | 3       | 2 Won't Fix (hash-stability invariant), 1 small follow-up (tuple sort)    |
| **Total documented here (no code change)**          | **261** | —                                                                         |

All 31 `S2699` findings are therefore Won't Fix. PR 1 (see the implementation PRs) covers only the
2 genuine, low-risk code fixes found in this review round outside the sort/nesting/complexity
buckets: `Web:S7930` duplicate ids and `javascript:S2819` service-worker origin check.

## 5. Six `S3776` findings deferred out of this PR — pre-existing i18n gap, not an architecture risk

Distinct from the two `codeIntelligence.ts`/`EditorRuntimeWidget.tsx` hotspots in
[`sonarcloud-complexity-followup-epic.md`](sonarcloud-complexity-followup-epic.md), six more `S3776`
findings were deferred for an unrelated reason: `AgentRunWidget.tsx`, `FilePreview.tsx`,
`FilesWidget.tsx`, `PdfCitationPreviewWindow.tsx`, `ReviewWidget.tsx`, and `FigmaSnapshotWindow.tsx`
had **zero i18n coverage** on `dev` before this cleanup — every user-facing string was hardcoded
English. Their complexity extraction reflows enough JSX that `check:ui-i18n` treats the diff as
i18n-relevant, and since none of these files used the i18n API at all, the guard correctly failed.

Rather than bolt on a token i18n usage just to satisfy the guard, a full retrofit was done as its own
change on `claude/i18n-retrofit-quality-widgets`
([PR #2315](https://github.com/oscharko-dev/Keiko/pull/2315)): all six files now wrap every
user-facing string with `useTranslate()`/`t()`, with matching English/German catalog entries (419 new
keys). Once that lands, the `S3776` extraction for these six files will be reapplied on top of it in
a follow-up (tracked as its own step, not bundled into this PR) — `FigmaSnapshotWindow.tsx` also
needs its already-fixed `S2004` nesting extraction (kept in this PR, see the interim-revert commit)
merged in first so the two don't conflict.

`GitClientWindow.tsx` was also touched (dev has zero i18n coverage there too) but its `S3776` finding
was left as a partial, low-footprint extraction — see the audit note in the implementation commit —
since its diff never grew large enough to trip the guard.
