# Prompt Enhancer — architecture and reuse blueprint

Operational companion to [ADR-0044](../adr/ADR-0044-prompt-enhancer-architecture.md). This document
is the reuse map, domain model, implementation sequencing, gap analysis, and risk register for
Epic [#1307](https://github.com/oscharko-dev/Keiko/issues/1307) and its child issues #1309–#1315.
ADR-0044 records the binding decisions; this blueprint records how each child issue realises them
against existing Keiko capabilities.

## 1. Scope and non-goals

**In scope (MVP).** Turn raw user input into a structured, safe, grounded, evaluable, model-agnostic
Enhanced Prompt; classify at least ten task classes; select a generation profile; generate and rank
at least three candidates on deterministic dimensions; emit a retrieval plan for grounded tasks;
encode safety guardrails; make prompt versions, rules, scores, and evaluation results traceable
through existing evidence; ship a regression-guarded evaluation suite; expose the capability through
governed API, CLI, and UI surfaces.

**Out of scope (per #1308 and the epic non-goals).** Implementing the runtime in this issue (that is
#1309–#1315); autonomous long-running prompt evolution; domain-specific fine-tuning; tool
orchestration with write authority outside existing governed workflow and human-review gates;
claiming factual correctness without retrieval/citations; and any new grounding, evaluation, memory,
evidence, model-provider, workflow, or UI subsystem when an existing one can be extended.

This blueprint changes no runtime behaviour. It is documentation that constrains the implementing
issues.

## 2. Domain objects

All shapes are wire-safe and live in `keiko-contracts` (`src/prompt-enhancer.ts`, issue #1309),
following the established `memory-barrel.ts` / `connected-context.ts` / `workflow-handoff.ts`
conventions: a `PROMPT_ENHANCER_SCHEMA_VERSION` constant, branded ids via the unique-symbol pattern,
frozen constant arrays, and discriminated-union validators returning `Ok | Fail`.

- **`RawPromptInput`** — the untrusted user draft plus optional context references (selected scope,
  attachments). Treated as untrusted evidence everywhere downstream.
- **`TaskAnalysis`** — deterministic analyzer output: detected `taskClass`, volatility/grounding-need
  flags, recommended `profile`, explicit assumptions, and clarification questions. Produced without a
  model call by default (ADR-0044 §3).
- **`EnhancedPrompt`** — the structured artefact with `role`, `goal`, `context`, `input`,
  `taskDecomposition`, `constraints`, `groundingRules`, `outputSchema`, `qualityCriteria`,
  `uncertaintyHandling`, and `safetyRules`. Provider-neutral; rendered to `ChatMessage[]`
  (`keiko-contracts/src/gateway.ts`) only at dispatch time.
- **`PromptCandidate`** and **`CandidateScorecard`** — a generated candidate plus its scores across
  the dimensions in §6.
- **`RetrievalPlan`** — scope + source policy + query strategy the enhancer emits for grounded tasks
  (§5). It is a plan, not an execution; the server binds it to existing retrieval. It carries an
  explicit `readiness` flag (`ready | unready`) plus a machine-readable `unreadyReason` so the server
  can refuse to execute a plan whose scope is not retrievable (§5, R1).
- **`SafetyAnnotation`** — machine-readable, server-enforceable metadata attached to an Enhanced
  Prompt. The MVP shape is a frozen record:
  `{ restrictedTools: readonly string[]; deniedOutputPatterns: readonly string[];
injectionWarnings: readonly string[]; requiresHumanReview: boolean }`. The validate stage
  (#1313) produces it; the server (#1314) enforces it before the prompt is used (it intersects
  `restrictedTools` with any tool grant, applies `deniedOutputPatterns` to surfaced output, and
  routes `requiresHumanReview` prompts to the existing human-review gate). The exact wire shape is
  fixed in #1309 and enforcement is proved by a #1315 safety fixture.
- **`PromptEnhancementEvidence`** — the redacted, hashed audit record (§8).

### Task taxonomy (≥10 classes)

A closed `PROMPT_ENHANCER_TASK_CLASSES` set, at least: `factual-qa`, `summarization`,
`structured-extraction`, `classification`, `code-generation`, `code-explanation`,
`reasoning-analysis`, `research`, `creative-writing`, `transformation-rewrite`,
`planning-decomposition`, `data-analysis`, `safety-critical` (legal/medical/financial/compliance),
and `agentic-tool-use`. The exact closed set is fixed in #1309; this list is the floor and exceeds
the ten-class requirement so #1309 can prune or rename without dropping below the threshold.

### Generation profiles

A closed `PROMPT_ENHANCER_PROFILES` set: `fast`, `precise`, `research`, `creative`, `technical`,
`safety-critical`, `agentic`. Each profile is data (required capabilities, token budget, temperature,
whether grounding is mandatory), paralleling `QualityIntelligenceTaskProfile`.

## 3. Capability-to-package reuse map

The default placement is the no-new-package distribution from ADR-0044 §1. Detailed anchors:

### Model access — `keiko-model-gateway` (reuse + extend)

- **Reuse**: `Gateway`, `selectConfiguredModel`/`findConfiguredCapability` for model-agnostic
  routing; the QI dispatch pipeline (`dispatchQualityIntelligenceRequest`), `buildPromptSegments`
  (trusted/untrusted separation), `assertProfileCompatibleWithModel`, the safe-error taxonomy,
  `createBudget`, `composeCancellationSignal`, and `createInMemoryReplayCache`.
- **Extend**: add `src/promptEnhancer/` task profiles (`pe:analyze` optional, `pe:candidate`,
  `pe:critic`, `pe:safety-check`) paralleling `QUALITY_INTELLIGENCE_TASK_PROFILES`. No provider SDK
  is imported here or anywhere else (`adr-0019-trust-1`).

### Grounding — `keiko-local-knowledge` + `keiko-server` (reuse + additive extend)

- **Reuse**: `runLocalKnowledgeRetrieval`, `assembleGroundedContext`, `validateAnswerGrounding`,
  `buildComposedRetrievalScope`/`describeRetrievalScope`, capsule/capsule-set lifecycle, and the
  server hybrid path `runHybridGroundedAsk` (RRF, ADR-0036). Citation, budget, and source-skip
  semantics are inherited unchanged.
- **Extend additively**: a `describeRetrievalPlan(scope, store)` helper and exported query-strategy
  profiling so the enhancer can emit a deterministic `RetrievalPlan`; an optional `retrievalPlan`
  field reserved on `RetrievalResult`. The enhancer never executes retrieval (epic #1311).

### Evaluation — `keiko-evaluations` + `keiko-contracts` (reuse + extend)

- **Reuse**: `runEvaluationSuite`, the `EvalRunnerDeps` injection pattern, `createEvaluationModel
provider` (offline scripted vs live), `scoreFixture`, `aggregateScorecard`, `summarizeScorecard`,
  `renderEvalSummary`, and checked-in deterministic fixtures.
- **Extend**: add enhancer dimensions to `EVALUATION_DIMENSIONS` (`keiko-contracts/src/evaluations.ts`)
  and corresponding scorers to the `SCORERS` map; add enhancer fixtures and Go/No-Go thresholds.

### Safety — `keiko-security` (reuse + extend)

- **Reuse**: `redact`/`createAuditRedactor`/`deepRedactStrings`, `canonicalise` + `sha256Hex`
  fingerprinting, `sealString` for any at-rest caching, and the `qi/*` safe-error discipline.
- **Extend**: prompt-injection `BUILTIN_PATTERNS` (jailbreak/markup/command-injection shapes), a
  user-context secret detector, and a `PromptEnhancementError` code set.

### Evidence — `keiko-evidence` (reuse + extend)

- **Reuse**: the `EvidenceStore` port (`put`/`update`/`list`/`get`/`delete`), `buildEvidenceManifest`,
  `persistEvidence`, redaction-on-write, and `RetentionPolicy`.
- **Extend**: a `src/promptEnhancement/` namespace (manifest schema + store) following the QI store
  template (record → redact → hash → validate totals → write). The manifest is added to the
  `EvidenceManifest` union without bumping `EVIDENCE_SCHEMA_VERSION` for unrelated records.

### Lifecycle — `keiko-workflows` (reuse + extend)

- **Reuse**: `WorkflowDescriptor`, `withStage`, `RunContext`, `GovernorState` (token/call/time
  budget), and `createScopedWriter` / `governedPatchRejectionCode` for any governed handoff.
- **Extend**: a `src/promptEnhancer/` descriptor + `runPromptEnhancer` scripted entry orchestrating
  `analyze → plan → generate → score → validate`, paralleling `runQualityIntelligenceTestDesign`.
- **Precedent**: this distributed-ownership pattern directly parallels Quality Intelligence (Epic
  #270), whose governance, redaction, evidence, and dispatch concerns are likewise split across
  `keiko-workflows`, `keiko-evidence`, `keiko-security`, and `keiko-model-gateway`. `keiko-workflows`
  already depends on `keiko-quality-intelligence` in the ADR-0019 allowlist, so the orchestration
  primitives (`WorkflowDescriptor`, `withStage`, `GovernorState`) the enhancer reuses are proven at
  scale.

### Prompt construction — `keiko-harness` (reuse convention only)

- **Reuse**: the labeled `SYSTEM_PROMPT` + `userMessage` + `contextBlock` separation used by
  `buildGenerateUnitTests` / `buildInvestigateBug` / `buildExplainPlan`. The generator follows this
  convention; it does not introduce a templating framework. The lifecycle stays in `keiko-workflows`
  (ADR-0044 Alternative 2).

### Surfaces — `keiko-server`, `keiko-cli`, `keiko-ui` (reuse + additive)

- **Server**: register `/api/prompt-enhancer/*` in `API_ROUTES`; reuse `UiHandlerDeps`
  (`modelPortFactory`, `redactor`), `readBody`/`parseBody` validation, `mappedGatewayError`, and SSE
  helpers; a server orchestrator binds the workflow run + `RetrievalPlan` → existing retrieval +
  evidence write (paralleling `grounded-orchestrator.ts`).
- **CLI**: a new command reusing existing command-registration and evidence-dir conventions.
- **UI**: a `PromptEnhancerPanel` sibling of `GroundedAnswerPanel` inside `ChatWindow`; reuse
  `KeikoSelect` (profile selection), `SafeMarkdown` (render), `CitationReference`/`MetricRow`
  (scores), and `useSSE` (streaming); re-export wire types in `lib/types.ts`.

## 4. Routing boundaries

- **Productive model calls** → `keiko-model-gateway` only. The analyzer is deterministic-first;
  candidate/critic/safety-check stages route through gateway profiles under the governor budget.
- **Workflow authority** → `keiko-workflows`. `runPromptEnhancer` owns stage sequencing,
  cancellation, and budget; the enhancer emits artefacts and never self-authorizes downstream action.
- **Grounding execution** → `keiko-local-knowledge` via `keiko-server`. The enhancer emits a
  `RetrievalPlan`; the server binds it. No second retrieval engine. **Scope-readiness ownership**: the
  enhancer's grounding planner sets the plan's `readiness` flag from `buildComposedRetrievalScope`
  (capsules exist, at least one has vectors, embedding identity matches); the server re-checks
  `readiness` before binding and refuses to execute an `unready` plan, returning a user-facing
  insufficient-evidence notice rather than fabricating grounded claims (R1). Neither side silently
  proceeds on an unready scope.
- **Persistence** → `keiko-evidence` via the `EvidenceStore` port, redacted and hashed.
- **Surfaces** → `keiko-server` BFF is the only network boundary; CLI and UI call the server; UI
  never configures providers or reaches gateway internals (`adr-0019-trust-2`/`trust-3`).

## 5. Evidence model

Each enhancement run writes one `PromptEnhancementEvidence` manifest plus companion artefacts
(`<runId>.enhanced-prompt.json`, `<runId>.rules-applied.json`, `<runId>.scorecard.json`) through the
existing `EvidenceStore`. Every string leaf is redacted by construction (`createAuditRedactor`) and
the manifest carries a content hash (`canonicalise` + `sha256Hex`) for tamper evidence. Retention
uses the existing `RetentionPolicy`. No raw secrets, customer data, private logs, or hidden system
prompts are persisted (ADR-0022, ADR-0030). The manifest records: input fingerprint (not raw input),
detected task class and profile, applied rules, candidate scores, selected candidate, evaluation
result, and safety annotations.

## 6. Evaluation strategy

Candidate scoring dimensions: **clarity, completeness, grounding readiness, safety, output
controllability, token efficiency** (epic Target Outcome #3). The MVP eval suite (#1315) additionally
reports **groundedness, faithfulness, format adherence, and task success** (epic Definition of Done)
using `runEvaluationSuite` with deterministic checked-in fixtures and a `createScriptedModelPort`
offline mode, gated by Go/No-Go thresholds plus human-reviewed live runs (the existing pilot pattern,
ADR Evaluation decision). Deterministic dimensions (clarity, completeness, output controllability,
token efficiency) are pure scorers; grounding readiness and safety may consult model-assisted critics
behind the gateway. Regression is prevented by checked-in fixtures and threshold gates, mirroring the
existing safety-gate semantics in `scorer.ts`.

**Where scorers live.** The dimension _types_ are added to `EVALUATION_DIMENSIONS` in
`keiko-contracts/src/evaluations.ts`. The deterministic scorer _functions_ are registered in the
`SCORERS` map in `keiko-evaluations` (offline) and reused by the runtime `score` stage through the
contract; model-assisted critics run as gateway `pe:critic` / `pe:safety-check` profiles. The runtime
`score` stage never calls `runEvaluationSuite` (ADR-0044 §1).

**Evaluation is post-validation and never an authority gate.** The validate stage (#1313) is the only
authority gate: a prompt that fails validation never reaches evaluation. Model-assisted safety critics
emit _scores only_; a low safety score is a data point surfaced to human review, not an
approve/reject decision, and never overrides validation. A #1315 fixture proves both: a
validation-failing prompt is rejected before scoring, and a validation-passing but low-safety prompt
still flows to human review with the low score surfaced.

## 7. Safety strategy

Guardrails encode the LLM-security risks named by the epic: prompt injection, indirect prompt
injection, sensitive-information disclosure, insecure output handling, excessive agency, and unsafe
tool use. Mechanisms:

1. **Untrusted segregation** — raw input and any retrieved/tool text are placed in the untrusted
   channel of `buildPromptSegments` before any model call.
2. **Validation rules** — the validate stage rejects Enhanced Prompts that grant authority (see the
   validation rule model below), returning a `PromptEnhancementError`.
3. **Safety annotations** — machine-readable, server-enforced restrictions travel with the Enhanced
   Prompt (the `SafetyAnnotation` shape in §2); the server honours them and never escalates authority
   from a generated prompt.
4. **Redaction + safe errors** — all persisted and surfaced text is redacted; errors carry no
   sensitive payload.
5. **Human review** — any downstream authority continues through existing governed handoff and
   human-review gates; the enhancer output is data requiring explicit user acceptance before use.

**Redaction and validation are distinct gates.** Redaction is _defensive sanitisation_ that runs
inside `buildPromptSegments` before every model call and on every persisted leaf; the
`keiko-security` `BUILTIN_PATTERNS` extension (jailbreak/markup/command-injection shapes) belongs to
this gate. Validation is a _prescriptive rejection_ gate in the validate stage. They are independent:
validation must not rely on redaction patterns alone, because an authority-granting prompt need not
match any known injection pattern.

**Validation rule model (deterministic-first).** The validate stage applies a closed set of
deterministic structural checks over the `EnhancedPrompt`; a match rejects the artefact with a typed
`PromptEnhancementError` and writes an evidence row. The MVP categories are:

- **Tool / capability grant** — the prompt defines new tools/functions, claims the assistant may
  execute commands or code, or instructs acquisition of new capabilities.
- **Secret access** — the prompt instructs reading, exfiltrating, or echoing secrets, credentials,
  tokens, or environment values, or embeds an unredacted secret (detected via the `keiko-security`
  secret detector).
- **Egress** — the prompt instructs outbound network calls, fetching external URLs, or transmitting
  context to a third party.
- **Patch / write authority** — the prompt instructs writing files, applying patches, or mutating the
  workspace outside the governed handoff path.

Checks are deterministic by default (string/structure rules over typed fields, not free-text
heuristics). A model-assisted reviewer MAY be added behind the gateway as a defence-in-depth _second_
signal, but it never replaces the deterministic checks and never weakens them. The exact closed rule
set, its false-positive/false-negative posture, and its fixtures are implemented and proved in #1313;
this model is the binding contract #1313 must satisfy.

A pre-implementation security review of these boundaries is required by #1308 before #1309 begins and
is recorded in the issue (see closure evidence). #1313 owns the executable safety implementation and
its fixtures.

## 8. Implementation sequencing map

Aligned to the epic's required order. Each issue is scoped to disjoint write ownership so no two
agents edit the same file scope.

| Issue     | Goal                                                        | Primary packages                                                                                     | Key reuse                                                                                                                  | Net-new (gap)                                                                             | Write ownership                                                |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **#1309** | Enhanced Prompt contracts, taxonomy, deterministic analyzer | `keiko-contracts`                                                                                    | `memory-barrel`/`connected-context`/`workflow-handoff` patterns, validators                                                | `prompt-enhancer.ts` shapes + taxonomy + analyzer; no model call by default               | `packages/keiko-contracts/**` + tests                          |
| **#1310** | Planner profiles + structured generator                     | `keiko-model-gateway/src/promptEnhancer/`, `keiko-workflows/src/promptEnhancer/`                     | `buildPromptSegments`, harness system/user/context convention, QI profiles                                                 | `pe:*` profiles, generator, profile catalog                                               | enhancer sub-modules + tests                                   |
| **#1311** | Grounding + retrieval planning                              | `keiko-local-knowledge`, `keiko-server`, `keiko-contracts`                                           | `runLocalKnowledgeRetrieval`, `buildComposedRetrievalScope`, `runHybridGroundedAsk`                                        | `RetrievalPlan` shape, `describeRetrievalPlan`, server binding                            | LK additive exports, server binder, contract shape, tests      |
| **#1312** | Candidate generation, critic scoring, optimization loop     | `keiko-evaluations`, `keiko-model-gateway/src/promptEnhancer/`, `keiko-contracts/src/evaluations.ts` | `scoreFixture`, `aggregateScorecard`, `EVALUATION_DIMENSIONS`, gateway critic dispatch                                     | enhancer dimensions + scorers, bounded candidate/critic loop                              | enhancer scorers, evaluations extension, tests                 |
| **#1313** | Safety guardrails, validation, audit evidence               | `keiko-security`, `keiko-evidence/src/promptEnhancement/`, enhancer validate stage                   | redaction/hashing/secretbox, `EvidenceStore`, QI store template, governed handoff                                          | injection patterns, `PromptEnhancementError`, evidence manifest + store, validation rules | security extension, evidence sub-module, validate stage, tests |
| **#1314** | Governed API, CLI, UI                                       | `keiko-server`, `keiko-cli`, `keiko-ui`                                                              | `API_ROUTES`/`UiHandlerDeps`/`mappedGatewayError`, CLI command pattern, `ChatWindow`/`KeikoSelect`/`SafeMarkdown`/`useSSE` | `/api/prompt-enhancer/*`, CLI command, `PromptEnhancerPanel`                              | server routes, cli command, ui panel, integration tests        |
| **#1315** | Evaluation suite, docs, closure evidence                    | `keiko-evaluations`, `docs/**`                                                                       | `runEvaluationSuite`, scorecard renderer, fixtures, release-doc + ADR patterns                                             | enhancer fixtures, threshold gates, runbook, closure evidence                             | evaluations fixtures, docs, README updates                     |

**#1312 vs #1315 ownership (both touch `keiko-evaluations`).** To keep write ownership disjoint:
#1312 owns the **runtime ranking path** — the six production candidate dimensions in
`EVALUATION_DIMENSIONS`, their deterministic scorer functions plus the `pe:critic` gateway profile,
and the bounded candidate/critic loop under `GovernorState`. #1315 owns the **offline regression
suite** — the four additional report-only metrics (groundedness, faithfulness, format adherence, task
success), the checked-in fixtures, the Go/No-Go thresholds, and the human-reviewed live-run protocol.
Both may extend `keiko-evaluations`, but in separate files: #1312 adds production scorers; #1315 adds
suite fixtures and threshold configuration.

## 9. Gap analysis

Everything below is genuinely new because nothing in the current codebase provides it; everything not
listed is reuse or additive extension (§3). No new package is required for the default plan.

**Net-new contracts and logic (all additive to existing packages):**

- `keiko-contracts`: `prompt-enhancer.ts` (+ optional `prompt-enhancer-validation.ts`) — Enhanced
  Prompt, taxonomy, profiles, retrieval-plan, safety-annotation, evidence-manifest shapes,
  validators. New `EVALUATION_DIMENSIONS` entries.
- `keiko-model-gateway/src/promptEnhancer/`: enhancer task profiles and candidate/critic dispatch
  wrappers over existing QI primitives.
- `keiko-workflows/src/promptEnhancer/`: descriptor + `runPromptEnhancer` lifecycle.
- `keiko-local-knowledge`: `describeRetrievalPlan` and exported query-strategy profiling (additive).
- `keiko-evaluations`: enhancer scorers, fixtures, thresholds.
- `keiko-security`: injection `BUILTIN_PATTERNS`, user-context secret detector,
  `PromptEnhancementError`.
- `keiko-evidence/src/promptEnhancement/`: manifest schema + store.
- `keiko-server`: `/api/prompt-enhancer/*` routes + orchestrator binder.
- `keiko-cli`: enhancer command.
- `keiko-ui`: `PromptEnhancerPanel` + `lib/types.ts` re-exports.

**Real capability gaps (confirmed absent):** raw-input normalization + structured-prompt construction
as a first-class artefact; structured prompt validation (does this prompt illegally grant authority?);
a machine-readable safety-annotation schema; a `RetrievalPlan` contract; enhancer evaluation
dimensions and fixtures; prompt-injection redaction patterns; a prompt-enhancement evidence manifest.
None of these is satisfiable by an existing module unchanged, but each lands additively in the
owning package above.

**Deferred new-package option (ADR-0044 §2).** If the deterministic core warrants its own package,
register `@oscharko-dev/keiko-prompt-enhancer` (`{contracts, security}`) by editing, in this order:
`scripts/check-package-graph.mjs` (its allowlist + `server`/`cli` consumer entries),
`.dependency-cruiser.cjs` (`adr-0019-direction-3m`, the next free letter after the current `3a`–`3l`;
take the next free `adr-0019-direction-3X` if concurrent work claims it first),
`scripts/arch-check-negative.mjs` (negative fixture), `tsconfig.packages.json` (project reference),
and root `package.json` `bundleDependencies`. This is acyclic and is the only path that touches
architecture-gate files; it is taken only with a documented ownership/coverage justification.

## 10. Risk register

| #   | Risk                                                                                                                                 | Area              | Likelihood × Impact | Mitigation                                                                                                                                                                                 | Owner issue  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| R1  | Grounding plan diverges from what the server can execute (scope/embedding mismatch), producing prompts that ask for ungrounded facts | Grounding         | M × H               | Emit `RetrievalPlan` from the same `buildComposedRetrievalScope` the server uses; add pre-execution scope-readiness validation; degrade to "insufficient evidence" notice, never fabricate | #1311        |
| R2  | Evaluation gives false confidence (overfit fixtures, offline ≠ live)                                                                 | Evaluation        | M × M               | Reuse offline-threshold + human-reviewed-live pilot pattern; checked-in deterministic fixtures; thresholds gate Go/No-Go; surface offline-vs-live deltas                                   | #1312, #1315 |
| R3  | Prompt-injection / indirect injection escapes into a generated prompt                                                                | Safety            | M × H               | Untrusted segregation via `buildPromptSegments`; injection redaction patterns; validate-stage rejection; safety annotations honoured by server; fixtures                                   | #1313        |
| R4  | Secret or customer data leaks into evidence or surfaced output                                                                       | Audit evidence    | L × H               | Redact-by-construction before every write; user-context secret detector; hashed manifests; safe-error taxonomy; no raw input persisted                                                     | #1313        |
| R5  | Generated prompt silently grants tool-write / egress / secret authority (excessive agency)                                           | Safety            | L × H               | Validation rules reject authority grants; enhancer emits data only; downstream authority stays behind governed handoff + human review                                                      | #1313        |
| R6  | UI integration regresses Conversation Center a11y or streaming                                                                       | UI integration    | M × M               | Reuse `ChatWindow` panel pattern, live-region/`SafeMarkdown`/`useSSE` conventions; jest-axe coverage; no `dangerouslySetInnerHTML`                                                         | #1314        |
| R7  | Model-specific optimisation breaks provider neutrality                                                                               | Model-agnosticism | L × M               | Provider-neutral Enhanced Prompt by default; model-specific tuning opt-in and capability-gated; no hard-coded model names                                                                  | #1310        |
| R8  | Candidate/critic loop inflates token cost or latency                                                                                 | Performance/cost  | M × M               | Bound candidates (≥3, capped) and stages with `GovernorState`; cancellation; replay cache for deterministic re-runs                                                                        | #1312        |
| R9  | Distributed sub-modules drift / contract leakage between packages                                                                    | Architecture      | L × M               | Single contract module in `keiko-contracts`; `arch:check` + `check:package-graph` unchanged (no new edges); blueprint as the conceptual map                                                | #1309        |
| R10 | Scope creep beyond the MVP (autonomous evolution, fine-tuning, tool write authority)                                                 | Scope             | M × M               | Epic non-goals enforced; stop-conditions in each child issue; this blueprint fixes MVP boundaries                                                                                          | all          |

## 11. Verification of this blueprint

- Existing-capability review complete and grounded in real exports across model-gateway,
  local-knowledge, Conversation Center grounding, evaluations, security, evidence, workflows,
  harness, contracts, server BFF, and UI (§3).
- A default no-new-package plan is documented (ADR-0044 §1, §3, §8) and a new-package option is
  justified with exact registration steps (ADR-0044 §2, §9).
- MVP boundaries are narrow enough to implement incrementally through #1309–#1315 (§8).
- Security, evidence, and evaluation implications are captured before implementation (§5–§7, §10).
- The final reuse plan is linked from the epic (closure evidence on #1308).

## 12. Related

- [ADR-0044](../adr/ADR-0044-prompt-enhancer-architecture.md) — the binding decision record.
- [ADR-0034](../adr/ADR-0034-hybrid-multi-source-grounding.md),
  [ADR-0036](../adr/ADR-0036-hybrid-grounding-reciprocal-rank-fusion.md) — grounding the retrieval
  plan targets.
- [ADR-0022](../adr/ADR-0022-connected-context-privacy.md) — evidence/privacy contract.
- [ADR-0019](../adr/ADR-0019-modular-package-architecture.md),
  [ADR-0021](../adr/ADR-0021-publish-strategy-bundled-monorepo-product.md) — package architecture and
  bundled-product contract.
- Epic [#1307](https://github.com/oscharko-dev/Keiko/issues/1307); child issues #1309–#1315.
