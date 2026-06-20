# ADR-0044: Prompt Enhancer architecture, package ownership, and trust boundaries

## Status

Accepted (2026-06-20). Governs Epic [#1307](https://github.com/oscharko-dev/Keiko/issues/1307)
(Prompt Enhancer with grounding, evaluation, and safety) and its child issues #1309–#1315. Records
the reuse-first architecture and trust boundaries the remaining child issues implement. Introduces
no runtime behaviour; this is a planning decision record paired with the operational
[Prompt Enhancer architecture blueprint](../prompt-enhancer/architecture-blueprint.md).

> **ADR numbering note.** Identifiers `ADR-0042` and `ADR-0043` are reserved by the concurrent
> Keiko Editor epic on the `feat/keiko-editor` integration branch. This epic uses `ADR-0044` to keep
> ADR identifiers globally unique across the project and avoid a same-number collision when the two
> integration branches reconcile.

## Context

Epic #1307 delivers a governed Prompt Enhancer that turns raw user input into a structured, safe,
grounded, evaluable, and model-agnostic Enhanced Prompt. The epic's binding constraint is the
**Reuse And No-Duplication Gate**: the enhancer must not create a parallel prompt, grounding,
evaluation, safety, evidence, model-provider, workflow, or UI subsystem when an existing Keiko
subsystem can be extended through a documented contract. Issue #1308 exists to settle the reuse plan,
package ownership, and trust boundaries before any runtime code (issues #1309–#1315) is written.

Keiko already contains every subsystem the enhancer composes, and — decisively — already contains a
near-exact precedent for a governed, model-using, evaluable, evidence-producing capability:
**Quality Intelligence (QI)**. QI is not a monolith and is not a single new feature package. It is
distributed as capability-bound `qualityIntelligence/` sub-modules inside the packages that own the
relevant capability, plus a small leaf domain package:

- Model-bound dispatch, capability gating, trusted/untrusted prompt segmentation, safe-error
  taxonomy, token budget, cancellation, and replay cache live in
  [`packages/keiko-model-gateway/src/qualityIntelligence/`](../../packages/keiko-model-gateway/src/qualityIntelligence/index.ts)
  (`dispatchQualityIntelligenceRequest`, `buildPromptSegments`, `assertProfileCompatibleWithModel`,
  `QualityIntelligenceSafeErrorException`, `createBudget`, `composeCancellationSignal`,
  `createInMemoryReplayCache`, `selectModelForProfile`, `QUALITY_INTELLIGENCE_TASK_PROFILES`).
- The governed lifecycle lives in
  [`packages/keiko-workflows/src/qualityIntelligence/`](../../packages/keiko-workflows/src/qualityIntelligence/runEntries.ts)
  (`runQualityIntelligenceTestDesign`, `QualityIntelligenceWorkflowDescriptor`, `withStage`, the
  `GovernorState` budget governor in [`planner/governor.ts`](../../packages/keiko-workflows/src/planner/governor.ts)).
- Audit evidence lives in
  [`packages/keiko-evidence/src/qualityIntelligence/`](../../packages/keiko-evidence/src/qualityIntelligence/manifestSchema.ts)
  (record → redact → hash → validate totals → write).
- Wire contracts and the BFF/retrieval surfaces are distributed the same way: a
  `qualityIntelligence/` contract surface in `keiko-contracts`, connector routes in `keiko-server`,
  and a retrieval handoff in `keiko-local-knowledge`. The pure domain core is the leaf package
  `@oscharko-dev/keiko-quality-intelligence` (allowed dependencies `{contracts, security}`). This
  full distribution — across at least six packages plus a leaf core — is the evidence that a
  distributed governed capability works at scale, and is the template the Prompt Enhancer follows.

The retrieval domain has the second relevant precedent: `@oscharko-dev/keiko-local-knowledge` is a
mid-stack domain package whose allowed dependencies are exactly `{contracts, model-gateway,
workspace}` ([`scripts/check-package-graph.mjs`](../../scripts/check-package-graph.mjs)), enforced as
`adr-0019-direction-3e` in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs).

The relevant subsystems and their reuse anchors, confirmed by reading the current source, are:

| Capability the enhancer needs                                        | Existing owner (reuse anchor)                                                                                                                                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Productive model calls, capability metadata, provider neutrality     | `keiko-model-gateway`: `Gateway`, `CAPABILITY_REGISTRY`, `selectConfiguredModel`, `ProviderAdapter`; QI dispatch primitives                                                               |
| Trusted-instruction / untrusted-evidence separation                  | `keiko-model-gateway/src/qualityIntelligence/promptSegmentation.ts`: `buildPromptSegments`                                                                                                |
| Grounding, retrieval, hybrid RRF, citation, budgets, scopes          | `keiko-local-knowledge`: `runLocalKnowledgeRetrieval`, `assembleGroundedContext`, `validateAnswerGrounding`, `buildComposedRetrievalScope`; server `runHybridGroundedAsk` (ADR-0034/0036) |
| Candidate scoring, scorecards, offline/live modes, safety gate       | `keiko-evaluations`: `scoreFixture`, `aggregateScorecard`, `runEvaluationSuite`, `createEvaluationModelProvider`; `keiko-contracts` `EVALUATION_DIMENSIONS`                               |
| Redaction, hashing, sealed-at-rest, safe-error taxonomy              | `keiko-security`: `redact`, `createAuditRedactor`, `canonicalise`/`sha256Hex`, `sealString`, gateway/tools/audit error codes                                                              |
| Evidence manifests, run ledger, redaction-on-write                   | `keiko-evidence`: `EvidenceStore` port, `buildEvidenceManifest`, `persistEvidence`; QI store template                                                                                     |
| Governed multi-stage execution, human-review handoff                 | `keiko-workflows`: `WorkflowDescriptor`, `withStage`, `GovernorState`, `createScopedWriter`/`governedPatchRejectionCode`                                                                  |
| Existing system/user/context prompt construction                     | `keiko-harness`: `buildGenerateUnitTests`, `buildInvestigateBug`, `buildExplainPlan` (`SYSTEM_PROMPT` + `userMessage` + `contextBlock`)                                                   |
| Wire-safe domain contracts, validators, branded ids, schema versions | `keiko-contracts`: `memory-barrel.ts`, `connected-context.ts`, `workflow-handoff.ts`, `evidence.ts`, `gateway.ts`                                                                         |
| BFF routes, request validation, streaming, error mapping             | `keiko-server`: `API_ROUTES`, `UiHandlerDeps`, `handleGroundedAsk`, `chat-stream-handlers.ts`, `mappedGatewayError`                                                                       |
| Governed UI workflow surface, model select, citation/markdown render | `keiko-ui`: `ChatWindow`, `KeikoSelect`, `GroundedAnswer`/`CitationReference`, `SafeMarkdown`, `useSSE`, `WorkflowPickerDialog`                                                           |

The package dependency graph that constrains placement is the ADR-0019 allowlist in
`scripts/check-package-graph.mjs` (the authoritative, exhaustive source; the edges below are quoted
verbatim from it for the four consumer packages that host the distributed sub-modules, so the
zero-new-edges claim in §1 of the Decision can be checked directly):

- `keiko-model-gateway` → `{contracts, security}`
- `keiko-local-knowledge` → `{contracts, model-gateway, workspace}`
- `keiko-workflows` → `{contracts, security, model-gateway, workspace, tools, harness, verification, evidence, quality-intelligence}`
- `keiko-evaluations` → `{contracts, security, model-gateway, workspace, tools, harness, workflows, verification, evidence}`
- `keiko-server` → `{contracts, security, model-gateway, workspace, tools, harness, workflows, verification, evidence, sdk, local-knowledge, memory-vault, memory-governance, memory-retrieval, memory-capture, memory-consolidation, quality-intelligence}`
- `keiko-cli` → `{contracts, security, model-gateway, workspace, tools, harness, workflows, evaluations, evidence, sdk, server, verification, memory-vault}`

Every edge the §1 distribution relies on — `workflows → {model-gateway, evidence}`,
`evaluations → {workflows, model-gateway}`, `server → {workflows, model-gateway, local-knowledge, evidence}`,
and `cli → {workflows, evaluations, server}` — is already present above.

## Decision

### 1. Default placement: no new package — distribute as governed sub-modules (Quality Intelligence pattern)

The Prompt Enhancer is implemented as capability-bound sub-modules inside the packages that already
own each capability, plus typed contracts in the contracts leaf, exactly mirroring Quality
Intelligence. This is the default because **every dependency edge the enhancer needs already exists
in the ADR-0019 allowlist, so the distributed design adds zero new package-graph edges and zero
changes to the architecture-gate registration files.**

| Concern                                                                                                                                                                  | Home (existing package)                                                                            | Reuse / extend                                                                                                                                                                    | Child issue  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Enhanced Prompt contracts, task taxonomy (≥10 classes), profile catalog, scoring-dimension and retrieval-plan / safety-annotation / evidence-manifest shapes, validators | `keiko-contracts` new `src/prompt-enhancer.ts` (+ `prompt-enhancer-validation.ts`)                 | follow `memory-barrel.ts` / `connected-context.ts` / `workflow-handoff.ts` pattern                                                                                                | #1309        |
| Deterministic analyzer (raw input → normalized task analysis)                                                                                                            | `keiko-contracts` (pure) consumed by the workflow runtime                                          | new deterministic module; model-assisted classification only if §3 routing requires it                                                                                            | #1309        |
| Model-bound analyze / candidate / critic dispatch + enhancer task profiles                                                                                               | `keiko-model-gateway` new `src/promptEnhancer/`                                                    | reuse `buildPromptSegments`, `assertProfileCompatibleWithModel`, `*SafeError*`, budget, cancellation, replay cache; add profiles paralleling `QUALITY_INTELLIGENCE_TASK_PROFILES` | #1310, #1312 |
| Governed `analyze → plan → generate → score → validate` lifecycle + human-review handoff                                                                                 | `keiko-workflows` new `src/promptEnhancer/`                                                        | reuse `withStage`, `GovernorState`, `createScopedWriter`, descriptor pattern                                                                                                      | #1310, #1313 |
| Grounding plan + source policy emission                                                                                                                                  | `keiko-contracts` `GroundingPlan` contract/planner + `keiko-model-gateway` rendering               | reuse existing grounding vocabulary and ADR-0034/0036 source semantics; **emit a source policy, never execute retrieval**                                                          | #1311        |
| Candidate critic scoring + offline/live evaluation suite                                                                                                                 | `keiko-evaluations` + `keiko-contracts` `evaluations.ts`                                           | extend `SCORERS` map and `EVALUATION_DIMENSIONS`; reuse `runEvaluationSuite`, `createEvaluationModelProvider`, scorecard aggregation                                              | #1312, #1315 |
| Injection-pattern redaction, prompt-enhancement error taxonomy, fingerprinting                                                                                           | `keiko-security`                                                                                   | extend `BUILTIN_PATTERNS`; add a `PromptEnhancementError` code set; reuse `canonicalise`/`sha256Hex`, `sealString`                                                                | #1313        |
| Audit evidence (prompt version, applied rules, candidate scores, eval results)                                                                                           | `keiko-evidence` new `src/promptEnhancement/`                                                      | reuse `EvidenceStore` port + the QI store template (record → redact → hash → validate → write)                                                                                    | #1313        |
| BFF `/api/prompt-enhancer/*` routes                                                                                                                                      | `keiko-server`                                                                                     | reuse `API_ROUTES`, `UiHandlerDeps`, `readBody`/`parseBody`, `mappedGatewayError`, SSE helpers; bind Prompt Enhancer grounding plans to executable retrieval/readiness checks     | #1314        |
| CLI command                                                                                                                                                              | `keiko-cli`                                                                                        | reuse existing command/registration patterns                                                                                                                                      | #1314        |
| Governed UI surface (`PromptEnhancerPanel` sibling of `GroundedAnswerPanel`)                                                                                             | `keiko-ui`                                                                                         | reuse `KeikoSelect`, `SafeMarkdown`, `CitationReference`, `useSSE`; re-export wire types in `lib/types.ts`                                                                        | #1314        |

No edits to `scripts/check-package-graph.mjs`, `.dependency-cruiser.cjs`,
`tsconfig.packages.json`, or root `package.json` `bundleDependencies` are required for this default.

The runtime `score` stage of the workflow calls the `pe:critic` model profile through the gateway
and aggregates the result; it does **not** call `runEvaluationSuite`, so it introduces no
`keiko-workflows → keiko-evaluations` edge. `runEvaluationSuite` and the `keiko-evaluations` package
are the **offline regression-testing** infrastructure (issue #1315, run from `keiko-cli`, which
already depends on `keiko-evaluations`), not a runtime dependency of the enhancer workflow.

### 2. Documented alternative: a dedicated `@oscharko-dev/keiko-prompt-enhancer` leaf package

If, during #1309/#1310, the deterministic domain core (analyzer + taxonomy + profile catalog +
deterministic pre-scorers) grows large enough to warrant its own ownership and coverage gate, it may
be extracted into a leaf package with allowed dependencies `{contracts, security}`, mirroring
`@oscharko-dev/keiko-quality-intelligence`. This remains acyclic because those dependencies are
leaves. Taking this path requires, and is only justified by, the registration steps recorded in the
[blueprint](../prompt-enhancer/architecture-blueprint.md#9-gap-analysis):

1. add the package + its `{contracts, security}` allowlist entry, and add it to the `server` and
   `cli` consumer allowlists, in `scripts/check-package-graph.mjs`;
2. add `adr-0019-direction-3m-prompt-enhancer-only-contracts-security` to `.dependency-cruiser.cjs`
   and a negative fixture in `scripts/arch-check-negative.mjs` (`3m` is the next free letter after the
   current `3a`–`3l`; if concurrent work claims it first, take the next free `adr-0019-direction-3X`);
3. add a project reference in `tsconfig.packages.json`;
4. add the package to root `package.json` `bundleDependencies` (ADR-0021 bundled-product contract).

The model-bound, lifecycle, evidence, and evaluation parts stay distributed as in §1 regardless;
only the deterministic core is a candidate for extraction. The default in §1 is preferred until a
concrete ownership or coverage need is demonstrated, because §1 changes no architecture-gate files.

### 3. Productive model calls stay behind the Model Gateway; the analyzer is deterministic-first

All analyze, candidate-generation, and critic model calls route through `keiko-model-gateway` via the
QI dispatch primitives. No package outside `keiko-model-gateway` imports a provider SDK
(`adr-0019-trust-1-provider-sdk-isolation`). The first-stage analyzer is deterministic by default
(no model call); model-assisted classification is permitted only where a child issue documents the
need and routes through the gateway with a capability-gated profile. Enhanced prompts are
provider-neutral by construction; any model-specific optimisation is opt-in and governed by
capability metadata, never hard-coded model names.

### 4. The Orchestrator/workflow is the authority; the enhancer never self-authorizes

The `analyze → plan → generate → score → validate` lifecycle is a governed workflow under
`keiko-workflows`, bounded by `GovernorState` (tokens/calls/time) and emitting stage events through
`withStage`. The enhancer produces artefacts (Enhanced Prompt, retrieval plan, candidate scorecard,
safety annotations, evidence rows); it never grants tool-write, secret-access, egress, or patch
authority. Any downstream authority continues to flow through existing governed handoff and
human-review gates (`createScopedWriter`, `WorkflowHandoffRequest`, `UserApprovalTokenInput`). A
generated prompt is data, not a capability grant.

### 5. Trust boundaries

- **Untrusted input segregation.** Raw user input, retrieval output, and any external/tool output
  are untrusted and are placed in the untrusted-evidence channel of `buildPromptSegments` (NFKC
  normalisation + control-character stripping) before any model call; trusted instructions are never
  interpolated with untrusted text.
- **Redaction is distinct from validation.** Redaction (sanitise-before-model-call) and validation
  (reject-an-unsafe-artefact) are two different gates and neither substitutes for the other.
  Redaction runs inside `buildPromptSegments` and on every persisted leaf; the `keiko-security`
  injection `BUILTIN_PATTERNS` extension is defensive sanitisation only. The validate stage is a
  separate, prescriptive authority-grant check defined by the
  [validation rule model](../prompt-enhancer/architecture-blueprint.md#7-safety-strategy); it must
  not rely on redaction patterns alone.
- **A generated prompt is data, never a capability grant.** The Enhanced Prompt structure can never
  encode a claim that the downstream user should grant the enhancer tool, secret, egress, or patch
  access; the validate stage rejects prompts that make such claims; and no surface (server, CLI, UI)
  ever interprets a prompt as a capability token or secret.
- **Redaction before persistence.** Every Enhanced Prompt artefact and evidence row is passed
  through `keiko-security` `createAuditRedactor` / `deepRedactStrings` before it is written, reusing
  the `keiko-evidence` redact-by-construction path. Raw secrets, customer data, private runtime logs,
  and hidden system prompts are never persisted.
- **Safe errors.** Enhancer errors adopt a `qi/*`-style safe-error taxonomy: no error carries
  secrets, raw user input, untrusted-evidence text, or provider/deployment endpoints.
- **Evidence integrity.** Prompt version, applied rules, candidate scores, and evaluation results are
  traceable through the existing `EvidenceStore`, redacted and hashed (`canonicalise` + `sha256Hex`),
  with retention governed by the existing `RetentionPolicy` model.
- **No quality-gate weakening.** Architecture boundaries, security posture, evidence semantics,
  deterministic verification, and the required `ci` guarantees are preserved unchanged.

### 6. Evaluation and safety are first-class and regression-guarded

Candidate scoring covers clarity, completeness, grounding readiness, safety, output controllability,
and token efficiency, expressed as additional `EVALUATION_DIMENSIONS` and `SCORERS`. The MVP eval
suite (#1315) reuses `runEvaluationSuite` with checked-in deterministic fixtures and an offline
threshold gate, plus human-reviewed live runs, so prompt quality and safety cannot regress silently.
Safety guardrails for prompt injection, indirect injection, sensitive-data disclosure, insecure
output handling, excessive agency, and unsafe tool use are encoded as enhancer validation rules and
safety annotations and proved by fixtures.

## Consequences

### Positive

- **Zero new architecture-gate edges for the default.** Verified by inspecting the
  `ALLOWED_WORKSPACE_DEPENDENCIES` allowlist in `scripts/check-package-graph.mjs` (the edge lists
  quoted in the Context above): every package-to-package edge the §1 distribution relies on already
  exists, so the design cannot introduce a dependency cycle or contract leakage and `arch:check`,
  `arch:check:negative`, and `check:package-graph` are unaffected by the default plan.
- **Maximum reuse, minimum surface.** Each concern lands in its owning package behind a documented
  sub-module contract, directly satisfying the epic's no-duplication gate.
- **Proven precedent.** The shape is identical to Quality Intelligence, an already-shipped governed,
  model-using, evaluable, evidence-producing capability, lowering implementation and review risk.
- **Incrementally implementable.** The capability decomposes cleanly along the existing child-issue
  boundaries (#1309–#1315), each scoped to one or two packages with disjoint write ownership.

### Negative

- **The enhancer has no single source directory in the default.** Like QI, the domain logic spans
  several packages; the [blueprint](../prompt-enhancer/architecture-blueprint.md) and the contracts
  module index act as the single conceptual map. The §2 alternative exists for when this tradeoff
  becomes painful.
- **Additive surface in shared packages.** `keiko-security`, `keiko-evidence`, `keiko-evaluations`,
  `keiko-contracts`, and `keiko-model-gateway` each grow a prompt-enhancer concern; reviewers must
  hold the cross-package contract in mind. The contracts module is the coordination point.

### Neutral

- The grounding-plan boundary means the enhancer depends on the contract shape of source policy, not
  on `keiko-local-knowledge` internals. Runtime retrieval binding and scope-readiness checks remain
  server-owned #1314 work, preserving the existing grounding trust boundary (ADR-0022/0034/0036).
- Whether the Score/Validate stages make live model calls is left to #1312/#1313 within the gateway
  and governor budget; the blueprint records both options.

## Alternatives Considered

### Alternative 1: A dedicated full-stack `keiko-prompt-enhancer` package owning the whole capability

A single new package holding analyzer, planner, generator, critic, grounding planner, safety, and
evidence, consumed by server/cli/workflows/evaluations.

- **Pros**: one home for the domain; isolated coverage gate; superficially like a clean module.
- **Cons**: it would need `{contracts, security, model-gateway, workspace, evidence}` and would have
  to be added to five consumer allowlists plus four registration files, adding new package-graph
  edges where none are required; it would duplicate the QI distribution that already proves the
  existing boundaries suffice; productive model dispatch, governed lifecycle, and evidence writing
  belong to `model-gateway`, `workflows`, and `evidence` respectively and would be pulled out of
  their owning packages.
- **Why rejected**: violates the epic's no-new-subsystem default without a capability gap to justify
  it; the §1 distribution achieves the same outcome with zero new edges. The narrower leaf-package
  variant for the deterministic core only is retained as the §2 documented alternative.

### Alternative 2: Build the enhancer inside `keiko-harness` as another task

`keiko-harness` already builds `SYSTEM_PROMPT` + `userMessage` + `contextBlock` for unit tests, bug
investigation, and plan explanation, and is depended on by all consumers.

- **Pros**: no new sub-modules; reuses the existing task-plan dispatch (`resolveTaskPlan`).
- **Cons**: `keiko-harness` is the single-loop execution primitive, not a multi-stage governed
  domain; the enhancer's `analyze → plan → generate → score → validate` lifecycle, multi-candidate
  generation, and evidence production exceed the harness abstraction and belong to `keiko-workflows`
  and `keiko-evidence`. Harness lacks `workflows`, `evaluations`, and `evidence` in its allowlist by
  design, so the lifecycle and audit parts cannot live there without weakening that boundary.
- **Why rejected**: wrong altitude. The enhancer reuses harness _prompt-construction conventions_
  (the labeled system/user/context pattern) for its generator, but its governed lifecycle is a
  workflow, not a harness task. Harness reuse is retained at the convention level only.

### Alternative 3: Import a third-party prompt-optimization framework (APO/DSPy/Ragas-style)

Adopt an external automatic-prompt-optimization or RAG-evaluation framework as a dependency.

- **Pros**: ready-made optimisation loops and metrics.
- **Cons**: adds a heavy maintained dependency through the bundled-product supply chain (ADR-0021),
  conflicts with the deterministic-first and provider-neutral posture, and duplicates `keiko-
evaluations` scoring and `keiko-model-gateway` routing. The epic explicitly forbids importing such
  a framework unless a maintained dependency is proven necessary and compatible.
- **Why rejected**: the required behaviour (bounded candidate generation, deterministic scoring,
  offline+live evaluation) is already expressible with `keiko-evaluations` and the gateway; no
  capability gap justifies the dependency or its security/packaging cost.

## Related

- [ADR-0019](ADR-0019-modular-package-architecture.md) and
  [ADR-0020](ADR-0020-workspace-tooling-and-architecture-gate.md): the package architecture and the
  architecture gate this ADR places the enhancer within.
- [ADR-0021](ADR-0021-publish-strategy-bundled-monorepo-product.md): the bundled-product contract
  that any new package (the §2 alternative) must satisfy.
- [ADR-0022](ADR-0022-connected-context-privacy.md): the privacy contract for grounded answers and
  evidence retention that the enhancer's grounding plan and evidence rows uphold.
- [ADR-0034](ADR-0034-hybrid-multi-source-grounding.md) and
  [ADR-0036](ADR-0036-hybrid-grounding-reciprocal-rank-fusion.md): the hybrid grounding and RRF
  selection the retrieval planner targets without modification.
- [Prompt Enhancer architecture blueprint](../prompt-enhancer/architecture-blueprint.md): the
  operational reuse map, implementation sequencing, gap analysis, and risk register paired with this
  ADR.
- Epic [#1307](https://github.com/oscharko-dev/Keiko/issues/1307) and child issues #1309–#1315.

## Date

2026-06-20
