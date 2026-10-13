import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

describe("selection quality activity evidence", () => {
  it("formats actual calibrated floors and confidence on the shared correlation", async () => {
    const log = createBufferedServerLogSink();
    const { pack } = await runConnectedRetrievalEval({
      files: { "src/Feature/validation.ts": "export const testFact = 73;\n" },
      query: "Explain src/Feature/validation.ts",
      activityLog: log,
      correlationId: "selection-quality-proof",
    });
    const event = log.events.find(
      (entry) => entry.op === "search.connected-context.selection-details",
    );
    expect(event?.extra).toMatchObject({
      keepOneFallbackApplied: false,
      selectionConfidence: "high",
      rerankerDisposition: "unconfigured",
      reranked: false,
      rerankFailedCalls: 0,
      addressedBasenameDedupDemotedCount: 0,
    });
    expect(event?.extra?.absoluteFloorPermille).toBe(
      pack.diagnostics?.selection?.absoluteFloorPermille,
    );
    expect(event?.correlationId).toBe("selection-quality-proof");
    const line = formatActivityLogProofLine(event ?? {});
    expect(line).not.toContain("validation.ts");
    expectActivityLogProof("search.connected-context.selection-quality.line", line);
  });
});
