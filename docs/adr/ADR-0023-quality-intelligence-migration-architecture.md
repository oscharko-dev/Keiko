# ADR-0023: Quality Intelligence Migration Architecture

## Status

Superseded by ADR-0025 (2026-06-06). Retained as the historical Epic #270 migration record.
Use ADR-0025, `docs/PUBLIC_API_SURFACE.md`, `docs/security-and-audit-boundaries.md`,
and current package manifests for active repository guidance.

## Date

2026-06-05

## Version

1.0

## Context

Epic #270 integrates Test Intelligence capabilities into Keiko as a native _Quality Intelligence_
capability. The integration must be Keiko-native: one local process, one runtime, one CLI binary,
one UI, one evidence store, one model gateway. Test Intelligence is a proven behavioral reference
and parity target; its standalone server, CLI binary, agentic harness, model gateway, Workbench
UI, credential files, and runtime state directories must not enter Keiko as parallel services.

Issue #362 (`quality-intelligence-keiko-baseline.md`) audited the current Keiko package graph
(17 packages at baseline commit `faf2deb7`) and produced a reuse-target matrix covering source
ingestion, document ingestion, durable memory, model generation, workflow execution, evidence,
UI surfaces, BFF routes, CLI surfaces, and security trust boundaries.

Issue #363 (`quality-intelligence-test-intelligence-inventory.md`) inventoried the 17 Test
Intelligence packages at reference commit `0ffeab80`, catalogued six CRITICAL/HIGH defects and
11 additional unsafe defaults, and produced a synthesized Keiko target map with explicit
disposition for each TI capability.

This ADR resolves the open architecture decisions identified in the §7 gaps of the #362 baseline
so that implementation children #272–#285 can proceed without re-litigating foundational choices.

### Architecture Invariants (from Epic #270)

The following invariants are non-negotiable for all implementation children:

1. Keiko is the source architecture; Test Intelligence adapts to Keiko boundaries.
2. Existing Keiko packages are reused first before any new code is written.
3. A reuse decision is recorded for every migrated TI capability.
4. A new package may exist only for genuinely new pure-domain logic.
5. Productive model calls remain behind `keiko-model-gateway` only.
6. Agent and workflow execution remains behind `keiko-harness` and `keiko-workflows` only.
7. Runtime state remains local under the Keiko local runtime state contract.
8. Evidence uses Keiko evidence semantics: redaction-before-persist, retention, audit.
9. External connectors are explicit, user-configured, least-privilege, dry-run capable.
10. The public install remains one package: `@oscharko-dev/keiko`.
11. The native implementation must not depend on `@oscharko-dev/test-intelligence` or
    `@oscharko-dev/ti-*`.

### ADR-0019 Reconciliation

ADR-0019 describes the original 11-package topology. Since acceptance, six new packages have been
added: `keiko-local-knowledge` (Epic #189), `keiko-memory-vault` (Epic #206),
`keiko-memory-capture` (Epic #207), `keiko-memory-consolidation` (Epic #208),
`keiko-memory-governance` (Epic #209), and `keiko-memory-retrieval` (Epic #210). The
dependency-direction rules in `.dependency-cruiser.cjs` already encode ten per-package strict
variants (3a–3j) for these packages. This ADR records the topology extension as an amendment
rather than modifying ADR-0019 directly, and adds rule variant `direction-10a` for the new
Quality Intelligence package.

## Decision

### D1 — Reuse First

Keiko services are reused before any new code is written. Quality Intelligence adapts to Keiko
package boundaries. The per-capability disposition table (§Migration Map) is the authoritative
record of which Keiko package owns each TI behavior.

### D2 — Behavior Parity, Not Code Parity

Migration parity is defined as: Keiko-native Quality Intelligence produces equivalent
user-visible behavior, equivalent defect detection, and equivalent audit evidence to Test
Intelligence's useful behaviors, while filtering every defect and unsafe default catalogued in
`quality-intelligence-test-intelligence-inventory.md` §2. Code-level correspondence is not
required and is not a goal.

### D3 — Per-Capability Disposition

Every migrated TI capability receives exactly one Keiko disposition from the following closed set:

| Disposition                   | Meaning                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reuse-as-is`                 | The Keiko package provides the capability today; no new code is required.                                                                                                                  |
| `extend-generic-seam`         | The Keiko package is extended with a generic seam (new type, new port, new config) so Quality Intelligence can plug in. The extension must not leak QI domain types into the host package. |
| `new-pure-domain-seam`        | The capability requires new code owned by `keiko-quality-intelligence`. The implementation must pass D4.                                                                                   |
| `reject-runtime`              | The TI capability is a standalone runtime layer (server, CLI, harness, gateway). It is replaced by the equivalent Keiko service.                                                           |
| `defer-with-product-decision` | The capability is out of scope for the current implementation wave or requires a separate product and release decision. A linked issue records the deferral.                               |

The disposition for each capability is recorded in §Migration Map of this document.

### D4 — Pure-Domain Package Constraint

New packages introduced for Quality Intelligence must be pure domain logic. A new package
MUST NOT own:

- HTTP clients or server routes (route through `keiko-server`);
- provider SDK calls (route through `keiko-model-gateway`);
- credential storage or retrieval (route through `keiko-model-gateway` and environment injection);
- persistence wiring or database schema migrations (route through `keiko-evidence`,
  `keiko-local-knowledge`, or `keiko-memory-vault`);
- UI components or browser-facing wire types (route through `keiko-ui` and `keiko-contracts`);
- scheduler loops, event-bus registries, or long-running agent loops (route through
  `keiko-harness` and `keiko-workflows`);
- file system IO outside approved port calls (route through `keiko-workspace` and `keiko-tools`).

Any pull request for a new Quality Intelligence package that introduces an import of a Node IO
module (`node:http`, `node:net`, `node:fs`, `better-sqlite3`, provider SDK, etc.) at production
source scope is an architecture violation and must be blocked at review.

### D5 — Model Gateway Exclusivity

All productive model calls (chat, streaming, generation, judge evaluation, embedding, capability
probe) go through `keiko-model-gateway` only. Quality Intelligence code does not import any LLM
provider SDK directly. TI model gateway concepts (routing policy, capability probe, circuit
breaker, replay cache, FinOps budget controls, constrained decoding, prompt optimization, mock
gateway) are implemented as extensions to `keiko-model-gateway` under issue #279. The
`adr-0019-trust-1-provider-sdk-isolation` rule in `.dependency-cruiser.cjs` enforces this at
error severity across all packages.

### D6 — Harness and Workflows Exclusivity

Agent and workflow execution goes through `keiko-harness` and `keiko-workflows` only. The TI
agentic harness, production runner, and repair-loop orchestrator are all classified as
`reject-runtime`. Quality Intelligence workflows are represented as `WorkflowDescriptor` entries
in `keiko-workflows` under issue #273. No second scheduler, checkpoint store, critic-agent loop,
or event bus may be introduced.

### D7 — Runtime State Contract

Quality Intelligence runtime state (run ID, progress, resource counters, cancellation, dry-run
gates) is managed by the Keiko local runtime state contract established in issue #175
(`docs/local-runtime-state-contract.md`). New QI state categories must be
registered in the same contract. State MUST NOT live in a separate `.test-intelligence/`
directory or a new standalone SQLite database outside the approved stores.

### D8 — Evidence Semantics

Quality Intelligence artifacts (generated test cases, coverage reports, validation findings,
export bundles, judge calibration records, audit dossiers, ML-BOM entries) are persisted through
`keiko-evidence` using redaction-by-construction, atomic O_EXCL writes, realpath containment, and
the `maxRuns=50` retention policy. TI evidence and attestation behavior is classified
`extend-generic-seam` or `new-pure-domain-seam` (for Quality Intelligence–specific fields) under
issue #274. The `adr-0019-trust-6-evidence-allowed-callers` rule is extended to include
`keiko-quality-intelligence` as a permitted caller.

### D9 — External Connector Policy

External connectors (Figma REST API, Jira/ADF, TMS/ALM/qTest/Polarion/Xray export) are
explicit, user-configured, least-privilege integrations. They are disabled until the user
provides credentials via environment variable injection. Credentials are never stored in JSON
config files (TI defect `workbench-settings-plaintext-credentials` is explicitly filtered).
Each connector must implement a dry-run preview before any external write. Connector
implementations live in `keiko-server` route extensions (BFF side) or in a future
`keiko-connectors` layer that passes D4 if it exists; they do not live in
`keiko-quality-intelligence` directly.

### D10 — Conversation Center Integration

Conversation Center integration consumes `keiko-workflows` handoff surfaces (workflow
descriptors, run start routes) and `keiko-evidence` artifact retrieval surfaces only. Quality
Intelligence does not implement a separate chat channel, memory provider, model client, or agent
loop for Conversation Center. The handoff contract (`TestDesignHandoff` and related types) lives
in `keiko-contracts`. Issue #281 owns this integration.

### D11 — Single Published Package

The public customer install remains one package: `@oscharko-dev/keiko`. New internal workspace
packages are bundled into the root artifact. No new package under `packages/` is published
independently as a result of Quality Intelligence work. Issue #287 gates the package-surface and
supply-chain integrity before release.

### D12 — No Test Intelligence Runtime Dependency

The native Quality Intelligence implementation MUST NOT import `@oscharko-dev/test-intelligence`,
`@oscharko-dev/ti-*`, or any artifact from the Test Intelligence Workbench build output. This is
enforced by `arch:check` once rule `direction-10a` (see D14) is in place and by a grep-based
assertion in #285's parity gate. The `.dependency-cruiser.cjs` `trust-1` variant may be extended
to cover `@oscharko-dev/ti-*` as a named forbidden namespace.

### D13 — One New Pure-Domain Package

Quality Intelligence introduces exactly one new pure-domain package:
**`@oscharko-dev/keiko-quality-intelligence`** (path: `packages/keiko-quality-intelligence/`).

Justification from the #362 reuse matrix and #271 gap analysis:

- _Gap 1 (test-design domain logic boundary)_: Test-design strategy (coverage model, test-case
  schema, validation schemas, intent derivation, deduplication, equivalence-class fingerprinting,
  polarity classification, policy registry) has no current Keiko owner. Placing it in
  `keiko-workflows` would make workflows responsible for domain state transitions it does not
  need to understand. A dedicated package enforces that separation.
- _Gap 2 (validation judge interface)_: Judge types (`JudgeInput`, `JudgeResult`,
  `JudgePanelConfig`), pure judge logic (logic, faithfulness, semantic, mutation oracle,
  self-consistency voter), and calibration context have no current Keiko owner. These are pure
  functions with model calls routed through `keiko-model-gateway`; they belong in a domain
  package, not in `keiko-workflows` where orchestration lives.
- _Gap 4 (memory integration for test context)_: Quality Intelligence–specific memory provenance
  tags (`memory.tag="qi-test-context"`) and retrieval scope contracts are QI-domain types. They
  belong in `keiko-quality-intelligence`, consumed by `keiko-workflows` QI workflow steps and by
  `keiko-server` BFF routes.
- _Gap 5 (conversation center handoff contract)_: The `TestDesignHandoff` type and related QI
  workflow I/O types logically belong in `keiko-contracts` (for cross-package sharing) or in
  `keiko-quality-intelligence` (for QI-specific domain logic). Per §Package Boundaries, pure
  wire types go to `keiko-contracts`; domain behavior types go to `keiko-quality-intelligence`.

The alternative of zero new packages (absorbing everything into `keiko-workflows`) was considered
and rejected: see §Alternatives Considered.

### D14 — New Dependency-Direction Rule

`.dependency-cruiser.cjs` receives one new strict rule variant for `keiko-quality-intelligence`:

**Rule `adr-0019-direction-10a-quality-intelligence-only-contracts-security`** (severity:
`error`): `keiko-quality-intelligence` may depend on `keiko-contracts` and `keiko-security` only.
It must not depend on `keiko-model-gateway`, `keiko-workspace`, `keiko-tools`, `keiko-harness`,
`keiko-workflows`, `keiko-evidence`, `keiko-server`, `keiko-cli`, `keiko-ui`,
`keiko-local-knowledge`, or any `keiko-memory-*` package in its production source.

Model calls are injected via a `ModelPort`-style port interface (defined in `keiko-contracts`);
the caller (`keiko-workflows` QI workflows) wires the gateway. Evidence persistence is handled by
`keiko-evidence`; the caller wires the store. This pattern mirrors the established port-injection
precedent from ADR-0005 and rules 3a–3j.

Existing allow-lists in rules 5a (workflows), 6a (server), and 7a (cli) are
extended to include `keiko-quality-intelligence` as a permitted import target in those packages'
production source. Rule 4a (harness) is intentionally not extended — `keiko-harness` does not
depend on `keiko-quality-intelligence` per D6.

The `adr-0019-trust-6-evidence-allowed-callers` rule is updated to include
`packages/keiko-quality-intelligence/src/` as a permitted evidence caller path for domain types
that reference evidence manifest shape (type-only imports).

Issue #287 updates `EXPECTED_RULES` from 18 to 19 (negative-fixture rules); total dep-cruiser rule count reaches 32.

## Anti-Duplication Table

The following table governs what Quality Intelligence may and may not introduce. Every cell is
enforceable by `arch:check`, lint, PR review, or the parity gate in #285.

| Risk area                    | Forbidden                                                                                                                                                                                                 | Permitted                                                                                                                                                                                                                  | Enforcement                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Harness / agent loop**     | Second scheduler, event bus, checkpoint store, agentic loop, or `createSession`-equivalent outside `keiko-harness`. Importing `@oscharko-dev/ti-agentic-harness`.                                         | Calling `keiko-harness` public API. Composing `WorkflowDescriptor` in `keiko-workflows`.                                                                                                                                   | `arch:check` rule 4a; PR review; parity gate #285                     |
| **Model gateway**            | Direct provider SDK import (`openai`, `@anthropic-ai/*`) outside `keiko-model-gateway`. Importing `@oscharko-dev/ti-model-gateway`. Second gateway factory.                                               | Calling `keiko-model-gateway` `Gateway.chat()` / `Gateway.stream()` / `requestOpenAIEmbedding()`. Extending `keiko-model-gateway` with new routing policy or capability probe via issue #279.                              | `arch:check` rule trust-1; rule direction-10a; grep assertion in #285 |
| **Local / runtime state**    | New `.test-intelligence/` directory. Standalone SQLite outside `keiko-evidence`, `keiko-local-knowledge`, `keiko-memory-vault`. Second state root.                                                        | Keiko local runtime state contract (issue #175). Approved stores via `keiko-evidence` and `keiko-local-knowledge` APIs.                                                                                                    | Issue #274 evidence gate; runtime state contract; parity gate #285    |
| **Evidence and redaction**   | Persisting model prompts, raw query text, raw credentials, or provider configuration. Copying TI's evidence manifest schema without adapting to Keiko's `EvidenceManifest`. Not redacting before persist. | `buildEvidenceManifest()` + `persistEvidence()` + `createAuditRedactor()` from `keiko-evidence`. Extending `EvidenceManifest` with `qualityIntelligence` section via issue #274.                                           | `arch:check` rule trust-6; issue #274 security review                 |
| **HTTP server / BFF**        | Embedding TI's HTTP server or creating a second BFF process. Adding QI routes outside `keiko-server`.                                                                                                     | New QI routes registered in `keiko-server`'s existing route dispatcher. SSE streams through existing `/api/run/{id}/events`.                                                                                               | `arch:check` rule 6a; issue #280/#281 PR scope gate                   |
| **CLI**                      | Embedding TI's `test-intelligence` CLI binary. Adding a separate `bin` entry for `quality-intelligence`.                                                                                                  | New `keiko quality-intelligence` subcommands in `keiko-cli` following existing descriptor-driven pattern.                                                                                                                  | `arch:check` rule 7a; package.json `bin` review                       |
| **UI**                       | Embedding TI's Workbench as an iframe or sub-application. Adding a `Next.js` app outside `keiko-ui`.                                                                                                      | New routes, panels, and run summary cards in `keiko-ui`. Extending `WorkflowInputSpec` with QI input field types via issue #280.                                                                                           | Issue #280 scope; WCAG 2.2 AA requirement; ADR-0011                   |
| **Security and redaction**   | Importing `@oscharko-dev/ti-security`. Creating a second PII detection layer. Storing credentials in JSON config files. Using TI's constraint-based decoding prompt safety shortcut.                      | `keiko-security` redaction primitives. `keiko-memory-capture` policy gate for QI workflow outcomes. Environment-variable-only credential injection.                                                                        | `arch:check` trust-1; issue #284 security review                      |
| **Figma / source ingestion** | Directly calling Figma REST API from `keiko-quality-intelligence`. Storing Figma frames in an unencrypted standalone database.                                                                            | Figma connector registered in `keiko-server` BFF (user-configured, env-var token, dry-run capable, disabled until configured). `keiko-workspace` and `keiko-local-knowledge` as the file-access and capsule-storage layer. | Issue #278 connector security review; ADR-0022                        |
| **Exports / TMS connectors** | Unconditional external writes to Jira, ALM, qTest, Polarion, or Xray. Embedding `@oscharko-dev/ti-integrations` runtime.                                                                                  | Dry-run-previewed, user-authorized export adapter in `keiko-server` (or a future `keiko-connectors` package that passes D4). Deferred to #283.                                                                             | Issue #283 explicit authorization gate                                |
| **Package exports**          | Exporting IO-bearing types (`http.IncomingMessage`, `better-sqlite3`, provider SDK types) from `keiko-quality-intelligence`.                                                                              | Pure domain types, validated schemas, port interfaces, dispositioned on `keiko-contracts` or `keiko-quality-intelligence`.                                                                                                 | `arch:check` rule direction-10a; package surface gate #287            |
| **Review governance**        | Implementing a separate review-queue HTTP API or standalone reviewer credential scheme.                                                                                                                   | Four-eyes review state machine in `keiko-quality-intelligence` domain types; wired by `keiko-workflows` and `keiko-server`. Issue #282.                                                                                    | Issue #282 scope gate                                                 |
| **Local Knowledge**          | Duplicating `keiko-local-knowledge`'s capsule store for QI documents. Running a second embedding or retrieval orchestration.                                                                              | Registering new parsers in `keiko-local-knowledge`'s `ParserRegistry` (extend-generic-seam). Calling `retrieveLocalKnowledge()` from QI workflows.                                                                         | `arch:check` rule 3e (local-knowledge); issue #278                    |
| **Memory**                   | Introducing QI-specific memory storage outside `keiko-memory-vault`. Bypassing `keiko-memory-capture`'s policy gate for QI workflow outcomes.                                                             | Using `keiko-memory-capture`/`keiko-memory-retrieval`/`keiko-memory-governance` with QI provenance tags (`qi-test-context`, `qi-regression-scenario`). Shared vault scope via project-scoped isolation.                    | `arch:check` rules 3f–3j; issue #274 security review                  |

## Migration Map

The table below is the authoritative per-capability disposition summary. Implementors must cite
the applicable row from this table in every Quality Intelligence pull request.

| TI capability                                                 | Keiko owner                                                                       | Disposition                                       | Rationale                                                                                                                                     | Linked issue |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Branded IDs (QI-specific)                                     | `keiko-contracts` + `keiko-quality-intelligence`                                  | new-pure-domain-seam                              | `QualityIntelligenceRunId`, `TestCaseId`, `JudgeRunId` are QI-domain branded IDs; wire types go to `keiko-contracts`.                         | #277         |
| Intent derivation                                             | `keiko-quality-intelligence` + `keiko-model-gateway`                              | new-pure-domain-seam                              | Core test-design domain logic; model calls route through gateway via port injection.                                                          | #272         |
| Test-design model (schema, polarity, field lifecycle)         | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Pure domain types and validators; no IO.                                                                                                      | #272         |
| Coverage relevance calculation                                | `keiko-quality-intelligence` + `keiko-model-gateway`                              | new-pure-domain-seam                              | Coverage domain logic; LLM-assisted planning via gateway.                                                                                     | #272         |
| Validation schemas (Zod/JSON Schema)                          | `keiko-quality-intelligence` + `keiko-contracts`                                  | new-pure-domain-seam                              | Pure schema validation; cross-package wire types to `keiko-contracts`.                                                                        | #277         |
| Logic judge                                                   | `keiko-quality-intelligence` + `keiko-model-gateway`                              | new-pure-domain-seam                              | Pure judge interface; model calls via gateway port injection.                                                                                 | #279         |
| Faithfulness judge                                            | `keiko-quality-intelligence` + `keiko-model-gateway`                              | new-pure-domain-seam                              | Pure judge interface; model calls via gateway port injection.                                                                                 | #279         |
| Semantic judge panel                                          | `keiko-model-gateway`                                                             | extend-generic-seam                               | Ensemble routing policy extended in gateway; QI wires panel via `ModelPort`.                                                                  | #279         |
| Mutation oracle                                               | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | IR mutation strategy; pure domain logic with no IO.                                                                                           | #272         |
| Policy profiles                                               | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Local policy registry; pure domain logic stored via `keiko-local-knowledge` capsules.                                                         | #272         |
| Figma payload normalization                                   | `keiko-quality-intelligence` + `keiko-local-knowledge`                            | extend-generic-seam                               | New `ParserRegistry` entry in `keiko-local-knowledge`; normalization logic in `keiko-quality-intelligence`. Figma token: env-var only.        | #278         |
| Jira ADF parser                                               | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Pure ADF parser function; no HTTP client in QI. HTTP call lives in `keiko-server` connector route.                                            | #278         |
| Custom-context input validation                               | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Pure validation; no IO.                                                                                                                       | #278         |
| Source-mix planning                                           | `keiko-quality-intelligence` + `keiko-model-gateway`                              | new-pure-domain-seam                              | Recommendation engine; model calls via gateway.                                                                                               | #278         |
| Multi-source reconciliation                                   | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Pure merge/deduplicate functions; no IO.                                                                                                      | #278         |
| LLM gateway routing / policy / capability probe               | `keiko-model-gateway`                                                             | reject-runtime                                    | TI gateway is a standalone runtime; `keiko-model-gateway` is the single LLM entry point. TI routing heuristics ported as extensions via #279. | #279         |
| LLM circuit breaker                                           | `keiko-model-gateway`                                                             | extend-generic-seam                               | Backoff strategy ported as an extension to existing resilience layer.                                                                         | #279         |
| Replay cache                                                  | `keiko-model-gateway` + `keiko-evidence`                                          | extend-generic-seam                               | Cache-key strategy ported; deterministic requests cached via gateway extension or evidence side-file.                                         | #279         |
| FinOps budget controls                                        | `keiko-model-gateway`                                                             | extend-generic-seam                               | Token-budget enforcement extended in gateway routing layer.                                                                                   | #279         |
| Constrained decoding / structured output                      | `keiko-model-gateway`                                                             | extend-generic-seam                               | Model-native structured output (not prompt-based tricks); schema passed via gateway call options.                                             | #279         |
| Prompt optimization                                           | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Pure prompt-builder functions; no IO.                                                                                                         | #272         |
| Mock gateway                                                  | `keiko-model-gateway`                                                             | extend-generic-seam                               | Test-double port already established (`ScriptedModelPort`); mock gateway behavior ported as scripted test double.                             | #279, #285   |
| Agentic harness / checkpoint                                  | `keiko-harness`                                                                   | reject-runtime                                    | TI harness is a standalone runtime; `keiko-harness` is the single execution seam.                                                             | #273         |
| Adversarial critic agent                                      | `keiko-quality-intelligence` + `keiko-workflows` + `keiko-model-gateway`          | new-pure-domain-seam                              | Critic algorithm ported as a QI workflow step; model calls via gateway.                                                                       | #273         |
| Causal hypothesis registry                                    | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Pure registry; persisted via `keiko-evidence` side-file.                                                                                      | #273         |
| Test-data oracle                                              | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Learned rule registry; pure domain state.                                                                                                     | #273         |
| Production runner / top-level orchestrator                    | `keiko-workflows`                                                                 | reject-runtime                                    | TI runner is a standalone runtime; `keiko-workflows` `WorkflowDescriptor` is the execution seam.                                              | #273         |
| Repair loop                                                   | `keiko-workflows`                                                                 | extend-generic-seam                               | Retry/loop pattern extended in workflow descriptors; no second orchestrator.                                                                  | #273         |
| Workflow state machine (draft/candidate/approved/closed)      | `keiko-quality-intelligence` + `keiko-harness`                                    | new-pure-domain-seam                              | 4-state model is QI-domain; states wired into `keiko-harness` `WorkflowState` if compatible, else a QI-specific seam.                         | #273, #282   |
| Evidence attestation                                          | `keiko-evidence`                                                                  | extend-generic-seam                               | Keiko evidence extended with `qualityIntelligence` manifest section; attestation semantics ported.                                            | #274         |
| Provenance graph                                              | `keiko-evidence` + `keiko-quality-intelligence`                                   | extend-generic-seam                               | Lineage tracking ported using existing run/workflow event model; QI-specific edge types in domain seam.                                       | #274         |
| Audit dossier                                                 | `keiko-evidence` + `keiko-quality-intelligence`                                   | extend-generic-seam                               | Audit records persist via `keiko-evidence`; QI-specific audit schema in domain seam.                                                          | #274         |
| ML-BOM (model lineage record)                                 | `keiko-quality-intelligence`                                                      | new-pure-domain-seam                              | Schema extension; persisted as evidence side-file via `keiko-evidence`.                                                                       | #274         |
| Review queue / four-eyes governance                           | `keiko-quality-intelligence` + `keiko-workflows`                                  | new-pure-domain-seam                              | QI domain state machine; wired by `keiko-workflows` and `keiko-server` routes. No separate HTTP API.                                          | #282         |
| TMS / ALM / Xray / qTest / Polarion export                    | `keiko-server` (connector route) + `keiko-quality-intelligence` (format adapters) | defer-with-product-decision                       | Deferred to #283; dry-run preview required; user-authorized only.                                                                             | #283         |
| PII detection and redaction                                   | `keiko-security` + `keiko-memory-capture`                                         | reuse-as-is                                       | Existing redaction and policy-gate seams cover QI workflow outcomes.                                                                          | #284         |
| HTTP request handling                                         | `keiko-server`                                                                    | reject-runtime                                    | TI server is a standalone runtime; QI routes registered in native `keiko-server` only.                                                        | #280, #281   |
| CLI subcommands                                               | `keiko-cli`                                                                       | reject-runtime                                    | TI CLI binary is a standalone runtime; QI commands as native `keiko quality-intelligence` subcommands.                                        | #273, #280   |
| Next.js Workbench UI                                          | `keiko-ui`                                                                        | reject-runtime                                    | TI Workbench is a standalone UI; QI surfaces built natively in `keiko-ui`.                                                                    | #280         |
| Repository detection, safe file reads, context packs          | `keiko-workspace`                                                                 | reuse-as-is                                       | No new code required; existing `discoverWorkspace()`, `readWorkspaceFile()`, `buildWorkspaceContextPack()`.                                   | #278         |
| Persistent capsule/document store, parser registry, retrieval | `keiko-local-knowledge`                                                           | reuse-as-is (extend-generic-seam for new parsers) | Existing capsule store and retrieval cover QI documents; new parsers registered via `ParserRegistry`.                                         | #278         |
| Durable memory (vault, capture, governance, retrieval)        | `keiko-memory-*`                                                                  | reuse-as-is                                       | Existing five memory packages cover QI context memory with QI-specific provenance tags.                                                       | #274, #281   |
| Agent runtime loop, event emission, limits                    | `keiko-harness`                                                                   | reuse-as-is                                       | Existing `createSession()` / `runAgent()` / `HarnessEvent` cover QI workflow execution.                                                       | #273         |
| Workflow descriptor and dry-run gate                          | `keiko-workflows` + `keiko-contracts`                                             | reuse-as-is                                       | `WorkflowDescriptor<TLimits>` pattern covers QI workflow definitions.                                                                         | #273         |
| Evidence manifest, store, redaction, retention                | `keiko-evidence`                                                                  | reuse-as-is                                       | All existing `buildEvidenceManifest()`, `persistEvidence()`, `createAuditRedactor()`, `applyRetention()` reused; extended for QI fields.      | #274         |
| Provider credential config, model capability probe            | `keiko-model-gateway` + `keiko-server`                                            | reuse-as-is                                       | Existing `GatewaySetup`, `discoverCapabilities()`, BFF route `/api/gateway/setup`.                                                            | #279         |
| BFF route dispatch, CSRF gate, CSP, SSE streaming             | `keiko-server`                                                                    | reuse-as-is                                       | All QI BFF routes go through existing `createUiServer()` dispatcher.                                                                          | #280, #281   |
| UI shell, sidebar, run summary cards, evidence viewer         | `keiko-ui` + `keiko-server`                                                       | reuse-as-is                                       | Existing project/chat shell, run summary cards, evidence viewer reused for QI runs.                                                           | #280         |
| Workflow input forms (descriptor-driven)                      | `keiko-ui` + `keiko-workflows`                                                    | extend-generic-seam                               | `WorkflowInputSpec` extended with QI input field types (coverage model, validator preferences).                                               | #280         |
| Tenant onboarding / data isolation / residency                | —                                                                                 | defer-with-product-decision                       | Multi-tenant is out of scope for current implementation wave.                                                                                 | #286         |

## Package Boundaries

### `@oscharko-dev/keiko-quality-intelligence`

**Path**: `packages/keiko-quality-intelligence/`

**Responsibility**: Pure Quality Intelligence domain logic: test-design model, intent derivation,
coverage relevance calculation, validation schemas and judges, mutation oracle, policy profiles,
multi-source reconciliation, export format adapters, review governance state machine, causal
hypothesis registry, test-data oracle, adversarial critic algorithm, prompt builders, ML-BOM
schema.

**Allowed dependencies (production source)**:

| Package                         | Reason                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| `@oscharko-dev/keiko-contracts` | Wire types, branded IDs, port interfaces, event envelopes.            |
| `@oscharko-dev/keiko-security`  | `deepRedactStrings()`, `looksLikeSecretShape()`, safe error wrapping. |

**Packages allowed to import `keiko-quality-intelligence` (production source)**:

| Package           | Permitted import scope                                                                |
| ----------------- | ------------------------------------------------------------------------------------- |
| `keiko-workflows` | QI workflow descriptors, judge orchestration, repair loops, adversarial critic steps. |
| `keiko-server`    | BFF route handlers wiring QI domain functions.                                        |
| `keiko-cli`       | CLI command dispatch invoking QI workflow entry points.                               |
| `keiko-evidence`  | Type-only imports for `qualityIntelligence` manifest section types.                   |

All other packages (including `keiko-harness`, `keiko-model-gateway`, `keiko-workspace`,
`keiko-tools`, `keiko-local-knowledge`, `keiko-memory-*`, `keiko-ui`) must not depend on
`keiko-quality-intelligence`.

**Explicitly forbidden imports in production source of `keiko-quality-intelligence`**:

- Any HTTP client library (`node:http`, `node:https`, `axios`, `got`, `undici` as a direct
  dependency).
- Any provider SDK (`openai`, `@anthropic-ai/*`, `@google-ai/*`).
- Any persistence library (`better-sqlite3`, `node:sqlite`, `leveldb`).
- Any `node:fs`, `node:path`, `node:os`, or `node:child_process` call not mediated by an
  injected port interface.
- Any `@oscharko-dev/ti-*` or `@oscharko-dev/test-intelligence` package.

**Port injection pattern**: Domain functions that require model calls receive a `ModelPort`-shaped
argument (defined in `keiko-contracts`). Domain functions that require evidence writes receive an
`EvidenceStore`-shaped argument (defined in `keiko-contracts`). The caller (`keiko-workflows` or
`keiko-server`) injects the concrete implementation at call time. This mirrors the pattern
established in issues #4, #5, #8, and the `keiko-memory-retrieval` seam.

### Extended `keiko-contracts` types

Quality Intelligence wire types that cross package boundaries (handoff types, run status types,
export artifact envelope types, QI-specific event envelopes) live in `keiko-contracts` under a
`quality-intelligence/` sub-directory. Issue #277 owns this contract surface.

## Migration Order and Write Ownership

The following table assigns write ownership per child issue. "Parallelism-safe" means the child
may proceed concurrently with other children listed as `yes`; `conditional` means concurrent work
is safe only after the listed prerequisite issue has produced a stable contract surface.

| Child issue                            | Primary write-owner package(s)                                                                                | Secondary touched packages                                                                                                                          | Parallelism-safe                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| #277 — QI contracts and fixtures       | `keiko-contracts` (QI sub-directory), `keiko-quality-intelligence` (initial scaffolding, schema validators)   | `keiko-evidence` (QI manifest type stubs)                                                                                                           | Yes (no overlap with #272–#274 until scaffolding lands)                             |
| #272 — Core test-design logic          | `keiko-quality-intelligence`                                                                                  | `keiko-contracts` (type extensions only)                                                                                                            | Conditional on #277 producing `keiko-quality-intelligence` scaffolding              |
| #279 — Model-gateway extensions        | `keiko-model-gateway`                                                                                         | `keiko-contracts` (new port interfaces)                                                                                                             | Conditional on #277 for port interface definitions                                  |
| #278 — Source ingestion                | `keiko-quality-intelligence` (ADF parser, source-mix planning)                                                | `keiko-local-knowledge` (new parsers), `keiko-server` (connector BFF routes), `keiko-workspace` (no source change, used as-is)                      | Conditional on #277; parallel with #272 once scaffolding is in place                |
| #273 — QI workflow execution           | `keiko-workflows` (new QI workflow descriptors)                                                               | `keiko-harness` (no source change required), `keiko-quality-intelligence` (workflow entry points), `keiko-contracts` (QI workflow descriptor types) | Conditional on #272 and #279 producing stable entry points                          |
| #274 — Evidence and local state        | `keiko-evidence` (QI manifest extension)                                                                      | `keiko-quality-intelligence` (side-file and ML-BOM schema), `keiko-server` (evidence route extensions)                                              | Conditional on #277 for manifest type stubs; parallel with #272/#279                |
| #282 — Review governance               | `keiko-quality-intelligence` (review state machine)                                                           | `keiko-workflows` (review workflow descriptor), `keiko-server` (review BFF routes), `keiko-ui` (review UI panels)                                   | Conditional on #273 for workflow infrastructure                                     |
| #280 — QI UI surfaces                  | `keiko-ui`                                                                                                    | `keiko-server` (new QI UI routes), `keiko-contracts` (BFF wire types)                                                                               | Conditional on #273 for run status; parallel with #282 if UI panels are independent |
| #281 — Conversation Center integration | `keiko-server` (handoff routes)                                                                               | `keiko-contracts` (TestDesignHandoff type from #277), `keiko-workflows` (QI workflow handoff)                                                       | Conditional on #273 and #277                                                        |
| #283 — Enterprise export adapters      | `keiko-server` (connector export routes)                                                                      | `keiko-quality-intelligence` (format adapter functions), `keiko-evidence` (export artifact side-file)                                               | Conditional on #274; can proceed after #273 produces stable artifacts               |
| #284 — Security hardening              | `keiko-quality-intelligence` (hardened validators, path safety), `keiko-server` (prompt injection mitigation) | `keiko-security`, `keiko-workspace`, `keiko-tools` (no source change; audit only)                                                                   | Conditional on #272/#273/#274 being feature-complete                                |
| #285 — Parity matrix                   | `docs/` (parity matrix documents)                                                                             | `keiko-quality-intelligence` (test fixtures only), all QI-affected packages (evaluation harness)                                                    | Conditional on all implementation children (#272–#283) being feature-complete       |
| #286 — Standalone TI compatibility     | `docs/` (compatibility decision matrix)                                                                       | None (audit only for Keiko; standalone TI repo decision out of Keiko scope)                                                                         | Parallel with #285                                                                  |
| #287 — Package surface gate            | Root `scripts/` and CI configuration                                                                          | `packages/keiko-quality-intelligence/` (package.json surface), `.dependency-cruiser.cjs` (rule direction-10a)                                       | Conditional on #277 for initial package scaffolding                                 |

No two implementation children own overlapping write files with the exception of `keiko-contracts`
(#277 produces the initial QI sub-directory; subsequent children extend it) and
`keiko-quality-intelligence` (#277 scaffolds the package; #272 and subsequent children extend it).
This overlap is managed by requiring #277 to land first.

## Standalone Test Intelligence Compatibility Decision

The standalone `@oscharko-dev/test-intelligence` package and its Workbench, CLI, and operator
contract remain an independent product for the duration of the Quality Intelligence migration.
Keiko does not import its runtime, pin to its API, or depend on its build output. The directional
choice is: the standalone product stays alive as a separate repository; Keiko's native Quality
Intelligence is the replacement path for teams adopting Keiko; no retirement, migration, or
deprecation of the standalone product is committed to in this ADR. The formal compatibility
decision matrix is deferred to issue #286. The following commitments apply during migration:

1. No Keiko pull request modifies any file in the `oscharko-dev/test-intelligence` repository.
2. No Keiko package declares `@oscharko-dev/test-intelligence` or `@oscharko-dev/ti-*` as a
   dependency.
3. The parity gate in #285 verifies Keiko-native behavior against the behavioral reference from
   `quality-intelligence-test-intelligence-inventory.md` without requiring a live TI runtime.
4. Any API-level interface compatibility goal (if required by customers using both products) is
   out of scope for this ADR and is explicitly deferred to #286.

## Open Items Deferred to Implementation Children

The following decisions are documented as open and must be resolved in the named child issues
before implementation begins in that area:

**#277 (QI contracts)**

- Final naming and namespace for QI-branded ID types within `keiko-contracts`
  (`quality-intelligence/` sub-directory vs. inline in `contracts/`).
- Whether `TestDesignHandoff` lives in `keiko-contracts` (cross-package) or
  `keiko-quality-intelligence` (QI-internal). Decision criterion: if any non-QI package needs
  to construct or inspect the handoff type, it belongs in `keiko-contracts`.
- Contract versioning scheme for `GENERATED_TEST_CASE_SCHEMA_VERSION` (mirror TI's approach or
  align to existing Keiko `evidenceSchemaVersion` pattern).

**#272 (core test-design logic)**

- Whether the 4-state workflow state machine (draft/candidate/approved/closed) lives in
  `keiko-quality-intelligence` independently or reuses `keiko-harness` `WorkflowState`. Decision
  criterion: if QI states map cleanly to harness `WorkflowState` enum variants, reuse; if they
  require QI-specific transitions not supported by harness, define a QI-local state machine.
- Scope of the `PolicyProfile` registry: whether policy profiles are stored as `keiko-local-knowledge`
  capsules (recommended for user-configurable policies) or as static typed constants in
  `keiko-quality-intelligence`.

**#279 (model gateway extensions)**

- Whether replay/response cache lives in `keiko-model-gateway` (as a call-level cache) or in
  `keiko-evidence` (as a deterministic-request side-file). Decision criterion: if the cache is
  shared across workflow runs (reuse across sessions), `keiko-evidence` is the correct location;
  if it is session-scoped, `keiko-model-gateway` is appropriate.
- Specific circuit-breaker backoff parameters (initial delay, max retries, error-class
  distinction). Not prescribed by this ADR; implementation choice in #279.

**#278 (source ingestion)**

- Whether the Figma connector BFF route lives in `keiko-server` directly or in a future
  `keiko-connectors` package. Criterion: `keiko-connectors` is justified only if three or more
  external connector types exist and share a common port interface. At #278 scope (Figma + Jira),
  `keiko-server` is the simpler choice.
- Scope of the Jira ADF parser: whether it covers Jira Server + Jira Cloud ADF schemas or only
  Cloud. Decision in #278 based on product scope.

**#273 (workflow execution)**

- Number and names of QI workflow descriptors to implement (minimum: one test-design generation
  workflow; adversarial critic workflow may be deferred).
- Whether the repair loop is implemented as a new `WorkflowDescriptor` stage or as a loop inside
  a single stage (harness retry semantics).

**#282 (review governance)**

- Whether four-eyes review integrates with `keiko-memory-governance` envelope builders
  (reuse existing governance patterns) or requires a QI-specific review record type.
- Expiration and archival policy for reviewed QI artifacts (align with `maxRuns=50` evidence
  retention or introduce a separate QI review retention policy).

**#283 (export adapters)**

- Which export formats are in scope for the initial delivery: Markdown, CSV, Jira-compatible
  Markdown, JUnit XML, or TMS-specific formats.
- Authorization UX: whether export authorization is a one-time per-session prompt or a persisted
  per-project connector setting.

**#285 (parity matrix)**

- Which TI adversarial fixtures from `quality-intelligence-test-intelligence-inventory.md` §4
  are converted to Keiko-owned test data (decision: sanitize and convert all 8 parity fixture
  shortlist entries) vs. which are re-derived synthetically.
- Pass/fail threshold for parity verification (recommended: 100% of non-deferred, non-rejected
  TI capabilities have at least one behavioral test in Keiko).

## Consequences

### Positive

- All 17 existing Keiko packages are reused first; the Quality Intelligence migration adds a
  maximum of one new internal workspace package.
- A single, explicit disposition table (§Migration Map) prevents TI runtime layers from entering
  Keiko accidentally.
- `keiko-quality-intelligence` dependency direction rule `direction-10a` enforces the pure-domain
  constraint automatically; any IO import is caught by `arch:check` before code review.
- Evidence redaction and retention apply to QI artifacts by construction, not by policy; no
  separate audit layer is required.
- Implementation children can proceed in parallel once #277 lands the initial package scaffolding
  and contract surface.

### Negative

- Every new TI capability that is not a direct reuse-as-is must carry a disposition entry in the
  migration map; this adds overhead to each child issue PR.
- `keiko-quality-intelligence` must prove its pure-domain status at every PR; importing an IO
  module accidentally triggers an `arch:check` failure that requires investigation.
- The allow-lists in rules 4a (harness), 5a (workflows), 6a (server), and 7a (cli) require
  updates in #287 to include `keiko-quality-intelligence`; missing this update blocks arch:check.
- Deferred capabilities (#283, tenant onboarding) must be explicitly documented as deferred in
  every child issue that touches those areas, to prevent silent scope creep.

### Neutral

- The test-design workflow and the bug-investigation workflow will share the same harness and
  workflow infrastructure; patterns learned from #8 and #9 apply directly.
- TI capabilities classified `reject-runtime` (harness, model gateway, server, CLI, Workbench)
  require no porting work; they are replaced by existing Keiko services.
- ADR-0019 remains unchanged; this ADR records the topology extension as a forward amendment.

## Alternatives Considered

### Alternative 1: Zero new packages — absorb everything into `keiko-workflows`

Absorb test-design domain logic (coverage model, judges, validation schemas, policy profiles,
causal hypothesis registry) directly into `keiko-workflows` as additional workflow modules.

- **Pros**: No new package; no new dependency-direction rule; simpler initial scaffolding.
- **Cons**: `keiko-workflows` already owns execution orchestration and workflow descriptors;
  mixing pure domain types (judge calibration records, test-case schema validators, policy
  profiles) into it gives the package two reasons to change. Once QI adds 5+ workflow types, the
  package will exceed 1000 LOC and 20 exports (ADR-0019 god-module threshold). The boundary
  between "domain logic" and "orchestration" becomes invisible, making future extraction
  expensive.
- **Why rejected**: Separation of concerns and the "one reason to change" quality standard
  require domain logic to live in its own package. The size trajectory alone justifies early
  extraction.

### Alternative 2: Multiple new packages — split by subdomain (keiko-test-design, keiko-quality-judges, keiko-quality-connectors)

Introduce three or more new packages matching the major TI subdomain groupings.

- **Pros**: Finer-grained ownership; smaller packages; easier to reason about each subdomain.
- **Cons**: Premature abstraction — the ADR-0019 rule "three similar usages before extracting"
  and "no premature abstraction" apply. At the start of the migration there are no proven usage
  patterns to justify a split. Three packages each importing only `keiko-contracts` + `keiko-security`
  with no cross-imports would also require three new dependency-direction rules and three
  `allow-list` updates, multiplying governance overhead.
- **Why rejected**: Insufficient evidence of divergent evolution at this stage. The ADR commits
  to reviewing the single-package boundary after #272–#274 land; if the package grows beyond
  1000 LOC or exhibits distinct ownership, a follow-up ADR will split it.

### Alternative 3: Embed Test Intelligence as a sub-package dependency

Declare `@oscharko-dev/test-intelligence` as a workspace dependency and import its domain types
directly.

- **Pros**: Faster initial implementation; TI's type system is already proven.
- **Cons**: Violates Epic #270 hard constraint. Imports TI's runtime dependency graph (including
  TI's standalone gateway, server, and CLI) into Keiko's bundle. Creates a circular product
  dependency (Keiko depends on TI; TI's parity gate depends on Keiko). Every TI defect listed
  in `quality-intelligence-test-intelligence-inventory.md` §2 would be inherited directly.
- **Why rejected**: This is an explicit stop condition in Epic #270 and in issue #271. It is not
  a viable option regardless of implementation speed benefit.

### Alternative 4: ADR-0019 amendment instead of a new ADR

Amend ADR-0019 in place to add the 18th package, new topology rows, and the dependency-direction
rule rather than creating ADR-0023.

- **Pros**: Single document for the complete topology; no cross-referencing needed.
- **Cons**: ADR-0019 was accepted for the architecture sprint (issues #157–#175). Amending it
  retroactively conflates two separate decisions: the initial modularization decision and the
  Quality Intelligence migration decision. Future readers cannot see when and why Quality
  Intelligence was added. ADR-0023 provides a clear decision trail with a specific date and
  explicit justification against the #362/#363 inputs.
- **Why rejected**: The hard rule "each ADR covers one decision" applies. ADR-0019 covers the
  initial modularization. ADR-0023 covers the Quality Intelligence migration. They are related
  but distinct decisions.

## Verification

After this ADR document lands, the following commands must all exit 0 from the repository root:

```bash
npm run arch:check      # All direction and trust rules pass; no new violations introduced by docs.
npm run lint            # ESLint max-warnings=0; docs files are not in lint scope.
npm run typecheck       # All workspace packages compile; docs files do not introduce type errors.
npm run format:check    # All tracked files match Prettier output.
```

This ADR is a documentation-only change. `arch:check`, `lint`, and `typecheck` must pass at
baseline; `format:check` must pass after `npx prettier --write docs/adr/ADR-0023*.md`.

Issue #287 adds a package-surface gate (`check:package-surface`) that verifies the final
`keiko-quality-intelligence` package exports once the package exists. That gate is not required
for this documentation PR.

## Related

- ADR-0019: Modular Package Architecture (anchor for package topology and dependency direction)
- ADR-0020: Workspace Tooling and Architecture Gate (severity policy; EXPECTED_RULES count)
- ADR-0021: Publish Strategy — Bundled Monorepo Product (one public package invariant)
- ADR-0022: Connected Context Privacy Contract (privacy pattern QI evidence must follow)
- Issue #270: Epic — Integrate Test Intelligence as native Keiko Quality Intelligence
- Issue #271: Define Keiko-native Quality Intelligence migration architecture (this issue)
- Issue #362 / `docs/historical/quality-intelligence-keiko-baseline.md`: Keiko reuse baseline
- Issue #363 / `docs/historical/quality-intelligence-test-intelligence-inventory.md`: TI behavior inventory
- `.dependency-cruiser.cjs`: architecture gate encoding ADR-0019 rules and the new `direction-10a` rule (owned by #287)
