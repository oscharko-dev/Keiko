import { describe, expect, it } from "vitest";
import { listEvidence, loadEvidence } from "./index-api.js";
import { createInMemoryEvidenceStore } from "./store.js";
import { EvidenceReadError, EvidenceSchemaError } from "./errors.js";
import type { EvidenceManifest } from "./types.js";

function manifestFixture(runId: string, startedAt: number): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
      fingerprint: "fp",
      harnessVersion: "0.1.5",
      taskType: "explain-plan",
      outcome: "completed",
      startedAt,
      finishedAt: startedAt + 10,
      durationMs: 10,
    },
    model: { modelId: "m1", costClass: "unknown" },
    usageTotals: { promptTokens: 1, completionTokens: 1, requestCount: 1, totalLatencyMs: 1 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
  };
}

function seed(): ReturnType<typeof createInMemoryEvidenceStore> {
  const store = createInMemoryEvidenceStore();
  store.put("run-b", JSON.stringify(manifestFixture("run-b", 200)));
  store.put("run-a", JSON.stringify(manifestFixture("run-a", 100)));
  return store;
}

describe("listEvidence", () => {
  it("returns sorted header entries with the projection fields", () => {
    const entries = listEvidence(seed());
    expect(entries.map((e) => e.runId)).toEqual(["run-a", "run-b"]);
    expect(entries[0]).toEqual({
      runId: "run-a",
      taskType: "explain-plan",
      outcome: "completed",
      startedAt: 100,
      finishedAt: 110,
      modelId: "m1",
    });
  });

  it("returns an empty list for an empty store", () => {
    expect(listEvidence(createInMemoryEvidenceStore())).toEqual([]);
  });

  it("ignores non-run JSON records that do not declare an evidence schema version", () => {
    const store = seed();
    store.put("memory-audit-2026-06-07", JSON.stringify({ date: "2026-06-07", events: [] }));
    expect(listEvidence(store).map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
  });

  it("lists additive browser capture manifests", () => {
    const store = createInMemoryEvidenceStore();
    store.put(
      "browser-run",
      JSON.stringify({
        ...manifestFixture("browser-run", 300),
        run: {
          ...manifestFixture("browser-run", 300).run,
          taskType: "browser-capture",
        },
        model: { modelId: "browser-tool", costClass: "unknown" },
        usageTotals: {
          promptTokens: 0,
          completionTokens: 0,
          requestCount: 0,
          totalLatencyMs: 0,
        },
        browser: {
          sessionId: "session-1",
          cdpPort: 9222,
          targetId: "TARGET-1",
          status: "closed",
          startedAt: 300,
          closedAt: 310,
          closeReason: "explicit",
          events: [
            {
              schemaVersion: "1",
              type: "browser:session-opened",
              sessionId: "session-1",
              seq: 1,
              ts: 300,
            },
          ],
        },
      } satisfies EvidenceManifest),
    );
    expect(listEvidence(store)[0]).toMatchObject({
      runId: "browser-run",
      taskType: "browser-capture",
      modelId: "browser-tool",
    });
  });
});

describe("loadEvidence", () => {
  it("loads and parses one manifest by runId", () => {
    const m = loadEvidence(seed(), "run-a");
    expect(m?.run.runId).toBe("run-a");
  });

  it("returns undefined for an absent runId", () => {
    expect(loadEvidence(seed(), "run-z")).toBeUndefined();
  });

  it("raises EvidenceSchemaError for an unknown evidenceSchemaVersion", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", JSON.stringify({ evidenceSchemaVersion: "9", run: {} }));
    expect(() => loadEvidence(store, "run-x")).toThrow(EvidenceSchemaError);
  });

  it("raises EvidenceSchemaError when the version key is missing", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", JSON.stringify({ run: {} }));
    expect(() => loadEvidence(store, "run-x")).toThrow(EvidenceSchemaError);
  });

  it("raises EvidenceSchemaError when a version-1 manifest lacks required fields", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", JSON.stringify({ evidenceSchemaVersion: "1" }));
    expect(() => loadEvidence(store, "run-x")).toThrow(EvidenceSchemaError);
  });

  it("raises a typed EvidenceReadError (not a raw SyntaxError) for malformed JSON (C1)", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", '{"evidenceSchemaVersion": "1", run');
    expect(() => loadEvidence(store, "run-x")).toThrow(EvidenceReadError);
  });

  it("propagates the typed read error through listEvidence too", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", "not json at all");
    expect(() => listEvidence(store)).toThrow(EvidenceReadError);
  });

  it("propagates a typed schema error through listEvidence too", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", JSON.stringify({ evidenceSchemaVersion: "1" }));
    expect(() => listEvidence(store)).toThrow(EvidenceSchemaError);
  });
});
