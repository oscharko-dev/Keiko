import { describe, expect, it, vi } from "vitest";
import type { DebugLifecycleEvent, EvidenceStore } from "@oscharko-dev/keiko-contracts";
import { createDapEvidenceProjector } from "./dapEvidenceProjector.js";

function store(put: EvidenceStore["put"]): EvidenceStore {
  return { put, list: () => [], get: () => undefined, delete: vi.fn() };
}

function event(): DebugLifecycleEvent {
  return {
    schemaVersion: "1",
    sequence: 1,
    eventKind: "teardown",
    sessionId: "opaque-session",
    state: "stopped",
    reason: "stopped",
    targetKind: "file",
    backend: "oci",
    network: "none",
    filesystem: "executionRoot",
    provisioningDigest: "a".repeat(64),
    timestampMs: 1,
    activationRevision: 1,
    outputAcceptedBytes: 4,
    outputTruncatedEvents: 1,
  };
}

describe("dapEvidenceProjector", () => {
  it("writes a bounded per-partition live projection without persisting the partition in JSON", async () => {
    const put = vi.fn((_runId: string, _json: string) => "/evidence");
    const projector = createDapEvidenceProjector(store(put));
    await projector.project("partition_a", { records: [event()], cumulativeEvictedCount: 3 });
    expect(put.mock.calls[0]?.[0]).toBe("debug-session-live-partition_a");
    const json = String(put.mock.calls[0]?.[1]);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: "1",
      kind: "debugSessionLiveProjection",
      cumulativeEvictedCount: 3,
    });
    expect(json).toContain("opaque-session");
    expect(json).toContain('"cumulativeEvictedCount":3');
    expect(json).not.toContain("partition_a");
  });

  it.each([
    { partition: "../escape", records: [event()], cumulativeEvictedCount: 0 },
    { partition: "partition_a!", records: [event()], cumulativeEvictedCount: 0 },
    {
      partition: "partition_a",
      records: [{ ...event(), eventKind: "unknown" }],
      cumulativeEvictedCount: 0,
    },
    {
      partition: "partition_a",
      records: [{ ...event(), output: "hostile" }],
      cumulativeEvictedCount: 0,
    },
    { partition: "partition_a", records: [event()], cumulativeEvictedCount: -1 },
    { partition: "partition_a", records: [{ ...event(), sequence: 0 }], cumulativeEvictedCount: 0 },
    {
      partition: "partition_a",
      records: [{ ...event(), sequence: 1.5 }],
      cumulativeEvictedCount: 0,
    },
    {
      partition: "partition_a",
      records: [event(), { ...event(), sequence: 2, eventKind: "unknown" }],
      cumulativeEvictedCount: 0,
    },
    {
      partition: "partition_a",
      records: Array.from({ length: 129 }, (_value, index) => ({
        ...event(),
        sequence: index + 1,
      })),
      cumulativeEvictedCount: 0,
    },
  ])("rejects hostile runtime projection without writing", async (hostile) => {
    const put = vi.fn((_runId: string, _json: string) => "/evidence");
    const projector = createDapEvidenceProjector(store(put));
    await expect(
      projector.project(hostile.partition, {
        records: hostile.records as never,
        cumulativeEvictedCount: hostile.cumulativeEvictedCount,
      }),
    ).rejects.toThrow("INVALID_DEBUG_EVIDENCE");
    expect(put).not.toHaveBeenCalled();
  });

  it("accepts the exact 128-record and zero-eviction boundaries", async () => {
    const put = vi.fn((_runId: string, _json: string) => "/evidence");
    const projector = createDapEvidenceProjector(store(put));
    const records = Array.from({ length: 128 }, (_value, index) => ({
      ...event(),
      sequence: index + 1,
    }));
    await expect(
      projector.project("partition_a", { records, cumulativeEvictedCount: 0 }),
    ).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledTimes(1);
  });
});
