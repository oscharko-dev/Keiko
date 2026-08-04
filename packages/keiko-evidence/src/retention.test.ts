import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRetention } from "./retention.js";
import {
  createInMemoryEvidenceStore,
  createNodeEvidenceStore,
  type EvidenceStore,
} from "./store.js";
import { DEFAULT_RETENTION, type EvidenceManifest, type EvidenceTaskType } from "./types.js";

function manifest(
  runId: string,
  startedAt: number,
  finishedAt: number,
  taskType: EvidenceTaskType = "explain-plan",
): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
      fingerprint: "fp",
      harnessVersion: "0.1.5",
      taskType,
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

function manifestWithUnknownTaskType(runId: string, startedAt: number, finishedAt: number): string {
  const known = manifest(runId, startedAt, finishedAt);
  return JSON.stringify({
    ...known,
    run: { ...known.run, taskType: "future-regulated-task" },
  });
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
    expect(applyRetention(store, { maxRuns: 2 })).toBe(1);
    expect([...store.list()].sort()).toEqual(["run-mid", "run-new"]);
  });

  it("deletes node-store side-file directories for expired manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-evidence-retention-side-files-"));
    try {
      const store = createNodeEvidenceStore(dir);
      store.put("run-old", JSON.stringify(manifest("run-old", 90, 100)));
      store.put("run-new", JSON.stringify(manifest("run-new", 190, 200)));
      const sideDir = join(dir, "run-old");
      mkdirSync(sideDir);
      writeFileSync(join(sideDir, "browser-1.png"), "png");

      applyRetention(store, { maxRuns: 1 });

      expect(store.list()).toEqual(["run-new"]);
      expect(existsSync(sideDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the count is within the cap", () => {
    const store = storeWith([
      ["run-a", 100],
      ["run-b", 200],
    ]);
    expect(applyRetention(store, { maxRuns: 5 })).toBe(0);
    expect([...store.list()].sort()).toEqual(["run-a", "run-b"]);
  });
});

describe("applyRetention — default partition isolation", () => {
  it("bounds chat/RAG evidence without evicting regulated or unknown manifests", () => {
    const store = createInMemoryEvidenceStore();
    store.put("regulated-old", JSON.stringify(manifest("regulated-old", 0, 1, "verify")));
    store.put("unknown-old", manifestWithUnknownTaskType("unknown-old", 1, 2));
    for (let index = 0; index <= 50; index += 1) {
      const runId = `chat-${String(index).padStart(2, "0")}`;
      store.put(
        runId,
        JSON.stringify(manifest(runId, index + 10, index + 11, "connected-context")),
      );
    }

    applyRetention(store, DEFAULT_RETENTION);

    expect(store.get("regulated-old")).toBeDefined();
    expect(store.get("unknown-old")).toBeDefined();
    expect(store.get("chat-00")).toBeUndefined();
    expect(store.list()).toHaveLength(52);
  });

  it("bounds regulated evidence without evicting chat/RAG or unknown manifests", () => {
    const store = createInMemoryEvidenceStore();
    store.put("regulated-old", JSON.stringify(manifest("regulated-old", 0, 1, "verify")));
    store.put("chat-old", JSON.stringify(manifest("chat-old", 1, 2, "connected-context")));
    store.put("unknown-old", manifestWithUnknownTaskType("unknown-old", 2, 3));
    for (let index = 0; index < 50; index += 1) {
      const runId = `regulated-${String(index).padStart(2, "0")}`;
      store.put(runId, JSON.stringify(manifest(runId, index + 10, index + 11, "verify")));
    }

    applyRetention(store, DEFAULT_RETENTION);

    expect(store.get("regulated-old")).toBeUndefined();
    expect(store.get("chat-old")).toBeDefined();
    expect(store.get("unknown-old")).toBeDefined();
    expect(store.list()).toHaveLength(52);
  });

  it("honours a declared partition cap without affecting another partition", () => {
    const store = createInMemoryEvidenceStore();
    store.put("regulated-old", JSON.stringify(manifest("regulated-old", 0, 1, "verify")));
    store.put("regulated-new", JSON.stringify(manifest("regulated-new", 1, 2, "verify")));
    store.put("chat-old", JSON.stringify(manifest("chat-old", 0, 1, "connected-context")));
    store.put("unknown-old", manifestWithUnknownTaskType("unknown-old", 0, 1));

    applyRetention(store, { maxRunsByPartition: { regulated: 1 } });

    expect([...store.list()].sort()).toEqual(["chat-old", "regulated-new", "unknown-old"]);
  });

  it("preserves the explicit global maxRuns migration path for recognised evidence", () => {
    const store = createInMemoryEvidenceStore();
    store.put("regulated-old", JSON.stringify(manifest("regulated-old", 0, 1, "verify")));
    store.put("chat-new", JSON.stringify(manifest("chat-new", 1, 2, "connected-context")));

    applyRetention(store, { maxRuns: 1 });

    expect(store.list()).toEqual(["chat-new"]);
  });
});

describe("applyRetention — disabled", () => {
  it("never deletes when disabled", () => {
    const store = storeWith([
      ["run-a", 100],
      ["run-b", 200],
      ["run-c", 300],
    ]);
    expect(applyRetention(store, { maxRuns: 1, disabled: true })).toBe(0);
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

  it("retains manifests whose task type is inherited, empty, or malformed", () => {
    const store = createInMemoryEvidenceStore();
    store.put("valid-old", JSON.stringify(manifest("valid-old", 90, 100)));
    store.put("valid-new", JSON.stringify(manifest("valid-new", 190, 200)));
    for (const [runId, taskType] of [
      ["hostile-constructor", "constructor"],
      ["hostile-to-string", "toString"],
      ["hostile-proto", "__proto__"],
      ["empty-task", ""],
      ["malformed-task", null],
    ] as const) {
      store.put(runId, JSON.stringify({ run: { finishedAt: 300, taskType } }));
    }

    applyRetention(store, { maxRuns: 1 });

    expect(store.get("valid-old")).toBeUndefined();
    expect(store.get("valid-new")).toBeDefined();
    for (const runId of [
      "hostile-constructor",
      "hostile-to-string",
      "hostile-proto",
      "empty-task",
      "malformed-task",
    ]) {
      expect(store.get(runId)).toBeDefined();
    }
  });

  it("retains non-record and non-finite headers without sacrificing valid evidence", () => {
    const store = createInMemoryEvidenceStore();
    store.put("valid-old", JSON.stringify(manifest("valid-old", 90, 100)));
    store.put("valid-new", JSON.stringify(manifest("valid-new", 190, 200)));
    const invalidRows: readonly (readonly [string, string])[] = [
      ["null-root", "null"],
      ["array-root", "[]"],
      ["null-run", '{"run":null}'],
      ["array-run", '{"run":[]}'],
      ["missing-header", '{"run":{}}'],
      ["infinite-header", '{"run":{"finishedAt":1e400,"taskType":"verify"}}'],
    ];
    for (const [runId, json] of invalidRows) store.put(runId, json);

    applyRetention(store, { maxRuns: 1 });

    expect(store.get("valid-old")).toBeUndefined();
    expect(store.get("valid-new")).toBeDefined();
    for (const [runId] of invalidRows) expect(store.get(runId)).toBeDefined();
  });

  it("accepts finite boundary timestamps for known task types", () => {
    const store = createInMemoryEvidenceStore();
    store.put("zero", JSON.stringify(manifest("zero", 0, 0, "generate-unit-tests")));
    store.put(
      "maximum",
      JSON.stringify(manifest("maximum", Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER)),
    );

    applyRetention(store, { maxRuns: 1 });

    expect(store.list()).toEqual(["maximum"]);
  });
});
