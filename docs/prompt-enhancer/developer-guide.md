# Prompt Enhancer — Developer Guide

Epic: [#1307](https://github.com/oscharko-dev/Keiko/issues/1307) · ADR: [ADR-0044](../adr/ADR-0044-prompt-enhancer-architecture.md) · Blueprint: [architecture-blueprint.md](./architecture-blueprint.md)

This guide documents the Prompt Enhancer for engineers: its contracts, the deterministic pipeline,
the packages it reuses, the extension points, and the evaluation workflow that guards quality and
safety. For end-user behaviour (profiles, assumptions, grounding, safety limits) see the
[user guide](./user-guide.md). For the epic closure record see the
[closure evidence](./1315-closure-evidence.md).

## 1. What it is

The Prompt Enhancer turns a raw user draft into a structured, provider-neutral **Enhanced Prompt**: a
role, goal, ordered task decomposition, constraints, grounding rules, an output schema, quality
criteria, uncertainty handling, and safety rules. The transformation is **deterministic-first**: the
analyzer, planner, generator, critic, grounding planner, and safety assessor are all pure functions —
no model call, clock, or randomness — so identical input always yields an identical artefact and the
suite gives reproducible CI coverage. A model-assisted candidate/critic stage is an explicit later
option (ADR-0044 §3/§6); the MVP is fully deterministic.

The Enhanced Prompt is **data, never a capability grant** (ADR-0044 §4): it isolates the untrusted
user draft into a single `input` section, never self-authorizes tools, file writes, network egress, or
secret access, and routes risky requests to human review.

## 2. The deterministic pipeline

```
PromptEnhancementRequest
  └─ analyzePrompt(request)                       → PromptTaskAnalysis        (keiko-contracts)
       └─ planPromptEnhancement(analysis, opts)   → PromptEnhancementPlan     (keiko-model-gateway)
            └─ generateEnhancedPrompt({…})        → EnhancedPrompt            (keiko-model-gateway)
                 ├─ scorePromptCandidate({…})     → PromptCandidateScorecard  (keiko-model-gateway)
                 └─ assessPromptSafety({…})       → PromptSafetyAssessment    (keiko-model-gateway + keiko-security)
```

`generateEnhancedPrompt` internally calls `planGrounding` (keiko-contracts) so every Enhanced Prompt
carries a complete `groundingPlan` (always present, even when its strategy is `no-grounding`).

| Stage                                                                              | Module                                   | Entry point                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Analyze (taxonomy, domain, criticality, grounding need, output schema, risk flags) | `keiko-contracts`                        | `analyzePrompt`                                                       |
| Grounding policy                                                                   | `keiko-contracts`                        | `planGrounding`                                                       |
| Plan (profile, reasoning strategy/depth, token budget, safety posture)             | `keiko-model-gateway`                    | `PromptEnhancer.planPromptEnhancement`                                |
| Generate the structured artefact                                                   | `keiko-model-gateway`                    | `PromptEnhancer.generateEnhancedPrompt`                               |
| Deterministic critic (6 quality dimensions)                                        | `keiko-model-gateway`                    | `PromptEnhancer.scorePromptCandidate`                                 |
| Candidate generation + bounded optimization                                        | `keiko-model-gateway`                    | `PromptEnhancer.generatePromptCandidates`, `optimizePromptCandidates` |
| Validate / safety assessment                                                       | `keiko-model-gateway` + `keiko-security` | `PromptEnhancer.assessPromptSafety`, `detectPromptInjectionSignals`   |
| Structural safety (pure)                                                           | `keiko-contracts`                        | `assessEnhancedPromptStructuralSafety`                                |
| Evidence record (redact → hash → validate → write)                                 | `keiko-evidence`                         | `recordPromptEnhancementRun`                                          |

## 3. Contracts surface (`keiko-contracts`)

The wire-safe shapes and the deterministic analyzer live in the leaf package so every layer can depend
on them without introducing graph edges.

- **Task taxonomy** — `PromptTaskClass` / `PROMPT_TASK_CLASSES`: 15 classes (`factual-qa`, `research`,
  `rag-question-answering`, `summarization`, `structured-extraction`, `data-analysis`,
  `code-generation`, `code-debugging`, `code-architecture`, `writing-editing`, `creative-writing`,
  `decision-support`, `agentic-tool-use`, `prompt-optimization`, `safety-critical`). `factual-qa` is
  the conservative default; `safety-critical` is an override for consequential advice in a
  legal/medical/finance/security domain.
- **Analyzer result** — `PromptTaskAnalysis`: `taskClass`, `domain`, `criticality`, `groundingNeed`,
  `outputSchema`, `missingContext`, `riskFlags`, `recommendedProfile`, content-light `signals`.
- **Enhanced Prompt** — `EnhancedPrompt`: `role`, `goal`, `context`, `input`, `taskDecomposition`,
  `constraints`, `groundingRules`, `groundingPlan`, `outputSchema`, `qualityCriteria`,
  `uncertaintyHandling`, `safetyRules`.
- **Grounding** — `GroundingPlan` (`strategy`, `required`, `sourcePriority`, `citation`, `directives`,
  `noAnswerConditions`, `ragEvaluation`, pinned `untrustedContent: true`); `GroundingStrategy` (6),
  `GroundingDirective` (6), `CitationDiscipline` (4).
- **Critic** — `PromptCriticDimension` / `PROMPT_CRITIC_DIMENSIONS` (clarity, completeness,
  grounding-readiness, safety, output-controllability, token-efficiency); `PromptCandidateScorecard`.
- **Safety** — `assessEnhancedPromptStructuralSafety`, `PromptSafetyAssessment`
  (`decision` ∈ {accepted, requires-human-review, rejected}; `verificationStatus` ∈
  {passed, passed-with-review, failed}; `findings`; `leastPrivilege`), `requiresHumanReviewForAnalysis`,
  `leastPrivilegeForAnalysis`.

## 4. Capability reuse (AC3)

The Prompt Enhancer adds **zero new package-graph edges** (ADR-0044 §1). It composes existing Keiko
capabilities:

- **Model Gateway** — All productive model access stays behind the gateway. The enhancer sub-module
  lives in `keiko-model-gateway/src/promptEnhancer/` (mirroring Quality Intelligence) and exposes the
  planner, generator, renderers, critic, candidate generation/optimization, and the validate stage. The
  MVP makes no model call; when a model-assisted stage is added it dispatches through the gateway's
  governed `ModelPort`, never directly.
- **Local Knowledge** — Grounding is _planned_, not executed, by the enhancer. The `GroundingPlan`
  selects strategies (`local-knowledge`, `repository-context`, `supplied-context-only`, `hybrid`,
  `external-research-required`) and a source priority; the Orchestrator/retrieval layer performs the
  actual retrieval against Local Knowledge at run time. Retrieved content is pinned untrusted
  (`untrustedContent: true`).
- **Evaluation** — The offline regression suite is the `keiko-evaluations` `PromptEnhancerEval`
  sub-module (§6). It reuses the package, its deterministic-fixture authoring style, and its
  scorecard/Go-No-Go shape.
- **Security** — `keiko-security` owns the authoritative, content-free, ReDoS-safe prompt-injection
  detector (`detectPromptInjectionSignals`) and the secret detector (`containsRedactableSecret`), plus
  the `PromptEnhancerError` taxonomy. The validate stage composes these signals into the safety
  assessment.
- **Evidence** — `keiko-evidence` `PromptEnhancement` writes a versioned, redacted, integrity-hashed
  manifest (`recordPromptEnhancementRun`) following the Quality Intelligence template
  (record → redact → hash → validate → write). The original draft is stored only as a SHA-256
  fingerprint plus a redacted, truncated excerpt — never raw text (AC4 of #1313). Current manifest
  schema: `PROMPT_ENHANCEMENT_EVIDENCE_SCHEMA_VERSION = 2`.

## 5. Extension points

- **Add a task class** — extend `PromptTaskClass` / `PROMPT_TASK_CLASSES` (`prompt-enhancer.ts`); add
  a `TaskClassRule` (strong/weak lexical cues), a `DEFAULT_FORMAT_BY_CLASS` entry, and a
  `recommendProfile` / `PROFILE_BY_TASK_CLASS` mapping in `prompt-enhancer-analyzer.ts`; and a role/goal
  template in `generator.ts`. The exhaustiveness helper `assertNeverTaskClass` forces every switch to
  handle the new member at compile time.
- **Add a generation profile** — extend the profile id union and add an entry to
  `PROMPT_ENHANCER_EXECUTION_PROFILES` (`profiles.ts`: token budget, reasoning strategy/depth, section
  caps, `groundingMandatory`). The planner and generator read profile metadata; they do not hard-code
  caps.
- **Add a grounding strategy / directive** — extend the grounding vocabularies in
  `prompt-enhancer.ts` and the `SOURCE_PRIORITY_BY_STRATEGY` / `RETRIEVAL_MODES_BY_STRATEGY` tables in
  `prompt-enhancer-grounding.ts`.
- **Add an evaluation fixture** — see §6.
- **Add an evaluation dimension** — extend `PROMPT_QUALITY_DIMENSIONS` and add a scorer arm in
  `keiko-evaluations/src/promptEnhancer/scorer.ts`; the aggregation and renderer iterate the constant,
  so no other change is required.

## 6. Evaluation workflow (#1315)

The suite lives in `keiko-evaluations/src/promptEnhancer/`, exposed from the package barrel as the
`PromptEnhancerEval` namespace.

**Design.** It is a _parallel_ prompt-quality harness, distinct from the agent-trajectory
`runEvaluationSuite` / `EVALUATION_DIMENSIONS` (see the ADR-0044 §6 implementation note for the
rationale). It runs the deterministic pipeline over checked-in fixtures and scores eight prompt-quality
dimensions against per-fixture oracles, then aggregates a Go/No-Go scorecard.

**Dimensions (AC1).** `clarity`, `completeness`, `groundedness`, `faithfulness`, `format-adherence`,
`safety`, `task-success`, `token-efficiency`. Each combines a **structural gate** (presence of the
mandated apparatus — task structure, grounding directives, safety rules, output schema) with the
fixture oracle and, where useful, a floor on the deterministic critic's continuous score. The
structural gate is what makes the suite regression-sensitive (AC2).

**Fixtures.** 26 checked-in fixtures across five categories: `task-class` (one per supported class —
all 15 covered, the issue requires ≥10), `grounding` (required-from-supplied, required-from-external,
not-required), `adversarial` (instruction-override, secret-exfiltration, tool-authority), `format`
(table, YAML, prose), and `token-efficiency` (lean vs thorough). Fixtures are pure value modules;
register a new one in `fixtures/index.ts` (`ALL_PROMPT_ENHANCER_FIXTURES`).

**Run it.**

```bash
# Dedicated, documented gate (builds packages, then runs only the eval suite):
npm run eval:prompt-enhancer

# Or programmatically (deterministic, no live model):
#   import { PromptEnhancerEval } from "@oscharko-dev/keiko-evaluations";
#   const scorecard = PromptEnhancerEval.runPromptEnhancerEvaluation();
#   console.log(PromptEnhancerEval.renderPromptEnhancerSummary(scorecard));
```

**CI.** The suite's `*.test.ts` files run automatically inside the required `ci` job's coverage gate
(`test:coverage:quality` → `test:coverage:packages`, whose glob is `packages/*/src/**/*.test.ts`), so
prompt quality and safety cannot regress silently. The `eval:prompt-enhancer` script is the explicit,
operator-runnable form of the same suite.

**Regression guarantee (AC2).** `scorer.test.ts` takes a passing observation, removes exactly one piece
of the mandated apparatus, and asserts the relevant dimension flips to FAIL:

| Removed apparatus                    | Dimensions that fail                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| Task structure (`taskDecomposition`) | `clarity`, `completeness`                                   |
| Grounding rules + directives         | `groundedness`, `faithfulness`                              |
| Safety rules                         | `safety` (and the re-assessed decision flips to `rejected`) |
| Structured output schema             | `format-adherence`                                          |

## 7. Determinism and the token model

Every stage is pure. The token estimate is a coarse, model-independent heuristic
(`CHARS_PER_TOKEN = 4`) applied consistently to every candidate, so candidate comparison is fair and
the optimization-loop budget is reproducible; it is **not** a provider tokenizer. The eval's
`token-efficiency` dimension scores instruction leanness via the critic's continuous score plus an
optional full-render ceiling — it deliberately does not compare the full rendered estimate against the
profile's instruction-token budget (those are different quantities).
