# Issue #749 - Adversarial Test-Quality Judge Verification

## Context

Issue [#749](https://github.com/oscharko-dev/Keiko/issues/749) verifies the adversarial
test-quality judge delivered under Epic [#736](https://github.com/oscharko-dev/Keiko/issues/736).
The issue scope is verification-only: prove that the existing Keiko seams flag a deliberately weak
test with a clear rationale, lower the run quality score, keep the judge behind the Model Gateway,
and keep persisted/UI evidence redaction-safe.

Implementation lineage inspected for this release note:

- Initial Epic implementation: [PR #785](https://github.com/oscharko-dev/Keiko/pull/785),
  merge `9d1899b`.
- Rationale/source-grounding hardening: [PR #813](https://github.com/oscharko-dev/Keiko/pull/813),
  merge `358ce360`.
- Live judge hardening and no-mock evidence: [PR #843](https://github.com/oscharko-dev/Keiko/pull/843),
  merge `84b04ec2`.
- Release-targeted judge audit hardening: [PR #1074](https://github.com/oscharko-dev/Keiko/pull/1074),
  merge `25ba1a91`.
- Weak-flag truncation hardening: [PR #1076](https://github.com/oscharko-dev/Keiko/pull/1076),
  merge `2e8dfaab`.

## Acceptance Evidence

| #749 acceptance point                      | Release evidence                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A deliberately weak test is flagged        | Workflow weak findings are candidate-scoped `test-quality` findings in `packages/keiko-workflows/src/qualityIntelligence/modelRoutedTestDesign.ts` (`buildTestQualityFinding`, `runJudgeStage`). The server BFF projects those findings into candidate `weakTestFlag` values in `packages/keiko-server/src/qualityIntelligence/uiRoutes.ts` (`buildWeakTestFlags`). |
| The flag carries a clear judge rationale   | `judgeRationaleSummary` derives the persisted summary from the weakest rubric dimensions, and `WeakTestFlag` renders that redacted rationale as an accessible note in `packages/keiko-ui/src/app/components/desktop/widgets/quality-intelligence/qiShared.tsx`.                                                                                                     |
| The run quality score is lowered           | `runJudgeStage` computes `qualityScore` as the percentage of strong outcomes; weak verdicts, gateway failures, budget overflow, and local oversize guards all count as weak outcomes.                                                                                                                                                                               |
| The judge is gateway-confined              | `packages/keiko-server/src/qualityIntelligence/judgePort.ts` builds the judge from `deps.modelPortFactory`, applies the `qi:judge-logic` capability gate, and calls only the injected gateway `ModelPort`; bypass guards cover the server and workflow package boundaries.                                                                                          |
| No secrets leak into persisted/UI evidence | `executeQiRun` threads `currentRedactionSecrets` into workflow persistence, and `recordQualityIntelligenceRun` deep-redacts persisted findings. The #749 regression test proves a configured provider secret is redacted from both the manifest finding and run-detail `weakTestFlag`.                                                                              |

## Live Verification

PR #843 recorded the no-mock live verification against the configured Azure-compatible gateway model
(`gpt-oss-120b`). The live run used a checkout-oriented source with one deliberately weak generated
test and one strong control test:

- Weak candidate: `Validate order total includes shipping cost`.
- Strong control: `Prevent checkout when cart is empty`.
- Observed outcome: the weak candidate was flagged with a judge rationale covering determinism and
  acceptance-criteria fidelity; the strong control was unflagged.
- Observed run quality score: `68`, lower than a fully strong run.
- Observed audit count: `modelGatewayCallCount = 26` for one generation dispatch plus 25 judge
  dispatches in the live run.
- Observed safety: the judge used the Model Gateway path; no direct provider SDK or external write
  path was introduced.

This note intentionally records only sanitized, reviewable evidence. It does not include raw model
output, prompts, local runtime logs, credentials, environment values, customer data, screenshots, or
private test-data contents.

## Release Regression Coverage

The release branch pins the live proof with deterministic tests that use fake gateway ports and a
real on-disk evidence store:

```text
npm exec -- vitest run \
  packages/keiko-quality-intelligence/src/__tests__/testQualityRubric.test.ts \
  packages/keiko-server/src/qualityIntelligence/__tests__/judgePort.test.ts \
  packages/keiko-workflows/src/qualityIntelligence/__tests__/modelRoutedTestDesign.test.ts \
  packages/keiko-server/src/qualityIntelligence/__tests__/runExecution.test.ts \
  packages/keiko-server/src/qualityIntelligence/__tests__/uiRoutes.test.ts \
  packages/keiko-server/src/qualityIntelligence/__tests__/serverQiBypassGuard.test.ts \
  packages/keiko-workflows/src/qualityIntelligence/__tests__/workflowsQiBypassGuard.test.ts \
  packages/keiko-model-gateway/src/qualityIntelligence/__tests__/routingBypassGuard.test.ts

npm --workspace packages/keiko-ui test -- \
  QiRunCard.test.tsx CandidatesPane.test.tsx QiRunCard.a11y.test.tsx \
  CandidatesPane.a11y.test.tsx globals.css.test.ts
```

Additional release-audit tests added for #749:

- `runExecution.test.ts` proves the end-to-end server path:
  `executeQiRun` -> on-disk QI evidence -> `handleGetQiRun`, with one strong and one weak judge
  verdict. It asserts `qualityScore = 50`, exactly one `weakTestFlag`, a redacted rationale, and
  `modelGatewayCallCount = 3` (one generation dispatch plus two judge dispatches).
- `runExecution.test.ts` proves that an oversized judge prompt returns the local safe weak verdict
  before `model.call`; the run is still flagged weak, but `modelGatewayCallCount` remains `1`
  because only the generation request reached the gateway.
- `modelRoutedTestDesign.test.ts` proves workflow compatibility with judge ports that report zero
  gateway dispatches for local guarded verdicts.
- `judgePort.test.ts` proves the actual server judge port reports `gatewayCallCount = 1` for a
  gateway-backed verdict and `gatewayCallCount = 0` for the prompt-budget local guard.

## Residual Risk

The live evidence remains historical PR evidence rather than a CI live-provider call. CI deliberately
uses fake gateway ports so it does not depend on external provider availability, credentials, network
policy, or customer data. Broader runtime budget work, such as enforcing advisory per-stage timeout
semantics across all QI stages, is outside #749's verification-note and missing-test scope.
