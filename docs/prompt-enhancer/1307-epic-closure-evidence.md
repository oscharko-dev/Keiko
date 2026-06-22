# Epic #1307 — Closure Evidence (Prompt Enhancer with grounding, evaluation, and safety)

Epic: [#1307](https://github.com/oscharko-dev/Keiko/issues/1307) · ADR:
[ADR-0044](../adr/ADR-0044-prompt-enhancer-architecture.md) · Branch: `feat/prompt-enhancer-1307` ·
Verified at HEAD `6d3c521a`.

This document is the umbrella closure record for the Prompt Enhancer epic. It aggregates the eight
child deliverables (#1308–#1315) into a single Definition-of-Done ledger, records a fresh verification
run of every required gate at the current branch head, and states the residual risks and follow-ups.
Child issue #1315 owns the evaluation-suite closure gate
([1315-closure-evidence.md](./1315-closure-evidence.md)); this document is the epic-level roll-up that
authorises closing #1307 itself.

## Outcome

**GO for closure.** All seven Target Outcomes and the functional Definition of Done are met with
deterministic implementation and passing regression tests. The MVP turns a raw prompt into a structured,
safe, grounded, evaluable, model-agnostic Enhanced Prompt, exposed through governed API, CLI, and UI
surfaces, with audit evidence and an eight-dimension evaluation scorecard. No architecture boundary,
quality gate, security posture, evidence semantic, or deterministic-verification guarantee was weakened:
the capability ships as governed `promptEnhancer/` sub-modules across existing packages with **zero new
package-graph edges** (ADR-0044, Quality Intelligence pattern).

## Child issue matrix

All eight child issues are **closed / completed** with `status: done` and their implementations merged
into `feat/prompt-enhancer-1307`. Each child issue carries its own reuse/extension rationale (epic
Definition of Done: "Reuse, extension, or generalization decisions are recorded for every implemented
child issue").

| Issue | Title                                              | State              | Feature squash     | Hardening follow-ups                   |
| ----- | -------------------------------------------------- | ------------------ | ------------------ | -------------------------------------- |
| #1308 | Architecture and reuse blueprint (ADR-0044)        | Closed / completed | `4df8a474` (#1324) | —                                      |
| #1309 | Enhanced Prompt contracts, taxonomy, analyzer      | Closed / completed | `7b8d2a76` (#1328) | `7369256c` (#1330)                     |
| #1310 | Planner profiles and structured generator          | Closed / completed | `a4cfb2ee` (#1331) | `14e8d855` (#1335)                     |
| #1311 | Grounding and retrieval planning                   | Closed / completed | `3cead4c5` (#1336) | `a6aca62d` (#1339)                     |
| #1312 | Candidate generation, critic scoring, optimization | Closed / completed | `03de8c20` (#1340) | `d74c5ca2` (#1342), `f5f9f626` (#1344) |
| #1313 | Safety guardrails, validation, audit evidence      | Closed / completed | `52a0da8f` (#1346) | `8f2d3789` (#1348)                     |
| #1314 | Governed API, CLI, UI surfaces                     | Closed / completed | `ab43fadd` (#1349) | `628c5ab0` (#1351), `97bbf595` (#1357) |
| #1315 | Evaluation suite, documentation, closure           | Closed / completed | `a4c98d90` (#1352) | `bfdf0ee5` (#1353), `6d3c521a` (#1359) |

Each feature PR was followed by an independent adversarial-review (`codex/*-audit-*`) follow-up PR; the
hardening commits above are net strengthenings (see _Post-#1315 hardening_).

## Definition of Done ledger

| Definition-of-Done item                                                         | Status | Evidence                                                                                                                                      |
| ------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| All child issues closed with acceptance criteria and verification updated       | Met    | #1308–#1315 all closed / completed, `status: done` (table above)                                                                              |
| Required GitHub checks green on implementation PRs                              | Met    | Every child PR merged green; the required `ci` gates re-run green at HEAD `6d3c521a` (_Verification_)                                         |
| Reuse / extension / generalization decisions recorded per child                 | Met    | ADR-0044 §1 reuse table; each child PR's Reuse-and-No-Duplication section; zero new package-graph edges                                       |
| Final closure evidence recorded in the epic or final child issue                | Met    | [1315-closure-evidence.md](./1315-closure-evidence.md) + this epic-level document + the epic closure comment                                  |
| Known limitations and follow-ups documented                                     | Met    | _Known limitations_ and _Residual risks and follow-ups_ below; user-guide _Known safety limitation_                                           |
| MVP generates production-usable enhanced prompts from raw prompts               | Met    | `runPromptEnhancement` (`keiko-workflows/src/promptEnhancer/index.ts`); `@smoke` browser e2e drives the real app path                         |
| At least ten task classes are supported                                         | Met    | 15 classes in `PROMPT_TASK_CLASSES` (`keiko-contracts/src/prompt-enhancer.ts`); `suite.test.ts` "covers at least ten supported task classes"  |
| Grounding rules for research and factual tasks integrated                       | Met    | `planGrounding` (`keiko-contracts/src/prompt-enhancer-grounding.ts`); generator rendering; grounding fixtures                                 |
| Safety rules against injection, sensitive-data exposure, tool misuse integrated | Met    | `PROMPT_SAFETY_RULE_IDS` / `PROMPT_SAFETY_VIOLATION_CODES` (`prompt-enhancer-safety.ts`); `keiko-security/promptInjection.ts`; validate stage |
| Prompt candidates can be generated, scored, compared, and selected              | Met    | `optimizePromptCandidates` + critic (`keiko-model-gateway/src/promptEnhancer/{candidates,critic,optimize}.ts`); ranked-slate test             |
| Evaluation metrics cover the eight named dimensions                             | Met    | `PROMPT_QUALITY_DIMENSIONS` (8) in `keiko-evaluations/src/promptEnhancer/types.ts`; `suite.test.ts` exercises every dimension                 |
| Regression tests prevent prompt-quality or safety degradation                   | Met    | AC2 regression block in `scorer.test.ts` (removing apparatus flips the dimension to FAIL)                                                     |
| Developer and end-user documentation available                                  | Met    | [developer-guide.md](./developer-guide.md), [user-guide.md](./user-guide.md), [architecture-blueprint.md](./architecture-blueprint.md)        |

## Target Outcome ledger

| #   | Target Outcome                                                                        | Status | Key evidence                                                                                                                         |
| --- | ------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| TO1 | Raw request → structured Enhanced Prompt (11 named components)                        | Met    | `EnhancedPrompt` (`prompt-enhancer.ts`) + generator; `index.test.ts` "assembles a complete … enhanced prompt with every section"     |
| TO2 | ≥10 task classes, volatile/grounded detection, 7 profiles, assumptions/clarifications | Met    | 15 task classes; 7 profiles in `PROMPT_ENHANCER_EXECUTION_PROFILES`; analyzer volatile-grounding + missingContext                    |
| TO3 | ≥3 candidates ranked by 6 deterministic dimensions                                    | Met    | `optimizePromptCandidates`; six-dimension critic; ranked-slate + clamp tests (variation-admitting tasks)                             |
| TO4 | Grounding/retrieval/uncertainty/source-priority/citation/contradiction explicit       | Met    | `planGrounding` strategies + closed vocabularies; `untrustedContent: true`; grounding fixtures                                       |
| TO5 | Safety guardrails for the 6 named threat classes encoded in prompt + contracts        | Met    | Safety rule ids + violation codes cover channel-separation, untrusted-marker, secrecy, output-validation, authority, least-privilege |
| TO6 | Versions, rules, assumptions, scores, eval results traceable through evidence         | Met    | `keiko-evidence/src/promptEnhancement/` manifest + store + redaction (redact before persist); schema-versioned                       |
| TO7 | Evaluation suite + regression tests + docs prove no silent regression                 | Met    | 26 fixtures / 5 categories; Go/No-Go scorecard; AC2 regression gates; `eval:prompt-enhancer` → GO                                    |

The six TO5 threat classes map to the safety model as: **prompt injection** →
`untrusted-instruction-override` / `manipulative-instruction`; **indirect prompt injection** →
`trusted-untrusted-separation` / `untrusted-content-marked` / `missing-channel-separation`; **sensitive
information disclosure** → `no-secret-or-system-prompt-disclosure` / `secret-request` /
`system-prompt-disclosure`; **insecure output handling** → `output-validation-required` /
`missing-output-validation`; **excessive agency** → `no-authority-grant` / `human-review-for-risky-actions`;
**unsafe tool use** → `least-privilege-tool-access` / `missing-least-privilege`.

## Governed surfaces and architecture authority

- **Workflow authority.** The governed `analyze → plan → optimize → validate → evidence-record-input`
  lifecycle lives in `keiko-workflows/src/promptEnhancer/index.ts` (`runPromptEnhancement`). The server
  `orchestrate.ts` is a thin compatibility barrel; both the BFF route and the CLI call the **same**
  authority — no parallel model client exists on any surface.
- **Model Gateway.** The MVP is fully deterministic and dispatches no live model. The optional
  downstream-dispatch model id is resolved through the Model Gateway (`findConfiguredCapability`), and
  `modelRouting` reports a graceful degraded state when no gateway config is present. The routing
  projection is credential-free (#1357): `runPromptEnhancement` receives a `ConfiguredCapabilitySource`
  (`{ providers: [{ modelId }], capabilities? }`), never the credential-bearing `GatewayConfig`.
- **API / CLI / UI.** BFF route `POST /api/prompt-enhancement` (`keiko-server/src/promptEnhancer/routes.ts`,
  CSRF-guarded); CLI command (`keiko-cli/src/prompt-enhancer.ts`); UI `PromptEnhancerPanel.tsx` with
  jest-axe WCAG 2.2 AA coverage on the empty form and a populated result. A `@smoke` Playwright e2e
  (`tests/e2e/prompt-enhancer-smoke.spec.ts`) drives the real app path (route + UI workflow) and captures
  a screenshot; it runs in the CI `ui` job. The enhanced prompt is presented for review and never
  executed (AC5).

## Verification performed

Re-run locally against `feat/prompt-enhancer-1307` HEAD `6d3c521a`. These are the same gates the required
`ci` job (and the `ui` job) run; `ci` triggers on `feat/prompt-enhancer-1307`.

| Gate                              | Command                             | Result                                                            |
| --------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Typecheck (+ package-graph)       | `npm run typecheck`                 | PASS                                                              |
| Version consistency               | `npm run check:version-consistency` | PASS                                                              |
| Lint (packages + UI)              | `npm run lint`                      | PASS                                                              |
| Architecture (dependency graph)   | `npm run arch:check`                | PASS                                                              |
| Architecture (negative)           | `npm run arch:check:negative`       | PASS                                                              |
| Quality-Intelligence supply chain | `npm run check:qi-supply-chain`     | PASS                                                              |
| Coverage quality gate             | `npm run test:coverage:quality`     | PASS (packages 572 files / 9656 tests; UI 152 files / 2271 tests) |
| Prompt Enhancer eval suite        | `npm run eval:prompt-enhancer`      | PASS (6 files / 42 tests; **GO** verdict)                         |
| Build + CLI/UI assets             | `npm run build && build:ui`         | PASS                                                              |
| Package surface                   | `npm run check:package-surface`     | PASS (2974 files; `dist/ui/static` present)                       |

**Quality-gate integrity (no weakening).** Across the full prompt-enhancer commit range
(`4df8a474^..6d3c521a`): `docs/qa/package-coverage-baseline.json` is byte-identical (no floor lowered);
`scripts/check-package-graph.mjs` and `.dependency-cruiser.cjs` are untouched (zero new edges); the only
root-surface change is the namespaced `PromptEnhancer` export plus two credential-free routing types
(`ConfiguredCapabilityProvider`, `ConfiguredCapabilitySource`) added to
`scripts/root-package-surface.contract.json`. No new top-level package was created.

**Adversarial closure verification.** A 13-agent adversarial workflow mapped every Target Outcome and DoD
item to live code and tests and returned **GO with zero blockers and zero highs**. All seven Target
Outcomes, the eight-dimension eval DoD, the three governed surfaces, and the gate-integrity invariants are
`met` with high confidence and cited passing tests. The single non-`met` dimension was a low-severity
documentation drift (the #1315 closure record still described #1314's issue as open); that drift is fixed
in this PR.

## Post-#1315 hardening

Four follow-up commits landed after the #1315 closure snapshot; all are net strengthenings, fully landed
on a clean HEAD:

- **#1351 `628c5ab0`** — closed governed-surface gaps; relocated orchestration into the
  `keiko-workflows` authority (zero new edges); `redactAllStrings` now replaces every string leaf with a
  fixed marker before any evidence hash when opaque credentials are configured.
- **#1353 `bfdf0ee5`** — split the AC2 regression gates so each removes exactly one apparatus piece with a
  baseline-pass assertion; added per-adversarial injection-code and content-free-rationale tests; doc
  accuracy fixes (one production change: a 4-line explanatory comment on `scoreFaithfulness`).
- **#1357 `97bbf595`** — keep prompt-enhancer routing config credential-free
  (`ConfiguredCapabilitySource` projection). This PR adds a behavioural regression test pinning the
  projection's drop behaviour (`promptEnhancementGatewayRoutingConfig` strips `apiKey` / `baseUrl` /
  topology) against a future spread-regression.
- **#1359 `6d3c521a`** — return an inspectable `rejected` fail-safe for safety-critical advice instead of
  throwing; the fail-safe re-runs `assessPromptSafety` and re-throws the original error unless the
  decision is genuinely `rejected`, so it can never silently authorise an unsafe prompt.

## Known limitations

- **Safety-critical advice is rejected, not routed to review.** Consequential advice in a safety-critical
  domain is returned as an inspectable `rejected` fail-safe (decision `rejected`, verificationStatus
  `failed`); the intended longer-term behaviour is `requires-human-review`. The evaluation pins the
  rejected outcome so it cannot regress silently. Follow-up: #1310 / #1313.
- **Deterministic MVP only.** Critic and candidate scoring are deterministic; a model-assisted
  LLM-as-judge stage and calibration study are out of scope.
- **Heuristic token estimate.** Token counts use a coarse `CHARS_PER_TOKEN = 4` heuristic, reproducible
  but approximate.
- **Grounding is planned, not executed.** The suite verifies the grounding plan; live retrieval is the
  Orchestrator / Local Knowledge concern at run time.

## Residual risks and follow-ups

- **Cue-table-based detection.** Safety detection is closed cue-table / substring based (hardened against
  Unicode / zero-width / bidi obfuscation) and inherently incomplete against novel paraphrases. Mitigated
  by defense-in-depth — untrusted input is isolated as data, the least-privilege baseline denies all by
  default, and no live model is dispatched — so a missed cue cannot silently authorise anything; at worst
  it escalates to review. The cue tables are load-bearing and need ongoing maintenance via the #1315
  adversarial fixtures.
- **Structural gateway seam.** Because the MVP wires no live `ModelPort`, the "model calls behind the
  Gateway" invariant is currently satisfied structurally (the `GatewayConfig` seam exists) rather than by
  an exercised live-model path. There is no bypass; a future model-assisted critic must re-verify this
  end-to-end.
- **Correct-by-construction guarantees not yet behaviourally pinned.** Cross-surface AC1 byte-identical
  parity (CLI vs server orchestrate path) is guaranteed by the shared `runPromptEnhancement` import and by
  the determinism test, but not by an explicit cross-surface diff test. Recommended fast-follow (recorded
  in [1315-closure-evidence.md](./1315-closure-evidence.md) follow-ups).
- **Volatile-grounding branch coverage.** Two of three volatile-grounding detection branches
  (named-current-event, market-or-price) are implemented but not yet exercised by a fixture.

## References

- ADR-0044 — Prompt Enhancer architecture, package ownership, trust boundaries.
- [1315-closure-evidence.md](./1315-closure-evidence.md), [developer-guide.md](./developer-guide.md),
  [user-guide.md](./user-guide.md), [architecture-blueprint.md](./architecture-blueprint.md).
- Epic #1307; child issues #1308–#1315.

_Signed-off-by: Claude coordinator implementation team._
