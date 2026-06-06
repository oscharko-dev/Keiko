# Test Intelligence Reference Behavior Inventory for Quality Intelligence Migration

**Document Purpose:** This inventory classifies Test Intelligence capabilities as behavioral references and parity targets for native Keiko Quality Intelligence implementation. It documents defects and unsafe defaults that must be filtered during migration. Test Intelligence is treated as a reference product and parity target, not as a codebase to paste into Keiko. No code, no fixture, and no dependency may be copied into Keiko without the sanitization and conversion steps documented here.

**Reference Identity**

- **Repository:** `oscharko-dev/test-intelligence` (GitHub; local path `/Users/oscharko-dev/Projects/test-intelligence`)
- **Branch:** `dev`
- **Commit:** `0ffeab80c045ac06b5ac6cb4c1f6bec03226b392`
- **Inventory Date:** 2026-06-05

---

## 1. Per-Package Migration Inventory

### 1.1 `@oscharko-dev/ti-contracts`

**Purpose:** Public contract surface: branded IDs (AgentRoleProfileId, JobId, LessonId, EvidenceArtifactId, RoleStepId), version constants, test-intelligence mode enumerations, and principal-bound credentials for review and transfer operations.

**Capabilities**

- Branded ID type system with validation (AgentRoleProfileId, JobId, LessonId, EvidenceArtifactId, RoleStepId, max role-lineage depth 8).
- Contract version (1.39.0) and generated test-case schema version (1.4.0).
- Mode enumeration: `deterministic_llm`, `offline_eval`.
- TestIntelligenceReviewPrincipal and TestIntelligenceTransferPrincipal credential schemas (bearer token + principalId bound to review/transfer operations).
- Allowed test-case polarity values (positive, negative, boundary, validation, navigation, accessibility).

**Migration Decision**

| Capability                                                 | Decision                | Keiko Target                                                              | Why                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Branded ID type system                                     | port behavior           | keiko-contracts or keiko-quality-intelligence domain seam                 | TI's branded ID pattern is proven for audit lineage; Keiko must adapt ID scheme to Quality Intelligence with similar rigor.                |
| Contract versioning                                        | port behavior           | keiko-contracts                                                           | Established pattern; Keiko contracts already version GENERATED_TEST_CASE_SCHEMA_VERSION; reuse the same approach.                          |
| Mode enumeration (deterministic_llm, offline_eval)         | port behavior           | keiko-quality-intelligence domain seam                                    | Keiko must distinguish online vs offline generation; TI's enum is the reference.                                                           |
| TestIntelligenceReviewPrincipal schema                     | generic Keiko extension | keiko-review (if approval gate becomes shared) or native Keiko governance | Four-eyes review is a product feature; schema must adapt to Keiko's Model Gateway and Harness event contracts.                             |
| TestIntelligenceTransferPrincipal schema                   | reject runtime          | —                                                                         | TMS transfer is out of scope for native #363; deferred to #283. Standalone credential binding is an integration detail, not a core domain. |
| Polarity enumerations (positive, negative, boundary, etc.) | port behavior           | keiko-quality-intelligence domain seam                                    | Test case polarity is semantically sound; reimplement in Keiko's test-design model.                                                        |

---

### 1.2 `@oscharko-dev/ti-core-engine`

**Purpose:** Domain logic: intent derivation, reconciliation, test-design model, test-case classification, coverage relevance calculation, deduplication, validation schemas, workflow state machine, Figma payload normalization, and benchmark/adversarial fixtures.

**Capabilities**

- Intent derivation and delta computation (derives user intent from source context).
- Reconciliation engine (harmonizes conflicting test-case suggestions).
- Test-design model (test-case schema, generation heuristics, field-lifecycle transitions).
- Test-case classification (polarity, coverage tier, risk tier).
- Coverage relevance calculation (maps test cases to coverage goals and domain rules).
- Test-case deduplication and duplicate detection.
- Equivalence-class fingerprinting for deduplication.
- Validation-rule schema and unresolved-validation tracking.
- Workflow state machine (4-state machine: draft → candidate → approved → closed; catalog of state transitions).
- Figma payload normalization and import governance.
- Figma render capture and snapshot vault (localizes Figma frames).
- Generated test-case schema validation (with optional regulatory-relevance and audit fields).
- Cross-field invariant engine (domain-specific business-rule verification).
- Field-lifecycle transition tiers.
- Benchmark expansion fixtures (adversarial test cases for stress-testing generation).
- Drift-canary fixture snapshots (regression detection).

**Migration Decision** (selecting key items; full matrix in Section 3)

| Capability                       | Decision                                | Keiko Target                                                     | Why                                                                                                                                 |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Intent derivation                | port behavior                           | keiko-quality-intelligence domain seam                           | Core test-design logic; proven semantic model; reimplement with Keiko Model Gateway instead of TI's embedded gateway.               |
| Test-case schema & validation    | port behavior                           | keiko-quality-intelligence domain seam + keiko-contracts         | Zod/JSON Schema validators; adapt to Keiko's evidence-redaction seam.                                                               |
| Workflow state machine           | port behavior                           | keiko-harness or keiko-quality-intelligence                      | 4-state model is sound; may reuse Keiko Harness WorkflowState if compatible, or define Quality Intelligence–specific state machine. |
| Figma payload normalization      | port behavior + generic Keiko extension | keiko-multi-source (new Keiko connector) + keiko-local-knowledge | Keiko needs Figma ingestion layer; TI's normalization is the reference spec.                                                        |
| Benchmark & adversarial fixtures | reuse fixture                           | keiko-quality-intelligence test data                             | Adversarial cases pin coverage; sanitize and convert to Keiko test-data format per #277/#285.                                       |

---

### 1.3 `@oscharko-dev/ti-multi-source`

**Purpose:** Multi-source ingestion: Figma/Jira/custom-context import, ADF parsing, source-mix planning, production-readiness checks, reconciliation, and customer-profile input.

**Capabilities**

- Figma REST adapter and import governance.
- Jira ADF parser, gateway client, and capability probe.
- Custom-context input validation and policy.
- Source-mix planning (recommends optimal combination of sources).
- Multi-source reconciliation and production-readiness checks.
- Customer-profile input for team preferences and domain constraints.

**Migration Decision**

| Capability                  | Decision                | Keiko Target                                                    | Why                                                                                                           |
| --------------------------- | ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Figma REST adapter          | generic Keiko extension | keiko-connectors (new Figma connector) + keiko-workspace        | Figma integration is a connector; Keiko must own the adapter. TI's implementation is reference behavior only. |
| Jira ADF parser             | port behavior           | keiko-multi-source (new Keiko layer) or keiko-connectors (Jira) | ADF parsing is proven; reimplement as a pure function.                                                        |
| Source-mix planning         | port behavior           | keiko-quality-intelligence domain seam                          | Recommendation engine for source selection; reimplement with Keiko Model Gateway.                             |
| Multi-source reconciliation | port behavior           | keiko-quality-intelligence domain seam                          | Merge and deduplicate sources; reuse TI's reconciliation heuristics.                                          |

---

### 1.4 `@oscharko-dev/ti-quality`

**Purpose:** Validation pipeline, policy gate, judges (logic, faithfulness, semantic), self-verification, mutation oracle, policy profiles, and judge-disagreement reports.

**Capabilities**

- Coverage planner and coverage baseline drift detection.
- Logic judge, faithfulness judge, semantic judge panel, and self-consistency voter.
- Judge disagreement reporting and IR mutation oracle.
- Policy profile encoding and cross-family judge policy.

**Migration Decision**

| Capability               | Decision                | Keiko Target                                                | Why                                                                                    |
| ------------------------ | ----------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Coverage planner         | port behavior           | keiko-quality-intelligence domain seam                      | Semantic model proven; reimplement with Keiko Model Gateway for LLM-assisted planning. |
| Judge consensus ensemble | generic Keiko extension | keiko-model-gateway (ensemble routing)                      | Ensemble pattern; extend Keiko Model Gateway with multi-judge coordination.            |
| Mutation oracle          | port behavior           | keiko-quality-intelligence domain seam                      | IR mutation strategy is semantic; reimplement in Keiko's test-design model.            |
| Policy profile           | port behavior           | keiko-quality-intelligence domain seam + Keiko local config | Team policies must be stored locally; reuse TI's policy schema.                        |

---

### 1.5 `@oscharko-dev/ti-model-gateway`

**Purpose:** LLM provider gateway with routing policy, capability probe, token/context budget control, circuit breaker, replay cache, FinOps budget controls, constrained decoding, prompt optimization, mock gateway, and task classifier.

**Migration Decision**

| Capability                    | Decision       | Keiko Target                                              | Why                                                                                                                                 |
| ----------------------------- | -------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| LLM gateway factory & routing | reject runtime | keiko-model-gateway (reuse existing Keiko implementation) | Keiko already has a proven Model Gateway (#160); reuse it. TI's gateway is a reference only—do NOT embed TI's standalone gateway.   |
| LLM capability probe          | port behavior  | keiko-model-gateway (extend if needed)                    | Model-capability detection is useful; reuse TI's probe heuristics if Keiko lacks them.                                              |
| LLM circuit breaker           | port behavior  | keiko-model-gateway (extend if needed)                    | Backoff strategy is proven; add to Keiko Model Gateway if not present.                                                              |
| Replay cache                  | port behavior  | keiko-model-gateway (extend if needed) or keiko-evidence  | Caching deterministic requests is valuable; reuse TI's cache-key strategy.                                                          |
| Constrained decoding          | port behavior  | keiko-model-gateway (extend if needed) or keiko-contracts | Schema-aware output is useful; reuse TI's validation approach.                                                                      |
| Production topology clients   | reject runtime | —                                                         | TI's multi-provider client factory is standalone runtime; Keiko Model Gateway is the single entry point. Do NOT embed TI's gateway. |

---

### 1.6 `@oscharko-dev/ti-evidence`

**Purpose:** Evidence attestation, tamper-evident seal, provenance graph, audit dossier, and ML-BOM.

**Migration Decision**

| Capability           | Decision      | Keiko Target                                                                | Why                                                                                                                  |
| -------------------- | ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Evidence attestation | port behavior | keiko-evidence (extend if needed) or keiko-quality-intelligence domain seam | Keiko Evidence is the persistence seam; TI's attestation is reference. Adapt to Keiko's evidence-redaction contract. |
| Provenance graph     | port behavior | keiko-evidence + keiko-quality-intelligence domain seam                     | Lineage tracking is valuable; reimplement using Keiko's run/workflow event model.                                    |
| Audit dossier        | port behavior | keiko-evidence + keiko-quality-intelligence                                 | Audit records are semantically sound; reuse TI's schema; persist via Keiko Evidence with audit trail.                |
| LBOM emitter         | port behavior | keiko-quality-intelligence domain seam                                      | ML-BOM is useful for compliance; reimplement as a schema extension.                                                  |

---

### 1.7 `@oscharko-dev/ti-agentic-harness`

**Purpose:** Adversarial critic agents, formal verification, causal hypothesis registry, lessons consolidation, test-data oracle, and agent-harness checkpoint.

**Migration Decision**

| Capability                 | Decision       | Keiko Target                                                                          | Why                                                                                                           |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Agent harness & checkpoint | reject runtime | keiko-harness (reuse existing) or keiko-quality-intelligence (if new loop needed)     | Keiko Harness is the execution seam; reuse it. TI's harness is a reference; do NOT embed as parallel runtime. |
| Adversarial critic agent   | port behavior  | keiko-quality-intelligence domain seam (routed through Keiko Model Gateway + Harness) | Critic algorithm is proven; reimplement as a workflow step.                                                   |
| Causal hypothesis registry | port behavior  | keiko-quality-intelligence domain seam                                                | Hypothesis tracking is useful; reimplement as a registry seam.                                                |
| Test-data oracle           | port behavior  | keiko-quality-intelligence domain seam                                                | Oracle learning is proven; reimplement as a learned rule registry.                                            |

---

### 1.8 `@oscharko-dev/ti-production-runner`

**Purpose:** Top-level orchestrator: ingestion, harness invocation, evidence collection, export pipeline, validation, compliance checking, ML-BOM, human review, incident classification, and policy gates.

**Migration Decision** (key items; 40+ modules total)

| Capability                                 | Decision                | Keiko Target                                                           | Why                                                                                                            |
| ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Production runner (top-level orchestrator) | reject runtime          | keiko-workflows + keiko-quality-intelligence domain seam               | Keiko Workflows is the execution seam; reuse it. TI's runner is a reference; do NOT embed as parallel runtime. |
| Production runner events & evidence        | port behavior           | keiko-contracts (extend if needed) + keiko-evidence                    | Event schema is proven; extend Keiko's WorkflowEvent contract with Quality Intelligence events.                |
| Export pipeline                            | generic Keiko extension | keiko-quality-intelligence domain seam + keiko-connectors (TMS export) | Export format conversion is domain logic; reimplement in Keiko with per-format adapters (#283).                |
| Policy gate                                | port behavior           | keiko-quality-intelligence domain seam                                 | Policy enforcement is proven; reimplement as a rule registry with evaluator.                                   |
| Judge consensus                            | port behavior           | keiko-quality-intelligence domain seam + keiko-model-gateway           | Voting logic is proven; extend Keiko Model Gateway with ensemble routing.                                      |
| Repair loop                                | port behavior           | keiko-workflows (retry/loop pattern) + keiko-quality-intelligence      | Regeneration strategy is proven; implement as a Keiko Workflow step.                                           |

---

### 1.9–1.17 Additional Packages (abbreviated)

| Package                              | Purpose                                                  | Key Decision                | Keiko Target                                                                                    |
| ------------------------------------ | -------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `@oscharko-dev/ti-review`            | Human review queue, four-eyes governance, state machine. | port behavior               | keiko-quality-intelligence domain seam or keiko-review (if shared)                              |
| `@oscharko-dev/ti-integrations`      | TMS/QC push, Jira write, traceability, execution ingest. | generic Keiko extension     | keiko-connectors (TMS export); deferred to #283                                                 |
| `@oscharko-dev/ti-security`          | PII detection, redaction, compliance rules.              | port behavior               | keiko-security (reuse existing)                                                                 |
| `@oscharko-dev/ti-eval`              | Evaluation, calibration, benchmark, drift control.       | port behavior               | keiko-evaluations (reuse) or keiko-quality-intelligence test data                               |
| `@oscharko-dev/ti-server`            | HTTP API, rate limiter, authentication, observability.   | reject runtime              | keiko-server (native Quality Intelligence routes only); do NOT embed TI's server                |
| `@oscharko-dev/ti-cli`               | Standalone CLI binary (run, tms-push, review, etc.).     | reject runtime              | keiko-cli (native Quality Intelligence commands); do NOT embed TI's CLI                         |
| `@oscharko-dev/ti-tenant`            | Tenant onboarding, data isolation, residency.            | defer with product decision | out of scope for #363 (multi-tenant deferred)                                                   |
| `@oscharko-dev/ti-is-path-inside`    | Path containment primitive.                              | port behavior               | keiko-workspace (reuse existing)                                                                |
| `@oscharko-dev/ti-test-intelligence` | Meta-facade package.                                     | reject runtime              | keiko-quality-intelligence (new Keiko package); do NOT import `@oscharko-dev/test-intelligence` |
| `@oscharko-dev/ti-workbench`         | Next.js UI app, model gateway settings, run editor.      | reject runtime              | keiko-ui (native Quality Intelligence surfaces); do NOT embed TI's Workbench                    |

---

## 2. Defect / Shortcut / Unsafe-Default Filter List

The following MUST NOT be ported into Keiko:

### 2.1 Server-Side Path Traversal Acceptance (MEDIUM Risk)

**Identifier:** `server-path-normalization-incomplete`

**Evidence:** `packages/server/src/route-params.ts` normalizes Windows paths but relies on sentinel-based error handling.

**Defect Class:** Brittle assumption (delegates safety to every route handler).

**Rejection:** Keiko's path-safety model (#6, #161) enforces containment at the filesystem port level with `realpath()` + containment check, not at HTTP layer alone.

---

### 2.2 Standalone Workbench Database Without Sanitization (HIGH Risk)

**Identifier:** `workbench-db-customer-data-risk`

**Evidence:** `apps/workbench/` uses `better-sqlite3` with unencrypted `workbench.db` in `.test-intelligence/` directory, potentially containing customer context, Figma frames, Jira issues, and model responses.

**Defect Class:** Non-production credential handling + standalone runtime concern + unsafe default.

**Rejection:** Keiko uses local encrypted runtime state via keiko-security redaction contract. TI's Workbench database cannot be copied without sanitization. Do NOT copy `workbench.db` or BetterSQLite3 schema into Keiko.

---

### 2.3 Credential Storage in Plaintext Settings (CRITICAL Risk)

**Identifier:** `workbench-settings-plaintext-credentials`

**Evidence:** TI's Workbench stores OAuth tokens, API keys, and bearer tokens in `.test-intelligence/local-runtime/workbench-settings.json` (plaintext JSON).

**Defect Class:** Non-production credential handling + unsafe default.

**Rejection:** Keiko does not persist credentials in workspace JSON. Credentials are environment-variable-injected at runtime only. Keiko-security seam handles credential masking before logging.

---

### 2.4 TI Standalone HTTP Server in Keiko (CRITICAL Stop Condition)

**Identifier:** `ti-server-embedded-runtime`

**Evidence:** `packages/server/src/server.ts` and container entrypoint assume TI is a standalone HTTP service binding a port.

**Defect Class:** Duplicate runtime + architectural violation.

**Rejection:** Embedding TI's HTTP server violates the epic's hard constraint. Quality Intelligence routes go into keiko-server's BFF only. Do NOT embed `createTestIntelligenceServer()`.

---

### 2.5 TI Standalone CLI in Keiko (CRITICAL Stop Condition)

**Identifier:** `ti-cli-embedded-binary`

**Evidence:** `packages/cli/src/cli.ts` defines subcommands (run, tms-push, calibration-refit, review) with `bin` export for `test-intelligence` binary.

**Defect Class:** Duplicate runtime + architectural violation.

**Rejection:** Keiko CLI is the single entry point. Quality Intelligence commands are native `keiko quality-intelligence` subcommands, not a separate binary. Do NOT copy TI's CLI.

---

### 2.6 TI's Multi-Provider Model Gateway (CRITICAL Stop Condition)

**Identifier:** `ti-model-gateway-standalone-runtime`

**Evidence:** `packages/model-gateway/src/llm-gateway.ts` assumes TI is responsible for provider routing, capability probing, circuit breaking, and FinOps budgeting.

**Defect Class:** Duplicate runtime + architectural violation.

**Rejection:** Keiko Model Gateway (#160) is the single LLM entry point. TI's implementation is a reference for what Quality Intelligence needs, but must not be embedded. Do NOT import TI's gateway packages.

---

### 2.7 TI's Agentic Harness Loop (CRITICAL Stop Condition)

**Identifier:** `ti-agentic-harness-embedded-loop`

**Evidence:** `packages/agentic-harness/src/agent-harness.ts` defines a top-level orchestration loop with critic agents, lesson collection, and retry logic.

**Defect Class:** Duplicate runtime + architectural violation.

**Rejection:** Keiko Harness and Keiko Workflows are the execution seams. All orchestration must use Keiko primitives only. Do NOT import `AgentHarness` or `ProductionRunner`.

---

### 2.8–2.18 Additional Defects

| Identifier                                      | Class                     | Rejection                                                         |
| ----------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `ti-constrained-decoding-prompt-safety`         | POC shortcut              | Use model-native structured output, not prompt-based tricks.      |
| `ti-evidence-contains-internal-agent-reasoning` | Unsafe default            | Redact internal reasoning before persist.                         |
| `ti-customer-markdown-pdf-unsafe-markup`        | POC shortcut              | Sanitize markdown and validate URLs if ported later.              |
| `ti-judge-consensus-no-diversity-check`         | Brittle assumption        | Enforce semantic diversity before consensus.                      |
| `ti-figma-token-in-config`                      | Non-production credential | Environment-variable-only injection; no config files.             |
| `ti-jira-token-in-config`                       | Non-production credential | Environment-variable-only injection; no config files.             |
| `ti-cli-unencrypted-local-store`                | Non-production credential | No unencrypted databases; redact-before-persist only.             |
| `ti-evidence-manifest-version-not-enforced`     | Brittle assumption        | Add Keiko's versioning discipline; no silent upgrades.            |
| `ti-redaction-decisions-not-logged`             | Unsafe default            | Log which fields were redacted for audit purposes.                |
| `ti-compliance-rules-non-maintainable`          | POC shortcut              | Implement as a versioned, auditable registry.                     |
| `ti-incident-classifier-opaque-training`        | Opaque implementation     | Document examples and decision rules for incident classification. |

---

## 3. Keiko Target Map (Synthesized)

| Test Intelligence Capability  | Keiko Owner                                                        | Decision                                | Notes                                                        |
| ----------------------------- | ------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------ |
| Branded IDs                   | keiko-contracts or keiko-quality-intelligence                      | port behavior                           | Adapt ID scheme for Quality Intelligence.                    |
| Intent derivation             | keiko-quality-intelligence + keiko-model-gateway                   | port behavior                           | Core domain logic; route via Model Gateway.                  |
| Test-case schema & validation | keiko-quality-intelligence + keiko-contracts                       | port behavior                           | Adapt to Keiko evidence redaction.                           |
| Coverage planner              | keiko-quality-intelligence + keiko-model-gateway                   | port behavior                           | LLM-assisted planning.                                       |
| Logic judge                   | keiko-quality-intelligence + keiko-model-gateway                   | port behavior                           | Model-assisted validation.                                   |
| Semantic judge panel          | keiko-model-gateway                                                | generic Keiko extension                 | Ensemble routing.                                            |
| Figma payload normalization   | keiko-multi-source (new connector) + keiko-local-knowledge         | port behavior + generic Keiko extension | New Figma connector needed.                                  |
| Jira ADF parser               | keiko-connectors (Jira) or keiko-multi-source                      | port behavior                           | Reimplement as pure function.                                |
| LLM gateway routing           | keiko-model-gateway (reuse)                                        | reject runtime                          | Do NOT embed TI's gateway.                                   |
| Adversarial critic agent      | keiko-quality-intelligence + keiko-model-gateway + keiko-workflows | port behavior                           | Workflow step via Model Gateway.                             |
| Production runner             | keiko-workflows (reuse)                                            | reject runtime                          | Do NOT embed TI's runner. Reimplement using Keiko Workflows. |
| Export pipeline               | keiko-quality-intelligence + keiko-connectors                      | generic Keiko extension                 | Per-format adapters; defer to #283.                          |
| Agent harness                 | keiko-harness (reuse)                                              | reject runtime                          | Do NOT embed TI's harness. Reuse Keiko Harness.              |
| Policy gate                   | keiko-quality-intelligence                                         | port behavior                           | Rule registry with evaluator.                                |
| Human review                  | keiko-quality-intelligence + keiko-workflows                       | port behavior                           | Review coordination via Workflows.                           |
| Evidence attestation          | keiko-evidence                                                     | port behavior                           | Extend with Quality Intelligence fields.                     |
| Audit dossier                 | keiko-evidence + keiko-quality-intelligence                        | port behavior                           | Persist with audit trail.                                    |
| PII redaction                 | keiko-security (reuse)                                             | port behavior                           | Reuse existing seam.                                         |
| HTTP request handler          | keiko-server (native routes only)                                  | reject runtime                          | Do NOT embed TI's server. Native routes only.                |
| CLI subcommands               | keiko-cli (native Quality Intelligence commands)                   | reject runtime                          | Do NOT embed TI's CLI binary.                                |
| Next.js Workbench UI          | keiko-ui (native Quality Intelligence surfaces)                    | reject runtime                          | Do NOT embed TI's Workbench. Implement natively.             |

---

## 4. Parity Fixture Shortlist

Candidates for Keiko-owned conversion for use in #277 and #285:

1. **Figma import fixtures** (TI path: `packages/core-engine/src/figma-snapshot-vault.ts`) → Sanitize; convert to Keiko fixture format.
2. **Test-case generation golden examples** (TI path: `packages/core-engine/src/baseline-fixtures.ts`) → Synthetic re-derivation; do NOT copy TI's examples.
3. **Judge evaluation golden examples** (TI path: `packages/quality/src/`) → Synthetic re-derivation with generic examples.
4. **Compliance rule examples** (TI path: `packages/quality/src/compliance-rules.ts`) → Synthetic patterns; do NOT copy domain-specific guidance.
5. **Adversarial test-case examples** (TI path: `packages/agentic-harness/src/`) → Synthetic re-derivation with generic patterns.
6. **Multi-source reconciliation examples** (TI path: `packages/multi-source/src/multi-source-fixtures.ts`) → Synthetic sources; validate reconciliation logic.
7. **Model gateway routing examples** (TI path: `packages/model-gateway/src/llm-mock-gateway.ts`) → Synthetic re-derivation; test doubles with generic responses.
8. **Export format examples** (TI path: `packages/integrations/src/`) → Synthetic test-case data; sample export files.

---

## 5. Child-Issue Scope Updates

Cross-references communicated to #272, #278, #279, #273, #274, #282, #283, #284, #285:

- **#272:** Intent derivation and test-design model must route model-assisted operations through keiko-model-gateway (not embed TI's gateway). Verify no `@oscharko-dev/ti-model-gateway` import.
- **#278:** New keiko-connectors layer required for Figma and Jira integration. TI's multi-source is reference only; do NOT import it.
- **#279:** All judge operations must route through keiko-model-gateway. Do NOT import `@oscharko-dev/ti-model-gateway`.
- **#273:** Orchestration must use keiko-workflows primitives only. Do NOT import `@oscharko-dev/ti-agentic-harness` or `@oscharko-dev/ti-production-runner`.
- **#274:** Persist artifacts via keiko-evidence with full redaction-before-persist. Extend evidence schema; do NOT copy TI's manifest wholesale.
- **#280:** Native Quality Intelligence UI goes into keiko-ui only. Do NOT embed TI's Workbench. Reuse UX patterns as reference for keiko-ui design.
- **#281:** Conversation Center integration through keiko-workflows (workflow handoff) and keiko-evidence (artifact retrieval), not TI's server API or CLI.
- **#282:** Review queue and four-eyes policy via keiko-workflows and keiko-review (if shared) or native Quality Intelligence state machine. Do NOT import TI's review-queue logic.
- **#283:** TMS export is deferred to #283. Reuse TI's format specifications as reference; do NOT import `@oscharko-dev/ti-integrations`.
- **#284:** Verify no TI runtime services embedded. PII redaction uses keiko-security. Credentials: environment-variable-only. Path safety: realpath + containment. No unencrypted local databases.
- **#285:** Parity matrix must verify Keiko's Quality Intelligence covers useful TI behavior WITHOUT preserving TI's defects, shortcuts, unsafe defaults, or standalone runtimes.

---

## 6. Verification Commands Run

### 6.1 Repository Enumeration (TI Reference)

```bash
cd /Users/oscharko-dev/Projects/test-intelligence
git log --oneline -1
# Output: 0ffeab8 Merge pull request #113 from oscharko-dev/codex/figma-proxy-auth-mode-pr
git rev-parse HEAD
# Output: 0ffeab80c045ac06b5ac6cb4c1f6bec03226b392
```

**Exit Code:** 0

---

### 6.2 TI Package Count

```bash
find /Users/oscharko-dev/Projects/test-intelligence/packages -maxdepth 1 -type d | wc -l
# Output: 19 (18 packages + root directory)
```

**Exit Code:** 0

---

### 6.3 Keiko npm Install

```bash
cd /Users/oscharko-dev/Projects/Keiko && npm install
# Output: up to date, audited 589 packages in 557ms
# found 0 vulnerabilities
```

**Exit Code:** 0

---

### 6.4 Keiko npm run arch:check

```bash
cd /Users/oscharko-dev/Projects/Keiko && npm run arch:check
# Output: ✔ no dependency violations found (914 modules, 2171 dependencies cruised)
```

**Exit Code:** 0

---

### 6.5 Keiko npm run lint

```bash
cd /Users/oscharko-dev/Projects/Keiko && npm run lint
# Output: ✓ 0 problems
```

**Exit Code:** 0

---

### 6.6 Keiko npm run typecheck

```bash
cd /Users/oscharko-dev/Projects/Keiko && npm run typecheck
# Output: ✓ Compilation successful
```

**Exit Code:** 0

---

### 6.7 Keiko npm run format:check

```bash
cd /Users/oscharko-dev/Projects/Keiko && npm run format:check
# Output: Checking formatting...
# All matched files use Prettier code style!
```

**Exit Code:** 0

---

## 7. Hard Rejections

Non-negotiable red lines:

1. **No `@oscharko-dev/test-intelligence` import.** Test Intelligence is reference only. No Keiko code imports `@oscharko-dev/test-intelligence` or `@oscharko-dev/ti-*`.
2. **No Workbench build output embedded.** TI's Workbench is a separate product. Keiko's Quality Intelligence UI goes into keiko-ui only.
3. **No standalone runtime layers.** No TI's HTTP server, CLI binary, model gateway, agentic harness, or production runner as parallel services.
4. **No unencrypted credential storage.** Credentials are environment-variable-injected at runtime. All credentials masked before logging.
5. **No copied fixtures without sanitization and conversion.** Fixtures are sanitized, converted to Keiko format, and Keiko-owned.
6. **No unvalidated defects ported forward.** Every defect identified in Section 2 is explicitly rejected or reimplemented from first principles.

---

**Inventory Complete.** This document is ready for #363 closure and input to #271 (Keiko-native Quality Intelligence migration architecture).
