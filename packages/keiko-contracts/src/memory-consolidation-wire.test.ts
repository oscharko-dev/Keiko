import { describe, expect, it } from "vitest";
import type {
  MemoryConsolidationJobResponseWire,
  MemoryConsolidationResultWire,
} from "./memory-consolidation-wire.js";
import type { MemoryId } from "./memory.js";

describe("memory consolidation BFF wire contracts", () => {
  it("keeps review evidence and conflict counts on the shared result wire", () => {
    const memoryIds = ["mem-1" as MemoryId, "mem-2" as MemoryId] as const;
    const result = {
      state: "completed",
      edgesProposed: [],
      updatesProposed: [],
      summaryStatus: {
        kind: "not-configured",
        updatesProposed: 0,
        skippedMergeClusters: 0,
        fallbacksUsed: 0,
      },
      staleFlags: [],
      reviewItems: [
        {
          id: "review-1",
          reason: "potential-conflict",
          relatedMemoryIds: memoryIds,
          evidence: [
            {
              kind: "negation-polarity",
              memoryIds,
              score: 0.91,
              threshold: 0.8,
            },
          ],
          detectedAt: 1_700_000_000_000,
        },
      ],
      clustersInspected: 2,
      conflictPairsDetected: 1,
      recordsInspected: 4,
      truncated: false,
      elapsedMs: 0,
    } satisfies MemoryConsolidationResultWire;

    const response = {
      job: {
        job: { id: "job-1", state: "completed", result },
        createdAt: 1_700_000_000_000,
        selection: { scopes: [{ kind: "global" }], includeExpired: false },
        settings: {
          jaccardThreshold: 0.8,
          staleConfidenceThreshold: 0.35,
          maxAgeMs: 30,
          maxClustersPerRun: 50,
          maxRecordsPerRun: 500,
        },
        memoryCount: 4,
        cancelRequested: false,
      },
    } satisfies MemoryConsolidationJobResponseWire;

    expect(response.job.job.result.conflictPairsDetected).toBe(1);
    expect(response.job.job.result.reviewItems[0]?.evidence[0]?.kind).toBe("negation-polarity");
  });
});
