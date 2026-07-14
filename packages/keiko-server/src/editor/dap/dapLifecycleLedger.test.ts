import { describe, expect, it, vi } from "vitest";
import type { DebugLifecycleEvidence } from "@oscharko-dev/keiko-contracts";
import { createDapLifecycleLedger } from "./dapLifecycleLedger.js";

function evidence(sessionId = "opaque-session"): DebugLifecycleEvidence {
  return {
    schemaVersion: "1",
    eventKind: "start",
    sessionId,
    state: "starting",
    reason: "requested",
    targetKind: "file",
    backend: "oci",
    network: "none",
    filesystem: "executionRoot",
    provisioningDigest: "a".repeat(64),
    timestampMs: 1,
    activationRevision: 1,
    outputAcceptedBytes: 0,
    outputTruncatedEvents: 0,
  };
}

describe("dapLifecycleLedger", () => {
  it("appends to the canonical journal before exposing a live event", async () => {
    const order: string[] = [];
    const ledger = createDapLifecycleLedger({
      appendJournal: () => {
        order.push("journal");
        return Promise.resolve();
      },
      projectLive: () => {
        order.push("projection");
        return Promise.resolve();
      },
    });
    await ledger.append("partition_a", evidence());
    expect(order).toStrictEqual(["journal", "projection"]);
    expect(ledger.list("partition_a").records).toStrictEqual([{ ...evidence(), sequence: 1 }]);
  });

  it("does not expose a failed canonical append", async () => {
    const ledger = createDapLifecycleLedger({
      appendJournal: () => Promise.reject(new Error("private")),
    });
    await expect(ledger.append("partition_a", evidence())).rejects.toThrow();
    expect(ledger.list("partition_a").records).toStrictEqual([]);
  });

  it("retains 128 events per workspace and reports cumulative eviction independently", async () => {
    const ledger = createDapLifecycleLedger({ appendJournal: () => Promise.resolve() });
    for (let index = 0; index < 130; index += 1) {
      await ledger.append("partition_a", evidence(`session_${String(index)}`));
    }
    await ledger.append("partition_b", evidence("other"));
    const partition = ledger.list("partition_a");
    expect(partition.cumulativeEvictedCount).toBe(2);
    expect(partition.records.at(-1)?.sequence).toBe(130);
    expect(ledger.list("partition_b")).toMatchObject({ cumulativeEvictedCount: 0 });
  });

  it("keeps canonical success when the bounded live projection fails", async () => {
    const onFailure = vi.fn();
    const failure = new Error("private");
    const ledger = createDapLifecycleLedger({
      appendJournal: vi.fn(() => Promise.resolve()),
      projectLive: () => Promise.reject(failure),
      onProjectionFailure: onFailure,
    });
    await expect(ledger.append("partition_a", evidence())).resolves.toBeDefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each(["", "a".repeat(129), "bad space", "prefix!", "!suffix"])(
    "rejects a hostile partition before journal append",
    async (partition) => {
      const appendJournal = vi.fn(() => Promise.resolve());
      const ledger = createDapLifecycleLedger({ appendJournal });
      await expect(ledger.append(partition, evidence())).rejects.toThrow("INVALID_DEBUG_EVIDENCE");
      expect(appendJournal).not.toHaveBeenCalled();
    },
  );

  it("rejects hostile evidence independently from a valid partition", async () => {
    const appendJournal = vi.fn(() => Promise.resolve());
    const ledger = createDapLifecycleLedger({ appendJournal });
    await expect(
      ledger.append("partition_a", {
        ...evidence(),
        eventKind: "hostile",
      } as unknown as DebugLifecycleEvidence),
    ).rejects.toThrow("INVALID_DEBUG_EVIDENCE");
    expect(appendJournal).not.toHaveBeenCalled();
  });

  it("retains exactly 128 records before the first eviction", async () => {
    const ledger = createDapLifecycleLedger({ appendJournal: () => Promise.resolve() });
    for (let index = 0; index < 128; index += 1) {
      await ledger.append("partition_a", evidence(`session_${String(index)}`));
    }
    expect(ledger.list("partition_a").cumulativeEvictedCount).toBe(0);
    expect(ledger.list("partition_a").records).toHaveLength(128);
    await ledger.append("partition_a", evidence("session_128"));
    expect(ledger.list("partition_a")).toMatchObject({ cumulativeEvictedCount: 1 });
  });

  it("does not require optional live-projection callbacks", async () => {
    const ledger = createDapLifecycleLedger({ appendJournal: () => Promise.resolve() });
    await expect(ledger.append("partition_a", evidence())).resolves.toBeDefined();
  });

  it("does not report a projection failure when no projection is configured", async () => {
    const onProjectionFailure = vi.fn();
    const ledger = createDapLifecycleLedger({
      appendJournal: () => Promise.resolve(),
      onProjectionFailure,
    });
    await expect(ledger.append("partition_a", evidence())).resolves.toBeDefined();
    expect(onProjectionFailure).not.toHaveBeenCalled();
  });

  it("does not require a projection-failure observer", async () => {
    const ledger = createDapLifecycleLedger({
      appendJournal: () => Promise.resolve(),
      projectLive: () => Promise.reject(new Error("private")),
    });
    await expect(ledger.append("partition_a", evidence())).resolves.toBeDefined();
  });

  it("passes an immutable snapshot to the configured live projection", async () => {
    const projectLive = vi.fn(() => Promise.resolve());
    const ledger = createDapLifecycleLedger({
      appendJournal: () => Promise.resolve(),
      projectLive,
    });
    await ledger.append("partition_a", evidence());
    expect(projectLive).toHaveBeenCalledExactlyOnceWith("partition_a", {
      records: [{ ...evidence(), sequence: 1 }],
      cumulativeEvictedCount: 0,
    });
  });
});
