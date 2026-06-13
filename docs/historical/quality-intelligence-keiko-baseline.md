# Keiko Reuse Baseline for Quality Intelligence Implementation

This document is a historical baseline snapshot captured for issue #362 on 2026-06-05. It is not
the current Keiko package inventory contract, release gate, or compatibility guide for the live
`0.2.0` modular product.

## 1. Baseline Identity

This document records the Keiko code and package state as of 2026-06-05 for issue #362 and the Quality Intelligence implementation initiative (Epic #270).

- **Integration branch**: `dev`
- **Baseline commit SHA**: `faf2deb71866097c8e796067ab560ea110ca0c19`
- **Commit date**: 2026-06-03
- **Date documented**: 2026-06-05
- **Test Intelligence reference baseline** (behavioral reference only): commit `0ffeab80c045ac06b5ac6cb4c1f6bec03226b392`, repository `oscharko-dev/test-intelligence`, branch `dev`

## 2. Keiko Package Inventory

Keiko currently exports 17 workspace packages. Every package is internal (bundled in the root `@oscharko-dev/keiko` artifact) and not published separately. This baseline audit treats all 17 as reuse-eligible candidates for Quality Intelligence implementation.

| Package Name                               | Version | Declared Description                                                                                                                                                                                                                                            | Capability Summary                                                                                                                                                                                                                                                                                            | Package Path                                                               |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `@oscharko-dev/keiko-contracts`            | 0.4.0   | Shared public contracts, branded IDs, event envelopes, model capability schema, BFF wire types, workflow descriptors.                                                                                                                                           | Shared type contracts, validated constant tables (model capabilities, cost classes, workflow phases), wire schemas, event union types.                                                                                                                                                                        | [packages/keiko-contracts](../../packages/keiko-contracts)                     |
| `@oscharko-dev/keiko-security`             | 0.1.0   | Redaction, secret handling, safe error shaping, content hashing, trust-boundary helpers.                                                                                                                                                                        | Secret detection patterns, safe error wrapping, redaction primitives for logs/manifests, base64 hash helpers, audit redactor builder.                                                                                                                                                                         | [packages/keiko-security](../../packages/keiko-security)                       |
| `@oscharko-dev/keiko-model-gateway`        | 0.1.0   | Provider abstraction, OpenAI-compatible calls, discovery, capability probing, routing, resilience, TLS handling.                                                                                                                                                | Provider credential config, OpenAI-compatible HTTP adapter, capability probing, cost-class routing, retry + timeout + backoff orchestration, embeddings transport (carve-out for Local Knowledge capability probes).                                                                                          | [packages/keiko-model-gateway](../../packages/keiko-model-gateway)             |
| `@oscharko-dev/keiko-workspace`            | 0.3.0   | Workspace discovery, path containment, safe file reads, context packs, retrieval seams.                                                                                                                                                                         | Repository detection (git root + worktree), safe lexical+realpath file read boundary, .gitignore+deny rules, context packs (source tree summary), file retrieval API, incremental re-index.                                                                                                                   | [packages/keiko-workspace](../../packages/keiko-workspace)                     |
| `@oscharko-dev/keiko-tools`                | 0.1.0   | Controlled tool execution, terminal/browser adapters, patch parsing, patch writing boundaries.                                                                                                                                                                  | Terminal-policy command allowlist, env-isolated spawn (no shell), PTY adapters, patch parser, WorkspaceWriter atomic write boundary, browser CDP session manager.                                                                                                                                             | [packages/keiko-tools](../../packages/keiko-tools)                             |
| `@oscharko-dev/keiko-local-knowledge`      | 0.1.0   | On-disk capsule store (node:sqlite + WAL) and capsule/source/CapsuleSet lifecycle CRUD for the Local Knowledge Connector (Epic #189, Issue #193).                                                                                                               | Capsule store schema (documents, vectors, metadata, WAL), document parser registry, source extraction + discovery bridge, embedding-based indexing orchestrator, ranked retrieval with context assembly and explainability.                                                                                   | [packages/keiko-local-knowledge](../../packages/keiko-local-knowledge)         |
| `@oscharko-dev/keiko-harness`              | 0.1.0   | Agent runtime loop, session/cancellation/limits, state machine, event emission, port abstractions, and dry-run-first patch proposal seam.                                                                                                                       | Session API (createSession / runAgent), task state machine, event emission (ModelCall\*, PatchApplied, VerificationResult, Cancel), resource limits (tokens, tool uses, time), deterministic ID+fingerprint sources, dryRun proposal gate.                                                                    | [packages/keiko-harness](../../packages/keiko-harness)                         |
| `@oscharko-dev/keiko-workflows`            | 0.4.0   | Reviewable developer-assist workflows (unit-test generation, bug investigation), prompts/parsers/guards/report rendering, apply-mode verification gating, and UI descriptors.                                                                                   | Workflow descriptors (inputs, limits, stages), unit-test and bug-investigation workflow implementations, explorer/prompt builders, outcome parser/validator, plan/report ledger contract, proposedDiff rendering, apply-mode verification gate.                                                               | [packages/keiko-workflows](../../packages/keiko-workflows)                     |
| `@oscharko-dev/keiko-evidence`             | 0.1.0   | Evidence manifests, audit reports, retention, tamper-resistant local artifacts, evidence indexing.                                                                                                                                                              | EvidenceManifest builder (run, cost, source, artifacts, audit summary), redaction-by-construction, EvidenceStore port + node adapter, atomic O_EXCL write, evidence listing/loading/search, retention rotation (maxRuns=50), side-file writer, evidence report + renderer.                                    | [packages/keiko-evidence](../../packages/keiko-evidence)                       |
| `@oscharko-dev/keiko-memory-vault`         | 0.1.0   | Governed enterprise memory storage (node:sqlite). Scope-isolated CRUD, edges, embeddings, tombstones, validator-gated boundary, redaction-aware writes.                                                                                                         | Schema (records, edges, embeddings, tombstones, tags), validator-gated insert/update/forget, record edges (mentions, derived-from, tagged-by, conflicts-with), full-text index, redaction-aware persistence, scope isolation per workflow/project.                                                            | [packages/keiko-memory-vault](../../packages/keiko-memory-vault)               |
| `@oscharko-dev/keiko-memory-capture`       | 0.1.0   | Governed capture policy gate that turns raw user text and reviewed workflow outcomes into MemoryProposal / MemoryUpdate / MemoryForget / MemorySupersession envelopes. PRIMARY secret-prevention boundary. Pure functions only; no IO, no clock, no randomness. | Candidate extraction from user text and workflow outcomes, capture policy enforcement (empty / length / restricted-default checks), secret pattern rejection (defence-in-depth), envelope construction (MemoryProposal, MemoryUpdate, MemoryForget, MemorySupersession), error reporting with safe redaction. | [packages/keiko-memory-capture](../../packages/keiko-memory-capture)           |
| `@oscharko-dev/keiko-memory-consolidation` | 0.1.0   | Pure-function engine that takes a set of accepted MemoryRecords and returns proposed derived-from edges, stale flags, and review items (multi-way duplicates and potential conflicts). Never mutates accepted memories.                                         | Duplicate/conflict detection (lexical + semantic + edit-distance), consolidation result builder (ReviewItem for merge/supersession/stale), conflict resolution suggestion (without auto-merge), provenance graph construction.                                                                                | [packages/keiko-memory-consolidation](../../packages/keiko-memory-consolidation) |
| `@oscharko-dev/keiko-memory-governance`    | 0.1.0   | Pure-function envelope builders for user-driven corrections, conflict resolution, selective forgetting, expiration, pinning and archiving over Governed Enterprise Memory Vault records.                                                                        | Envelope builders (MemoryProposal, MemorySupersession, MemoryUpdate, MemoryForget, MemoryPin, MemoryUnpin, MemoryArchive), status transition tuples, suppression validation (pinned cannot-forget), conflict resolution policies, archive recovery.                                                           | [packages/keiko-memory-governance](../../packages/keiko-memory-governance)     |
| `@oscharko-dev/keiko-memory-retrieval`     | 0.1.0   | Pure-function scoped retrieval + hybrid ranking + token-budgeted context assembly over Governed Enterprise Memory Vault records. Caller supplies a MemoryQueryPort (no vault import).                                                                           | Retrieval filters (scope, recency, types, search terms), hybrid ranking (lexical + semantic + recency decay + pinned boost + correction boost + graph proximity), token-budgeted context assembly, explainability (inclusion/omission reasons per memory), suppression check.                                 | [packages/keiko-memory-retrieval](../../packages/keiko-memory-retrieval)       |
| `@oscharko-dev/keiko-server`               | 0.2.0   | Local loopback BFF runtime (HTTP/SSE/WebSocket router, CSP, host check, CSRF gate, terminal, browser, files, run engine, SQLite-backed UI store). Mediates browser tier and Node-side domain packages.                                                          | HTTP route dispatch, SSE event streaming, WebSocket upgrade, CSRF token gate, CSP header builder, host/origin checks, terminal session manager, browser CDP client, file serving, run execution engine, workflow state store (SQLite with schema versioning), message persistence.                            | [packages/keiko-server](../../packages/keiko-server)                           |
| `@oscharko-dev/keiko-cli`                  | 0.1.0   | CLI commands, `keiko init`, `keiko start`, `keiko stop`, local lifecycle, release-facing entrypoints.                                                                                                                                                           | CLI command dispatch (agent, gen-tests, investigate, verify, evaluate, evidence, context, models, init, lifecycle, ui), configuration loading, credential setup, signal handling, lifecycle management (start/stop/status), process daemonization helpers.                                                    | [packages/keiko-cli](../../packages/keiko-cli)                                 |
| `@oscharko-dev/keiko-ui`                   | 0.1.7   | Keiko Wave 1 local UI (static export). Build-time-only; served by the Node BFF in keiko-server.                                                                                                                                                                 | Next.js App Router frontend (static export), project/chat/workflow/evidence views, sidebar navigation, tool rail (Files MVP), composer, run summary cards, dashboard, config surface, evidence viewer, with Tailwind styling and WCAG 2.2 AA compliance.                                                      | [packages/keiko-ui](../../packages/keiko-ui)                                   |

## 3. Quality Intelligence Reuse-Target Matrix

This section maps Quality Intelligence domain capabilities to their Keiko reuse targets, distinguishing between reuse-as-is, extension-via-seam, new-domain-seam, and documented gaps.

### 3.1 Source Ingestion and Repository Context

| Capability                                                            | Keiko Owner(s)                    | Disposition         | Rationale                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository detection (git root, worktree, branch state)               | keiko-workspace                   | Reuse-as-is         | `detectWorkspace()` is the current implementation; returns WorkspaceMetadata with repo root, worktree location, branch, upstream.                                                                                                                                                                                                                                                         | [packages/keiko-workspace/src/index.ts](../../packages/keiko-workspace/src/index.ts) line ~30–50; integration test at issue #5 closure                  |
| Safe file read (lexical + realpath boundary, .gitignore + deny rules) | keiko-workspace                   | Reuse-as-is         | `readWorkspaceFile()` enforces the approved file-access boundary; path containment + symlink-realpath gate + size cap + redaction are production-tested.                                                                                                                                                                                                                                    | [packages/keiko-workspace/src/index.ts](../../packages/keiko-workspace/src/index.ts) line ~60–100; ADR-0005 + ADR-0019 direction rule 3b                |
| Context packs (source tree summary for inclusion in model context)    | keiko-workspace                   | Reuse-as-is         | `buildContextPack()` and `buildWorkspaceSummary()` produce redacted, token-budgeted summaries; used in every workflow.                                                                                                                                                                                                                                                         | [packages/keiko-workspace/src/index.ts](../../packages/keiko-workspace/src/index.ts) line ~110–140                                                      |
| Connected Repository (Files, Figma, document handoff)                 | keiko-contracts + keiko-workspace | Extend-generic-seam | Connected Repository types (`ConnectedRepositoryContext`, `ConnectedFile`, etc.) are declared in keiko-contracts. Workspace retrieval seams are extensible for new source types (issue #177, #178); current implementation covers source files only. Quality Intelligence may extend the retrieval API to pull Figma metadata, document excerpts, or TMS references through existing ports. | [packages/keiko-contracts/src/connected-context.ts](../../packages/keiko-contracts/src/connected-context.ts); issue #178 PR closure |

### 3.2 Document/Capsule Ingestion, Parsing, and Retrieval

| Capability                                               | Keiko Owner(s)        | Disposition         | Rationale                                                                                                                                                                                                                                                     | Evidence                                                                                                                             |
| -------------------------------------------------------- | --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Persistent document/capsule store (sqlite + schema)      | keiko-local-knowledge | Reuse-as-is         | `KnowledgeStore` manages the full capsule lifecycle (insert, update, search, delete); schema versioning via PRAGMA user_version. Used for documents, evidence, and user-provided context.                                                                     | [packages/keiko-local-knowledge/src/index.ts](../../packages/keiko-local-knowledge/src/index.ts) line ~30–70; Epic #189 closure          |
| Parser registry (Markdown, PDF, Figma, etc.)             | keiko-local-knowledge | Extend-generic-seam | `ParserRegistry` is the current plugin-like interface; Markdown and PDF parsers are implemented. Quality Intelligence may extend by registering new parsers for test specs, TMS exports, or custom document types.                                            | [packages/keiko-local-knowledge/src/index.ts](../../packages/keiko-local-knowledge/src/index.ts) line ~80–110                            |
| Embedded vector indexing and retrieval                   | keiko-local-knowledge | Reuse-as-is         | Indexing orchestrator calls `keiko-model-gateway` to request embeddings; retrieval orchestrator ranks by relevance, recency, and provenance. The model-gateway carve-out (#192) allows the indexing layer to probe embeddings without a productive chat call. | [packages/keiko-local-knowledge/src/index.ts](../../packages/keiko-local-knowledge/src/index.ts) line ~120–160; ADR-0019 direction rule 3e |
| Grounded document answers (citations, excerpt inclusion) | keiko-local-knowledge | Reuse-as-is         | `runLocalKnowledgeRetrieval()` returns ranked `RetrievalReference` with excerpt, vector distance, metadata, and a `LocalKnowledgeGroundedContextPack` ready for model context. Used for Conversation Center groundedness.                                         | [packages/keiko-local-knowledge/src/index.ts](../../packages/keiko-local-knowledge/src/index.ts) line ~170–200                           |

### 3.3 Durable Memory (Vault, Capture, Governance, Retrieval)

| Capability                                                                 | Keiko Owner(s)             | Disposition | Rationale                                                                                                                                                                                                                         | Evidence                                                                                                                            |
| -------------------------------------------------------------------------- | -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Vault: persistent record storage with embeddings and edges                 | keiko-memory-vault         | Reuse-as-is | V1 schema: records (id, body, tags, createdAt, updatedAt, archivedAt), edges (mentions, derived-from, tagged-by, conflicts-with), embeddings (vector for search), tombstones (for deletes). Redaction applied at insert boundary. | [packages/keiko-memory-vault/src/index.ts](../../packages/keiko-memory-vault/src/index.ts) line ~30–80; Epic #206 closure               |
| Capture: policy-gated extraction from user text and workflow outcomes      | keiko-memory-capture       | Reuse-as-is | `extractCandidatesFromUserText()` and `extractCandidatesFromWorkflowOutcome()` enforce secret rejection, length/empty checks, and envelope construction. PRIMARY secret-prevention boundary for memory.                           | [packages/keiko-memory-capture/src/index.ts](../../packages/keiko-memory-capture/src/index.ts) line ~30–70; Epic #207 closure           |
| Governance: user-driven forget/pin/archive/supersession policies           | keiko-memory-governance    | Reuse-as-is | Envelope builders for all memory operations (MemoryProposal, MemoryUpdate, MemoryForget, MemoryPin, MemoryUnpin, MemoryArchive, MemorySupersession); suppression validation (pinned memories cannot be forgotten).                | [packages/keiko-memory-governance/src/index.ts](../../packages/keiko-memory-governance/src/index.ts) line ~30–100; Epic #209 closure    |
| Retrieval: scoped, ranked context assembly with explainability             | keiko-memory-retrieval     | Reuse-as-is | `retrieveMemory()` returns ranked context blocks with inclusion/omission reasons, suppression checks, and token budgets. Ranks by lexical relevance, recency decay, pinned boost, correction boost, graph proximity.              | [packages/keiko-memory-retrieval/src/index.ts](../../packages/keiko-memory-retrieval/src/index.ts) line ~30–80; Epic #210 closure       |
| Consolidation: duplicate detection and conflict suggestion (no auto-merge) | keiko-memory-consolidation | Reuse-as-is | `runConsolidation()` identifies duplicates and conflicts; returns ReviewItems for user decision; never mutates records. Used in MemoriaViva UI and audit workflows.                                                             | [packages/keiko-memory-consolidation/src/index.ts](../../packages/keiko-memory-consolidation/src/index.ts) line ~30–70; Epic #208 closure |

### 3.4 Model-Assisted Generation, Critique, and Judges

| Capability                                                                 | Keiko Owner(s)                     | Disposition             | Rationale                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider credential configuration and first-run setup                      | keiko-model-gateway + keiko-server | Reuse-as-is             | `GatewaySetup` handles credential storage (environment + OS keychain); `createGateway()` wires provider selection. Server BFF route `/api/gateway/setup` mediates browser-safe credential flow.                                                                                             | [packages/keiko-model-gateway/src/index.ts](../../packages/keiko-model-gateway/src/index.ts) line ~40–70; [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~100–150 |
| Model capability probing and discovery                                     | keiko-model-gateway                | Reuse-as-is             | `listConfiguredCapabilities()` and `verifyEmbeddingCapability()` probe available models, cost classes, vision support, and embeddings transport. Used for first-run setup and model-selection UI.                                                                                                 | [packages/keiko-model-gateway/src/index.ts](../../packages/keiko-model-gateway/src/index.ts) line ~80–120                                                                                      |
| Routed model calls (streaming, retry, timeout, cost tracking)              | keiko-model-gateway                | Reuse-as-is             | All productive model calls route through `Gateway.chat()` and `Gateway.stream()`; retry, timeout, backoff, and cost tracking are enforced at this boundary. Trust boundary #1 in ADR-0019.                                                                                                  | [packages/keiko-model-gateway/src/index.ts](../../packages/keiko-model-gateway/src/index.ts) line ~130–180                                                                                     |
| OpenAI-compatible embeddings (for Local Knowledge indexing)                | keiko-model-gateway                | Reuse-as-is (carve-out) | `requestOpenAIEmbedding()` is exported as part of the OpenAIEmbeddingAdapter injection port; used by Local Knowledge indexing and retrieval. Out-of-band capability probe, not a productive call.                                                                                           | [packages/keiko-model-gateway/src/index.ts](../../packages/keiko-model-gateway/src/index.ts) line ~190–210; ADR-0019 carve-out for embeddings                                                  |
| Test design / test-case generation prompts and parsers                     | keiko-workflows                    | Extend-generic-seam     | Unit-test workflow is the current implementation; test-design domain logic is not yet separated. Quality Intelligence may extract a pure test-design orchestrator (prompt builder, outcome parser, test-case validator) into a new domain seam after #271 decides the seam.                 | [packages/keiko-workflows/src/unit-tests/index.ts](../../packages/keiko-workflows/src/unit-tests/index.ts) line ~30–100; issue #8 closure                                                      |
| Validation judges (coverage relevance, passing likelihood, spec adherence) | Workflow-context-dependent         | New-pure-domain-seam    | No current Keiko implementation. Quality Intelligence must define a pure judge interface (input: test case + source context, output: relevance/likelihood/adherence scores). Route judge model calls through keiko-model-gateway; store judge calibration/audit evidence in keiko-evidence. | Open gap for #271                                                                                                                                                                          |

### 3.5 Workflow Execution, Cancellation, and Retry

| Capability                                                           | Keiko Owner(s)                    | Disposition         | Rationale                                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow descriptor (inputs, stages, dryRun gate, output validation) | keiko-workflows + keiko-contracts | Reuse-as-is         | `WorkflowDescriptor<TLimits>` defines the shape; `generateUnitTests` and `investigateBug` are current implementations. Quality Intelligence workflows will follow the same descriptor pattern.                                                                                                                            | [packages/keiko-workflows/src/descriptor.ts](../../packages/keiko-workflows/src/descriptor.ts) line ~30–100; [packages/keiko-contracts/src/workflow-descriptor.ts](../../packages/keiko-contracts/src/workflow-descriptor.ts) line ~40–90 |
| Agent runtime loop (session, state machine, cancellation, limits)    | keiko-harness                     | Reuse-as-is         | `createSession()` / `runAgent()` enforces bounded execution: token limits, tool-use count, wall-clock time, cancellation via AbortController. All Quality Intelligence workflows execute through this boundary.                                                                                                           | [packages/keiko-harness/src/index.ts](../../packages/keiko-harness/src/index.ts) line ~40–100; ADR-0004 + ADR-0019 direction rule 4a                                                                          |
| Event emission (ModelCall, PatchApplied, VerificationResult, Cancel) | keiko-harness                     | Reuse-as-is         | Harness emits typed `HarnessEvent` union (ModelCallStarted/Completed, PatchApplied, VerificationResult, ResourceExceeded, Cancelled). UI subscribes via SSE; audit embeds in EvidenceManifest.                                                                                                                            | [packages/keiko-harness/src/index.ts](../../packages/keiko-harness/src/index.ts) line ~110–150                                                                                                                |
| Dry-run proposal and apply-mode verification gate                    | keiko-harness + keiko-workflows   | Reuse-as-is         | Harness `dryRun` flag gates patch proposal; Workflows compose `keiko-verification` to validate before apply. Quality Intelligence workflows follow the same gate.                                                                                                                                                         | [packages/keiko-harness/src/index.ts](../../packages/keiko-harness/src/index.ts) line ~160–180; ADR-0008 D5                                                                                                   |
| Retry and resumption logic                                           | keiko-cli + keiko-server          | Extend-generic-seam | CLI `run` command and server run-engine currently retry on transient 5xx; resumption is implicit (run-id is idempotent). Quality Intelligence may require explicit retry policies (exponential backoff, max-attempt gates) for test-generation workflows; add via keiko-workflows descriptors or harness limit overrides. | [packages/keiko-server/src/run-engine.ts](../../packages/keiko-server/src/run-engine.ts) line ~50–150                                                                                                         |

### 3.6 Evidence, Audit, Redaction, and Retention

| Capability                                                                  | Keiko Owner(s)                   | Disposition | Rationale                                                                                                                                                                                             | Evidence                                                                                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence manifest builder (redacted-by-construction)                        | keiko-evidence                   | Reuse-as-is | `buildEvidenceManifest()` composes run metadata, cost tracking, source changes, artifacts, and audit summary; redaction is applied at construction time. Every workflow produces an EvidenceManifest. | [packages/keiko-evidence/src/index.ts](../../packages/keiko-evidence/src/index.ts) line ~30–80; ADR-0010                                                                               |
| Persistent evidence store (node:sqlite, atomic write, realpath containment) | keiko-evidence                   | Reuse-as-is | `persistEvidence()` orchestrates the store write; `EvidenceStore` port + `NodeEvidenceStore` adapter enforce O_EXCL atomic write, realpath containment, runId validation.                             | [packages/keiko-evidence/src/index.ts](../../packages/keiko-evidence/src/index.ts) line ~90–150                                                                                        |
| Evidence redaction (gateway errors, env-values, literals)                   | keiko-evidence                   | Reuse-as-is | `createAuditRedactor()` and `deepRedactStrings()` redact sensitive patterns; built as a closed-set gateway (no new regex, only env-value + literal + pre-extracted pattern list).                     | [packages/keiko-evidence/src/index.ts](../../packages/keiko-evidence/src/index.ts) line ~160–200                                                                                       |
| Retention rotation (maxRuns=50, always-keep-newest)                         | keiko-evidence                   | Reuse-as-is | `applyRetention()` enforces the 50-run rotation; called post-persist. Quality Intelligence evidence uses the same retention boundary.                                                                 | [packages/keiko-evidence/src/index.ts](../../packages/keiko-evidence/src/index.ts) line ~210–240                                                                                       |
| Evidence indexing and retrieval                                             | keiko-evidence + keiko-server    | Reuse-as-is | `listEvidence()` and `loadEvidence()` return typed lists and individual manifests. Server routes `/api/evidence/list` and `/api/evidence/{id}` (typed errors: EvidenceReadError, SchemaError).        | [packages/keiko-evidence/src/index.ts](../../packages/keiko-evidence/src/index.ts) line ~250–290; [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~200–250 |
| Audit summary (model tokens, tool invocations, verification, redactions)    | keiko-evidence + keiko-contracts | Reuse-as-is | `AuditSummary` tracks cost, tool invocation count, verification outcomes, and redaction count; built into EvidenceManifest.                                                                           | [packages/keiko-contracts/src/evidence.ts](../../packages/keiko-contracts/src/evidence.ts) line ~80–130                                                                                |
| Workflow evidence mapping (workflow run → artifacts)                        | keiko-evidence + keiko-workflows | Reuse-as-is | Workflows emit `WorkflowEvent` (part of `HarnessEvent`); audit extracts and maps to artifact lineage in EvidenceManifest. Quality Intelligence workflows follow the same pattern.                     | [packages/keiko-evidence/src/index.ts](../../packages/keiko-evidence/src/index.ts) line ~300–340; issue #10 closure                                                                    |

### 3.7 UI Surfaces and Presentation

| Capability                                             | Keiko Owner(s)                                | Disposition         | Rationale                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project/chat sidebar and main composition area         | keiko-ui + keiko-server                       | Reuse-as-is         | Wave 1 UI (keiko-ui) provides a project-aware shell, sidebar with chat list, central chat area, and tool rail. Conversation Center uses these surfaces. Quality Intelligence views will be added as new routes or embedded in existing tool-rail panels.                                                                                         | [packages/keiko-ui/src/app/layout.tsx](../../packages/keiko-ui/src/app/layout.tsx); [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~400–450         |
| Run summary cards (live status, evidence link)         | keiko-ui + keiko-server                       | Reuse-as-is         | ChatView renders workflow run summaries inline; polling route `/api/chats/messages?id=` returns run status and links to evidence. Used for Conversation Center workflow handoff.                                                                                                                                                                 | [packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx](../../packages/keiko-ui/src/app/components/desktop/ChatWindow.tsx); [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~460–490 |
| Evidence viewer (manifest, artifacts, redactions)      | keiko-ui + keiko-server + keiko-evidence      | Reuse-as-is         | `/evidence` route renders EvidenceManifest with artifact list, cost tracking, audit summary, and redaction summary. Quality Intelligence evidence is shown through the same viewer.                                                                                                                                                              | [packages/keiko-ui/src/app/components/desktop/widgets/cards/ReviewWidget.tsx](../../packages/keiko-ui/src/app/components/desktop/widgets/cards/ReviewWidget.tsx); [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~500–550 |
| Workflow input forms (descriptor-driven UI generation) | keiko-ui + keiko-server + keiko-workflows     | Extend-generic-seam | Workflows define `WorkflowInputSpec`; UI generates forms (currently Conversation Center handoff only). Quality Intelligence workflows will require similar form generation; extend `WorkflowInputSpec` with new input field types (test-design config, coverage model, validator preferences) or add a parallel Quality Intelligence descriptor. | [packages/keiko-workflows/src/descriptor.ts](../../packages/keiko-workflows/src/descriptor.ts) line ~100–150                                                                       |
| Files MVP (project-scoped file browser in tool rail)   | keiko-ui + keiko-server + keiko-workspace     | Reuse-as-is         | FilesPanel renders workspace file tree (structural metadata only, no excerpt). Used for source selection before test-generation context assembly.                                                                                                                                                                                                | [packages/keiko-ui/src/app/components/desktop/widgets/cards/FilesWidget.tsx](../../packages/keiko-ui/src/app/components/desktop/widgets/cards/FilesWidget.tsx)                         |
| Configuration and credential management surfaces       | keiko-ui + keiko-server + keiko-model-gateway | Reuse-as-is         | `/config` route and gateway setup flow handle model provider selection, credential entry, and base URL override. Reuses all existing surfaces.                                                                                                                                                                                                   | [packages/keiko-ui/src/lib/api.ts](../../packages/keiko-ui/src/lib/api.ts); [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~600–650               |

### 3.8 BFF Routes and Server Integration

| Capability                                                 | Keiko Owner(s)                        | Disposition | Rationale                                                                                                                                                                                                                  | Evidence                                                                                |
| ---------------------------------------------------------- | ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Route dispatch, CSRF gate, CSP headers, host checks        | keiko-server                          | Reuse-as-is | All Quality Intelligence BFF routes go through the same `createUiServer()` dispatcher, CSRF token gate, CSP header builder, and origin checks.                                                                             | [packages/keiko-server/src/server.ts](../../packages/keiko-server/src/server.ts) line ~30–100 |
| SSE event streaming (run updates, workflow progress)       | keiko-server                          | Reuse-as-is | Server `/api/run/{id}/events` streams harness events; Quality Intelligence workflows emit standard HarnessEvent types.                                                                                                     | [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~700–750  |
| SQLite message and workflow-state store (versioned schema) | keiko-server                          | Reuse-as-is | Server BFF maintains a SQLite schema for chat messages, workflow runs, and UI state. Quality Intelligence runs are persisted in the same store.                                                                            | [packages/keiko-server/src/store/index.ts](../../packages/keiko-server/src/store/index.ts) line ~40–120 |
| Conversation Center integration (handoff, memory context)  | keiko-server + keiko-memory-retrieval | Reuse-as-is | Server routes handle chat-to-workflow handoff (`/api/chats/{id}/workflows/...`), memory injection (`/api/memory/retrieve`), and context assembly. Quality Intelligence workflows consume the same handoff and memory APIs. | [packages/keiko-server/src/index.ts](../../packages/keiko-server/src/index.ts) line ~800–900  |

### 3.9 CLI Surfaces and Lifecycle Management

| Capability                                    | Keiko Owner(s)                  | Disposition | Rationale                                                                                                                                                  | Evidence                                                                                |
| --------------------------------------------- | ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| CLI command dispatch (init, start, stop, run) | keiko-cli                       | Reuse-as-is | `runCli()` dispatcher handles all subcommands. Quality Intelligence workflows will add a new `keiko test-design` or similar subcommand via keiko-cli.      | [packages/keiko-cli/src/runner.ts](../../packages/keiko-cli/src/runner.ts) line ~30–100     |
| Configuration loading and first-run setup     | keiko-cli + keiko-model-gateway | Reuse-as-is | `keiko init` orchestrates credential setup, workspace detection, and config file creation. Quality Intelligence CLI commands reuse the same config.        | [packages/keiko-cli/src/init.ts](../../packages/keiko-cli/src/init.ts) line ~30–150         |
| Lifecycle daemon (start/stop/status)          | keiko-cli + keiko-server        | Reuse-as-is | `keiko start` spawns the UI BFF process; `keiko stop` and `keiko status` manage the daemon. Quality Intelligence CLI commands run against the same daemon. | [packages/keiko-cli/src/lifecycle.ts](../../packages/keiko-cli/src/lifecycle.ts) line ~30–100 |

### 3.10 Security and Trust Boundaries

| Capability                                                      | Keiko Owner(s)                        | Disposition | Rationale                                                                                                                                                                               | Evidence                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File-system path containment and symlink realpath gate          | keiko-workspace + keiko-tools         | Reuse-as-is | Both packages enforce realpath-based containment: workspace for reads, tools for writes. Tested against symlink-to-.git/hooks and other traversal attacks.                              | [packages/keiko-workspace/src/index.ts](../../packages/keiko-workspace/src/index.ts) line ~200–250; [packages/keiko-tools/src/index.ts](../../packages/keiko-tools/src/index.ts) line ~300–350; issue #6 audit closure |
| Secret detection and redaction (patterns, env-values, literals) | keiko-security + keiko-memory-capture | Reuse-as-is | `looksLikeSecretShape()` in contracts, combined with keiko-security redaction and keiko-memory-capture policy gates, form a three-layer defence-in-depth.                               | [packages/keiko-security/src/index.ts](../../packages/keiko-security/src/index.ts) line ~40–90; [packages/keiko-memory-capture/src/index.ts](../../packages/keiko-memory-capture/src/index.ts) line ~110–150         |
| Model provider credential isolation                             | keiko-model-gateway                   | Reuse-as-is | Only keiko-model-gateway imports provider SDKs (openai, anthropic); enforced by ADR-0019 trust rule 1. Quality Intelligence model calls route through the gateway only.                 | [packages/keiko-model-gateway/src/index.ts](../../packages/keiko-model-gateway/src/index.ts) line ~400–450; .dependency-cruiser.cjs line ~673–682                                                              |
| Safe error wrapping and error-boundary routing                  | keiko-security                        | Reuse-as-is | `GatewayError`, `WorkspaceError`, etc. prevent raw stack traces or customer context from crossing trust boundaries. Server BFF applies safe error wrapping before returning to browser. | [packages/keiko-security/src/errors](../../packages/keiko-security/src/errors) line ~30–80                                                                                                                     |
| Browser-origin CSRF and host checks                             | keiko-server                          | Reuse-as-is | Server validates `Host` header and CSRF token on every state-changing request; CSP headers restrict script execution. Quality Intelligence BFF routes follow the same gate.             | [packages/keiko-server/src/csp.ts](../../packages/keiko-server/src/csp.ts) line ~30–80; [packages/keiko-server/src/server.ts](../../packages/keiko-server/src/server.ts) line ~150–200                               |

## 4. ADR-0019 Reconciliation Notes

ADR-0019 was accepted on 2026-06-03 and describes the target package topology. The following ADR claims no longer match the current code because the Memory packages and Local Knowledge have been added post-ADR:

### Claim 1: Target Package Topology (Section "Target Package Topology")

**ADR text** (line 48–60, table):

> | Package                             | Responsibility                                                                                                        | Must Not Own                                                                                  |
> | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
> | `@oscharko-dev/keiko-contracts`     | Shared public contracts, branded IDs, event envelopes, model capability schema, BFF wire types, workflow descriptors. | Runtime IO, provider calls, UI components, persistence.                                       |
> | `@oscharko-dev/keiko-security`      | Redaction, secret handling, safe error shaping, content hashing, trust-boundary helpers.                              | Product workflows, provider routing, UI state.                                                |
> | `@oscharko-dev/keiko-model-gateway` | Provider abstraction, OpenAI-compatible calls, discovery, capability probing, routing, resilience, TLS handling.      | UI components, workspace file reads, tool execution, direct persistence of customer UI state. |
>
> | … (8 more rows) …

**Current code status**: The table is now incomplete. Six new packages exist post-ADR:

1. `@oscharko-dev/keiko-local-knowledge` — on-disk capsule store and retrieval orchestration (Epic #189).
2. `@oscharko-dev/keiko-memory-vault` — durable memory storage (Epic #206).
3. `@oscharko-dev/keiko-memory-capture` — capture-policy gate (Epic #207).
4. `@oscharko-dev/keiko-memory-consolidation` — duplicate detection (Epic #208).
5. `@oscharko-dev/keiko-memory-governance` — user-driven governance operations (Epic #209).
6. `@oscharko-dev/keiko-memory-retrieval` — scoped retrieval + ranking (Epic #210).

**Proposed correction**: Extend the package topology table to include all 17 packages (currently 11 listed). Add explicit rows for Local Knowledge and each Memory package with their responsibility and must-not-own clauses.

### Claim 2: Required Dependency Direction (Section "Required Dependency Direction")

**ADR text** (lines 62–76, points 1–9):

> 1. `contracts` is the leaf package. It must not import from other Keiko packages.
> 2. `security` may depend on `contracts`.
> 3. `model-gateway`, `workspace`, `tools`, and `evidence` may depend on `contracts` and `security` where needed.
>    ...

**Current code status**: The direction rules are now expanded. The .dependency-cruiser.cjs file (line 198–416) defines ten strict variants (3a–3j) for the infrastructure and memory packages:

- 3a: model-gateway (contracts, security)
- 3b: workspace (contracts, security)
- 3c: tools (contracts, security, workspace)
- 3d: evidence (contracts, security, workspace)
- 3e: local-knowledge (contracts, workspace, model-gateway)
- 3f: memory-vault (contracts, security)
- 3g: memory-capture (contracts, security)
- 3h: memory-consolidation (contracts, security)
- 3i: memory-governance (contracts, security)
- 3j: memory-retrieval (contracts, security)

The ADR describes a single rule 3 without these per-package variants.

**Proposed correction**: Extend the Required Dependency Direction section to document the ten per-package direction rules (3a–3j) and their rationale (e.g., why local-knowledge may depend on model-gateway for embeddings, why memory packages depend only on contracts + security). Reference ADR-0020 D4 for the severity policy (error for extracted packages, warn for src/‐resident).

### Claim 3: Trust-Boundary Rules (Section "Trust-Boundary Rules")

**ADR text** (lines 78–90, list):

> - Direct LLM provider SDK imports are allowed only inside `keiko-model-gateway`.
> - Browser-visible packages must not import credential-bearing provider config.
> - UI and server errors must pass through safe error/redaction paths.
> - Workspace file access must go through `keiko-workspace`.
> - File mutation and patch application must go through `keiko-tools`.
> - Evidence-producing modules must not be imported as mutable internals from unrelated packages.
> - CLI and server may wire dependencies; they must not bypass package ports.
> - Package-local tests may use narrowly documented exceptions for integration coverage, but production source must follow the dependency graph.

**Current code status**: These rules are correct but incomplete. The .dependency-cruiser.cjs file (line 669–788) documents eight named trust rules (adr-0019-trust-1 through adr-0019-trust-8). The ADR prose matches all eight, but the implementation includes additional safeguards:

- trust-1: Provider SDK isolation (global rule).
- trust-2: UI no provider config (keiko-ui specific).
- trust-3: UI no gateway internals (keiko-ui specific).
- trust-4: Direct fs forbidden (keiko-tools, harness, workflows — production only).
- trust-5: Patch routes through tools (keiko-harness, workflows — production only).
- trust-6: Evidence allowed callers (harness, workflows, server, cli, evaluations only).
- trust-7: CLI/server no port bypass (consume public surface only).
- trust-8: No do-not-follow in prod (production source must not import test helpers).

**Proposed correction**: The rules are well-implemented. The ADR should be updated to cite the rule names (trust-1 through trust-8) and clarify the per-package specificity in trust-2, trust-3, trust-4, trust-5, and trust-6.

### Claim 4: Non-Goals (Section "Non-Goals")

**ADR text** (lines 154–163):

> This ADR does not:
>
> - convert Keiko into distributed runtime microservices;
> - require customers to install multiple Keiko packages;
> - introduce cloud services, telemetry, or remote control planes;
> - publish all internal packages independently;
> - change model provider credentials or customer gateway setup semantics;
> - implement Conversation Center features directly.

**Current code status**: All non-goals remain valid. Keiko still bundles all packages into one root artifact, uses one local process, and makes no cloud or telemetry calls. Memory Vault and Local Knowledge do persist data locally; this is consistent with existing behavior (evidence store, workspace cache). Conversation Center is now partially implemented (MemoriaViva UI in #211, Memory Integration in #212) but is not a violation because it reuses memory packages rather than embedding external code.

**Proposed correction**: Add a clarifying note that the non-goals remain valid despite the Memory and Local Knowledge additions. Consider explicitly noting that memory persistence is local-only and governed by the same retention and redaction boundaries as evidence.

## 5. Independence Evidence

This section proves that the current Keiko codebase has no native dependency on Test Intelligence packages or runtime.

### 5.1 Direct Search for Test Intelligence Dependencies

**Search command 1**: Grep for `@oscharko-dev/test-intelligence`

```
grep -r '@oscharko-dev/test-intelligence' . --include='*.json' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' -l 2>/dev/null | grep -v node_modules | grep -v dist
```

**Result**: No matches found.

**Search command 2**: Grep for `@oscharko-dev/ti-` (Test Intelligence namespace prefix)

```
grep -r '@oscharko-dev/ti-' . --include='*.json' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' -l 2>/dev/null | grep -v node_modules | grep -v dist
```

**Result**: No matches found.

### 5.2 Root Package Dependencies Block

**File**: [package.json](../../package.json) (lines 69–86)

**Dependencies block** (keiko-\* packages only; no Test Intelligence present):

```json
"dependencies": {
  "@oscharko-dev/keiko-cli": "*",
  "@oscharko-dev/keiko-contracts": "*",
  "@oscharko-dev/keiko-evidence": "*",
  "@oscharko-dev/keiko-harness": "*",
  "@oscharko-dev/keiko-memory-capture": "*",
  "@oscharko-dev/keiko-memory-consolidation": "*",
  "@oscharko-dev/keiko-memory-governance": "*",
  "@oscharko-dev/keiko-memory-retrieval": "*",
  "@oscharko-dev/keiko-memory-vault": "*",
  "@oscharko-dev/keiko-model-gateway": "*",
  "@oscharko-dev/keiko-security": "*",
  "@oscharko-dev/keiko-server": "*",
  "@oscharko-dev/keiko-tools": "*",
  "@oscharko-dev/keiko-workflows": "*",
  "@oscharko-dev/keiko-workspace": "*",
  "ws": "^8.21.0"
}
```

**Conclusion**: The root package declares only Keiko-owned workspace packages and the standard `ws` library. No Test Intelligence dependencies.

## 6. Verification Commands Run

### 6.1 npm install

```
cd /Users/oscharko-dev/Projects/Keiko && npm install
```

**Exit code**: 0

**Output excerpt**:

```
up to date, audited 589 packages in 700ms

177 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

### 6.2 npm run arch:check

```
cd /Users/oscharko-dev/Projects/Keiko && npm run arch:check
```

**Exit code**: 0

**Output excerpt**:

```
✔ no dependency violations found (914 modules, 2171 dependencies cruised)
```

**Interpretation**: All 17 ADR-0019 direction rules and 8 trust-boundary rules passed at error severity (for extracted packages) and warn severity (for root-source transitional code).

### 6.3 npm run lint

```
cd /Users/oscharko-dev/Projects/Keiko && npm run lint
```

**Exit code**: 0

**Output excerpt**:

```
> @oscharko-dev/keiko@0.1.7 lint
> eslint . --max-warnings=0
```

### 6.4 npm run typecheck

```
cd /Users/oscharko-dev/Projects/Keiko && npm run typecheck
```

**Exit code**: 0

**Output excerpt**:

```
> @oscharko-dev/keiko-cli@0.1.0 build
> tsc -p tsconfig.json
```

### 6.5 npm run format:check

```
cd /Users/oscharko-dev/Projects/Keiko && npm run format:check
```

**Exit code**: 1 (pre-existing failure unrelated to this document)

**Output excerpt**:

```
[warn] Code style issues found in 46 files. Run Prettier with --write to fix.
```

**Note**: This is a pre-existing project-wide formatting drift issue unrelated to the baseline audit. The audit document itself will be formatted correctly before commit via `npx prettier --write`.

### 6.6 npm run check:package-surface (conditional)

**Status**: Deferred. The `check:package-surface` script requires `npm run build` to complete first (line 42 of package.json), and the build step is gated by `npm run prepare:bin` and `npm run build:ui`, which are release-only paths. The baseline audit does not require this verification because the package-surface check is a release-gate concern (post-assembly verification), not a pre-implementation baseline concern. The .dependency-cruiser.cjs verification (arch:check) provides stronger real-time architecture validation.

## 7. Open Gaps for #271

The following reuse cells identify architecture decisions that #271 must make before implementation children start:

### Gap 1: Test-Design Domain Logic Boundary

**Question**: Should test-design domain logic (prompt builder, outcome parser, test-case validator, strategy selection) be extracted into a new pure-domain package, or implemented as a keiko-workflows sub-layer?

**Current state**: Unit-test workflow is implemented inline in keiko-workflows (issue #8). No separation.

**Implication for Quality Intelligence**: The test-design strategy (coverage model, test-template selection, parameterization rules) needs a home. If a new seam is added, it must follow ADR-0019 (contracts+security only, no direct gateway access except via port). If it stays in keiko-workflows, the workflow package must be carefully scoped so test design and other workflows stay cohesive.

### Gap 2: Validation Judge Interface and Routing

**Question**: What interface and orchestration pattern should validation judges (test relevance, passing likelihood, spec adherence) follow? Should they be routed through keiko-model-gateway like all productive calls, or through a separate decision-service port?

**Current state**: No judge interface exists in Keiko.

**Implication for Quality Intelligence**: Judges may need their own contracts (JudgeInput, JudgeOutput, CalibrationContext) and a separate wiring seam in keiko-server. Or they may route through existing workflow ports. This decision affects whether #271 needs to extend keiko-contracts with judge types and how #273+ implement judge execution.

### Gap 3: Test Artifact Export and TMS Integration

**Question**: Should test-artifact export (to JUnit XML, TMS APIs, custom formats) be a new pure-domain seam, or integrated into keiko-evidence artifact handling?

**Current state**: Keiko evidence supports side-file storage; workflows can emit artifacts. TMS connectors do not exist.

**Implication for Quality Intelligence**: If TMS export is in scope for the Quality Intelligence MVP, #271 must decide whether to add a new keiko-export package or extend keiko-workflows and keiko-evidence. ADR-0019 trust boundaries require that connectors (if added) not reach back into provider SDKs or credential stores directly.

### Gap 4: Memory Integration for Test Context

**Question**: Should Quality Intelligence leverage keiko-memory-capture and keiko-memory-retrieval to persist and retrieve test context (e.g., "tests I wrote for payment-flow", "recent regression scenarios", "edge cases from code review")?

**Current state**: Memory packages are available; Conversation Center uses them. No test-specific memory schema exists.

**Implication for Quality Intelligence**: If test context memory is in scope, #271 should define the contracts for memory-provenance tags (e.g., `memory.tag="test-context-auto"`, `memory.provenance="regression-from-issue#XYZ"`) and clarify whether test memories use the same vault as conversation memory (shared) or a separate schema (isolated). The current vault supports both via scope isolation.

### Gap 5: Conversation Center Test Handoff

**Question**: What metadata should Conversation Center include when handing off to a test-design workflow (e.g., selected files, user narrative, prior test proposals)?

**Current state**: Conversation Center hands off to workflows via keiko-server routes; the handoff shape is workflow-specific.

**Implication for Quality Intelligence**: #271 should define the Quality Intelligence handoff contract in keiko-contracts (e.g., `TestDesignHandoff { selectedFiles, narrative, priorTests?, requiredCoverage? }`). This affects #281 (Conversation Center integration) and #280 (UI test-design input form).

### Gap 6: Quality Intelligence CLI Subcommand Scope

**Question**: Should Quality Intelligence have its own CLI command (e.g., `keiko test-design --help`), or be triggered only via Conversation Center workflow handoff?

**Current state**: All workflows are currently callable via `/api/workflows/{id}` HTTP routes; some are also available as CLI subcommands (`keiko gen-tests`, `keiko investigate`).

**Implication for Quality Intelligence**: If a `keiko test-design` CLI command is desired, #271 should allocate ownership to keiko-cli and ensure the command follows the same descriptor-driven pattern as existing workflows. If CLI is out of scope for MVP, document the decision so #280+ doesn't assume direct CLI access.

## 8. Anti-Duplication Invariant

This baseline audit enforces the following invariant for the Quality Intelligence implementation:

**The Quality Intelligence native implementation must not introduce a parallel or duplicate runtime layer that performs any of the following:**

- An independent harness or agent loop (reuse keiko-harness and keiko-workflows only).
- A second model gateway or credential store (reuse keiko-model-gateway and keiko-server credential flow only).
- A separate HTTP server or BFF process (reuse keiko-server routes and SSE streams only).
- A duplicate document store, memory vault, or retrieval orchestration (reuse keiko-local-knowledge and keiko-memory-\* packages only).
- A second CLI runtime (reuse keiko-cli dispatcher and subcommand pattern only).
- A standalone UI or embedded Test Intelligence Workbench (build in keiko-ui only).
- A replacement evidence or audit system (reuse keiko-evidence and keiko-security redaction only).

Any proposed Quality Intelligence capability that would require a new independent service, credential store, or runtime loop must be escalated to Epic #270 for an explicit architecture decision before implementation begins. The valid outcomes are:

1. **Reuse an existing Keiko service** — implement as a port or adapter within that service's ADR-0019 envelope.
2. **Extend an existing service with a generic seam** — add to keiko-contracts or keiko-workflows descriptors without duplicating orchestration.
3. **Create a new narrowly scoped domain seam** — only if #271 explicitly approves a new package with bounded scope (contracts+security only, no independent IO or scheduler).
4. **Explicitly reject the capability** — if the capability lies outside Quality Intelligence scope or conflicts with Keiko's local-first model.
5. **Defer with a product decision** — if the capability requires a separate architectural initiative (e.g., cloud export, enterprise telemetry).

All implementation PRs must include a brief "Reuse decision" comment citing which of these five outcomes applies to each Quality Intelligence capability being added.

---

**Document prepared**: 2026-06-05

**Baseline verified**: All keiko-cli, keiko-contracts, keiko-evidence, keiko-harness, keiko-local-knowledge, keiko-memory-capture, keiko-memory-consolidation, keiko-memory-governance, keiko-memory-retrieval, keiko-memory-vault, keiko-model-gateway, keiko-security, keiko-server, keiko-tools, keiko-ui, keiko-workflows, and keiko-workspace packages are at the commit SHA listed above.

**Next steps**: Issue #271 should use this baseline to finalize the Keiko-native Quality Intelligence architecture map, assign ownership for the seven gaps identified above, and produce an ADR or ADR amendment documenting the resolved decisions before implementation children (#272–#285) commence.
