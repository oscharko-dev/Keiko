# Keiko Editor — Staged multi-language expansion: architecture reuse audit and delivery blueprint

> Planning artifact for Issue [#1213](https://github.com/oscharko-dev/Keiko/issues/1213) (Parent Epic
> [#1189](https://github.com/oscharko-dev/Keiko/issues/1189)).
> Status: **Proposed** — pending human review.
> Normative companion: [ADR-0045](../adr/ADR-0045-staged-multi-language-lsp-expansion.md).

This blueprint is **planning only**. It writes no runtime code, installs no language server or
toolchain, and changes neither the first-release TypeScript/JavaScript scope nor the #1189 required
implementation order. It records _how_ the Keiko Editor would add deterministic language intelligence
for Java, Python, Rust, and Go (and their test stacks) by **reusing** the seams already shipped for
TS/JS, and _under what governance_ each future language is delivered. The citable decisions are in
ADR-0045; this document carries the assessment matrices, the per-language security model, the reuse
map, the risk register, the verification contract, and the acceptance-criteria traceability.

All findings below were grounded against the repository on `release/0.2.0` and against current
(2026-06) upstream facts for each LSP server and toolchain.

---

## 1. Purpose and scope

### 1.1 What this plan delivers

A staged strategy to extend the editor's **deterministic** language intelligence (completion,
diagnostics, hover/quick-info, symbols, formatting) from TS/JS to four additional languages, ordered by
risk and feasibility, with a defined owner boundary, rollback path, security-review partition, and
verification contract **per language**.

### 1.2 First-release scope is preserved (AC1)

The first release (#1189) remains TypeScript/JavaScript-first and is **unchanged** by this plan:

- The deterministic TS/JS provider (#1198) — completion/diagnostics/hover/symbols/formatting over the
  TypeScript language service — keeps its behaviour, contracts, and release baselines.
- TS/JS test generation (#1202/#1203, wave 2) — Vitest, React Testing Library, Playwright — is
  untouched.
- No TS/JS provider, route, budget, or gate is modified, weakened, or re-scoped. Adding a new language
  is purely additive: a new registry entry that the orchestrator resolves by `languageId`.

### 1.3 Out of scope for #1213

- Implementing any provider, spawning any LSP server, or installing/bundling any language server or
  toolchain.
- Adding Monaco runtime code or browser-side LSP clients.
- Blocking the #1189 release or changing its implementation order.
- Model-assisted behaviour for new languages (deterministic-first; AI completion stays the separate,
  language-agnostic Model-Gateway path).

---

## 2. Architecture: how a new language attaches

### 2.1 The provider-pluggable registry (reused, not rebuilt)

The deterministic language service is a **keiko-server module** with a provider registry
(`packages/keiko-server/src/editor/languageService.ts`) and provider-pluggable contracts
(`packages/keiko-contracts/src/language-service.ts`: `LanguageServiceOperation`,
`LanguageServiceRequest`, `LanguageProviderDescriptor`, `LANGUAGE_SERVICE_SCHEMA_VERSION`). A new
language is a new `LanguageProviderDescriptor` (declaring its `languages[]` and supported
`operations[]`) registered into the orchestrator. **No contract version bump and no editor-shell change
are required** (ADR-0045 D1). The browser keeps calling the same BFF routes; the orchestrator continues
to enforce workspace containment, document-size bounds, wall-clock deadlines, `AbortSignal`
cancellation, and output sanitisation for every provider.

```
LanguageServiceRequest ─▶ registry.resolve(languageId) ─▶ LanguageProvider ─▶ sanitised result
   (TS/JS today)                                          └─▶ {Python, Go, Java, Rust} provider
                                                              └─▶ out-of-process LSP child of keiko-server
```

### 2.2 The LSP bridge is server-side (ADR-0045 D2)

Each new provider bridges to its standard LSP server as an **out-of-process child of keiko-server**,
over stdio JSON-RPC. The Monaco↔LSP bridge is a server concern, not a browser one:

- The browser tier stays a pure consumer of the governed BFF routes — no `monaco-languageclient`, no
  WebSocket/worker transport to an LSP server, no new browser egress surface, no CSP change (ADR-0042
  D2/D3).
- The server orchestrator remains the **single governed source of truth** (ADR-0042 D4); LSP output is
  sanitised before it reaches the browser exactly as TS/JS output is.
- The only candidate new npm runtime dependency is a server-side MIT JSON-RPC client
  (`vscode-jsonrpc` / `vscode-languageserver-protocol`).

### 2.3 LSP servers and toolchains are operator-provisioned, not bundled

Consistent with the Out-of-Scope "installing language servers" and the ADR-0021 bundling model, the LSP
servers (`jdtls`, `pyright`/`pylsp`, `rust-analyzer`, `gopls`) and their language toolchains (JDK,
Node/Python, Rust, Go) are **operator-provided runtime tools discovered on `PATH`**, like `git`. Keiko
does not redistribute them; their licenses are invocation concerns, not redistribution concerns. A
provider whose server is absent reports `UNSUPPORTED_LANGUAGE` (no fabrication, no ungoverned fallback).

---

## 3. Candidate language assessment matrix

Standard LSP server, license, runtime, footprint, startup egress, process model, and — the decisive
column for a regulated product — **whether and when analysis executes untrusted project code** (current
as of 2026-06).

| Language | LSP server                   | License            | Runtime toolchain | Disk footprint (server + toolchain, approx.) | Startup egress                                              | Untrusted-code execution during analysis                                                      |
| -------- | ---------------------------- | ------------------ | ----------------- | -------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Python   | Pyright (Microsoft)          | MIT                | Node.js (recent)  | ~200 MB                                      | None; no implicit stub/plugin downloads                     | **None** — pure static analysis; project code never executed                                  |
| Python   | python-lsp-server (pylsp)    | MIT                | Python 3.9+       | ~60–220 MB                                   | None; plugins only if locally installed                     | **Low** — does not execute project code; plugin code from the local env only                  |
| Go       | gopls (`golang.org/x/tools`) | BSD-3-Clause       | Go 1.21+          | ~400–600 MB                                  | None at startup; module fetch lazy via `GOPROXY` (`=off`)   | **None/low** — gopls executes no project code; `go:generate` driven by `go`, not gopls        |
| Java     | Eclipse JDT LS (jdtls)       | EPL-2.0            | JDK 21+           | ~250–300 MB                                  | None at startup; egress on Maven/Gradle artifact resolution | **High** — executes Maven/Gradle build scripts & plugins during project import/index          |
| Rust     | rust-analyzer                | Apache-2.0 AND MIT | Rust toolchain    | ~1.5–2.5 GB                                  | None at startup; crates.io fetch lazy on completion         | **Critical** — proc-macro expansion + `build.rs` run arbitrary code at index time, no sandbox |

**Key finding.** None of the LSP servers _require_ network at startup (all are offline-deployable with
pre-provisioned artifacts). The differentiator is **untrusted-code execution during analysis**: Pyright
and gopls execute nothing; jdtls executes build scripts during indexing; rust-analyzer executes
proc-macros and `build.rs` at index time, with no sandbox and no user gesture. This is a second
untrusted-execution surface, distinct from the test-execution surface ADR-0043 already governs, and it
fires earlier (on project open, not on "generate/run tests"). The disk-footprint figures above are
approximate install sizes (server binary + toolchain) as of 2026-06, not runtime memory — runtime
memory varies with project size and is bounded separately per §9.

For the default Python provider this blueprint selects **Pyright** over pylsp: zero project-code
execution, no plugin surface, Microsoft-maintained, and a smaller trust boundary. pylsp remains a
documented alternative where a pure-Python deployment is required.

---

## 4. Staged rollout order and rationale (AC2)

Ordering criteria, each scored Low/Medium/High:

| Language | User value (regulated sectors) | Index-time exec risk | Dependency footprint  | Verification feasibility (offline + sandboxed)     | Stage |
| -------- | ------------------------------ | -------------------- | --------------------- | -------------------------------------------------- | ----- |
| Python   | High (data, scripting, ML ops) | **None**             | Low (~200 MB)         | **High** — Pyright no-exec; pytest offline venv    | **1** |
| Go       | Medium–High (cloud/infra)      | **None/Low**         | Medium (~400–600 MB)  | **High** — `GOPROXY=off`; `go test` + vendor       | **2** |
| Java     | **High** (banking/insurance)   | High                 | Medium (~250–300 MB)  | Medium — build-tool exec; offline-able, heavier    | **3** |
| Rust     | Medium (systems/security)      | **Critical**         | **High** (1.5–2.5 GB) | Low — proc-macro exec at index; cargo offline gaps | **4** |

Rationale:

1. **Python first.** The best risk/feasibility/value combination: Pyright executes no project code, so
   it adds language intelligence with **no new untrusted-execution surface**; the footprint is the
   smallest; pytest verifies deterministically offline against a pre-provisioned venv. It proves the
   multi-language seam at the lowest risk.
2. **Go second.** gopls executes no untrusted code and `GOPROXY=off` plus vendored modules gives a clean
   deny-by-default boundary; the static binary is light and disposal is simple. `go test` offline is the
   strongest of the four test stories. Low risk, real value.
3. **Java third.** Very high regulated-sector value, but jdtls executes Maven/Gradle build scripts and
   plugins during project import — so it ships only with the D3 safe-mode (no plugin execution, offline
   artifact resolution) plus the enforced-isolation wrapping of the indexing process and a security
   review. Heavier integration; medium-high risk.
4. **Rust last.** The highest-risk language: proc-macro expansion and `build.rs` run arbitrary untrusted
   code at index time with no sandbox, the toolchain is the heaviest (1.5–2.5 GB), and `cargo`'s offline
   mode has known dev-dependency gaps. It is gated on a dedicated security review and an enforced-egress
   story for the LSP **indexing** process, not only for test execution.

The order is independently shippable: each stage is one (or a few) implementation issues and is
**default-off** until its verification contract (§10) is met.

---

## 5. Per-language owner boundary and rollback/disable path (AC3)

Each language is delivered as a **separately-registered provider behind a per-language feature flag**,
default-off. Ownership and rollback:

| Concern                 | Owner                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Provider registration   | keiko-server language-service registry (one `LanguageProviderDescriptor` per language)                                          |
| LSP process lifecycle   | keiko-server through the ADR-0043-compatible spawn boundary: spawn, health, safe-mode config, dispose on close/workspace-switch |
| Workspace-root + config | keiko-server (reused TS/JS discovery, §8)                                                                                       |
| Output sanitisation     | keiko-server orchestrator (shared, unchanged)                                                                                   |
| Enforced isolation      | `@oscharko-dev/keiko-sandbox` + command attestation (for any code-executing server or test run)                                 |
| Feature flag / rollback | keiko-server config, one flag per language                                                                                      |

**Rollback/disable is per-language and cascade-free.** Turning a language's flag off:

1. removes its `LanguageProviderDescriptor` from the registry;
2. disposes its LSP child process;
3. causes the orchestrator to return `UNSUPPORTED_LANGUAGE` for that `languageId`.

Monaco's language-agnostic syntax highlighting/editing (#1193) and the Model-Gateway AI completion
(#1199/#1200) remain for that language; **no other language and not the TS/JS path are affected**.
Rollback requires no contract change and no editor-shell change.

---

## 6. LSP / Keiko-specific / separate-security-review partition (AC4)

For every language, operations split three ways:

| Partition                    | Operations / responsibilities                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LSP-delegated**            | diagnostics, hover/quick-info, completion candidates, document symbols, formatting — computed by the out-of-process server                                                                                                                                                                                                                                                                |
| **Keiko-specific**           | workspace-root discovery & config rules (§8); provider registration; output sanitisation (bidi/zero-width strip, inert-Markdown hover fence, count caps, byte/wall-clock/`AbortSignal` bounds); deterministic-first orchestration; metadata-only evidence; BFF wiring; ADR-0043-compatible process launch; network/filesystem/environment isolation wrapping of any code-executing server |
| **Separate security review** | spawning a server that executes untrusted project code at index time (**Java, Rust**); any new long-lived LSP process manager that cannot reuse `runCommand`; toolchain provisioning & runtime inventory; per-language test execution (reuses #1202/#1204/ADR-0043); offline artifact-provisioning model                                                                                  |

Per-language summary of what is LSP-based vs needs review:

| Language | LSP-delegated                  | Keiko-specific glue                                 | Requires separate security review                                                  |
| -------- | ------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Python   | all five ops via Pyright       | root = `pyproject.toml`/`setup.cfg`; venv discovery | pytest execution (untrusted `conftest.py`) under ADR-0043                          |
| Go       | all five ops via gopls         | root = `go.mod`; `GOPROXY=off` enforcement          | `go test` execution; vendored-module provisioning                                  |
| Java     | all five ops via jdtls         | root = `pom.xml`/`build.gradle`; offline resolution | **jdtls index-time build-script execution**; Maven/Gradle offline; JUnit run       |
| Rust     | all five ops via rust-analyzer | root = `Cargo.toml`; safe-mode flags                | **rust-analyzer proc-macro/`build.rs` index-time execution**; `cargo test` offline |

---

## 7. Security and sandbox requirements per toolchain

The governing baseline: Keiko is not an OS sandbox (`docs/security-and-audit-boundaries.md`), productive
model calls route only through the Model Gateway, and untrusted-code execution is gated behind
ADR-0043's enforced deny-by-default execution boundary, CI-proven via `@oscharko-dev/keiko-sandbox` and
the shared command attestation path. The boundary must cover the threat in question: network egress for
exfiltration, plus filesystem/environment containment whenever the operation executes untrusted project
code against an analysis copy rather than an already-applied real workspace.

**Two untrusted-execution surfaces, both governed by ADR-0043:**

1. **Index-time execution (new in this plan).** jdtls and rust-analyzer execute untrusted project code
   simply to analyse a project. Required posture (ADR-0045 D3):
   - **Safe-mode by default**: rust-analyzer `procMacro.enable=false`, `cargo.buildScripts.enable=false`;
     jdtls build-tool import in read-only/no-execution mode; `GOPROXY=off`; Maven/Gradle offline; Pyright
     static-only.
   - Any feature requiring execution is **off by default**, enabled only with the LSP **server process**
     wrapped in ADR-0043-compatible isolation: `network:"none"` plus `filesystem:"execution-root"` or an
     equivalent workspace-only filesystem and environment boundary with attestation. If that containment
     cannot be proven, the execution-requiring fidelity feature remains disabled. Enablement also requires
     a per-language security review.
2. **Test-time execution (already governed).** Generated tests run through the #1202 assured pre-filter
   in a disposable execution root and #1204 post-apply verification in the applied workspace, with each
   path using its documented ADR-0043 enforcement mode. Multi-language reuses this path with
   language-specific runners (§10) — no parallel execution path.

**Process-launch boundary.** ADR-0043's single subprocess boundary is the existing `keiko-tools`
`runCommand` path. Future LSP implementations must reuse that wrapper/attestation model, command rules,
and environment allowlist. A long-lived LSP process manager that cannot reuse `runCommand` is not a
small implementation detail: it requires an ADR-0043 amendment that records equivalent controls before a
provider ships.

**Offline artifact provisioning** is the precondition for deny-by-default at both surfaces, because
every toolchain otherwise fetches dependencies just-in-time:

| Language | Offline test/run recipe                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| Java     | `mvn dependency:go-offline` then `mvn -o test`; Gradle `--offline` after pre-fetch           |
| Python   | pre-provision venv; pytest runs offline; inspect `conftest.py` import chains                 |
| Rust     | `cargo vendor --versioned-dirs` + `cargo test --offline --locked` (verify dev-deps captured) |
| Go       | `go mod download` / `vendor/` + `GOPROXY=off go test`                                        |

Each per-language issue must produce automated ADR-0043 boundary evidence for any operation that
executes toolchain or project code: outbound connection from the isolated process **fails**; filesystem
reads/writes outside the execution root or approved workspace boundary **fail**; environment variables are
allowlisted; and the command or LSP process emits attestation for the enforced controls.

**Per-language security-review scope and safe-mode proof.** For Java and Rust the implementation issue
must: (a) document the exact LSP-server launch flags / initialization options and process-launch wrapper
that enforce safe-mode (no build-script/proc-macro execution at index time); (b) prove with a committed malicious fixture
(e.g. a `pom.xml` build goal, or a `build.rs`/derive macro that would observably fail or write a marker
if executed) that safe-mode does **not** execute project code at index time; and (c) open a dedicated
security-review ticket scoped to that language's attack surface — Java: Maven/Gradle plugin loading and
offline artifact integrity; Rust: proc-macro sandbox-escape vectors and crate-download/artifact
integrity. **Security-review closure** is a release gate for those languages (§10).

---

## 8. Workspace-root discovery and configuration rules

Reuses the TS/JS pattern (nearest config within the workspace root, following containment +
`realpath`, without enumerating the project), per language root marker:

| Language | Root marker(s)                            | Config followed                                 |
| -------- | ----------------------------------------- | ----------------------------------------------- |
| Python   | `pyproject.toml`, `setup.cfg`, `setup.py` | interpreter/venv selection; Pyright config      |
| Go       | `go.mod`                                  | module path; `GOFLAGS`/`GOPROXY` (forced `off`) |
| Java     | `pom.xml`, `build.gradle`(`.kts`)         | build model (offline); JDK selection            |
| Rust     | `Cargo.toml` (workspace + member)         | cargo workspace; safe-mode flags                |

Discovery stays inside workspace containment; roots outside the selected project path and symlink
escapes are rejected (the existing containment + `realpath` checks). No new path-trust surface is
introduced.

---

## 9. Performance and memory budgets per provider

The editor performance budgets (ADR-0042 D3.6, enforced/recorded by #1207/#1209,
`docs/keiko-editor/1207-performance-budgets.md`) remain authoritative for the **browser/editor** side
(B1–B11) and are unchanged. Multi-language providers add a **server-side, out-of-process** dimension
the TS/JS in-process service did not have. The targets below are **indicative**; each per-language
implementation issue ratifies or tightens them against measured baselines and records them as release
evidence (the #1207-measures / #1209-records split), against representative file sizes
(≈100 KB / 500 KB / 1 MB):

| Budget (per language, server-side)       | Indicative target (each per-language issue ratifies against measured baselines)                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| LSP server cold-start                    | off the keystroke path; indicative p50 ≤ 500 ms / p95 ≤ 2.5 s for a representative project; recorded            |
| Completion / hover / diagnostics latency | indicative p50 ≤ 150 ms for files ≤ 100 KB; degrade gracefully on larger files; recorded per operation per size |
| Large-file handling                      | reuse the editor read-only/degraded path above 500 KB / 10,000 lines (ADR-0042 D3.6)                            |
| LSP-server memory (per workspace)        | indicative ceiling ≤ 512 MiB per language per workspace after index; recorded; no leak across open/close        |
| Disposal                                 | server killed/reaped cleanly within ≤ 250 ms on editor close or workspace switch                                |

Because LSP servers are out-of-process, their memory is accounted **separately** from the Monaco
worker/model budgets (B11); a future language must not regress the editor-side budgets and must record
its own server-side figures as release evidence (mirroring the #1207-measures / #1209-records split).

---

## 10. Verification contract per future language (Expected Verification)

Every per-language implementation issue must satisfy and record evidence for all six (ADR-0045 D6):

1. **Local fixture workspaces** — committed per-language fixtures: single-file diagnostics with inline
   errors/warnings; multi-file symbol resolution (cross-file imports/references); workspace-root
   discovery across nested config; deny-list/containment enforcement (paths outside root and symlink
   escapes rejected).
2. **Deterministic diagnostics/hover/completion tests** — assertions against recorded golden fixtures
   with **zero network calls**; hover quick-info rendered as inert Markdown (no HTML injection);
   completion results count-capped and sanitised (bidi/zero-width stripped, clipped to budget).
3. **Worker/process lifecycle tests** — bounded LSP cold-start; clean kill/dispose on editor close and
   workspace switch; no memory leak across repeated open/close cycles; tested single-file and multi-file.
4. **Dependency and license review** — server-side bridge npm deps pinned and bundled npm/workspace
   SBOM-clean; LSP server + toolchain documented as operator-provisioned with their licenses
   (EPL-2.0/MIT/BSD-3-Clause/Apache-2.0+MIT), pinned versions, checksums/provenance, and reproducible
   installation instructions in a runtime toolchain inventory.
5. **Sandbox, filesystem, and process-boundary evidence** — for any toolchain or LSP code execution,
   automated ADR-0043 evidence that outbound connection from inside `network:"none"` **fails**,
   filesystem access outside `filesystem:"execution-root"` or an equivalent approved workspace boundary
   **fails**, the process environment is allowlisted, and the launch path emits attestation; deterministic-local
   vs execution-requiring operations are explicitly labelled, with execution-requiring ones off by default.
6. **Performance evidence** — latency per operation vs representative file sizes; large-file degradation
   reuse; server startup/disposal timing; LSP-server memory per workspace — recorded against §9 budgets.

For Java and Rust, **security-review closure** (§7) is an additional per-language release gate.

**Test stacks and offline behaviour** (the runners the assured pre-filter would drive per language):

| Language | Frameworks / runner                            | Network at test time (default)                                   | Deny-by-default recipe                                                                             |
| -------- | ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Java     | JUnit 5 + Maven Surefire / Gradle (`mvn test`) | downloads deps from Maven Central                                | `mvn dependency:go-offline` then `mvn -o test`                                                     |
| Python   | pytest (`pytest` / `python -m pytest`)         | pytest itself none; deps + `conftest.py` need a provisioned venv | provision venv from a committed lock/requirements installed offline; inspect `conftest.py` imports |
| Rust     | `cargo test`                                   | downloads from crates.io                                         | `cargo vendor` + `cargo test --offline --locked`                                                   |
| Go       | `go test ./...`                                | resolves modules via `GOPROXY`                                   | `GOPROXY=off` + vendored `go.mod`/`go.sum`/`vendor/`                                               |

These reuse the assured pre-filter (`packages/keiko-server/src/editor/assuredPreFilterRunner.ts`,
build→pass→stability N≥5→coverage→mutation), the verification orchestrator
(`packages/keiko-verification/src/orchestrator.ts`, `networkEnforcement` modes), the convention-driven
stack detector (`packages/keiko-workflows/src/unit-tests/frontend.ts` → a `detectBackendStack` analog),
and `@oscharko-dev/keiko-sandbox` — with no parallel spawn path.

---

## 11. Dependency decision record

| Dependency                                          | License            | Decision                              | Rationale / conditions                                                                                                                                          |
| --------------------------------------------------- | ------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monaco-languageclient`                             | MIT                | **Not adopted (browser tier)**        | Browser-side LSP client would bypass the governed server orchestrator (ADR-0042 D4) and add a browser transport/egress surface (D3). Server-side bridge chosen. |
| `vscode-jsonrpc` / `vscode-languageserver-protocol` | MIT                | **Candidate (server-side only)**      | Minimal, battle-tested JSON-RPC the keiko-server LSP bridge needs; the only candidate new npm runtime dep; pinned + SBOM-gated when first adopted.              |
| Eclipse JDT LS (`jdtls`)                            | EPL-2.0            | **Operator-provisioned, not bundled** | Java provider. Invocation not redistribution (ADR-0021). Executes build scripts → safe-mode + enforced isolation + security review (Java stage).                |
| Pyright                                             | MIT                | **Operator-provisioned, not bundled** | Default Python provider. No project-code execution → smallest trust boundary.                                                                                   |
| python-lsp-server (`pylsp`)                         | MIT                | **Alternative, not bundled**          | Pure-Python deployments; plugin surface from local env only.                                                                                                    |
| rust-analyzer                                       | Apache-2.0 AND MIT | **Operator-provisioned, not bundled** | Rust provider. Critical index-time execution → last stage, dedicated security review, enforced isolation of the indexing process.                               |
| gopls                                               | BSD-3-Clause       | **Operator-provisioned, not bundled** | Go provider. No untrusted-code execution; `GOPROXY=off` enforced.                                                                                               |

No LSP/toolchain dependency enters the bundled npm/workspace SBOM (ADR-0021); only the server-side
JSON-RPC bridge would, and it is MIT. Operator-provisioned LSP servers and toolchains still enter the
runtime operating surface, so each per-language issue must attach a runtime toolchain inventory with
pinned versions, checksums/provenance, and license review before enablement.

---

## 12. Risk register

| #   | Risk                                                                                                                 | Category                 | Likelihood × Impact | Mitigation / owner                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | LSP server executes untrusted project code at index time (jdtls build scripts, rust-analyzer proc-macros/`build.rs`) | Untrusted execution      | High × High         | Safe-mode by default (ADR-0045 D3); execution only behind ADR-0043-compatible network + filesystem/environment isolation on the server process + security review. Java/Rust stages. |
| M2  | Browser-side LSP client bypasses the governed server orchestrator / widens CSP                                       | Model boundary / CSP     | Low × High          | Server-side bridge only (D2); no `monaco-languageclient` in the browser; CSP unchanged.                                                                                             |
| M3  | Toolchain fetches dependencies just-in-time, defeating deny-by-default egress                                        | Network boundary         | Med × High          | Offline provisioning (§7) is a precondition; `GOPROXY=off`, `mvn -o`, `cargo --offline`, provisioned venv; boundary proof required.                                                 |
| M3b | Long-lived LSP process launch bypasses ADR-0043's single spawn boundary                                              | Command boundary         | Med × High          | Reuse `runCommand` wrapper/attestation/env allowlist, or land an ADR-0043 amendment with equivalent long-lived process controls before shipping.                                    |
| M4  | Heavy toolchain (Rust 1.5–2.5 GB) inflates footprint / startup, regressing budgets                                   | Performance / footprint  | Med × Med           | Operator-provisioned (not bundled); per-provider startup/memory budgets recorded (§9); large-file degradation reused.                                                               |
| M5  | A new provider regresses the TS/JS path or another language                                                          | Architecture             | Low × High          | Per-language flag + isolated registry entry; cascade-free rollback (§5); TS/JS path untouched (AC1).                                                                                |
| M6  | Runtime toolchain provenance or license obligations are hidden by bundled-SBOM wording                               | Supply chain / legal     | Med × Med           | Bundled npm/workspace SBOM remains scoped to shipped packages; per-language runtime toolchain inventory records pinned versions, checksums/provenance, and license review.          |
| M7  | Retrieved/test context carries an injection payload into a future language test-gen prompt                           | Prompt injection (LLM08) | Med × High          | Reuse the existing untrusted-content handling and metadata-only evidence (#1211/#1206); deterministic LSP results are never model input.                                            |
| M8  | `cargo` offline mode misses dev-dependencies, making Rust verification non-reproducible                              | Verification             | Med × Med           | `cargo vendor --versioned-dirs` + `--locked`; verify dev-deps captured; documented in the Rust stage's evidence.                                                                    |

---

## 13. Reuse / no-duplication map

What the expansion reuses, so no parallel subsystem is created:

| Existing seam                                                                                 | Reused for                                                                                           |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `keiko-server/src/editor/languageService.ts` + `keiko-contracts/src/language-service.ts`      | Provider registration; orchestration; sanitisation; bounds/cancellation                              |
| `keiko-server/src/editor/assuredPreFilterRunner.ts`                                           | Multi-language test pre-filter (build→pass→stability→coverage→mutation)                              |
| `keiko-verification/src/orchestrator.ts`                                                      | `networkEnforcement` modes; honest enforced-limit reporting                                          |
| `@oscharko-dev/keiko-sandbox`                                                                 | Enforced network and filesystem/environment boundary evidence for index-time and test-time execution |
| `keiko-workflows/src/unit-tests/frontend.ts`                                                  | Convention-driven stack detection → `detectBackendStack` analog                                      |
| `keiko-model-gateway/src/model-selection.ts`                                                  | Language-agnostic AI completion (unchanged; LSP results stay deterministic)                          |
| `keiko-server/src/editor/codingContextProviders.ts` + `keiko-contracts/src/coding-context.ts` | Server-side retrieval/context for any future test-gen (untrusted, tier-tagged)                       |

No new retrieval, knowledge, memory, context-assembly, model-routing, verification, or evidence
subsystem is introduced.

---

## 14. Scheduling, routing, and merge governance

Per the issue Scheduling Rule (ADR-0045 D7):

- This work is **not** implemented on the #1189 implementation line by default.
- When scheduled, it is either **promoted to a dedicated future epic** or **split into per-language
  implementation issues**, each with its own routing, branch, board fields, and acceptance criteria.
- Each implementation issue respects ADR-0019 rule 8, ADR-0042 D4/D5/D6, and ADR-0043.
- This planning deliverable (the ADR + this blueprint) introduces no code and weakens no gate; it is a
  docs-only change to `release/0.2.0`.

Suggested sequencing of future issues: **Stage 1 Python (Pyright)** → **Stage 2 Go (gopls)** → **Stage 3
Java (jdtls, with security review)** → **Stage 4 Rust (rust-analyzer, with dedicated security review)**,
each gated on its §10 verification contract.

---

## 15. Regulatory record-keeping and oversight mapping

For the regulated-delivery posture, the multi-language plan preserves the existing controls:

- **EU AI Act Reg. (EU) 2024/1689 Art. 12 (record-keeping) & Art. 14 (human oversight).** Deterministic
  LSP results are auditable through the same governed server path; any code execution (index-time or
  test-time) is metadata-only-evidenced and human-reviewable; nothing is applied without explicit user
  action.
- **DORA Reg. (EU) 2022/2554.** No new external network dependency at runtime (LSP servers
  offline-deployable; `GOPROXY=off`/offline toolchains); the bundled npm/workspace supply-chain surface
  stays governed separately from the operator runtime toolchain inventory; network plus filesystem/
  environment isolation contains untrusted execution.
- **BaFin BDAI principles (2021).** Deterministic-first (no model in the LSP path), explainable results,
  and a clear human-in-the-loop boundary are retained per language.

---

## 16. Acceptance-criteria traceability

| AC  | Criterion                                                                                                                                                                    | Where satisfied                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| AC1 | The first-release TS/JS scope remains unchanged.                                                                                                                             | §1.2; ADR-0045 Status/D7                     |
| AC2 | Candidate language support ordered by risk, user value, dependency footprint, verification feasibility.                                                                      | §3 (matrix) + §4 (scored order); ADR-0045 D4 |
| AC3 | Each future language has a defined owner boundary and a clear rollback/disable path.                                                                                         | §5; ADR-0045 D5                              |
| AC4 | Plan documents which parts are LSP-based, Keiko-specific, and which require separate security review.                                                                        | §6; ADR-0045 D5                              |
| EV  | Per-future-language verification (fixtures, deterministic tests, lifecycle, dependency/license/runtime inventory, sandbox/network/filesystem/process boundary, performance). | §10; ADR-0045 D6                             |
| SR  | Scheduling Rule: not on #1189 line; promote-to-epic or split-per-language; decoupled shell; deterministic-first.                                                             | §14; ADR-0045 D7                             |

---

## 17. Grounding references

- Repository seams (release/0.2.0): `packages/keiko-server/src/editor/languageService.ts`,
  `assuredPreFilterRunner.ts`, `codingContextProviders.ts`;
  `packages/keiko-contracts/src/{language-service,coding-context}.ts`;
  `packages/keiko-verification/src/orchestrator.ts`;
  `packages/keiko-workflows/src/unit-tests/frontend.ts`;
  `packages/keiko-model-gateway/src/model-selection.ts`; `packages/keiko-sandbox/src`.
- ADRs: [ADR-0019](../adr/ADR-0019-modular-package-architecture.md),
  [ADR-0021](../adr/ADR-0021-publish-strategy-bundled-monorepo-product.md),
  [ADR-0042](../adr/ADR-0042-keiko-editor-package-and-boundaries.md),
  [ADR-0043](../adr/ADR-0043-enforced-execution-isolation.md),
  [ADR-0045](../adr/ADR-0045-staged-multi-language-lsp-expansion.md).
- Docs: [editor-language-service.md](../editor-language-service.md),
  [security-and-audit-boundaries.md](../security-and-audit-boundaries.md),
  [keiko-editor/1207-performance-budgets.md](../keiko-editor/1207-performance-budgets.md),
  [planning/keiko-editor-architecture-blueprint.md](keiko-editor-architecture-blueprint.md).
- Upstream (2026-06): LSP 3.17; Eclipse JDT Language Server (EPL-2.0); Pyright (MIT) /
  python-lsp-server (MIT); rust-analyzer (Apache-2.0 AND MIT); gopls (BSD-3-Clause);
  `monaco-languageclient` (MIT); `vscode-jsonrpc` / `vscode-languageserver-protocol` (MIT).
- OWASP Top 10 for LLM Applications (2025): LLM01, LLM05, LLM08.
