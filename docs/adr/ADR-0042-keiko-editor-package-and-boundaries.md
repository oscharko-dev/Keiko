# ADR-0042: Keiko Editor package, boundaries, and governed coding architecture

## Status

Proposed (2026-06-18). Pending human review. Authored for Issue
[#1190](https://github.com/oscharko-dev/Keiko/issues/1190) (Parent Epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189)). This ADR is the citable decision record
referenced by the dependency-cruiser browser-tier rule that Issue
[#1191](https://github.com/oscharko-dev/Keiko/issues/1191) adds for `@oscharko-dev/keiko-editor`. The
full plan, reuse matrices, dependency decision record, risk register, and regulatory mapping live in
the companion blueprint:
[docs/planning/keiko-editor-architecture-blueprint.md](../planning/keiko-editor-architecture-blueprint.md).

Amended 2026-06-18 for Issue [#1196](https://github.com/oscharko-dev/Keiko/issues/1196): added
decision D3.7 (Monaco DOMPurify supply-chain control for the keiko-ui host mount).

## Date

2026-06-18

## Version

1.1

## Context

The Keiko Editor epic delivers a VS Code-grade in-product coding experience: a Monaco-based editor and
diff editor inside a Workspace card window, Keiko-governed completion and inline completion,
deterministic language intelligence and diagnostics, retrieval-grounded coding context, reviewable
diffs, and (in a later wave) reviewable generated tests with deterministic verification and evidence.

Keiko is a regulated-delivery product. Every cross-package boundary is governed by a numbered ADR
cited from `.dependency-cruiser.cjs`, productive model calls route only through
`@oscharko-dev/keiko-model-gateway`, the browser tier (`@oscharko-dev/keiko-ui`) must not value-import
Node-domain packages (ADR-0019 direction rule 8), the UI binds to loopback, patches are dry-run by
default, evidence is redacted before persistence, and Keiko is explicitly **not** an OS sandbox
(`docs/security-and-audit-boundaries.md`). Introducing a new browser-facing editor package and an
agentic coding loop must preserve all of these invariants.

The host stack is fixed and non-trivial for editor runtime loading: `@oscharko-dev/keiko-ui` runs
**Next.js 16.2.9 (App Router), Turbopack, and `output: "export"` static export**
(`packages/keiko-ui/next.config.mjs`). `monaco-editor` and `@monaco-editor/react` are not yet
dependencies. The Model Gateway's `ModelCapability` contract
(`packages/keiko-contracts/src/gateway.ts`) has no fill-in-the-middle (FIM) capability today.

This ADR governs the architecture decisions that the downstream editor children (#1191–#1213) must
respect. It does not implement them.

## Decision

### D1 — `@oscharko-dev/keiko-editor` is a browser-tier package that owns editor UI only

A new workspace package `@oscharko-dev/keiko-editor` is created (by #1191) in the **browser tier**,
peer to `@oscharko-dev/keiko-ui` under ADR-0019. It owns Monaco editor/diff lifecycle and rendering,
editor UI contracts, the host-integration API (typed ports/callbacks), provider **wiring** (not
computation), the Monaco theme bound to the #1212 design tokens, and editor-local view/keyboard/a11y
state.

It must **not** own repository search, knowledge retrieval, memory retrieval, context assembly, model
routing, the Model Gateway, patch application, verification, evidence persistence, workspace
authority, or any concrete Keiko BFF route. It must be reusable outside `keiko-ui` and must not import
`keiko-ui` internals.

v1 ships **one** package; a `core`/`react` split is deferred until a second host consumer exists, with
internal module layout kept split-ready.

### D2 — Browser-tier dependency direction and monorepo-gate integration

`@oscharko-dev/keiko-editor` inherits the browser-tier trust boundary: it must not value-import
Node-domain packages (`keiko-model-gateway`, `keiko-workspace`, `keiko-tools`, `keiko-harness`,
`keiko-workflows`, `keiko-evidence`, `keiko-server`, `keiko-quality-intelligence`,
`keiko-local-knowledge`, `keiko-sdk`); type-only imports of shared contracts are permitted. v1
workspace dependency is `@oscharko-dev/keiko-contracts` (type-only where possible).

Issue #1191 must, in one reviewable change, update all governed gates (each verified present on the
base branch):

1. `scripts/check-package-graph.mjs` — add a `keiko-editor` entry to `ALLOWED_WORKSPACE_DEPENDENCIES`
   (absence emits `"<pkg>: missing ADR-0019 workspace dependency allowlist entry"`).
2. `tsconfig.packages.json` — add a `packages/keiko-editor` project reference.
3. `.dependency-cruiser.cjs` — add a new browser-tier from-rule forbidding
   `packages/keiko-editor/src` from value-importing Node-domain packages, mirroring
   `adr-0019-direction-8-ui-not-node-domain-values` (`dependencyTypesNot: ["type-only"]`). **This new
   rule cites this ADR (ADR-0042).**
4. `scripts/arch-check-negative.mjs` — update `EXPECTED_DEPCRUISER_RULE_COUNTS` for the new rule and
   add a negative fixture under `tests/architecture/fixtures/`.

### D3 — No-CDN Monaco runtime and worker strategy for Next.js 16 + Turbopack + static export

1. **No CDN.** Monaco core and all language workers are served same-origin from the locally installed
   `monaco-editor` package. No editor runtime asset is fetched from a CDN.
2. **`@monaco-editor/react` loader pinned.** The host calls `loader.config({ monaco })` against the
   local package before first mount; the wrapper's default CDN loader is never used.
3. **ESM worker wiring; no webpack plugin.** `monaco-editor-webpack-plugin` is forbidden (incompatible
   with Turbopack). Workers load via `new Worker(new URL("…", import.meta.url), { type: "module" })`
   in a `MonacoEnvironment.getWorker` factory, behind a client-only dynamic import (`ssr: false`),
   following the existing client-only-guard pattern (`registerSw.ts`).
4. **CSP unchanged.** The server CSP already sets `worker-src 'self'`, `script-src 'self'` with inline
   SHA-256 hashes (no `unsafe-inline`), `connect-src 'self'`, and `style-src 'self' 'unsafe-inline'`
   (pre-existing, for Tailwind) (`packages/keiko-server/src/csp.ts`). Same-origin ESM workers,
   same-origin BFF calls, and Monaco's runtime style injection satisfy this; no
   `worker-src`/`script-src`/`connect-src`/`style-src` widening is permitted for Monaco or editor coding
   features. `@oscharko-dev/keiko-editor` may not issue direct browser network calls to non-same-origin
   model, retrieval, analytics, telemetry, or provider endpoints.
5. **No-CDN / no-browser-egress proof.** #1193 proves zero non-loopback and non-same-origin browser
   requests on editor + worker-backed features under both `next dev` (Turbopack) and the static
   production build; #1206/#1207 extend that network-intercept proof to completion, inline completion,
   diagnostics/context, and disabled test-generation actions. #1193 also asserts that worker chunks
   ship in the static export.
6. **Initial performance budgets.** The static shell carries 0 bytes gzip of Monaco/editor code in
   first-load JavaScript; the lazy editor + Monaco runtime budget is ≤ 2.5 MB gzip total with no worker
   chunk > 750 KB gzip; first editor-card open targets p50 ≤ 1.5 s and p95 ≤ 2.5 s; typing keeps
   per-keystroke main-thread work < 50 ms and INP ≤ 200 ms at p75; files > 500 KB or > 10,000 lines
   enter read-only/degraded mode, and files > 1,000,000 bytes use the existing too-large path without
   instantiating Monaco. #1207 measures and enforces these budgets; #1209 records release evidence.
7. **Monaco DOMPurify supply-chain control (#1196 host mount).** Mounting Monaco in `keiko-ui` brings
   `monaco-editor`'s declared `dompurify@3.2.7` dependency into keiko-ui's audit closure, tripping the
   `ui` job's `npm audit --audit-level=moderate --workspace @oscharko-dev/keiko-ui`. The control is a
   root `overrides: { dompurify: "3.4.11" }` pinning the patched DOMPurify line (the advisories affect
   `<= 3.4.10`); `monaco-editor` stays at the `0.55.1` pin and the `npm audit fix` downgrade to `0.53.0`
   is not taken. The override does not replace Monaco's vendored DOMPurify copy, but the mounted editor
   disables every Markdown-rendering sink in `buildEditorOptions` (hover, suggest docs, parameter hints,
   inline suggest, code lens, lightbulb, inlay hints, links) and wires no completion/diagnostics
   provider, so the vendored sanitiser never executes and runtime exposure is nil. The durable fix
   remains upgrading Monaco to a release vendoring DOMPurify `>= 3.3.2` once one exists. Detailed in the
   `@oscharko-dev/keiko-editor` README supply-chain note.

### D4 — Server-side deterministic language service is the single source of truth

The deterministic TypeScript/JavaScript language service is a **keiko-server module** (#1198), not a
new package (server may already depend on the domain packages it needs; no new ADR-0019 direction rule
is required). It is the single governed source of truth for completion, diagnostics, hover, symbols,
and quick info. The in-browser Monaco `ts.worker` is **disabled for governed features** and provides
only local tokenization/bracket-matching/colouring. Where both could answer, the server language
service wins for anything recorded, audited, or model-augmented. `monaco-languageclient` is **not
adopted by default**; reconsider only for an out-of-process LSP bridge (#1213) after dependency review.

### D5 — All completion and generated output is governed; FIM is a Model Gateway extension

Completion is two-tier: deterministic language-service completion (default, model-free) and additive
Keiko AI completion routed through the Model Gateway (#1199 bridge, #1200 inline). The editor package
registers Monaco providers and renders results; it computes nothing and never calls a model directly.

The Model Gateway gains a suffix-aware FIM/infilling capability and selection (#1210), mirroring the
QI capability-gate pattern (`buildSelectionQueryForCapabilities`), since `ModelCapability` has no FIM
flag today. The as-you-type selection query must require **both** the new FIM capability **and** the
existing `latencyClass: "fast"` field on `ModelCapability`, so a `standard`/`slow` model is never
elected for per-keystroke ghost text. **Degradation policy:** as-you-type ghost text only when a fast
FIM-capable model is available; otherwise manual-invoke inline suggestion backed by deterministic
completion — never a silent ungoverned fallback. The as-you-type path is debounced and self-cancelling
(`AbortSignal`) and remains enabled only while content-free telemetry stays within p50 ≤ 200 ms / p95
≤ 750 ms after debounce; deterministic completion targets p50 ≤ 150 ms / p95 ≤ 500 ms. Completion must
use aligned/instruct models, not raw base-model FIM (prompt-injection risk).

### D6 — Agentic coding context is assembled by existing backend retrieval, not the editor

The editor obtains coding context only through a typed context port (#1192:
`EditorContextRequest`/`EditorContextResult` with a `purpose`) backed by a governed server-side
retrieval service (#1211) that reuses existing systems — `repoSearch`/`repoSearchPolicy`,
connected-context orchestration (`grounded-orchestrator`), Local Knowledge retrieval, memory retrieval
(`retrieveMemoryContext`), Quality Intelligence evidence, context-pack assembly (`buildContextPack`),
and workflow context selectors. All run server-side and query-only. The editor package contains **no**
retrieval/knowledge/memory/context-assembly logic. Per-keystroke completion uses only the cheapest
deterministic context; heavier providers serve explicit requests. Every provider has defined
degradation behaviour (unavailable/not-ready/denied/too-expensive/out-of-budget) recorded as
metadata-only evidence: redacted relative labels, hashes, byte counts, provider/provenance ids,
omissions, and policy decisions only — never raw queries, excerpts, prompts, workspace roots, secrets,
or customer content. Retrieved repo text, Local Knowledge chunks, memory, and QI evidence are untrusted
model input; #1211/#1206 must test malicious retrieval fixtures and prove retrieved content cannot grant
tool authority, request secrets, bypass review/evidence gates, apply patches, or execute tests.

### D7 — Patches stay reviewable; code execution is deferred behind enforced egress

Diff/patch preview (#1195) reuses the dry-run model (harness never applies; `renderDryRun` never
writes; dry-run-by-default per `docs/security-and-audit-boundaries.md`). Patch **apply** and
editor-driven test **generation/execution/verification**
(#1202/#1203/#1204) are **wave 2**, gated behind a default-off feature flag that may be enabled only
once a deny-by-default network-egress boundary is enforced and proven by an automated test. Rationale:
executing model-generated tests is untrusted-code execution (OWASP LLM05:2025) and Keiko does not yet
OS-enforce egress (`tools.ts` `network: "inherit"`; `limits.ts` `enforced: false`;
`security-and-audit-boundaries.md` "Keiko is not a sandbox"). No v1 flow executes model-generated
code.

### D8 — Release branch and human-in-the-loop merge gates

Editor work lands on the epic integration branch (currently `feat/keiko-editor`); child PRs target
the integration branch, keep `Human Review Required: Yes`, require green checks, and resolve or
disposition all actionable findings. No autonomous merge into the protected release line; a human
reviewer explicitly approves the epic's final merge. Keiko never commits, pushes, merges, or applies
patches without explicit local action.

## Consequences

- The editor gains a VS Code-grade experience while every model call, retrieval, patch, verification,
  and evidence write stays inside the existing governed seams; the browser tier cannot bypass them.
- Creating the package is a governed, reviewable change: the four gate edits in D2 are enumerated, so
  the architecture checks fail closed until they land and the new rule cites this ADR.
- The no-CDN ESM worker decision is compatible with the real host stack (Turbopack + static export)
  and the existing CSP without relaxation.
- One governed language-intelligence path (server language service) removes provider ambiguity and
  keeps results auditable.
- Deferring code execution behind enforced egress keeps v1 free of untrusted-code execution; wave 2
  has a concrete, testable enablement prerequisite rather than an implicit assumption.
- Cost: the editor needs a richer host-integration port surface (#1192) than a naive Monaco drop-in,
  and FIM completion depends on a per-deployment model capability (#1210) that may be absent, in which
  case ghost text gracefully degrades.

## Out of Scope

- Implementing editor components, server endpoints, or applying generated code (owned by #1191–#1213).
- Running arbitrary VS Code extensions; browser-side direct model calls; live writes to external
  test-management systems.
- Multi-language deterministic LSP providers and their test stacks (#1213, P2, deferred).
- Native installers (Electron/Tauri) — unchanged from ADR-0024.

## Alternatives Considered

- **Split `core`/`react` packages in v1.** Rejected for v1: doubles the monorepo-gate surface for no
  current second consumer; ADR-0025 forward-only baseline discourages speculative package growth.
  Internal layout stays split-ready.
- **Use the in-browser `ts.worker` as the completion/diagnostics provider.** Rejected: it is
  ungoverned, single-file, and would create a second answer path that bypasses audit and
  model-boundary governance. It is kept only for cosmetic local tokenization.
- **Adopt `monaco-languageclient` now.** Rejected for v1: Monaco's bundled workers + the server
  language service cover TS/JS without LSP/JSON-RPC plumbing; revisit for out-of-process LSP (#1213).
- **`monaco-editor-webpack-plugin` for worker bundling.** Rejected: incompatible with Next.js 16
  Turbopack; ESM worker wiring is used instead.
- **Enable editor-driven test execution in v1.** Rejected: untrusted-code execution without enforced
  egress isolation; deferred to wave 2 behind a proven egress boundary.

## Related

- ADR-0019 (Modular Package Architecture; dependency direction rule 8 = browser tier)
- ADR-0024 (Installable PWA architecture; CSP, static export host)
- ADR-0025 (Forward-only 0.2.0 modular baseline)
- ADR-0029 (Workspace object registry and extension contract)
- ADR-0038 (Shared proxy- and custom-CA-aware outbound HTTP egress)
- Epic #1189; Issue #1190 (this ADR + the companion blueprint); Issues #1191–#1213
- `docs/planning/keiko-editor-architecture-blueprint.md`
- `docs/security-and-audit-boundaries.md`
- Monaco Editor 0.55.1 (MIT); `@monaco-editor/react` 4.7.0 (MIT); Monaco ESM worker integration; LSP
  3.17; `monaco-languageclient`
- OWASP Top 10 for LLM Applications (2025): LLM01, LLM05, LLM08
- EU AI Act Reg. (EU) 2024/1689 Art. 12 & 14; DORA Reg. (EU) 2022/2554; BaFin BDAI principles (2021)
