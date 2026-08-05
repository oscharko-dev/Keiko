import { describe, expect, it } from "vitest";

import { FIXTURE_ANSWER_CLAIMS, runGroundedRetrievalLatencyEval } from "./grounded-latency-eval.js";

// Audit KEIKO-0053. The gate script owns the budget decision; this suite owns the measurement's
// two load-bearing properties: it really runs both stages, and the injected-delay lever really
// moves the entailment measurement. Without the second, the gate's non-tautology proof is vacuous.

describe("runGroundedRetrievalLatencyEval", () => {
  it("measures both stages and reports their sum", async () => {
    const sample = await runGroundedRetrievalLatencyEval();

    expect(sample.retrievalMs).toBeGreaterThan(0);
    expect(sample.entailmentMs).toBeGreaterThan(0);
    expect(sample.totalMs).toBeCloseTo(sample.retrievalMs + sample.entailmentMs, 6);
  });

  // The entailment stage short-circuits a claim to `unavailable` WITHOUT calling the judge when the
  // cited excerpt exceeds `maxExcerptChars`. An over-long fixture would therefore skip every judge
  // call and the injected delay would measure nothing — the gate would report PASS over an
  // entailment pass that never ran. This pins that the fixture stays on the judged side of that
  // boundary: every cited claim must reach the judge, so the delay lands once per claim.
  //
  // The claim count comes from the module under test, not a literal here: a hard-coded 8 would keep
  // passing at a lower expectation the moment the fixture shrank, which is the failure this guards.
  it("routes every cited claim through the judge, so an injected delay is visible", async () => {
    const delayMs = 20;
    const sample = await runGroundedRetrievalLatencyEval({ injectedJudgeDelayMs: delayMs });

    expect(sample.entailmentMs).toBeGreaterThanOrEqual(delayMs * FIXTURE_ANSWER_CLAIMS);
  }, 30_000);

  // Relative, not an absolute millisecond ceiling: an absolute threshold is a wall-clock assertion
  // on a shared runner and would flake under load. The claim that matters is that the delay lever —
  // and only the delay lever — moves the number, so compare the two runs against each other.
  it("is inert when no delay is injected", async () => {
    const delayMs = 20;
    const clean = await runGroundedRetrievalLatencyEval({ injectedJudgeDelayMs: 0 });
    const delayed = await runGroundedRetrievalLatencyEval({ injectedJudgeDelayMs: delayMs });

    expect(clean.entailmentMs).toBeLessThan(delayed.entailmentMs - delayMs * 4);
  }, 30_000);
});
