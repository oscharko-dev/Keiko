# ADR-0045: Staged multi-language editor expansion — deterministic LSP providers and multi-stack test generation

## Status

Proposed (2026-06-20). Pending human review. Authored for Issue
[#1213](https://github.com/oscharko-dev/Keiko/issues/1213) (Parent Epic
[#1189](https://github.com/oscharko-dev/Keiko/issues/1189)). This ADR is the citable decision record
for the staged expansion of the Keiko Editor beyond TypeScript/JavaScript to deterministic
language-intelligence providers for Java, Python, Rust, and Go and their test stacks (JUnit/Maven,
pytest, `cargo test`, `go test`). It records the decision that [ADR-0042](ADR-0042-keiko-editor-package-and-boundaries.md)
deferred to "an out-of-process LSP bridge (#1213) after dependency review" (ADR-0042 D4 and
Alternatives Considered). The full candidate-language assessment, reuse matrices, dependency decision
record, risk register, per-language security model, and regulatory mapping live in the companion
blueprint: [docs/planning/keiko-editor-multi-language-expansion.md](../planning/keiko-editor-multi-language-expansion.md).

This ADR is **planning only**. It changes no runtime code, installs no language server or toolchain,
relaxes no existing boundary or quality gate, and does not alter the first-release
TypeScript/JavaScript scope or the #1189 required implementation order. Each future language is
delivered by its own implementation issue (or a promoted dedicated epic) with its own routing, branch,
board fields, and acceptance criteria, under the governance recorded here.

## Date

2026-06-20

## Version

1.0

## Context

The Keiko Editor first release (#1189) is TypeScript/JavaScript-first. Deterministic language
intelligence (completion, diagnostics, hover/quick-info, document symbols, formatting) is a governed,
model-free **keiko-server module** with a **provider-pluggable registry** — the single governed source
of truth per [ADR-0042](ADR-0042-keiko-editor-package-and-boundaries.md) D4. The in-browser Monaco
`ts.worker` is disabled for governed features; the browser tier talks only to same-origin BFF routes,
issues no direct model/retrieval/analytics network calls, and the CSP is not widened for editor
features (ADR-0042 D2/D3). Productive model calls route only through
`@oscharko-dev/keiko-model-gateway` (ADR-0042 D5). Agentic coding context is assembled server-side by
existing retrieval systems behind a typed port (ADR-0042 D6). Executing untrusted, model-generated
code is gated behind a deny-by-default, CI-proven enforced-egress boundary
([ADR-0043](ADR-0043-enforced-execution-isolation.md), `@oscharko-dev/keiko-sandbox`), and Keiko is
explicitly **not** an OS sandbox (`docs/security-and-audit-boundaries.md`).

ADR-0042 deferred multi-language deterministic providers (#1213, P2) and named
`monaco-languageclient` / out-of-process LSP as the path to "reconsider after dependency review." This
ADR performs that review and records the staged-expansion decision.

The candidate languages, their standard LSP servers, and their toolchains differ materially in the one
dimension that matters most for a regulated-delivery product — **whether analysis executes untrusted
project code, and when** (assessed 2026-06; full table in the blueprint §3):

| Language | Standard LSP server                 | License            | Runtime toolchain | Disk footprint (server + toolchain, approx.) | Untrusted-code execution during analysis                                                                            |
| -------- | ----------------------------------- | ------------------ | ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Python   | Pyright (Microsoft)                 | MIT                | Node.js (recent)  | ~200 MB                                      | **None** — pure static analysis; project code is never executed.                                                    |
| Go       | gopls (`golang.org/x/tools`)        | BSD-3-Clause       | Go 1.21+          | ~400–600 MB                                  | **None/low** — gopls does not execute project code; `go:generate` is driven by the `go` tool, not gopls.            |
| Java     | Eclipse JDT Language Server (jdtls) | EPL-2.0            | JDK 21+           | ~250–300 MB                                  | **High** — executes Maven/Gradle build scripts and plugins during project import/indexing.                          |
| Rust     | rust-analyzer                       | Apache-2.0 AND MIT | Rust toolchain    | ~1.5–2.5 GB                                  | **Critical** — proc-macro expansion and `build.rs` execute arbitrary untrusted code at index time, with no sandbox. |

The decisive new fact, relative to the TS/JS baseline, is that for Java and Rust **untrusted code runs
at index/hover time — simply opening a project — long before any test executes**. ADR-0043's enforced
boundary today wraps _test execution_ (the #1202 assured pre-filter, #1204 post-apply verification).
Multi-language analysis introduces a second untrusted-execution surface that the deterministic TS/JS
path never had, and the plan must govern it explicitly rather than inherit a test-only assumption.

## Decision

### D1 — No new package; languages register as providers in the existing server-side registry

Multi-language support is delivered by registering new `LanguageProviderDescriptor` entries
(`packages/keiko-contracts/src/language-service.ts`) into the existing server-side language-service
orchestrator (`packages/keiko-server/src/editor/languageService.ts`). **No new workspace package is
created, no contract version bump is required, and the `@oscharko-dev/keiko-editor` browser shell is
not modified** — it keeps talking to the same BFF routes (`POST /api/editor/{language,context,
completion,inline}`). The orchestrator stays language-agnostic: it resolves a provider by `languageId`
and dispatches `completion`/`diagnostics`/`hover`/`symbols`/`formatting` unchanged, preserving
ADR-0042 D4 (one governed source of truth) and D1 (editor owns UI only, computes nothing).

### D2 — Out-of-process LSP servers are owned server-side; no browser-side LSP client

Each new provider bridges to its standard LSP server as an **out-of-process child of `keiko-server`**,
spoken to over stdio JSON-RPC. The Monaco↔LSP bridge is a **server-side** concern. LSP process launch
must not introduce an ungoverned second spawn boundary: a future implementation either reuses the
existing ADR-0043 command wrapper/attestation path (`keiko-tools` `runCommand`, with command rules,
environment allowlisting, and sandbox attestation) or lands an ADR-0043 amendment that defines an
equivalent long-lived LSP process manager before any provider ships. **`monaco-languageclient` is
evaluated and not adopted in the browser tier**: a browser-side language client would open a second
answer path that bypasses the governed server orchestrator (violating ADR-0042 D4), and any
browser→server LSP transport (WebSocket/worker) would add a browser egress surface the no-CDN/CSP
decision (ADR-0042 D3) forbids. The thin JSON-RPC plumbing keiko-server needs (`vscode-jsonrpc` /
`vscode-languageserver-protocol`, MIT) is the only candidate new npm runtime dependency, and only for
the server. The LSP servers themselves are **operator-provisioned runtime tools discovered on `PATH`**
(like `git` or `node`), **not bundled** into the Keiko package (consistent with the Out-of-Scope
"installing language servers" and ADR-0021 bundling model); Keiko does not redistribute them, so their
licenses (EPL-2.0, BSD-3-Clause, Apache-2.0/MIT, MIT) are invocation concerns, not redistribution
concerns that enter the bundled npm/workspace SBOM. They still require a per-language runtime toolchain
inventory with pinned versions, checksums/provenance, and license review before enablement. A provider
whose server is absent reports `UNSUPPORTED_LANGUAGE` (no fabrication, no fallback to an ungoverned
path).

### D3 — Deterministic-first and safe-by-default; index-time untrusted execution is the gating risk

Every new provider is **deterministic and model-free** — LSP results are never routed through the
Model Gateway or model-augmented (AI completion remains the separate, language-agnostic two-tier path
of ADR-0042 D5). LSP servers run in their **safest configuration by default**, with every feature that
would execute untrusted project code **off by default**:

- rust-analyzer: proc-macro expansion and build-script execution disabled
  (`cargo.buildScripts.enable=false`, `procMacro.enable=false`); no automatic crate download.
- jdtls: build-tool project import restricted to a read-only/no-execution mode; no Maven/Gradle plugin
  execution during indexing; offline artifact resolution only.
- gopls: `GOPROXY=off`, no implicit module downloads.
- Pyright/pylsp: static analysis only (Pyright never executes project code).

Any analysis feature that **requires** executing untrusted project code (e.g. full proc-macro fidelity,
Gradle-plugin-driven Java model accuracy) is **off by default**, may be enabled only with the LSP
indexing process wrapped in an **ADR-0043-compatible enforced boundary applied to the server process
itself**: `network:"none"` plus `filesystem:"execution-root"` or an equivalent workspace-only
filesystem and environment boundary with attestation. If that filesystem/environment containment cannot
be proven on the target platform, the execution-requiring fidelity feature remains disabled. A
**separate per-language security review** is required before it ships. This extends ADR-0043's boundary
from test execution to index-time execution; it does not relax it.

### D4 — Staged rollout order: Python → Go → Java → Rust

Candidate languages are sequenced by **risk × user value × dependency footprint × verification
feasibility** (full scoring in the blueprint §4):

1. **Python (Pyright)** — first: zero code execution during analysis, MIT, modest footprint, excellent
   offline/deterministic verification (pytest runs offline against a pre-provisioned venv). Lowest risk,
   high regulated-sector value.
2. **Go (gopls)** — second: gopls executes no untrusted code, `GOPROXY=off` yields a clean offline
   boundary, lightweight static binary, strong offline test story (`go test` + vendored modules). Low
   risk.
3. **Java (jdtls)** — third: very high enterprise/regulated value, but build-script execution at index
   time requires the D3 safe-mode plus enforced isolation and a security review; heavier integration
   (Maven/Gradle, offline artifact provisioning). Medium-high risk.
4. **Rust (rust-analyzer)** — last: critical index-time untrusted execution (proc-macros + `build.rs`,
   no sandbox), heaviest footprint (1.5–2.5 GB toolchain), hardest offline verification (`cargo`
   offline has known dev-dependency gaps). Gated on a dedicated security review and an enforced-egress
   story for the LSP indexing process, not only for test execution.

Each stage is independently shippable and **default-off** behind a per-language feature flag.

### D5 — Per-language owner boundary, LSP/Keiko/security-review partition, and rollback path

For each language the plan defines (blueprint §5/§6) a three-way partition:

- **LSP-delegated** (computed by the out-of-process server): diagnostics, hover/quick-info, completion
  candidates, symbols, formatting.
- **Keiko-specific** (owned by keiko-server, reused from the TS/JS path): workspace-root discovery and
  configuration rules (nearest `pyproject.toml`/`go.mod`/`pom.xml`|`build.gradle`/`Cargo.toml` within
  containment + `realpath`), provider registration, output sanitization (bidi/zero-width stripping,
  inert-Markdown hover fence, count caps, byte/wall-clock/`AbortSignal` bounds), deterministic-first
  orchestration, metadata-only evidence, BFF wiring, ADR-0043-compatible process launch, and the
  network/filesystem/environment isolation wrapping of any code-executing server.
- **Separate security review** (a dedicated ticket per language): spawning a server that executes
  untrusted project code at index time (Java, Rust); any new long-lived LSP process manager that cannot
  reuse `runCommand`; toolchain provisioning; and per-language test execution (reuses #1202/#1204/
  ADR-0043).

**Rollback/disable is per-language with no cascade**: flipping a language's flag off removes its
registry entry and disposes its server process; the orchestrator then returns `UNSUPPORTED_LANGUAGE`
for that `languageId`, Monaco's language-agnostic syntax highlighting/editing and the Model-Gateway AI
completion remain, and no other language or the TS/JS path is affected.

### D6 — Required verification contract for every future language

Each future per-language implementation issue must satisfy, and record evidence for, all of (blueprint
§10):

1. **Local fixture workspaces** — committed per-language fixtures exercising single-file diagnostics,
   cross-file symbol resolution, workspace-root discovery, and containment/symlink-escape rejection.
2. **Deterministic diagnostics/hover/completion tests** — golden-fixture assertions with **zero network
   calls**; hover rendered as inert Markdown; completion count-capped and sanitized.
3. **Worker/process lifecycle tests** — bounded cold-start, clean disposal on editor-close/workspace-switch,
   no memory leak across open/close cycles.
4. **Dependency and license review** — server + bridge npm deps pinned, bundled npm/workspace SBOM-clean,
   license-compatible; operator-provisioned toolchains documented in a runtime inventory with pinned
   versions, checksums/provenance, and license review (not bundled).
5. **Sandbox, filesystem, and process-boundary evidence** — for any **execution-requiring** toolchain or
   LSP operation (index-time build-script/proc-macro execution or test execution), automated evidence
   that `network:"none"` denies outbound connections and `filesystem:"execution-root"` or an equivalent
   workspace-only filesystem/environment boundary is enforced; the process launch path must reuse
   ADR-0043 attestation or cite the required ADR-0043 amendment; deterministic-local (offline) vs
   execution-requiring operations are explicitly labelled, the latter off by default.
6. **Performance evidence** — latency per operation vs representative file sizes, large-file degradation
   reuse (read-only above 500 KB / 10,000 lines per ADR-0042 D3.6), server startup/disposal time, and
   LSP-server memory per workspace, recorded against the per-provider budgets (blueprint §9), which each
   per-language issue ratifies against its own measured baselines (mirroring the #1207-measures /
   #1209-records split).

These reuse the existing seams — the assured pre-filter
(`packages/keiko-server/src/editor/assuredPreFilterRunner.ts`), verification orchestrator
(`packages/keiko-verification/src/orchestrator.ts`), convention-driven stack detection
(`packages/keiko-workflows/src/unit-tests/frontend.ts` → a `detectBackendStack` analog), and
`@oscharko-dev/keiko-sandbox` — without a parallel execution path.

### D7 — Scheduling and merge governance

Per the issue Scheduling Rule, multi-language work is **not** implemented on the #1189 implementation
line by default. When scheduled, it is either promoted to a dedicated future epic or split into
per-language implementation issues, each with its own routing, branch, board fields, and acceptance
criteria. Every such issue must respect ADR-0019 direction rule 8 (browser tier imports no Node-domain
values), ADR-0042 D4 (server language service is the single governed source of truth), ADR-0042 D5/D6
(model boundary and server-side context), and ADR-0043 (enforced egress for untrusted execution). The
first-release TS/JS scope and the #1189 implementation order are unchanged by this plan.

## Consequences

- The editor can grow to Java, Python, Rust, and Go without a new package, a contract bump, or a change
  to the browser shell — the provider-pluggable registry (ADR-0042 D4) absorbs each language as a
  registration.
- Multi-language analysis is governed from day one: the new index-time untrusted-execution surface is
  named, defaulted to safe, and bound to ADR-0043's enforced-egress boundary and a per-language
  security review, rather than inheriting a test-only isolation assumption.
- The exact safe-mode launch flags per server, the malicious-fixture proof that safe mode does not
  execute project code at index time, and the per-language security-review scope (Java: Maven/Gradle
  plugin-loading attack surface and offline artifact integrity; Rust: proc-macro sandbox-escape and
  crate-download/artifact integrity) are owned by each implementation issue; the full risk register is
  the companion blueprint §12.
- The staged order makes the lowest-risk, highest-feasibility languages (Python, Go) shippable first
  and isolates the highest-risk language (Rust) behind a dedicated security review, so partial delivery
  is safe and reviewable.
- The only candidate new npm runtime dependency is a server-side MIT JSON-RPC client; LSP servers and
  toolchains stay operator-provisioned and out of the bundled npm/workspace SBOM surface (ADR-0021).
  Runtime license/provenance exposure is not flat by default: it is governed by the per-language
  runtime toolchain inventory and license review.
- Cost: each language needs server-side LSP-process lifecycle management (spawn, health, dispose,
  per-language safe-mode configuration) and, for Java/Rust, network/filesystem/environment isolation of
  the indexing process — more than a thin registry entry. This is owned by the per-language
  implementation issues, not this plan.

## Out of Scope

- Implementing any provider, spawning any LSP server, installing or bundling any language server or
  toolchain, or adding Monaco runtime code (owned by future per-language issues).
- Blocking, re-scoping, or re-ordering the #1189 first release; changing the #1189 required
  implementation order.
- Model-assisted (non-deterministic) behaviour for new languages; that remains the separate
  language-agnostic Model-Gateway path and is not introduced here.
- Browser-side LSP clients, in-browser language workers for governed features, or any CSP/connect-src
  widening.

## Alternatives Considered

- **Adopt `monaco-languageclient` in the browser tier.** Rejected: it creates a second, ungoverned
  answer path that bypasses the server orchestrator (ADR-0042 D4) and adds a browser egress/transport
  surface that ADR-0042 D3 forbids. The server-side bridge keeps one governed source of truth.
- **A new `@oscharko-dev/keiko-language-providers` package.** Rejected for now: the existing registry
  absorbs providers with no contract change; ADR-0025 forward-only baseline discourages speculative
  package growth. Revisit only if a second, non-keiko-server host needs the providers.
- **Ship all four languages at once.** Rejected: Rust's critical index-time execution risk and the
  heavy, heterogeneous toolchains make a single landing unreviewable; the staged order delivers value
  early and isolates risk.
- **Enable proc-macro/build-script execution by default for fidelity.** Rejected: it would execute
  untrusted project code at index time outside an enforced boundary — exactly the OWASP LLM05-class
  risk ADR-0043 exists to contain. Safe-mode-by-default, opt-in behind enforced egress + security
  review, is the only acceptable posture.
- **Per-language in-browser workers (mirroring Monaco's `ts.worker`).** Rejected: ungoverned,
  single-file, and bypasses audit/model-boundary governance, same as the rejected TS/JS worker path in
  ADR-0042.

## Related

- [ADR-0019](ADR-0019-modular-package-architecture.md) (modular package architecture; direction rule 8
  = browser tier imports no Node-domain values)
- [ADR-0021](ADR-0021-publish-strategy-bundled-monorepo-product.md) (bundling model; LSP servers and
  toolchains are operator-provisioned, not bundled)
- [ADR-0042](ADR-0042-keiko-editor-package-and-boundaries.md) (editor package and boundaries; D4
  server language service authority; this ADR realises its deferred #1213 expansion)
- [ADR-0043](ADR-0043-enforced-execution-isolation.md) (enforced execution isolation; extended here to
  index-time execution)
- Companion blueprint: [docs/planning/keiko-editor-multi-language-expansion.md](../planning/keiko-editor-multi-language-expansion.md)
- [docs/editor-language-service.md](../editor-language-service.md);
  [docs/security-and-audit-boundaries.md](../security-and-audit-boundaries.md);
  [docs/keiko-editor/1207-performance-budgets.md](../keiko-editor/1207-performance-budgets.md)
- Epic #1189; Issue #1190 (ADR-0042 + the editor blueprint); Issue #1213 (this ADR + the companion
  blueprint)
- LSP 3.17; Eclipse JDT Language Server (EPL-2.0); Pyright (MIT) / python-lsp-server (MIT);
  rust-analyzer (Apache-2.0 AND MIT); gopls (BSD-3-Clause); `monaco-languageclient` (MIT, evaluated,
  not adopted browser-side); `vscode-jsonrpc` / `vscode-languageserver-protocol` (MIT)
- OWASP Top 10 for LLM Applications (2025): LLM01, LLM05, LLM08
- EU AI Act Reg. (EU) 2024/1689 Art. 12 & 14; DORA Reg. (EU) 2022/2554; BaFin BDAI principles (2021)
