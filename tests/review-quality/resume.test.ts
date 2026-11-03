import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReviewRunSettlement } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { ReviewRunStore } from "../../packages/keiko-server/src/review/service/store.js";
import { runMigrations } from "../../packages/keiko-server/src/store/schema.js";
import { clientRequestPattern, openGateResume } from "./resume.js";

const MODELS = { reviewerModelId: "reviewer", counterCheckerModelId: "counter" };
const COMMITS = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const ZERO = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
const SINCE = 10_000;

let stateDir: string;
let db: DatabaseSync;
let store: ReviewRunStore;
let sequence = 0;

interface StoredRun {
  readonly caseKey: string;
  readonly createdAt: number;
  readonly settlement?: ReviewRunSettlement;
  readonly reviewerModelId?: string;
  readonly headSha?: string;
}

function storeRun(run: StoredRun): string {
  sequence += 1;
  const runId = `run-${String(sequence)}`;
  store.insert({
    runId,
    repositoryId: "repo_0000000000000001",
    repositoryRoot: "/lab/keiko",
    clientRequestId: `review-gate-${run.caseKey}-${String(run.createdAt)}`,
    correlationId: `corr-${String(sequence)}`,
    target: { kind: "local-range", baseRef: "base", headRef: "head" },
    reviewerModelId: run.reviewerModelId ?? MODELS.reviewerModelId,
    counterCheckerModelId: MODELS.counterCheckerModelId,
    gatewayGeneration: 1,
    createdAt: run.createdAt,
  });
  store.setTarget(runId, { baseSha: COMMITS.baseSha, headSha: run.headSha ?? COMMITS.headSha }, []);
  if (run.settlement !== undefined) {
    store.settle(runId, [], {
      settlement: run.settlement,
      settledAt: run.createdAt + 1,
      candidateCount: 0,
      reviewer: ZERO,
      counterChecker: ZERO,
    });
  }
  return runId;
}

function reusable(caseKey: string): string | undefined {
  const resume = openGateResume(stateDir, SINCE, MODELS);
  try {
    return resume.reusableRun(caseKey, COMMITS);
  } finally {
    resume.close();
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "review-gate-resume-"));
  mkdirSync(join(stateDir, "ui"));
  db = new DatabaseSync(join(stateDir, "ui", "keiko-ui.db"));
  runMigrations(db);
  store = new ReviewRunStore(db);
});

afterEach(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("openGateResume", () => {
  it("reuses the latest stored review of the original run, whatever it measured", () => {
    storeRun({ caseKey: "pr-1", createdAt: SINCE + 1, settlement: { kind: "complete" } });
    const latest = storeRun({
      caseKey: "pr-1",
      createdAt: SINCE + 2,
      settlement: { kind: "incomplete", reason: "budget-exhausted" },
    });
    expect(reusable("pr-1")).toBe(latest);
  });

  it("reviews again what the stop interrupted or a model the review never reached refused", () => {
    storeRun({
      caseKey: "pr-1",
      createdAt: SINCE + 1,
      settlement: { kind: "abandoned", reason: "interrupted" },
    });
    storeRun({
      caseKey: "pr-2",
      createdAt: SINCE + 2,
      settlement: { kind: "skipped", reason: "model-unavailable" },
    });
    storeRun({ caseKey: "pr-3", createdAt: SINCE + 3 });
    expect(reusable("pr-1")).toBeUndefined();
    expect(reusable("pr-2")).toBeUndefined();
    expect(reusable("pr-3")).toBeUndefined();
  });

  it("ignores reviews before the original run, of another pair or of other commits", () => {
    storeRun({ caseKey: "pr-1", createdAt: SINCE - 1, settlement: { kind: "complete" } });
    storeRun({
      caseKey: "pr-2",
      createdAt: SINCE + 1,
      settlement: { kind: "complete" },
      reviewerModelId: "other",
    });
    storeRun({
      caseKey: "pr-3",
      createdAt: SINCE + 1,
      settlement: { kind: "complete" },
      headSha: "c".repeat(40),
    });
    expect(reusable("pr-1")).toBeUndefined();
    expect(reusable("pr-2")).toBeUndefined();
    expect(reusable("pr-3")).toBeUndefined();
  });

  it("matches a case key exactly, never a longer one that shares its prefix", () => {
    storeRun({ caseKey: "pr-12", createdAt: SINCE + 1, settlement: { kind: "complete" } });
    expect(reusable("pr-1")).toBeUndefined();
    expect(clientRequestPattern("a_b%c")).toBe("review-gate-a\\_b\\%c-%");
  });
});
