import { describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ConsolidationResult } from "@oscharko-dev/keiko-memory-consolidation";
import { buildConsolidationJob, transitionJob } from "@oscharko-dev/keiko-memory-consolidation";
import type { MemoryEdgeId, MemoryId, MemoryReviewerId } from "@oscharko-dev/keiko-contracts";
import {
  createConsolidationJobRegistry,
  type ConsolidationJobRecord,
} from "./memory-consolidation-registry.js";

const SECRET_MARKER = "secret-memory-body-marker";

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function richResult(): ConsolidationResult {
  const older = memoryId("memory-older");
  const newer = memoryId("memory-newer");
  const edge = {
    id: "edge-1" as MemoryEdgeId,
    schemaVersion: "1" as const,
    fromMemoryId: older,
    toMemoryId: newer,
    kind: "supersedes" as const,
    createdAt: 20,
    provenanceSummary: SECRET_MARKER,
  };
  return {
    ...emptyResult(),
    edgesProposed: [edge],
    updatesProposed: [
      {
        schemaVersion: "1",
        memoryId: newer,
        reviewerId: "reviewer-1" as MemoryReviewerId,
        updatedAt: 20,
        bodyPatch: SECRET_MARKER,
        reviewerNote: SECRET_MARKER,
      },
    ],
    summaryStatus: {
      kind: "configured",
      updatesProposed: 1,
      skippedMergeClusters: 0,
      fallbacksUsed: 0,
    },
    reviewItems: [
      {
        id: "review-1",
        reason: "potential-conflict",
        relatedMemoryIds: [older, newer],
        sourceMemoryIds: [older, newer],
        proposedAction: { kind: "supersede", older, newer },
        evidence: [{ kind: "value-replacement", memoryIds: [older, newer], detail: SECRET_MARKER }],
        proposedEdges: [edge],
        detectedAt: 20,
        suggestedResolution: { recommendedWinnerId: newer, rationale: SECRET_MARKER },
      },
    ],
  };
}

function requireResult(record: ConsolidationJobRecord | undefined): ConsolidationResult {
  const result = record?.job.result;
  if (result === undefined) throw new Error("Expected a completed consolidation result.");
  return result;
}

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

  it("persists only body-free audit facts and restores review items as non-applicable", () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const registry = createConsolidationJobRegistry({ evidenceStore, now: () => 20 });
    const job = buildConsolidationJob("job-sensitive", 10);
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
      memoryCount: 2,
    });
    const running = transitionJob(job, "running");
    registry.setRunning(job.id, running);
    registry.complete(
      job.id,
      transitionJob(running, "completed", { completedAt: 20, result: richResult() }),
      2,
      [
        {
          itemId: "review-1",
          memories: [
            { memoryId: memoryId("memory-older"), status: "proposed", updatedAt: 10 },
            { memoryId: memoryId("memory-newer"), status: "accepted", updatedAt: 10 },
          ],
        },
      ],
    );

    const operative = registry.get(job.id);
    const operativeResult = requireResult(operative);
    expect(operativeResult.updatesProposed[0]?.bodyPatch).toBe(SECRET_MARKER);
    expect(operative?.reviewSnapshots).toHaveLength(1);

    const persisted = evidenceStore.get("memory-consolidation-jobs");
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain(SECRET_MARKER);
    expect(persisted).not.toContain("bodyPatch");
    expect(persisted).not.toContain("reviewerNote");
    expect(persisted).not.toContain("provenanceSummary");
    expect(persisted).not.toContain("suggestedResolution");
    expect(persisted).not.toContain('"detail"');

    const restored = createConsolidationJobRegistry({ evidenceStore }).get(job.id);
    const restoredResult = requireResult(restored);
    expect(restored?.reviewSnapshots).toEqual([]);
    expect(restoredResult.updatesProposed).toEqual([]);
    expect(restoredResult.reviewItems[0]?.evidence?.[0]).not.toHaveProperty("detail");
  });
});
