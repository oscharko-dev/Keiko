import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ConsolidationResult } from "@oscharko-dev/keiko-memory-consolidation";
import { buildConsolidationJob, transitionJob } from "@oscharko-dev/keiko-memory-consolidation";
import { createConsolidationJobRegistry } from "./memory-consolidation-registry.js";

function emptyResult(): ConsolidationResult {
  return {
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
    reviewItems: [],
    clustersInspected: 0,
    conflictPairsDetected: 0,
    recordsInspected: 0,
    truncated: false,
    elapsedMs: 0,
  };
}

describe("createConsolidationJobRegistry persistence", () => {
  it("restores completed job results from the evidence snapshot", () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const registry = createConsolidationJobRegistry({ evidenceStore, now: () => 20 });
    const job = buildConsolidationJob("job-1", 10);
    registry.register({
      job,
      createdAt: 10,
      selection: { scopes: [], includeExpired: true },
      settings: {
        jaccardThreshold: 0.85,
        staleConfidenceThreshold: 0.3,
        maxAgeMs: 90,
        maxClustersPerRun: 100,
        maxRecordsPerRun: 1000,
      },
      memoryCount: 0,
    });
    const running = transitionJob(job, "running");
    registry.setRunning("job-1", running);
    const completed = transitionJob(running, "completed", {
      completedAt: 20,
      result: emptyResult(),
    });
    registry.complete("job-1", completed, 3);

    const restored = createConsolidationJobRegistry({ evidenceStore });
    const record = restored.get("job-1");
    expect(record?.job.state).toBe("completed");
    expect(record?.memoryCount).toBe(3);
    expect(record?.job.result?.elapsedMs).toBe(10);
  });
});
