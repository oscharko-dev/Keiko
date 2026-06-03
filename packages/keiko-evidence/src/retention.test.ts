import { describe, expect, it } from "vitest";
import { applyRetention } from "./retention.js";
import { createInMemoryEvidenceStore, type EvidenceStore } from "./store.js";
import type { EvidenceManifest } from "./types.js";

function manifest(runId: string, startedAt: number, finishedAt: number): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
      fingerprint: "fp",
      harnessVersion: "0.1.5",
      taskType: "explain-plan",
      outcome: "completed",
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    },
    model: { modelId: "m1", costClass: "unknown" },
    usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
  };
}

// runId -> finishedAt; persisted in arbitrary insertion order so "oldest" is computed from the
// header, not from insertion or filesystem mtime.
function storeWith(rows: readonly (readonly [string, number])[]): EvidenceStore {
  const store = createInMemoryEvidenceStore();
  for (const [runId, finishedAt] of rows) {
    store.put(runId, JSON.stringify(manifest(runId, finishedAt - 10, finishedAt)));
  }
  return store;
}

describe("applyRetention — maxRuns", () => {
  it("deletes the oldest beyond the cap, keeping the most recent N by finishedAt", () => {
    const store = storeWith([
      ["run-old", 100],
      ["run-mid", 200],
      ["run-new", 300],
    ]);
    applyRetention(store, { maxRuns: 2 });
    expect([...store.list()].sort()).toEqual(["run-mid", "run-new"]);
  });

  it("is a no-op when the count is within the cap", () => {
    const store = storeWith([
      ["run-a", 100],
      ["run-b", 200],
    ]);
    applyRetention(store, { maxRuns: 5 });
    expect([...store.list()].sort()).toEqual(["run-a", "run-b"]);
  });
});

describe("applyRetention — disabled", () => {
  it("never deletes when disabled", () => {
    const store = storeWith([
      ["run-a", 100],
      ["run-b", 200],
      ["run-c", 300],
    ]);
    applyRetention(store, { maxRuns: 1, disabled: true });
    expect(store.list()).toHaveLength(3);
  });
});

describe("applyRetention — maxAgeMs", () => {
  it("deletes manifests older than the age cap relative to the newest finishedAt", () => {
    const store = storeWith([
      ["run-old", 100],
      ["run-mid", 500],
      ["run-new", 1000],
    ]);
    // newest finishedAt is 1000; cutoff = 1000 - 400 = 600 → run-old(100) and run-mid(500) deleted.
    applyRetention(store, { maxAgeMs: 400 });
    expect(store.list()).toEqual(["run-new"]);
  });
});

describe("applyRetention — maxTotalBytes", () => {
  it("deletes oldest until under the byte cap", () => {
    const store = storeWith([
      ["run-old", 100],
      ["run-new", 200],
    ]);
    const oldBytes = store.get("run-old")?.length ?? 0;
    // Cap just below the two-manifest total but above one → the oldest is dropped.
    applyRetention(store, { maxTotalBytes: oldBytes + 1 });
    expect(store.list()).toEqual(["run-new"]);
  });

  it("always keeps the newest manifest even if it alone exceeds the byte cap", () => {
    const store = storeWith([
      ["run-old", 100],
      ["run-new", 200],
    ]);
    // A cap of 1 byte is below even a single manifest; the newest must survive, the oldest is dropped.
    applyRetention(store, { maxTotalBytes: 1 });
    expect(store.list()).toEqual(["run-new"]);
  });
});

describe("applyRetention — robustness", () => {
  it("ignores an unparseable manifest rather than throwing", () => {
    const store = createInMemoryEvidenceStore();
    store.put("good", JSON.stringify(manifest("good", 90, 100)));
    store.put("bad", "{not json");
    expect(() => {
      applyRetention(store, { maxRuns: 1 });
    }).not.toThrow();
    expect(store.list()).toContain("good");
  });
});
