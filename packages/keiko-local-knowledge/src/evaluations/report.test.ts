import { describe, expect, it } from "vitest";

import { singleTopicFixture } from "./fixtures.js";
import { renderRetrievalEvalQualityGateReport } from "./report.js";
import { runRetrievalEval } from "./runner.js";

describe("renderRetrievalEvalQualityGateReport", () => {
  it("renders deterministic markdown from scorecards", async () => {
    const scorecard = await runRetrievalEval(singleTopicFixture);
    const report = renderRetrievalEvalQualityGateReport([scorecard]);
    expect(report).toContain("# Local Knowledge Retrieval Quality Gate");
    expect(report).toContain("| Fixture | Recall | Precision | Isolation | Citation | No-evidence | Context budget | Latency | Pass |");
    expect(report).toContain("| single-topic | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |");
    expect(report).toContain("PASS");
  });
});
