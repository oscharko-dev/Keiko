# Issue #1206 — Keiko Editor Security, Privacy, CSP, Supply-Chain, and Model-Boundary Review

Date: 2026-06-19

Parent epic: #1189. Lead role: security reviewer.

Base audited implementation: the consolidated Keiko Editor epic on `feat/keiko-editor`
(#1191-#1205, #1210, #1211), with #1275 and the containment follow-up #1276 merged.

This memo is the #1206 deliverable. It records the security review, the threat-model coverage, the
dependency and license review, and the CSP/worker deployment notes for the editor stack. It is an
audit-and-verification issue: the editor's trust boundaries were already built and tested per feature
issue, so this review proves the consolidated posture, adds cross-cutting regression tests, and fixes
the confirmed audit gaps: an explicit LLM10 token-window ceiling, reserve-before-call enforcement for
that ceiling, and prompt redaction on both live editor model surfaces.

## 1. Method

The review ran a read-only audit across seven trust-boundary dimensions (browser→provider boundary,
route path containment, content-free telemetry/evidence, Monaco no-CDN/CSP/worker safety, dependency
and license supply chain, OWASP LLM Top-10 coverage, and architecture-gate liveness plus the generated
patch-apply path), followed by an adversarial counterexample pass that attempted to refute each core
acceptance criterion with a concrete bypass. All citations below are `file:line` against the audited
tree.

Outcome: the original adversarial pass refuted the LLM10 claim because the editor enforced a per-root
**request-rate** ceiling but no explicit per-window **token** ceiling. Follow-up closure audit also
found a check-then-record race in that ceiling and an unredacted dropdown-completion prompt path. These
gaps are fixed in this change set (§4). No other high or critical finding was confirmed.

## 2. Trust-boundary map

- **Browser tier** (`@oscharko-dev/keiko-editor`, `keiko-ui`): renders the editor and calls
  host-injected callbacks only. It never imports a provider SDK or a Node-domain value, and never
  reaches a model provider. Enforced by `adr-0042-editor-not-node-domain-values`
  (`.dependency-cruiser.cjs:685`, severity `error`) and `adr-0019-trust-1-provider-sdk-isolation`
  (`.dependency-cruiser.cjs:736`). Both are proven live by `scripts/arch-check-negative.mjs`
  (the editor rule fires the expected 8 times against `tests/architecture/fixtures/editor-browser/`).
- **Server tier (BFF)** (`packages/keiko-server/src/editor/*`): the only path from the browser to the
  Model Gateway. Every route resolves the workspace root and overlay path through the shared
  containment layer before any read, model call, or retrieval.
- **Model Gateway** (`keiko-model-gateway`): the sole package permitted to import provider SDKs.

## 3. Threat-model coverage (OWASP LLM Top 10 2025 + model-boundary guardrails)

| Threat                                                        | Stated control                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **LLM01** Indirect / cross-file prompt injection              | Workspace-derived completion, test-generation, and retrieval context is treated as untrusted: dual sanitization (`stripUnsafeFormatChars` then the redactor) on every excerpt and citation, plus a system prompt that pins context as read-only reference material.                                              | `codingContextProviders.ts:82-110,127-152`; `editorInlineCompletionModel.ts:54-62`; `editorCompletionModel.ts:65-73`           |
| **LLM05** Improper output handling / untrusted-code execution | Editor-driven test generation/execution is feature-flagged off in v1; no v1 flow executes model-generated code. Gate A (`KEIKO_EDITOR_TEST_GENERATION`) and Gate B (`KEIKO_EDITOR_TEST_GENERATION_EXECUTION`) both default off; with Gate A off the route returns `disabled` before any retrieval or model call. | `testGenerationRoutes.ts:54-91,283-285`; ADR-0042 D7                                                                           |
| **LLM08** Vector / embedding weaknesses                       | Retrieved RAG context carries a per-source trust tier and is redacted + byte-bounded before it reaches the model; high-trust outcomes cannot be driven by an embedded chunk.                                                                                                                                     | `codingContext.ts:62` (`tierForCodingContextSource`); `codingContextProviders.ts:341-364`; `localKnowledgeRetrieval.ts`        |
| **LLM10** Unbounded consumption (denial-of-wallet)            | Two server-owned per-root ceilings: a request-rate limiter (max requests/window) **and** a sliding-window token budget (max tokens/window). The token budget reserves a conservative prompt+completion estimate before provider calls, then settles to actual usage when the provider reports it.                   | `inlineCompletionRateLimiter.ts`; `editorModelTokenBudget.ts`; wiring in `inlineCompletionRoutes.ts` and `completionRoutes.ts` |
| **FIM model-selection guardrail**                             | The infilling model must be aligned/instruct or edit-tuned; a raw base-FIM endpoint is rejected at selection time (`degradeReason = only-base-infilling-model`).                                                                                                                                                 | `keiko-model-gateway` `selectCompletionModelFromCapabilities` + `isAlignedInfillingModel` (rejects undeclared/base)            |

## 4. Confirmed findings and fixes

**Finding (high, confirmed by the adversarial pass).** The editor model tier enforced a per-root
request-rate limiter (`DEFAULT_INLINE_RATE_LIMIT` = 600 requests / 60 s) and a per-call cost-class
ceiling via `selectCompletionModel`, but no explicit per-window **token** ceiling. Worst-case spend was
therefore bounded only implicitly (requests × per-call cap); the epic threat model asks for an explicit
maximum tokens/window in addition to the request cap.

**Fix.** A per-root sliding-window token budget governs both live model tiers:

- `packages/keiko-server/src/editor/editorModelTokenBudget.ts` — `createEditorModelTokenBudget`
  tracks `(timestamp, tokens)` per opaque workspace root over an injected clock, exposes
  `tryReserve(root, now, tokens)` for pre-call reservations plus compatibility inspection helpers, and
  ships a finite, generous default (`DEFAULT_EDITOR_MODEL_TOKEN_BUDGET` = 1,000,000 tokens / 60 s,
  tunable by deployment policy). A process-wide shared instance spans the inline and completion tiers
  for one root. The module holds only counts and timestamps - never a prompt, buffer, or path.
- `inlineCompletionRoutes.ts` and `completionRoutes.ts` build the redacted prompt, reserve a
  conservative prompt+completion token estimate before invoking the Model Gateway, degrade when the
  reservation would exceed the window, and settle to actual `promptTokens + completionTokens` when
  provider usage metadata exists. If usage is absent, the conservative reservation remains.

This makes the LLM10 control explicit and enforced for every live editor model-call surface, alongside
the existing request-rate ceiling. It changes no wire contract; token counts are content-free.

**Finding (high, confirmed by follow-up audit).** Inline completion redacted active-buffer
prefix/suffix before prompt assembly, but dropdown completion sent the same active-buffer slices to the
provider without applying the route redactor.

**Fix.** `GenerateModelCompletionsInput` now accepts `redactText`, `buildModelCompletionPrompt` applies
it before bounding prefix/suffix, and `completionRoutes.ts` passes the same
`stripUnsafeFormatChars` + deployment redactor helper already used by inline completion.

## 5. Acceptance Criteria ledger

| Criterion (issue body)                                                                                     | Status                    | Evidence                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser code cannot call provider APIs directly                                                            | Verified                  | `adr-0042-editor-not-node-domain-values` + `adr-0019-trust-1-provider-sdk-isolation` (`.dependency-cruiser.cjs:685,736`); `arch:check` + `arch:check:negative` (editor rule fires 8×); no provider URL/SDK in `keiko-editor`/`keiko-ui` source |
| Completion / test-generation routes reject denied and out-of-root paths                                    | Verified + new regression | Shared containment (`files.ts` deny-before-realpath; `languageRoutes.ts:50` `resolveOverlayPath`); per-route tests; new cross-route `editorSecurityBoundary.test.ts`                                                                           |
| No raw secrets or customer content persisted in telemetry or evidence                                      | Verified                  | Compile-time `content-free-guard.ts` (14 contracts); recorders redact via `redactor(manifest)` before `store.put`; `rootHash`/`promptHash` only; reviewable `insertText`/`newText` excluded from evidence                                      |
| Monaco worker setup does not require unsafe remote script execution                                        | Verified                  | `csp.ts` `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`), `worker-src 'self'`; ESM same-origin workers (`worker-entries.ts`); `loader.config({monaco})` (`runtime.ts`); no-CDN source-scan tests                                        |
| Dependency review is documented                                                                            | Done                      | §6 below                                                                                                                                                                                                                                       |
| All high/critical findings are fixed or block the epic                                                     | Done                      | One high (LLM10 token ceiling) fixed in §4; no other high/critical confirmed                                                                                                                                                                   |
| Threat model covers LLM01, LLM05, LLM08, LLM10 + FIM guardrail, each with a stated control                 | Done                      | §3                                                                                                                                                                                                                                             |
| Threat model covers indirect prompt injection and untrusted-code execution, each with a mitigation         | Done                      | §3 (LLM01, LLM05)                                                                                                                                                                                                                              |
| Untrusted-code-execution egress control is enforced or the feature is flagged off                          | Done                      | Test execution flagged off in v1 (Gate A/B default off), so no v1 flow executes model-generated code; enforced-egress remains the wave-2 enablement prerequisite (ADR-0042 D7)                                                                 |
| Dependency review records DOMPurify ≥ 3.3.2 and the `@monaco-editor/react` maintenance note                | Done                      | §6                                                                                                                                                                                                                                             |
| The `@oscharko-dev/keiko-editor` browser-tier rule exists and fires (negative fixture)                     | Verified                  | `.dependency-cruiser.cjs:685`; `scripts/arch-check-negative.mjs:64` expects 8; fixture present                                                                                                                                                 |
| `@monaco-editor/react` default loader is CDN unless overridden; no Monaco core/worker asset is CDN-fetched | Done                      | §7                                                                                                                                                                                                                                             |

### Deliverables

- **Security review memo** — this document.
- **Additional tests for editor-specific trust boundaries** — `editorModelTokenBudget.test.ts` (the token
  governor and reservation settlement), the LLM10 degrade/reservation route tests in
  `inlineCompletionRoutes.test.ts` and `completionRoutes.test.ts`, prompt-redaction coverage in
  `editorCompletionModel.test.ts`, `inlineCompletionRoutes.test.ts`, and `completionRoutes.test.ts`,
  and the consolidated cross-route containment suite
  `editorSecurityBoundary.test.ts`. The containment suite covers every path-accepting editor route —
  completion, inline-completion, context, repo-search, language, and test-generation (exercised with
  its feature gate enabled so its target-path containment is proven, since it is gated off in v1). A
  deny-listed path is rejected uniformly as `403 DENIED`; an out-of-root path is rejected as
  `403 DENIED` by the containment-first routes and as `400 INVALID_REQUEST` by test-generation, which
  shape-checks `mustBeRelative` before containment.
- **Dependency and license review notes** — §6.
- **CSP / worker deployment notes** — §7.

## 6. Dependency and license review notes

### 6.1 Editor dependency closure

| Package                 | Version                   | License               | Notes                                                                          |
| ----------------------- | ------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `monaco-editor`         | 0.55.1                    | MIT                   | Editor core + language workers, served same-origin; no CDN.                    |
| `@monaco-editor/react`  | 4.7.0                     | MIT                   | React wrapper; single-maintainer community package (bus-factor note below).    |
| `@monaco-editor/loader` | 1.7.0 (root `overrides`)  | MIT                   | Pinned to neutralize the wrapper's default CDN loader.                         |
| `dompurify`             | 3.4.11 (root `overrides`) | MPL-2.0 OR Apache-2.0 | npm-resolved version, patched for CVE-2026-0540 (≥ 3.3.2). See DOMPurify note. |

All four are permissive, OSI-approved licenses. The workspace license gate
(`scripts/check-workspace-supply-chain.mjs`) emits a per-workspace SBOM for every package and confirms
all licenses fall within the allow-list; `check:qi-supply-chain` confirms no telemetry/analytics or
test-intelligence dependency entered the closure.

### 6.2 DOMPurify (CVE-2026-0540)

There are two DOMPurify copies, and the review records both:

- **npm-resolved**: `dompurify@3.4.11`, pinned by the root `overrides` (`package.json`). This is on the
  patched 3.x line (≥ 3.3.2) and is what `npm ls dompurify` reports.
- **Vendored inside `monaco-editor`**: `monaco-editor@0.55.1` bundles its own DOMPurify 3.2.7 relatively
  (`node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js`), which the npm override
  cannot replace. The advisories against 3.2.7 are rated moderate (below the `--audit-level=high` CI
  gate), and the runtime sink is closed by design: per ADR-0042 D3.7, the editor disables every Monaco
  markdown-rendering surface and renders hover content as inert HTML-escaped text, so the vendored
  sanitizer only ever processes escaped, non-attacker-controlled text. The durable fix remains
  upgrading `monaco-editor` to a release that vendors DOMPurify ≥ 3.3.2 once one exists.

`npm audit --audit-level=high` reports zero high/critical advisories for the closure.

### 6.3 `@monaco-editor/react` bus-factor

`@monaco-editor/react` (and `@monaco-editor/loader`) are maintained by a single individual. The
supply-chain risk is mitigated by: pinned versions in both the workspace `package.json` and the root
`overrides`; lockfile SHA-512 integrity verified on every install via `npm ci`; the per-package SBOM +
license gate; and the no-CDN policy, which prevents a silent runtime fetch of an upstream change. The
editor package is `private` and does not ship in the published `@oscharko-dev/keiko` tarball.

### 6.4 Lockfile and supply-chain posture

`package-lock.json` is lockfileVersion 3 with SHA-512 integrity per entry; `npm ci` enforces it. The
`@monaco-editor/loader` and `dompurify` overrides are the only editor-related lockfile pins.

## 7. CSP and worker deployment notes

- **CSP is unchanged by the editor and is not relaxed.** `buildCspHeader` (`csp.ts`) emits
  `default-src 'none'`, `script-src 'self'` + per-document SHA-256 hashes (never `'unsafe-inline'` or
  `'unsafe-eval'`), `worker-src 'self'`, and `connect-src 'self'`. The header is applied to every BFF
  response (`server.ts` → `applySecurityHeaders`), and the inline-script hashes are loaded from the
  build artifact and fail closed (script blocked, never `'unsafe-inline'`) when absent
  (`load-csp.ts`).
- **Monaco runs same-origin with no CDN.** Workers are instantiated with the ESM
  `new Worker(new URL("monaco-editor/esm/...", import.meta.url), { type: "module" })` pattern
  (`monaco/worker-entries.ts`), which `worker-src 'self'` permits. `@monaco-editor/react` ships
  `@monaco-editor/loader`, whose default loader fetches Monaco from a CDN; `configureMonacoLoader`
  calls `loader.config({ monaco })` with the locally installed instance before first mount
  (`monaco/runtime.ts`), and the root `overrides` pin `@monaco-editor/loader` so the default CDN loader
  is never used. No-CDN is enforced by source-scan tests (`monaco/runtime.test.ts`,
  `monaco/workers.test.ts`).
- **Deployment requirement.** Serve the locally installed `monaco-editor` assets same-origin; do not
  add a `<meta>` CSP or any `script-src`/`worker-src` widening. The editor mounts via `next/dynamic`
  with `ssr: false`, so Monaco is never evaluated during the Next static-export prerender, and it
  reports an actionable unsupported-runtime error rather than falling back to a CDN when Web Workers or
  the URL API are unavailable.

## 8. Residual and accepted items

- **Vendored DOMPurify 3.2.7** — accepted interim; sink closed (§6.2); durable fix is a Monaco upgrade
  once a release vendors ≥ 3.3.2.
- **`@monaco-editor/react` single maintainer** — accepted, mitigated (§6.3).
- **AI-provenance prompt reconstruction** — by design the evidence store keeps only a prompt hash, not
  the prompt; full prompt reconstruction is intentionally unsupported (ADR-0042 redaction). Not a
  control gap.
- **Wave-2 generated-test execution** — remains gated off pending an enforced, deny-by-default
  network-egress boundary (ADR-0042 D7); no v1 flow executes model-generated code.

## 9. Local verification

```sh
npm ci
npm run build:packages
npm --workspace @oscharko-dev/keiko-server test -- src/editor/editorModelTokenBudget.test.ts \
  src/editor/editorSecurityBoundary.test.ts src/editor/inlineCompletionRoutes.test.ts \
  src/editor/completionRoutes.test.ts src/editor/editorCompletionModel.test.ts
npm run typecheck
npm run lint
npm run arch:check
npm run arch:check:negative
npm run check:version-consistency
npm run check:qi-supply-chain
npm run check:workspace-supply-chain
npm audit --audit-level=high
```

The final PR closeout cites the GitHub `ci` result and the full local gate suite before Issue #1206 is
moved to Done and closed.
