import { describe, expect, it } from "vitest";
import { listEvidence, loadEvidence } from "./index-api.js";
import { createInMemoryEvidenceStore, type EvidenceStore } from "./store.js";
import { EvidenceReadError, EvidenceSchemaError } from "./errors.js";
import type { EvidenceManifest } from "./types.js";
import { DEFAULT_TOKEN_ESTIMATOR_ID } from "@oscharko-dev/keiko-contracts";

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

  // The two cases below used to assert that listEvidence propagates these typed errors. The
  // invariant they encode — a bad manifest raises a TYPED error rather than a raw exception — is
  // preserved and now pinned where it belongs, on the single-run lookup. Enumeration answers a
  // different question ("which runs can I show?") and is pinned separately below (KEIKO-0106/1033).
  it("raises the typed read error from loadEvidence while listEvidence skips the entry", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", "not json at all");
    expect(() => loadEvidence(store, "run-x")).toThrow(EvidenceReadError);
    expect(listEvidence(store)).toEqual([]);
  });

  it("raises the typed schema error from loadEvidence while listEvidence skips the entry", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-x", JSON.stringify({ evidenceSchemaVersion: "1" }));
    expect(() => loadEvidence(store, "run-x")).toThrow(EvidenceSchemaError);
    expect(listEvidence(store)).toEqual([]);
  });

  it("keeps listing healthy runs when one manifest is unreadable, legacy or shape-invalid", () => {
    // One foreign file in .keiko/evidence must not blank the audit ledger: a restored backup, a
    // truncated write, or the first schema bump would otherwise hide every healthy run
    // (KEIKO-0106 / KEIKO-1033).
    const store = seed();
    store.put("run-legacy", JSON.stringify({ evidenceSchemaVersion: "2", run: {} }));
    store.put("run-torn", '{"evidenceSchemaVersion": "1", run');
    store.put(
      "run-corrupt",
      JSON.stringify({ ...manifestFixture("run-corrupt", 300), stateTransitions: "not-an-array" }),
    );
    // Also cover the two guard branches ahead of parseManifest: a non-record top level (null) and
    // a record with no recognisable evidenceSchemaVersion at all (empty object).
    store.put("run-null", "null");
    store.put("run-empty", "{}");
    expect(listEvidence(store).map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
    expect(() => loadEvidence(store, "run-legacy")).toThrow(EvidenceSchemaError);
    expect(() => loadEvidence(store, "run-torn")).toThrow(EvidenceReadError);
    expect(() => loadEvidence(store, "run-corrupt")).toThrow(EvidenceSchemaError);
    expect(() => loadEvidence(store, "run-null")).toThrow(EvidenceSchemaError);
    expect(() => loadEvidence(store, "run-empty")).toThrow(EvidenceSchemaError);
  });

  it("skips a runId whose store.get() itself throws a typed read/schema error", () => {
    // The node store's own get() can throw EvidenceReadError for a genuine filesystem fault (an
    // EACCES/read race), not only return a value that reads but fails to parse — that throw must
    // be treated the same as a malformed-content skip, not abort the whole enumeration.
    const store = seed();
    const withUnreadableEntry: EvidenceStore = {
      ...store,
      list: () => ["run-a", "run-b", "run-unreadable"],
      get: (runId) => {
        if (runId === "run-unreadable") {
          throw new EvidenceReadError(`cannot read evidence manifest: ${runId}`);
        }
        return store.get(runId);
      },
    };
    expect(listEvidence(withUnreadableEntry).map((entry) => entry.runId)).toEqual([
      "run-a",
      "run-b",
    ]);
  });

  it("still propagates an unexpected store failure out of listEvidence (fails closed)", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-a", JSON.stringify(manifestFixture("run-a", 100)));
    const failing = {
      ...store,
      get: (runId: string): string | undefined => {
        throw new Error(`store I/O failure for ${runId}`);
      },
    };
    expect(() => listEvidence(failing)).toThrow("store I/O failure");
  });

  it("loads a PR5-shaped manifest carrying contextAssembly + compaction (ADR-0056 Gate 2)", () => {
    const store = createInMemoryEvidenceStore();
    const manifest: EvidenceManifest = {
      ...manifestFixture("run-ce", 400),
      contextAssembly: {
        schemaVersion: "1",
        profile: {
          schemaVersion: "1",
          maxInputTokens: 128_000,
          reservedOutputTokens: 8_000,
          safetyMarginTokens: 4_000,
          effectiveInputBudget: 116_000,
          tokenEstimatorId: DEFAULT_TOKEN_ESTIMATOR_ID,
        },
        totalEstimatedTokens: 1_200,
        budgetPressure: "moderate",
        lanes: [],
        orderedForRecency: true,
      },
      compaction: [
        {
          schemaVersion: "1",
          laneId: "repo-evidence",
          reason: "budget exceeded",
          itemsBefore: 8,
          itemsAfter: 3,
          tokensBefore: 4_000,
          tokensAfter: 1_200,
        },
      ],
    };
    store.put("run-ce", JSON.stringify(manifest));
    const loaded = loadEvidence(store, "run-ce");
    expect(loaded?.contextAssembly?.budgetPressure).toBe("moderate");
    expect(loaded?.compaction?.[0]?.laneId).toBe("repo-evidence");
  });

  it("still loads a legacy manifest without the new fields (ADR-0056 Gate 2)", () => {
    const store = createInMemoryEvidenceStore();
    store.put("run-legacy", JSON.stringify(manifestFixture("run-legacy", 500)));
    const loaded = loadEvidence(store, "run-legacy");
    expect(loaded?.contextAssembly).toBeUndefined();
    expect(loaded?.compaction).toBeUndefined();
  });

  it("rejects a manifest whose contextAssembly is not an object (ADR-0056 D6)", () => {
    const store = createInMemoryEvidenceStore();
    store.put(
      "run-bad-ca",
      JSON.stringify({ ...manifestFixture("run-bad-ca", 600), contextAssembly: "nope" }),
    );
    expect(() => loadEvidence(store, "run-bad-ca")).toThrow(EvidenceSchemaError);
  });

  it("rejects a manifest whose compaction is not an array (ADR-0056 D6)", () => {
    const store = createInMemoryEvidenceStore();
    store.put(
      "run-bad-comp",
      JSON.stringify({ ...manifestFixture("run-bad-comp", 700), compaction: { not: "array" } }),
    );
    expect(() => loadEvidence(store, "run-bad-comp")).toThrow(EvidenceSchemaError);
  });
});
