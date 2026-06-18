# Keiko Editor — Architecture Reuse Audit and Delivery Blueprint

> Planning artifact for Issue [#1190](https://github.com/oscharko-dev/Keiko/issues/1190)
> (Parent Epic [#1189](https://github.com/oscharko-dev/Keiko/issues/1189)).
> Status: **Proposed** — pending human review. This document is the architecture authority for the
> Keiko Editor epic. It plans implementation; it does not implement editor components, create server
> endpoints, or apply generated code changes (those are out of scope for #1190 and owned by the
> child issues #1191–#1213).
>
> Normative companion: [ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md). Where this
> blueprint and ADR-0042 overlap, ADR-0042 is the citable decision record for the architecture gates
> (package tier, dependency direction, no-CDN/worker/CSP, server-language-service authority, FIM
> extension). This blueprint adds the reuse matrices, dependency decision record, risk register,
> sequencing plan, and regulatory mapping.

## 1. Purpose and scope

Establish the complete architecture plan for the Keiko Editor before implementation starts: package
boundaries, reuse decisions, completion strategy, agentic-coding context strategy, the Monaco runtime
and worker strategy for the actual host stack, the language-intelligence split, dependency choices,
the test-generation flow, the security trust boundary, the release/branch policy, and the regulatory
record-keeping mapping.

The Keiko Editor delivers a VS Code-grade in-product coding experience while preserving Keiko's
regulated-delivery architecture: deterministic-first behaviour, productive model calls behind the
Model Gateway, the Orchestrator as workflow authority, governed retrieval, reviewable patches, and
redacted evidence. The editor package owns **editor UI behaviour and rendering only**; all coding
intelligence is composed by existing Keiko backend systems through typed ports.

### 1.1 v1 scope (owner decision, 2026-06-18)

v1 delivers epic Stories 1, 2, 3, and 6:

- editor + diff editor (Monaco), Workspace card-window integration;
- Keiko-governed completion and inline completion;
- deterministic language intelligence and diagnostics for TypeScript/JavaScript;
- retrieval-grounded coding context ([#1211](https://github.com/oscharko-dev/Keiko/issues/1211))
  and diff/patch-preview ([#1195](https://github.com/oscharko-dev/Keiko/issues/1195));
- security, performance, accessibility, documentation, and final verification.

**No v1 flow executes model-generated code.**

### 1.2 Wave-2 scope (deferred, gated)

Editor-driven test **generation, execution, and verification**
([#1202](https://github.com/oscharko-dev/Keiko/issues/1202),
[#1203](https://github.com/oscharko-dev/Keiko/issues/1203),
[#1204](https://github.com/oscharko-dev/Keiko/issues/1204)) is wave 2. It is gated on an enforced
deny-by-default network-egress boundary, proven by an automated test, because executing
model-generated tests is untrusted-code execution (OWASP LLM05:2025) and the platform does not yet
OS-enforce egress (see §10 and the risk register, §13). The blueprint defines the feature flag and
the wave-2 enablement prerequisite; it does not enable any code-execution flow in v1.

### 1.3 Out of scope for #1190

Implementing editor components; creating server endpoints; applying generated code changes; running
arbitrary VS Code extensions; browser-side direct model calls; live writes to external
test-management systems.

## 2. Package boundaries and host responsibilities

### 2.1 The `@oscharko-dev/keiko-editor` package (browser tier)

A new browser-tier workspace package, peer to `@oscharko-dev/keiko-ui` under the ADR-0019 topology.
It is created and integrated into the monorepo governance gates by
[#1191](https://github.com/oscharko-dev/Keiko/issues/1191); this blueprint and ADR-0042 define the
boundary it must satisfy.

**The editor package owns:**

- Monaco editor and diff-editor lifecycle, model identity, and rendering;
- editor UI contracts and the host-integration API (typed callbacks/ports for IO, completion,
  diagnostics, test-generation actions, and patch actions);
- completion-provider and inline-completion-provider **wiring** (registration with Monaco), delegating
  the actual completion computation to the host;
- the Monaco theme bound to the Keiko Editor design tokens (#1212);
- editor-local view state (selection, folding, scroll), keyboard substrate, and accessibility.

**The editor package must not own** (these remain backend/workflow responsibilities, reached only
through host-injected ports): repository search, knowledge retrieval, memory retrieval, context
assembly, model routing/selection, the Model Gateway, patch application, verification, evidence
persistence, workspace authority, or any concrete Keiko BFF route. The package is reusable outside
`keiko-ui` and must not import `keiko-ui` internals (epic Definition of Done).

### 2.2 Host responsibilities (`keiko-ui` + `keiko-server`)

- `@oscharko-dev/keiko-ui` hosts the editor package: it injects the host-integration ports, mounts
  the editor in the Workspace card-window registry
  (`packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts` —
  `registerWindowRender`, the `"editor"` `WindowType`, and the existing `EditorWidget` placeholder it
  replaces), wires the design tokens, and configures the Monaco runtime (no CDN; §5).
- `@oscharko-dev/keiko-server` owns the governed BFF routes (file state, diagnostics, completion,
  context retrieval) and wires the backend ports to the deterministic language service, the Model
  Gateway, the retrieval/context systems, verification, and evidence. The editor never calls these
  routes directly; the host injects callbacks that call them.

### 2.3 One package or split `core` / `react`

**Decision: ship one package (`@oscharko-dev/keiko-editor`) in v1.** A `core` (framework-agnostic
contracts + Monaco lifecycle) vs `react` (React bindings) split is deferred until a second host
consumer appears. Keeping one package minimises monorepo-gate surface (one
`ALLOWED_WORKSPACE_DEPENDENCIES` entry, one `tsconfig.packages.json` reference, one
dependency-cruiser from-rule) and matches ADR-0025's forward-only baseline (do not grow package
count speculatively). The internal module layout must keep React bindings separable so a later split
is mechanical, not a rewrite.

## 3. Monorepo governance integration (the gate edits #1191 must make)

Creating `@oscharko-dev/keiko-editor` will hard-fail `npm run arch:check`,
`npm run arch:check:negative`, and `npm run check:package-graph` until the governed configuration is
updated. The blueprint names every gate so #1191 can land them in one reviewable change. All of these
are verified to exist on the base branch:

| Gate file                         | Required edit                                                                                                                                                                                                                                             | Verified anchor                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/check-package-graph.mjs` | Add a `keiko-editor` entry to `ALLOWED_WORKSPACE_DEPENDENCIES` (its permitted workspace deps; v1 expects only `@oscharko-dev/keiko-contracts`, type-only where possible). Absence emits `"<pkg>: missing ADR-0019 workspace dependency allowlist entry"`. | `ALLOWED_WORKSPACE_DEPENDENCIES` map (≈ lines 10–171); failure message (≈ lines 249–250).                                                    |
| `tsconfig.packages.json`          | Add a project reference for `packages/keiko-editor`.                                                                                                                                                                                                      | `references[]` (20 entries today; ≈ lines 3–25).                                                                                             |
| `.dependency-cruiser.cjs`         | Add a **new browser-tier from-rule** forbidding `packages/keiko-editor/src` from value-importing Node-domain packages, mirroring `adr-0019-direction-8-ui-not-node-domain-values` (type-only imports allowed via `dependencyTypesNot: ["type-only"]`).    | `adr-0019-direction-8-ui-not-node-domain-values` (≈ lines 659–683); 31 named rules today (23 `adr-0019-direction-*` + 8 `adr-0019-trust-*`). |
| `scripts/arch-check-negative.mjs` | Increment the rule count in `EXPECTED_DEPCRUISER_RULE_COUNTS` for the new rule and add a negative fixture exercising it.                                                                                                                                  | `EXPECTED_DEPCRUISER_RULE_COUNTS` (≈ lines 38–67); `FIXTURE_PATH = "tests/architecture/fixtures"` (≈ lines 27–28).                           |

Because the editor sits in the browser tier (like `keiko-ui`), it inherits the same trust boundary:
no value imports of Node-domain packages, no provider SDKs, no credentials. ADR-0019 direction rule 8
is the precedent. This is why a **required** ADR (ADR-0042) is needed: every cross-package boundary in
this monorepo is governed by a numbered ADR cited from `.dependency-cruiser.cjs`, and the new from-rule
added by #1191 must cite a real ADR number.

## 4. Backend trust boundary and BFF seam

`@oscharko-dev/keiko-server` exposes governed editor BFF routes
([#1197](https://github.com/oscharko-dev/Keiko/issues/1197)) for file state, diagnostics, completion,
and conflict metadata. The server already enforces the boundary the editor must inherit:

- **Model Gateway only.** Productive model calls route through `@oscharko-dev/keiko-model-gateway`
  exclusively; the gateway barrel intentionally hides HTTP/adapter internals so productive calls
  cannot bypass routing (`packages/keiko-model-gateway/src/index.ts`). The UI/browser tier must not
  import the gateway as a value (ADR-0019 rule 8).
- **Workspace containment.** File reads/writes stay inside the selected project path with `realpath`
  checks (`docs/security-and-audit-boundaries.md`).
- **Redaction-before-persist** evidence and **dry-run-by-default** patches
  (`docs/security-and-audit-boundaries.md`; §9, §10).
- **CSP enforced on every BFF response** (`packages/keiko-server/src/headers.ts` —
  `applySecurityHeaders`; `packages/keiko-server/src/csp.ts` — `buildCspHeader`).
- **Same-origin browser network only.** The server CSP sets `connect-src 'self'`
  (`packages/keiko-server/src/csp.ts`, line 65). `@oscharko-dev/keiko-editor` may not issue direct
  browser `fetch`, `EventSource`, WebSocket, analytics, model-provider, retrieval-provider, or
  telemetry calls to non-same-origin endpoints. Completion, inline completion, diagnostics, context,
  and future test-generation actions flow through host-injected callbacks backed by Keiko BFF routes.

## 5. Monaco runtime and worker strategy (no-CDN, Next.js 16 + Turbopack + static export)

The host stack is **Next.js 16.2.9, App Router, Turbopack, `output: "export"` static export**
(verified: `packages/keiko-ui/package.json` `"next": "16.2.9"`;
`packages/keiko-ui/next.config.mjs` `output: "export"` and `turbopack: { root: repoRoot }`). Neither
`monaco-editor` nor `@monaco-editor/react` is a dependency yet.

Decisions ([#1193](https://github.com/oscharko-dev/Keiko/issues/1193) implements; ADR-0042 records):

1. **No CDN.** All Monaco runtime assets — the editor core and the language/JSON/CSS/HTML/TS web
   workers — are served from the locally installed `monaco-editor` package (same-origin). This is an
   epic Architecture Invariant and a regulated-delivery requirement.
2. **`@monaco-editor/react` loader pinned to the local Monaco.** The wrapper's default loader fetches
   Monaco from a CDN (jsDelivr) unless configured. The host must call
   `loader.config({ monaco })` against the locally installed package before first mount, so no CDN
   request is ever issued.
3. **Forbid `monaco-editor-webpack-plugin`.** It is incompatible with Next.js 16's default Turbopack.
   Worker wiring uses the ESM pattern — `new Worker(new URL("…", import.meta.url), { type: "module" })`
   via a hand-authored `MonacoEnvironment.getWorker(_, label)` factory — plus a client-only dynamic
   import (`ssr: false`), following the existing client-only guard pattern
   (`packages/keiko-ui/src/app/components/desktop/install/registerSw.ts`).
4. **CSP alignment.** The server CSP already sets `worker-src 'self'`
   (`packages/keiko-server/src/csp.ts`, ≈ line 75) and `script-src 'self'` (+ inline SHA-256 hashes,
   no `unsafe-inline`). Same-origin ESM workers satisfy this with no CSP relaxation. `style-src`
   already carries `'self' 'unsafe-inline'` (pre-existing, for Tailwind's injected styles;
   `csp.ts` ≈ line 63), and `connect-src 'self'` (line 65) keeps browser completion/context traffic
   same-origin. Monaco's runtime style injection needs **no** CSP change. #1193/#1206 must verify that
   no **new** `worker-src`/`script-src`/`style-src`/`connect-src` widening is introduced for Monaco or
   editor coding features, and that the static export emits the worker assets into the export output
   so they resolve at `keiko ui` runtime.
5. **No-CDN proof plan.** Two checks, both owned by #1193 and re-confirmed by #1207/#1209: (a) an
   **automated** Playwright network-intercept test that loads the editor, a worker-backed feature,
   deterministic completion, inline completion, diagnostics/context, and disabled test-generation
   actions, then fails if any browser request targets a non-loopback or non-same-origin endpoint. Run
   it against both `next dev` (Turbopack) and the static production build; (b) a build-output assertion
   that the Monaco worker chunks are present in the static export. The automated check (a) provides
   regression protection, not a one-time manual review.

### 5.1 Initial performance budgets for #1207 / #1209

#1207 owns the final measurement harness and #1209 owns release evidence, but the first implementation
must start with hard budgets rather than open-ended "measure and document" language:

- **Static shell / first-load JS:** routes that do not open the editor must load **0 bytes gzip**
  attributable to `monaco-editor`, `@monaco-editor/react`, or `@oscharko-dev/keiko-editor` in the
  first-load JavaScript graph. #1207 adds a static-export bundle assertion that fails if any Monaco or
  editor package appears in the initial payload.
- **Lazy editor bundle:** the lazy-loaded editor + Monaco runtime JavaScript budget is **≤ 2.5 MB gzip
  total** across editor-triggered chunks, with no individual worker chunk **> 750 KB gzip**. Exceeding
  either number is a release-blocking #1207 finding unless explicitly accepted as a documented
  limitation by #1209.
- **Cold start:** first editor-card open (user action → editor interactive) targets **p50 ≤ 1.5 s** and
  **p95 ≤ 2.5 s** on the representative #1207 development machine for both `next dev` and static
  export. Any one-time Monaco worker-startup long task over 50 ms must be isolated to first open and
  recorded; repeated long tasks during typing fail the gate.
- **Typing and inline rendering:** completion-enabled typing, cursor movement, selection, and
  accepting/rejecting inline suggestions must keep per-keystroke main-thread work **< 50 ms** and
  editor Interaction to Next Paint **≤ 200 ms at p75**. Ghost-text rendering yields to input
  (`requestIdleCallback`, scheduler yield, or equivalent) and may not block keystrokes.
- **Completion request latency:** deterministic language-service completion targets **p50 ≤ 150 ms** /
  **p95 ≤ 500 ms**. As-you-type AI ghost text is allowed only when the Model Gateway selects a
  FIM-capable `latencyClass: "fast"` model and measured content-free telemetry stays within **p50 ≤
  200 ms** / **p95 ≤ 750 ms** after the debounce window; otherwise the feature degrades to
  manual-invoke inline suggestion plus deterministic completion. Manual-invoke AI completion may be
  slower but must report p50/p95 in release evidence.
- **Large files:** files **≤ 500 KB and ≤ 10,000 lines** are the fully interactive target. Files above
  either threshold but within the existing BFF edit ceiling (`MAX_TEXT_PREVIEW_BYTES = 1,000,000`) open
  in a read-only/degraded editor mode with completion, diagnostics, and inline suggestions disabled and
  a visible status. Files above `1,000,000` bytes use the existing too-large failure path and do not
  instantiate Monaco.
- **Lifecycle / memory:** closing an editor card or switching workspace disposes Monaco models,
  providers, and workers for that editor lane. #1207 records per-card worker memory and fails if memory
  remains more than **10 MB above pre-open baseline** after close, garbage collection, and a bounded
  settle window in the scripted check.

## 6. Language intelligence: in-browser worker vs server language service

Monaco bundles an in-browser TypeScript worker (`ts.worker`) that can answer single-file
completion, diagnostics, hover, and quick-fixes without any LSP plumbing. Keiko's regulated model
requires governed, auditable, cross-file analysis. The split:

- **Server-side deterministic TypeScript language service is the single source of truth** for
  governed completion, diagnostics, hover, symbols, and quick info
  ([#1198](https://github.com/oscharko-dev/Keiko/issues/1198) builds it as a **keiko-server module**,
  not a new package — `keiko-server` may already depend on the domain packages it needs, so no new
  ADR-0019 direction rule is required). It is cross-file/workspace-aware and produces auditable,
  bounded results through the governed BFF.
- **The in-browser `ts.worker` is disabled for governed features.** It provides only local
  tokenization, bracket matching, and syntax colouring as a fast cosmetic layer. It must not be the
  provider for completion, diagnostics, hover, or symbols, so there is exactly one governed answer
  path and no ungoverned divergent provider.
- **Conflict resolution.** When both could answer, the server language service wins for any feature
  that is recorded, audited, or model-augmented. The in-browser worker is never consulted for those.
- **`monaco-languageclient` is not adopted by default.** Monaco's bundled workers plus the server
  language service cover v1 without LSP/JSON-RPC plumbing. Adopt it only if a real out-of-process LSP
  server bridge enters scope (e.g. the #1213 multi-language expansion), after dependency review
  (§12).

## 7. Completion and inline completion governance

All completion and generated output route through Keiko backend governance and the Model Gateway
(epic Invariant; AC). Architecture:

- **Two-tier completion.** (1) Deterministic language-service completion (#1198) is the default,
  fast, model-free path. (2) Keiko AI completion (#1199 gateway bridge; #1200 inline/ghost text) is
  additive and server-governed: the completion request is assembled server-side, routed through the
  Model Gateway, cancellable, budgeted, and telemetry-light. The editor package only registers the
  Monaco providers and renders results; it computes nothing.
- **FIM / fill-in-the-middle capability assessment** ([#1210](https://github.com/oscharko-dev/Keiko/issues/1210)).
  The Model Gateway's `ModelCapability` (`packages/keiko-contracts/src/gateway.ts`) has **no FIM flag
  today** (it carries `toolCalling`, `structuredOutput`, `streaming`, `supportsImageInput`,
  `supportsDocumentInput`, `supportsSeeding`, `supportsResponseFormat`, cost/latency class). #1210 must
  add a suffix-aware infilling capability and selection so the gateway can detect whether a configured
  model supports low-latency FIM. Capability data ships empty by design
  (`packages/keiko-model-gateway/src/capabilities.data.ts` — `CAPABILITY_DATA = []`); FIM detection is
  per-deployment, mirroring the QI capability pattern
  (`packages/keiko-model-gateway/src/qualityIntelligence/capabilityGate.ts` —
  `buildSelectionQueryForCapabilities`, the single source of truth for capability→selection mapping).
  The "fast" qualifier is not prose: the as-you-type selection query must require **both** the new FIM
  capability **and** the existing `latencyClass: "fast"` field on `ModelCapability`
  (`packages/keiko-contracts/src/gateway.ts`), so a `standard`/`slow` model can never be elected for
  per-keystroke ghost text. #1210 records this as a required selection predicate.
- **Degradation policy.** As-you-type ghost text is offered **only** when a fast, suffix-aware
  (FIM-capable, `latencyClass: "fast"`) model is available. Otherwise the editor falls back to
  manual-invoke inline suggestion backed by deterministic completion. There is no silent ungoverned
  fallback. The as-you-type path is debounced and self-cancelling: a completion request fires only
  after a typing pause (#1207 sets the window, target ≥ 200 ms) and each new keystroke aborts the
  in-flight request via the existing `AbortSignal` plumbing
  (`packages/keiko-server/src/grounded-orchestrator.ts`) before issuing a new one, so the network path
  cannot accumulate per-keystroke requests.
- **FIM safety.** Completion must use an aligned/instruct model, not a raw base model, because raw
  base-model FIM is highly susceptible to prompt-injection from surrounding buffer/retrieved context
  (§13). #1210/#1200 record this guardrail.

## 8. Agentic coding context architecture (reuse, not re-implementation)

Agentic coding context (for completion, inline completion, generated tests, and explanations) is
assembled by **existing Keiko backend retrieval/context systems**, not by an editor-specific retrieval
runtime (epic Invariant; AC). The editor sends a typed context request through the host port and
receives an assembled, governed context pack; it contains **no retrieval, knowledge, memory, or
context-assembly logic**.

- **Typed context port** ([#1192](https://github.com/oscharko-dev/Keiko/issues/1192)). The editor
  declares an `EditorContextRequest`/`EditorContextResult` contract with a `purpose`
  (`completion | inline | test-generation | explanation`). The acceptance criterion for #1192 is that
  the editor package contains no retrieval/knowledge/memory/context logic.
- **Backing service** ([#1211](https://github.com/oscharko-dev/Keiko/issues/1211)). A governed
  coding-context retrieval service composes the existing seams server-side and query-only (see Reuse
  Matrix B, §11). All providers run server-side; none becomes browser-side editor state.

The exact boundary: `@oscharko-dev/keiko-editor` owns editor UI contracts and rendering; #1192 is the
typed seam; #1211 is the server-side assembler; the existing retrieval packages do the work.
Per-keystroke completion uses only the cheapest deterministic context (e.g. symbol-nearby
`repoSearch`); expensive providers (Local Knowledge vector retrieval, memory retrieval) are excluded
from the per-keystroke path and used only for explicit, heavier requests (test generation,
explanations).

### 8.1 Degradation behaviour (per provider)

For every context provider, #1211 must define behaviour when it is unavailable, not-ready, denied
(scope/permission), too expensive, or out of budget: the request degrades to a smaller governed
context (and ultimately to deterministic-only completion) and records the omission as metadata-only
evidence; it never silently fabricates context and never blocks the editor. This mirrors the existing
omission-reason pattern (`repoSearchPolicy.policyOmissionReason`).

### 8.2 Retrieval-as-prompt-injection controls

Retrieved repository text, Local Knowledge capsule chunks, retained memory, and Quality Intelligence
evidence are untrusted model input. Scrubbing and fencing are necessary but not sufficient: #1211/#1206
must use an exported/shared hardening seam (for example `QualityIntelligenceHardening` plus
`@oscharko-dev/keiko-security` redaction helpers, or an explicitly extracted successor to the current
file-local QI scrubber) rather than coupling to private server helpers. Prompt templates must label
retrieved content as non-authoritative data, keep system/developer policy outside retrieved context,
and forbid retrieved content from granting tool authority, requesting secrets, bypassing
review/evidence gates, applying patches, or executing tests.

#1211/#1206 must add malicious-retrieval fixtures covering `repoSearch`, Local Knowledge, memory
retrieval, and QI evidence. The fixtures inject instructions such as "ignore prior instructions",
"read `.env`", "apply this patch", or "execute this test"; the expected outcome is reduced or
flagged context plus no privileged action. Evidence for these tests is content-free: source tier,
provider id, hash/byte counts, omission reason, and policy decision only.

## 9. Diff and patch preview (v1)

[#1195](https://github.com/oscharko-dev/Keiko/issues/1195) builds the Monaco diff editor and
patch-preview. It reuses the existing dry-run patch model — patches are emitted as a `patch:proposed`
event and never applied by the harness (`packages/keiko-harness/src/patcher.ts` —
`handlePatchProposal`; `packages/keiko-tools/src/patch.ts` — `renderDryRun`, which never writes;
dry-run-by-default per `docs/security-and-audit-boundaries.md`). The existing HTML/CSS diff rendering
(`packages/keiko-ui/.../widgets/cards/shared/diffParser.ts` — `parseUnifiedDiff`, with
`MAX_DIFF_BYTES = 512 KB` / `MAX_DIFF_FILES = 400` caps from Issue #645; `ReviewWidget.tsx` —
`DiffFileSection`/`DiffLineView`) is the functional precedent; the Monaco diff editor upgrades the
**presentation** while preserving the same bounded, dry-run, review-before-apply semantics. Patch
**apply** is wave 2 (#1204), gated as in §10.

## 10. Test generation, verification, and the untrusted-code boundary (wave 2)

Editor-driven test generation/execution/verification (#1202/#1203/#1204) reuses existing flows
(Reuse Matrix A, §10.1) but is **deferred to wave 2** behind an enforced egress boundary.

**Why deferred.** Executing model-generated tests during verification is untrusted-code execution
(OWASP LLM05:2025 — Improper Output Handling). The platform does not OS-enforce network egress today:

- `packages/keiko-contracts/src/tools.ts` — `NetworkPolicy = "inherit" | "none"`,
  `DEFAULT_SANDBOX_POLICY.network = "inherit"`, with an inline note that Wave 1 does **not** enforce
  OS-level network isolation (deferred to a container layer; `"inherit"` is the honest current value).
- `packages/keiko-verification/src/limits.ts` — the `network` limit is recorded `enforced: false`
  with `NETWORK_NOTE = "documented; OS-level isolation deferred to container wave"`; the test suite
  asserts "network is never enforced".
- `docs/security-and-audit-boundaries.md` — "Keiko is not a sandbox and does not provide OS-level
  isolation"; "Verification can execute repository-authored scripts".

**Enablement prerequisite (wave-2 feature flag).** A single feature flag (default **off**) gates the
editor-driven generate→execute→verify flow. It may be enabled only when an enforced deny-by-default
egress boundary exists and is **proven by an automated CI test** (i.e. `NetworkPolicy "none"` is
actually honored for the verification execution context). Until then, v1 ships diagnostics,
completion, and reviewable diffs — no flow that executes model-generated code. Generation-time
isolation, a coverage-delta gate, and a mutation-kill gate are wave-2 acceptance criteria for
#1202/#1203 (the repo already ships a mutation gate, `test:mutation:security`).

### 10.1 Existing flows reused by wave 2

- Test-generation workflow: `packages/keiko-workflows/src/qualityIntelligence/modelRoutedTestDesign.ts`
  (`modelRoutedTestDesign`) — model call injected as an abstract generate port; server tier owns
  gateway wiring.
- Generation port + injection hardening:
  `packages/keiko-server/src/qualityIntelligence/generationPort.ts` (`createQiGenerationPort`, whose
  current file-local scrubber normalizes, strips C0/C1/invisible-format controls, and neutralizes
  `<qi-evidence>` delimiters). #1211/#1206 must reuse an exported/shared hardening seam or extract that
  behavior deliberately; do not couple editor retrieval to a private helper. This is also the model for
  LLM08 retrieval-injection defence (§13).
- Candidate artifact store + reviewable edits:
  `packages/keiko-evidence/src/qualityIntelligence/` (`recordQualityIntelligenceCandidates`,
  `loadQualityIntelligenceCandidates`, `applyQualityIntelligenceCandidateEdit`).
- Verification orchestrator: `packages/keiko-verification/src/orchestrator.ts` (`runVerification`,
  allowlisted `VERIFICATION_COMMAND_RULES`, `outputDigest` byte-count-only, `toResult` redacted;
  no-shell command boundary per `docs/security-and-audit-boundaries.md`).
- Evidence: redaction-irreversible QI evidence
  (`packages/keiko-evidence/src/qualityIntelligence/redaction.ts`) and immutable schema versioning
  (`packages/keiko-contracts/src/evidence.ts` — `EVIDENCE_SCHEMA_VERSION = "1"`; breaking changes
  add a new union member rather than mutating `"1"`).

## 11. Reuse / no-duplication matrices

Disposition legend: **Reuse as-is** · **Generalize** (extend a current API) · **Wrap in BFF**
(expose via a governed route/port) · **New** (justified capability gap) · **Out of scope**.

### 11.1 Matrix A — editor, files, test-generation, patch, verification, evidence, design surfaces

| Existing surface (verified path)                                                                                                                           | Use case                                                     | Disposition                | Notes                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `keiko-ui/.../windows/WindowsRegistry.ts` (`registerWindowRender`, `"editor"` `WindowType`)                                                                | Open editor as a Workspace card window (#1196)               | Reuse as-is                | `"editor"` type + `PARTIAL.editor` already exist; inject Monaco render via `registerWindowRender`. Comply with ADR-0029 descriptor metadata.                       |
| `keiko-ui/.../widgets/cards/EditorWidget.tsx` (textarea placeholder)                                                                                       | Core editor component (#1194)                                | Generalize → replace       | Replace the `<textarea>` with the Monaco-backed component while preserving dirty-state, `Cmd/Ctrl-S` save, and `expectedModifiedAt` conflict detection.            |
| `keiko-ui/src/lib/api.ts` files/editor APIs; `keiko-server/src/files.ts`                                                                                   | File read/write/save BFF                                     | Reuse + extend             | Preserve selected-root containment, denied-path rules, write-conflict handling, max-size limits, redaction. New editor-session contracts in #1197.                 |
| `design-system/keiko-editor-tokens.css` (#1212) + `design-system/editor-theme.html`; `keiko-ui/.../globals.css`                                            | Monaco theme (syntax, chrome, diff, diagnostics, ghost text) | Reuse as-is                | Tokens already exist and **extend** `keiko-tokens.css` (do not fork). Wire into globals/Monaco theme; no ad-hoc editor colours.                                    |
| `keiko-ui/.../shared/diffParser.ts` (`parseUnifiedDiff`); `ReviewWidget.tsx` (`DiffFileSection`/`DiffLineView`)                                            | Diff/patch preview (#1195)                                   | Generalize                 | Reuse bounded-diff semantics (512 KB / 400-file caps); upgrade presentation to the Monaco diff editor.                                                             |
| `keiko-harness/src/patcher.ts` (`handlePatchProposal`); `keiko-tools/src/patch.ts` (`renderDryRun`)                                                        | Patch dry-run / apply (#1195 preview, #1204 apply)           | Reuse as-is                | Harness never applies; `renderDryRun` never writes (dry-run-by-default, `docs/security-and-audit-boundaries.md`). Apply remains explicit + wave 2.                 |
| `keiko-workflows/src/qualityIntelligence/modelRoutedTestDesign.ts`; `keiko-server/.../generationPort.ts`; `keiko-harness/src/tasks/generate-unit-tests.ts` | Test generation (#1202/#1203)                                | Generalize + wrap (wave 2) | Reuse generate port + injection scrubbing; expose an editor-originated request. No parallel generator.                                                             |
| `keiko-verification/*` (`runVerification`, `VERIFICATION_COMMAND_RULES`)                                                                                   | Verification (#1204)                                         | Reuse as-is (wave 2)       | Allowlisted commands, no shell, resource limits, classified evidence.                                                                                              |
| `keiko-evidence/*` (`recordQualityIntelligenceRun`, QI redaction, candidate store; `EVIDENCE_SCHEMA_VERSION`)                                              | Evidence for generated tests/patches                         | Reuse as-is                | Redaction-before-persist; immutable schema versioning. Provenance must distinguish user edits, Keiko completions, Keiko patches, verification, model-call records. |
| `keiko-contracts/src/unit-test-events.ts`                                                                                                                  | Test-generation event envelopes                              | Reuse as-is                | Editor test-gen emits the existing typed events.                                                                                                                   |

### 11.2 Matrix B — repository search, connected-context, Local Knowledge, memory retrieval, workflow context

All of these are server-side and query-only. The editor reaches them **only** via the #1192 typed
context port backed by the #1211 service. The editor owns none of this logic.

| Existing surface (verified path)                                                                                                                    | Use case                                                                    | Disposition              | Notes                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keiko-workspace/src/repoSearch.ts` (`searchText`, `findFiles`, `readExcerpt`)                                                                      | Symbol-nearby / dependency-impact / test-nearby / diagnostic-backed context | Reuse as-is              | Already reused server-side in `grounded-orchestrator.ts` (≈ lines 400, 1092, 1550). Query-only (depends on a `WorkspaceFs` port). Cheapest path → eligible per-keystroke.                                                                                                                                                     |
| `keiko-workspace/src/repoSearchPolicy.ts` (`resolveSearchPolicy`, `policyOmissionReason`, `SearchIntent`)                                           | Search governance + omission reasons                                        | Reuse as-is              | Provides the degradation/omission-reason pattern adopted in §8.1.                                                                                                                                                                                                                                                             |
| `keiko-workspace/src/contextPack.ts` (`buildContextPack`, `buildContextPackFromFiles`, `ContextPackDeps`)                                           | Budget-aware context-pack assembly                                          | Generalize               | Deterministic ranking + byte-budget. Generalize for editor purposes via #1211 rather than a new collector.                                                                                                                                                                                                                    |
| `keiko-server/src/grounded-orchestrator.ts` (`retrieveConnectedContextPack`, `OrchestratorDeps`, `GroundedAnswerer`); `grounded-qa-multi-source.ts` | Connected-context orchestration                                             | Generalize / wrap        | Linear retrieval pipeline; `GroundedAnswerer` seam is Model-Gateway-backed in production. #1211 reuses this assembly path; does not duplicate it.                                                                                                                                                                             |
| `keiko-local-knowledge/src/retrieval/*` (`runLocalKnowledgeRetrieval`, `assembleGroundedContext`); `.../conversation/*`                             | Capsule / knowledge-source grounding                                        | Reuse as-is (query-only) | Server-side retrieval inputs only; never browser editor state. Excluded from per-keystroke path (cost).                                                                                                                                                                                                                       |
| `keiko-memory-retrieval/*` (`retrieveMemoryContext`, `MemoryQueryPort`); route `/api/memory/context` (`routes.ts`), used in `chat-handlers.ts`      | Retained engineering memory as coding context                               | Reuse as-is (query-only) | Pure function + injected port. Governed/server-side; excluded from per-keystroke path like Local Knowledge.                                                                                                                                                                                                                   |
| `keiko-workflows/src/index.ts` (`planner`, `ranking`, `contextpack`; `classifyRetrievalIntent`)                                                     | Workflow context selectors / intent classification                          | Reuse as-is              | Reused by the orchestrator; #1211 selects intent through the same seam.                                                                                                                                                                                                                                                       |
| `keiko-evidence/src/connected-context-evidence.ts` (`persistConnectedContextEvidence`) + audit types                                                | Retrieval audit trail                                                       | Reuse as-is              | Editor-originated retrieval writes metadata-only audit evidence: redacted relative scope/path labels, query hash + byte count, excerpt hashes + byte counts, provider/provenance ids, omissions, and policy decisions. It must not persist raw queries, raw excerpts, workspace roots, prompts, secrets, or customer content. |
| `keiko-memory-capture/*`                                                                                                                            | Capturing memory **from** editor sessions                                   | Out of scope (v1)        | Not a v1 need; flag if a real capability gap emerges.                                                                                                                                                                                                                                                                         |

**No editor-specific retrieval collector is introduced.** Every coding-context need maps to an
existing system reused or generalized through #1211; this is the acceptance condition stated in the
#1190 blueprint-addendum comment.

### 11.3 Context-source reuse map (by agentic coding use case)

This map answers the #1190 blueprint-addendum comment directly: each agentic coding use case is mapped
to the existing Keiko context providers it consumes, with the per-provider disposition (**reuse** /
**generalize** / **wrap in BFF** / **leave out**) and the degradation behaviour when a provider is
unavailable, not-ready, denied, too expensive, or out of budget. All providers are the server-side,
query-only systems in Matrix B (§11.2), reached only through the #1192 typed context port backed by
the #1211 service; the editor runs no retrieval itself.

| Agentic use case                                                                     | Context providers consumed (disposition)                                                                                                                                                                                                                              | Degradation behaviour                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Completion** (deterministic + Keiko AI, #1198/#1199)                               | `repoSearch` symbol/dependency/test-nearby (reuse); `contextPack` budget assembly (generalize). Local Knowledge / memory / QI evidence: **left out** of the per-keystroke path (cost).                                                                                | If `repoSearch`/`contextPack` is unavailable or over budget, completion proceeds on buffer-local context only and ultimately falls back to deterministic language-service completion; omission recorded as metadata-only evidence. |
| **Inline completion / ghost text** (#1200/#1210)                                     | Same as Completion — `repoSearch` (reuse) + `contextPack` (generalize), strictly the cheapest deterministic context only. All heavier providers **left out**.                                                                                                         | If no FIM-capable `latencyClass:"fast"` model or context is unavailable: no ghost text; manual-invoke inline suggestion backed by deterministic completion. Never blocks typing.                                                   |
| **Generated unit tests** (#1202, wave 2)                                             | `repoSearch` + `contextPack` (reuse/generalize); connected-context orchestration (`grounded-orchestrator`) (generalize/wrap); Local Knowledge retrieval (reuse, query-only); memory retrieval (reuse, query-only); QI evidence (reuse).                               | Each provider degrades to a smaller governed context and records the omission as metadata-only evidence; generation proceeds with reduced grounding rather than failing, and never executes in v1 (gated, §10).                    |
| **Generated frontend / component / Vitest / RTL / Playwright tests** (#1203, wave 2) | Same provider set as unit tests (reuse/generalize/wrap), plus component/selector context from `repoSearch` over the component tree (reuse). No new collector.                                                                                                         | Same degradation as unit tests; if component-specific context is unavailable, falls back to file/symbol-scoped grounding with recorded omission.                                                                                   |
| **Diagnostics & explanations** (#1201)                                               | Deterministic server language service is authoritative for diagnostics (no model). Explanations may consume `repoSearch` + `contextPack` (reuse/generalize) and, for explicit (non-keystroke) requests, connected-context/Local Knowledge/memory (reuse, query-only). | Diagnostics never depend on retrieval (deterministic). Explanations degrade to symbol-local context with metadata-only recorded omission; never block the editor.                                                                  |
| **Memory capture from editor sessions**                                              | `keiko-memory-capture` — **left out** of v1.                                                                                                                                                                                                                          | Not a v1 capability; flagged for a future capability-gap review, not implemented as an editor collector.                                                                                                                           |

## 12. Dependency decision record (Monaco, `@monaco-editor/react`, LSP bridge)

| Dependency                                       | Version checked                              | License | Decision                                 | Rationale / conditions                                                                                                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------- | ------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monaco-editor`                                  | 0.55.1 (epic grounding, 2026-06-17; current) | MIT     | **Adopt** (local, no CDN)                | The editor + diff editor + bundled language workers. All assets served same-origin (§5). Supply-chain controls in #1193/#1206 (pinned version, SBOM, license gate).                                                                                  |
| `@monaco-editor/react`                           | 4.7.0                                        | MIT     | **Adopt**, loader pinned to local Monaco | Wrapper for React lifecycle. Must call `loader.config({ monaco })` so the default CDN loader is never used.                                                                                                                                          |
| `monaco-editor-webpack-plugin`                   | —                                            | —       | **Reject**                               | Incompatible with Next.js 16 Turbopack. Use ESM worker wiring instead (§5.3).                                                                                                                                                                        |
| `monaco-languageclient`                          | —                                            | —       | **Not adopted by default**               | Monaco's bundled `ts.worker` + the server TS language service cover v1 without LSP/JSON-RPC. Reconsider only for an out-of-process LSP bridge (#1213), after dependency review (fit, maintenance, size, security, Keiko-architecture compatibility). |
| Out-of-process LSP servers (Java/Python/Rust/Go) | —                                            | —       | **Deferred** (#1213, P2)                 | Staged multi-language expansion; not v1.                                                                                                                                                                                                             |

No additional LSP dependencies are imported until dependency review is complete (epic Engineering
Notes). The grounding references (Monaco ESM worker integration; LSP 3.17; `monaco-languageclient`
repo) are used for orientation only.

## 13. Risk register

| #   | Risk                                                                                                                    | Category                          | Likelihood × Impact            | Mitigation / owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Monaco/`@monaco-editor/react` (and transitive deps) introduce supply-chain exposure; default loader silently uses a CDN | Supply chain                      | Med × High                     | Pin versions; SBOM + license gate (`check:workspace-supply-chain`); `loader.config({ monaco })`; no-CDN proof (§5.5). Owner: #1193/#1206.                                                                                                                                                                                                                                                                                                                                          |
| R2  | Worker loading breaks under Turbopack / static export, or CSP blocks workers                                            | Browser workers                   | Med × High                     | ESM `new Worker(new URL(...))` + client-only dynamic import; `worker-src 'self'` already present; dev+prod proof + build-output assertion. Owner: #1193/#1207.                                                                                                                                                                                                                                                                                                                     |
| R3  | As-you-type completion exceeds the latency/INP budget; large files degrade responsiveness                               | Performance                       | Med × Med                      | Per-keystroke uses deterministic + cheapest context only; requests are debounced (≥ 200 ms, #1207) and self-cancelling (`AbortSignal`); §5.1 sets hard budgets: <50 ms per-keystroke main-thread work, INP ≤200 ms at p75, deterministic completion p50 ≤150 ms / p95 ≤500 ms, AI ghost text p50 ≤200 ms / p95 ≤750 ms, full interactivity only up to 500 KB and 10,000 lines, and read-only/degraded mode above that until the 1,000,000-byte BFF ceiling.                        |
| R3b | Monaco inflates the UI bundle / first-load JS                                                                           | Performance / supply chain        | Med × High                     | Monaco is a lazy-loaded chunk behind the `ssr: false` dynamic import and must **not** appear in first-load JS; §5.1 sets 0 bytes gzip Monaco/editor code in non-editor first-load JS, ≤2.5 MB gzip total lazy editor + Monaco runtime, and no worker chunk >750 KB gzip. #1207 adds static-export assertions that fail if Monaco/editor code enters the initial payload or exceeds these budgets.                                                                                  |
| R4  | Browser-side completion/context bypasses the Model Gateway or leaks credentials                                         | Model boundary                    | Low × High                     | ADR-0019 rule 8 (no Node-domain value imports in browser tier); gateway barrel hides internals; all model calls server-side. Owner: #1199/#1206. ADR-0042 records the rule.                                                                                                                                                                                                                                                                                                        |
| R5  | Executing model-generated tests = untrusted-code execution without OS egress isolation                                  | Workspace writes / execution      | High (if enabled early) × High | **Deferred to wave 2** behind a default-off flag gated on enforced deny-by-default egress proven by CI test (§10). Generation-time isolation + coverage-delta + mutation-kill gates.                                                                                                                                                                                                                                                                                               |
| R6  | Retrieved RAG context carries an injection payload into the completion/test-gen prompt (OWASP LLM08 / LLM01)            | Model boundary / prompt injection | Med × High                     | Reuse or extract an exported/shared hardening seam for control-character stripping, delimiter neutralization, and redaction; do not couple to private QI helpers or rely on scrubbing alone. Prompt templates label retrieved chunks as non-authoritative data, malicious-retrieval fixtures cover repoSearch/Local Knowledge/memory/QI evidence, privileged outcomes remain impossible without explicit user action, and retrieval evidence is metadata-only. Owner: #1211/#1206. |
| R7  | Raw base-model FIM is highly injectable from surrounding buffer/retrieved context                                       | Model boundary                    | Med × High                     | Require aligned/instruct completion models, not base FIM; record guardrail in #1210/#1200.                                                                                                                                                                                                                                                                                                                                                                                         |
| R8  | Patch apply mutates files outside review/containment                                                                    | Workspace writes                  | Low × High                     | Dry-run by default; explicit, scope-validated apply; rollback guardrails (wave 2, #1204).                                                                                                                                                                                                                                                                                                                                                                                          |
| R9  | New browser-tier package weakens architecture gates (missing rule/fixture)                                              | Architecture                      | Med × Med                      | Land all gate edits + negative fixture in #1191 (§3); ADR-0042 cited from the new rule.                                                                                                                                                                                                                                                                                                                                                                                            |
| R10 | Editor accrues retrieval/knowledge/memory logic (parallel runtime)                                                      | Architecture                      | Med × Med                      | #1192 AC: editor contains no retrieval/knowledge/memory/context logic; enforced by the boundary in §2 and §8.                                                                                                                                                                                                                                                                                                                                                                      |

## 14. First supported language/test stack and staged expansion

- **v1 first-class:** TypeScript / JavaScript. Deterministic language intelligence (#1198) and test
  generation (#1202/#1203, wave 2) target TS/JS, Vitest, and React Testing Library where applicable;
  Playwright/frontend smoke paths where applicable.
- **Language-agnostic from day one:** syntax highlighting/editing (Monaco, #1193) and AI completion
  via the Model Gateway (#1199/#1200/#1210) are not language-bound.
- **Staged expansion** ([#1213](https://github.com/oscharko-dev/Keiko/issues/1213), **P2, deferred**):
  deterministic LSP providers for Java, Python, Rust, Go and their test stacks (JUnit/Maven, pytest,
  cargo, `go test`). This is where `monaco-languageclient` / out-of-process LSP would be re-evaluated.

## 15. Release branch and human-in-the-loop merge gates

- **Integration branch.** Keiko Editor work lands on the epic integration branch (currently
  `feat/keiko-editor`). Child-issue PRs target that integration branch, not the protected mainline
  release branch directly. (Note: the epic body's original references to
  `codex/keiko-editor-vscode-experience` off `release/0.2.0` predate the current `feat/keiko-editor`
  integration branch; the names should be reconciled in the epic, but the gate model is unchanged.)
- **Human-in-the-loop merge gates.** Every child PR keeps `Human Review Required: Yes`; required
  GitHub checks must be green; all actionable review findings are fixed or explicitly dispositioned;
  acceptance criteria and verification checkboxes are updated only when evidence exists. No autonomous
  merge into the protected release line: a human reviewer explicitly approves the final merge of the
  epic (epic Definition of Done). Keiko never commits, pushes, opens PRs, merges, or applies patches
  without explicit local action (ADR-0019 / security boundaries).

## 16. Parallelization and sequencing plan

The epic's "no two agents on overlapping file scope" stop condition requires an explicit plan.

- **Strictly sequential server chain** (shared writes to `packages/keiko-contracts/src/index.ts`
  barrel and the server `API_ROUTES`/route table): **#1197 → #1198 → #1199** (BFF session contracts →
  deterministic language service → completion bridge), with #1200 (inline) and #1201
  (diagnostics/symbols/hover/formatting) following #1199. Serialize these contract/route writes.
- **May run concurrently** (disjoint scope): #1191 (package + gates) once landed unblocks the rest;
  #1192 (editor contracts/ports) and #1212 (design tokens, already present) are independent of the
  server chain; #1193 (Monaco runtime) and #1194 (core editor) and #1195 (diff) are editor-package
  scope; #1210 (gateway FIM) is gateway scope; #1211 (context service) is server/retrieval scope but
  must coordinate its contract additions with the #1197→#1199 barrel writes.
- #1192 and #1211 do **not** write the contracts barrels that the server chain serializes, so they are
  not in that shared-write set.

## 17. Regulatory record-keeping and oversight mapping

The editor's evidence, provenance, and human-review design must map to the following. **Any
high-risk classification under EU AI Act Annex III is a reviewer determination, not an assumption made
by this blueprint.**

| Regime                                  | Requirement                     | How the design satisfies it                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EU AI Act (Reg. (EU) 2024/1689) Art. 12 | Record-keeping / logging        | Redaction-before-persist evidence (`keiko-evidence`), connected-context audit (`persistConnectedContextEvidence`), immutable evidence schema versioning, distinguishable provenance (user edits vs Keiko completions vs Keiko patches vs verification vs model-call records). |
| EU AI Act Art. 14                       | Human oversight                 | Dry-run patches, explicit review-before-apply, `Human Review Required: Yes`, no autonomous merge, human-approved final merge.                                                                                                                                                 |
| DORA (Reg. (EU) 2022/2554)              | ICT risk, traceability          | Governed BFF + Model Gateway as the single model seam; allowlisted commands; SBOM/license gates; auditable retrieval evidence. SBOM/Register-of-Information mapping is a follow-up owner input.                                                                               |
| BaFin BDAI principles (2021)            | Algorithmic decision governance | Deterministic-first defaults, model-boundary governance, documented limitations, human oversight. Whether to adopt BaFin's Dec-2025 ICT/AI guidance as the primary reference is an open owner decision.                                                                       |

Open owner decisions (compliance inputs, not start-blockers): (a) EU AI Act Art. 6(3)/Art. 50
classification memos; (b) adopt BaFin Dec-2025 ICT/AI guidance vs the 2021 BDAI principles;
(c) DORA critical-function + SBOM Register-of-Information mapping. The wave-2 egress decision is
already made (§1.2, §10): defer behind enforced egress.

## 18. Acceptance-criteria traceability

| #1190 acceptance criterion                                                                    | Satisfied in                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Exact package boundaries and host responsibilities                                            | §2                                                                 |
| Which existing Keiko modules are reused/extended                                              | §8, §10.1, §11 (Matrices A & B)                                    |
| Forbids CDN Monaco loading by default                                                         | §5, §12; ADR-0042                                                  |
| All completions and generated tests route through Keiko backend governance                    | §6, §7, §10                                                        |
| Agentic context assembled by existing Keiko backend retrieval, not an editor-specific runtime | §8, §11.2                                                          |
| Exact boundary between editor UI contracts and backend context/search/retrieval ports         | §2.1, §8                                                           |
| First supported language/test stack and staged expansions                                     | §14                                                                |
| Release branch and human-in-the-loop merge gates                                              | §15                                                                |
| Monaco worker strategy for Next.js 16 + Turbopack + static export, no-CDN proof plan          | §5                                                                 |
| In-browser-worker vs server-language-service division + conflict resolution                   | §6                                                                 |
| FIM/infilling capability requirement + inline-completion degradation policy                   | §7                                                                 |
| Evidence/provenance/human-review mapped to EU AI Act Art. 12/14, DORA, BaFin                  | §17                                                                |
| Required ADR (write ownership)                                                                | [ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md) |
| Reuse/no-duplication matrices (2)                                                             | §11.1, §11.2                                                       |
| Context-source reuse map by agentic use case (blueprint-addendum comment)                     | §11.3                                                              |
| Dependency decision record                                                                    | §12                                                                |
| Risk register                                                                                 | §13                                                                |
| Parallelization plan                                                                          | §16                                                                |

## 19. Grounding references

- ADR-0019 (modular package architecture, dependency direction rule 8 = browser tier), ADR-0024
  (installable PWA / CSP / static-export host), ADR-0025 (forward-only 0.2.0 baseline), ADR-0029
  (workspace object registry), ADR-0038 (outbound egress), and ADR-0042 (this epic's editor ADR).
- `.dependency-cruiser.cjs`, `scripts/check-package-graph.mjs`, `scripts/arch-check-negative.mjs`,
  `tsconfig.packages.json`, `docs/security-and-audit-boundaries.md`.
- Monaco Editor `0.55.1` (MIT); `@monaco-editor/react` `4.7.0` (MIT); Monaco ESM worker integration
  guide; LSP 3.17 specification; `monaco-languageclient` (evaluate-before-adopt).
- Bavarian et al., "Efficient Training of Language Models to Fill in the Middle," 2022
  (arXiv:2207.14255).
- OWASP Top 10 for LLM Applications (2025): LLM01 (prompt injection), LLM05 (improper output
  handling), LLM08 (vector/embedding/retrieval weaknesses).
- EU AI Act, Reg. (EU) 2024/1689, Art. 12 & 14; DORA, Reg. (EU) 2022/2554; BaFin "Big data and
  artificial intelligence" principles (2021).
