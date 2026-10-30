// The review run records (Issue #4136): migration 55's tables, one active run per repository
// enforced by the database, idempotent client request ids, settlement, history and retained refs.

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../store/schema.js";
import { ReviewRunStore, type ReviewRunInsert } from "./store.js";

let db: DatabaseSync;
let store: ReviewRunStore;

function insert(overrides: Partial<ReviewRunInsert> = {}): ReviewRunInsert {
  return {
    runId: "run-1",
    repositoryId: "repo_0000000000000001",
    repositoryRoot: "/repo",
    clientRequestId: "client-1",
    correlationId: "corr-1",
    target: { kind: "pull-request", number: 7 },
    reviewerModelId: "reviewer",
    counterCheckerModelId: "checker",
    gatewayGeneration: 3,
    createdAt: 1_000,
    ...overrides,
  };
}

const ZERO = { promptTokens: 0, completionTokens: 0, durationMs: 0 };

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  store = new ReviewRunStore(db);
});

afterEach(() => {
  db.close();
});

describe("ReviewRunStore", () => {
  it("refuses a second unsettled run of the same repository and replays a request id", () => {
    expect(store.insert(insert())).toEqual({ ok: true });
    expect(store.insert(insert({ runId: "run-2", clientRequestId: "client-2" }))).toEqual({
      ok: false,
      reason: "active-exists",
      activeRunId: "run-1",
    });
    expect(store.insert(insert({ runId: "run-3" }))).toEqual({
      ok: false,
      reason: "duplicate-request",
      runId: "run-1",
    });
    expect(
      store.insert(insert({ runId: "run-4", clientRequestId: "x", repositoryId: "repo_other" })),
    ).toEqual({ ok: true });
  });

  it("settles a run with its findings in one transaction and frees the repository", () => {
    store.insert(insert());
    store.setTarget("run-1", { baseSha: "a".repeat(40), headSha: "b".repeat(40) }, ["refs/x"]);
    store.setCoverage(
      "run-1",
      {
        changedFiles: 2,
        reviewedFiles: 1,
        partiallyReviewedFiles: 0,
        unprocessedFiles: 0,
        addedLines: 3,
        removedLines: 1,
        budgetTokens: 100,
        usedTokens: 40,
      },
      [
        { path: "src/a.ts", list: "included" },
        { path: "pkg.lock", list: "filtered", reason: "lockfile" },
      ],
    );
    store.settle("run-1", [], {
      settlement: { kind: "complete" },
      settledAt: 5_000,
      candidateCount: 0,
      reviewer: { promptTokens: 10, completionTokens: 2, durationMs: 30 },
      counterChecker: ZERO,
    });
    const row = store.get("run-1");
    expect(row).toMatchObject({
      phase: "settled",
      settlement: { kind: "complete" },
      headSha: "b".repeat(40),
      privateRefs: ["refs/x"],
      reviewer: { promptTokens: 10 },
    });
    expect(store.coverageEntries("run-1")).toEqual([
      { path: "src/a.ts", list: "included" },
      { path: "pkg.lock", list: "filtered", reason: "lockfile" },
    ]);
    expect(store.activeRunId("repo_0000000000000001")).toBeUndefined();
    expect(store.insert(insert({ runId: "run-2", clientRequestId: "client-2" }))).toEqual({
      ok: true,
    });
    expect(store.retainedRefs("/repo")).toEqual(new Set(["refs/x"]));
    expect(store.medianDurationMs()).toBe(4_000);
  });

  it("rolls the settlement back when a finding cannot be written", () => {
    store.insert(insert());
    const finding = {
      fingerprint: "f".repeat(64),
      reviewerRank: 1,
      report: { file: "a" } as never,
      verdict: null,
      evidenceInHead: false,
      presented: true,
      // A presented finding without a rank violates the table's check constraint.
      presentationRank: null,
    };
    expect(() => {
      store.settle("run-1", [finding], {
        settlement: { kind: "complete" },
        settledAt: 2_000,
        candidateCount: 1,
        reviewer: ZERO,
        counterChecker: ZERO,
      });
    }).toThrow();
    expect(store.get("run-1")?.phase).toBe("preparing");
    expect(store.unsettled().map((row) => row.runId)).toEqual(["run-1"]);
  });

  it("lists history newest first and the latest run per pull request", () => {
    for (const [index, number] of [7, 7, 8].entries()) {
      const runId = `run-${String(index)}`;
      store.insert(
        insert({
          runId,
          clientRequestId: runId,
          target: { kind: "pull-request", number },
          createdAt: index,
        }),
      );
      store.settle(runId, [], {
        settlement: { kind: "skipped", reason: "target-changed" },
        settledAt: index + 1,
        candidateCount: 0,
        reviewer: ZERO,
        counterChecker: ZERO,
      });
    }
    expect(store.history("repo_0000000000000001", 7, 10).map((row) => row.runId)).toEqual([
      "run-1",
      "run-0",
    ]);
    expect(store.latestPerPullRequest("repo_0000000000000001").map((row) => row.runId)).toEqual([
      "run-1",
      "run-2",
    ]);
  });
});
