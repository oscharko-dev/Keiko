import { describe, expect, it } from "vitest";

import { singleTopicFixture } from "./fixtures.js";
import { renderRetrievalEvalQualityGateReport } from "./report.js";
import { runRetrievalEval } from "./runner.js";

describe("renderRetrievalEvalQualityGateReport", () => {
  it("renders deterministic markdown from scorecards", async () => {
    const scorecard = await runRetrievalEval(singleTopicFixture);
    const report = renderRetrievalEvalQualityGateReport([scorecard]);
    expect(report).toContain("# Local Knowledge Retrieval Quality Gate");
    expect(report).toContain(
      "| Fixture | Recall | Precision | MRR | nDCG | Isolation | Citation | No-evidence | Context budget | Latency | Outcomes | Pass |",
    );
    expect(report).toContain("Thresholds: recall>=0.900");
    expect(report).toContain("context-budget>=1.000");
    expect(report).toContain(
      "| single-topic | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |",
    );
    expect(report).toContain("queries=1; refs=2; no-evidence=0/0; reasons=none");
    expect(report).toContain("PASS");
    expect(report).not.toContain("PASS | |");
  });
});
