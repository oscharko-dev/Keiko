import { describe, expect, it } from "vitest";
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
} from "@oscharko-dev/keiko-contracts/memory";
import {
  boundedReason,
  findDanglingReviewItems,
  findMissingCrossReferences,
  findOrphanMemories,
  findStaleNotArchived,
  scanMemoryHealth,
  MEMORY_HEALTH_SCAN_DEFAULTS,
  type HealthScanFinding,
} from "./health-scan.js";
import { makeRecord } from "./_support.js";

const DAY = 864e5;
const NOW = 1_700_000_000_000;

let nextFindingId = 0;
function newFindingId(): string {
  nextFindingId += 1;
  return `finding-${String(nextFindingId)}`;
}

function edge(from: string, to: string, kind: MemoryEdge["kind"] = "related"): MemoryEdge {
  return {
    id: `${from}-${to}` as MemoryEdgeId,
    schemaVersion: "1",
    fromMemoryId: from as MemoryId,
    toMemoryId: to as MemoryId,
    kind,
    createdAt: NOW,
  };
}

function edgesByMemory(
  records: readonly MemoryRecord[],
  edges: readonly MemoryEdge[],
): ReadonlyMap<MemoryId, readonly MemoryEdge[]> {
  const map = new Map<MemoryId, MemoryEdge[]>();
  for (const record of records) map.set(record.id, []);
  for (const e of edges) {
    map.get(e.fromMemoryId)?.push(e);
    if (e.toMemoryId !== e.fromMemoryId) map.get(e.toMemoryId)?.push(e);
  }
  return map;
}

function noEdges(records: readonly MemoryRecord[]): ReadonlyMap<MemoryId, readonly MemoryEdge[]> {
  return edgesByMemory(records, []);
}

describe("findOrphanMemories (AC1)", () => {
  it("flags an accepted memory with zero edges, referencing its id and a bounded reason", () => {
    const r = makeRecord({ id: "m-1", status: "accepted" });
    const findings = findOrphanMemories([r], noEdges([r]), NOW, newFindingId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("orphan-memory");
    expect(findings[0]?.memories).toEqual([{ memoryId: "m-1", type: r.type, status: "accepted" }]);
    expect(findings[0]?.reason.length).toBeLessThan(240);
  });

  it("does not flag an accepted memory that has any edge", () => {
    const a = makeRecord({ id: "m-1", status: "accepted" });
    const b = makeRecord({ id: "m-2", status: "accepted" });
    const findings = findOrphanMemories(
      [a, b],
      edgesByMemory([a, b], [edge("m-1", "m-2")]),
      NOW,
      newFindingId,
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores non-accepted records even with zero edges", () => {
    const r = makeRecord({ id: "m-1", status: "proposed" });
    const findings = findOrphanMemories([r], noEdges([r]), NOW, newFindingId);
    expect(findings).toHaveLength(0);
  });
});

describe("findMissingCrossReferences (AC2)", () => {
  it("flags two accepted, similar, unlinked memories in the same scope+type", () => {
    const a = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "the deployment region is eu-west-1",
    });
    const b = makeRecord({
      id: "m-2",
      status: "accepted",
      body: "the deployment region is eu-west-2",
    });
    const { findings, truncated } = findMissingCrossReferences(
      [a, b],
      noEdges([a, b]),
      0.55,
      NOW,
      newFindingId,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("missing-cross-reference");
    expect(findings[0]?.memories.map((m) => m.memoryId).sort()).toEqual(["m-1", "m-2"]);
    expect(truncated).toBe(false);
  });

  it("does not flag a pair below the similarity threshold", () => {
    const a = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "prefers dark mode in the editor",
    });
    const b = makeRecord({
      id: "m-2",
      status: "accepted",
      body: "database is postgres version 16",
    });
    const { findings } = findMissingCrossReferences(
      [a, b],
      noEdges([a, b]),
      0.55,
      NOW,
      newFindingId,
    );
    expect(findings).toHaveLength(0);
  });

  it("does not flag a similar pair that already has an edge between them", () => {
    const a = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "the deployment region is eu-west-1",
    });
    const b = makeRecord({
      id: "m-2",
      status: "accepted",
      body: "the deployment region is eu-west-2",
    });
    const { findings } = findMissingCrossReferences(
      [a, b],
      edgesByMemory([a, b], [edge("m-1", "m-2")]),
      0.55,
      NOW,
      newFindingId,
    );
    expect(findings).toHaveLength(0);
  });

  it("does not compare records across different scopes or types (partition isolation)", () => {
    const a = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "the deployment region is eu-west-1",
      scope: { kind: "user", userId: "u-1" } as MemoryRecord["scope"],
    });
    const b = makeRecord({
      id: "m-2",
      status: "accepted",
      body: "the deployment region is eu-west-1",
      scope: { kind: "user", userId: "u-2" } as MemoryRecord["scope"],
    });
    const { findings } = findMissingCrossReferences(
      [a, b],
      noEdges([a, b]),
      0.55,
      NOW,
      newFindingId,
    );
    expect(findings).toHaveLength(0);
  });

  it("bounds each partition independently and reports truncation (security-triage #2129-F1)", () => {
    const records: MemoryRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord({ id: `m-${String(i)}`, status: "accepted", body: `body variant ${String(i)}` }),
    );
    const { truncated } = findMissingCrossReferences(
      records,
      noEdges(records),
      0.55,
      NOW,
      newFindingId,
      3,
    );
    expect(truncated).toBe(true);
  });

  it("does not report truncation when every partition is under the per-partition bound", () => {
    const records: MemoryRecord[] = Array.from({ length: 3 }, (_, i) =>
      makeRecord({ id: `m-${String(i)}`, status: "accepted" }),
    );
    const { truncated } = findMissingCrossReferences(
      records,
      noEdges(records),
      0.55,
      NOW,
      newFindingId,
      3,
    );
    expect(truncated).toBe(false);
  });
});

describe("findStaleNotArchived (AC3)", () => {
  it("flags a superseded record unchanged for longer than the window", () => {
    const r = makeRecord({ id: "m-1", status: "superseded", updatedAt: NOW - 40 * DAY });
    const findings = findStaleNotArchived([r], NOW, 30 * DAY, newFindingId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("stale-not-archived");
  });

  it("flags a conflicted record unchanged for longer than the window", () => {
    const r = makeRecord({ id: "m-1", status: "conflicted", updatedAt: NOW - 40 * DAY });
    const findings = findStaleNotArchived([r], NOW, 30 * DAY, newFindingId);
    expect(findings).toHaveLength(1);
  });

  it("does not flag a superseded record within the window", () => {
    const r = makeRecord({ id: "m-1", status: "superseded", updatedAt: NOW - 10 * DAY });
    const findings = findStaleNotArchived([r], NOW, 30 * DAY, newFindingId);
    expect(findings).toHaveLength(0);
  });

  it("does not flag accepted or proposed records regardless of age", () => {
    const a = makeRecord({ id: "m-1", status: "accepted", updatedAt: NOW - 400 * DAY });
    const b = makeRecord({ id: "m-2", status: "proposed", updatedAt: NOW - 400 * DAY });
    const findings = findStaleNotArchived([a, b], NOW, 30 * DAY, newFindingId);
    expect(findings).toHaveLength(0);
  });
});

describe("findDanglingReviewItems (AC4)", () => {
  it("flags an unresolved negation-flip conflict older than the window", () => {
    const a = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "we use tabs",
      updatedAt: NOW - 20 * DAY,
    });
    const b = makeRecord({
      id: "m-2",
      status: "accepted",
      body: "we do not use tabs",
      updatedAt: NOW - 20 * DAY,
    });
    const { findings, truncated } = findDanglingReviewItems([a, b], 14 * DAY, NOW, newFindingId);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("dangling-review-item");
    expect(truncated).toBe(false);
  });

  it("does not flag a conflict younger than the window", () => {
    const a = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "we use tabs",
      updatedAt: NOW - 2 * DAY,
    });
    const b = makeRecord({
      id: "m-2",
      status: "accepted",
      body: "we do not use tabs",
      updatedAt: NOW - 2 * DAY,
    });
    const { findings } = findDanglingReviewItems([a, b], 14 * DAY, NOW, newFindingId);
    expect(findings).toHaveLength(0);
  });

  it("does not flag a pair with no conflict signal", () => {
    const a = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "prefers dark mode",
      updatedAt: NOW - 40 * DAY,
    });
    const b = makeRecord({
      id: "m-2",
      status: "accepted",
      body: "database is postgres",
      updatedAt: NOW - 40 * DAY,
    });
    const { findings } = findDanglingReviewItems([a, b], 14 * DAY, NOW, newFindingId);
    expect(findings).toHaveLength(0);
  });

  it("bounds each partition independently and reports truncation (security-triage #2129-F1)", () => {
    const records: MemoryRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord({ id: `m-${String(i)}`, status: "accepted", updatedAt: NOW - 20 * DAY }),
    );
    const { truncated } = findDanglingReviewItems(records, 14 * DAY, NOW, newFindingId, 3);
    expect(truncated).toBe(true);
  });
});

describe("scanMemoryHealth (AC5-AC7, orchestrator)", () => {
  it("never mutates the input records or edge map", () => {
    const records = [makeRecord({ id: "m-1", status: "accepted" })].map((r) => Object.freeze(r));
    const edges = Object.freeze(noEdges(records));
    expect(() => scanMemoryHealth(records, edges, { nowMs: NOW, newFindingId })).not.toThrow();
  });

  it("never includes raw body/payload text on any finding (AC6)", () => {
    const secretBody = "SECRET-PROJECT-CODENAME-DO-NOT-LEAK";
    const a = makeRecord({ id: "m-1", status: "accepted", body: secretBody });
    const b = makeRecord({ id: "m-2", status: "accepted", body: `${secretBody} v2` });
    const result = scanMemoryHealth([a, b], noEdges([a, b]), { nowMs: NOW, newFindingId });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretBody);
    for (const finding of result.findings) {
      expect(Object.keys(finding)).not.toContain("body");
      expect(Object.keys(finding)).not.toContain("payload");
    }
  });

  it("bounds work at maxRecordsPerScan and reports truncation (AC7)", () => {
    const records: MemoryRecord[] = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ id: `m-${String(i)}`, status: "accepted" }),
    );
    const result = scanMemoryHealth(records, noEdges(records), {
      nowMs: NOW,
      newFindingId,
      policy: { maxRecordsPerScan: 3 },
    });
    expect(result.recordsInspected).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("reports truncated when a single partition alone exceeds maxRecordsPerPartition, even under the global maxRecordsPerScan bound (security-triage #2129-F1)", () => {
    const records: MemoryRecord[] = Array.from({ length: 6 }, (_, i) =>
      makeRecord({ id: `m-${String(i)}`, status: "accepted", body: `body variant ${String(i)}` }),
    );
    const result = scanMemoryHealth(records, noEdges(records), {
      nowMs: NOW,
      newFindingId,
      policy: { maxRecordsPerScan: 1000, maxRecordsPerPartition: 3 },
    });
    expect(result.recordsInspected).toBe(6);
    expect(result.truncated).toBe(true);
  });

  it("reports no truncation when under the bound", () => {
    const records = [makeRecord({ id: "m-1", status: "accepted" })];
    const result = scanMemoryHealth(records, noEdges(records), { nowMs: NOW, newFindingId });
    expect(result.truncated).toBe(false);
    expect(result.recordsInspected).toBe(1);
  });

  it("is deterministic: same input twice yields byte-identical, sorted output", () => {
    const a = makeRecord({ id: "m-2", status: "accepted" });
    const b = makeRecord({
      id: "m-1",
      status: "accepted",
      body: "prefers dark mode duplicate-ish",
    });
    const options = { nowMs: NOW, newFindingId: (): string => "fixed-id" };
    const first = scanMemoryHealth([a, b], noEdges([a, b]), options);
    const second = scanMemoryHealth([b, a], noEdges([b, a]), options);
    expect(first.findings).toEqual(second.findings);
    const ids = first.findings.map((f: HealthScanFinding) => f.memories[0]?.memoryId);
    expect(ids).toEqual([...ids].sort());
  });

  it("uses MEMORY_HEALTH_SCAN_DEFAULTS when no policy override is supplied", () => {
    const r = makeRecord({ id: "m-1", status: "accepted" });
    const result = scanMemoryHealth([r], noEdges([r]), { nowMs: NOW, newFindingId });
    expect(result.recordsInspected).toBeLessThanOrEqual(
      MEMORY_HEALTH_SCAN_DEFAULTS.maxRecordsPerScan,
    );
  });
});

describe("boundedReason (AC6 enforcement, verifier follow-up)", () => {
  it("passes a short reason through unchanged", () => {
    expect(boundedReason("similarity 0.62 >= threshold 0.55, no edge between records")).toBe(
      "similarity 0.62 >= threshold 0.55, no edge between records",
    );
  });

  it("truncates a reason exceeding MEMORY_HEALTH_SCAN_REASON_MAX_CHARS", () => {
    const overlong = "x".repeat(300);
    const result = boundedReason(overlong);
    expect(result).toHaveLength(240);
    expect(result).toBe("x".repeat(240));
  });

  it("leaves a reason exactly at the limit unchanged", () => {
    const exact = "y".repeat(240);
    expect(boundedReason(exact)).toBe(exact);
  });
});
