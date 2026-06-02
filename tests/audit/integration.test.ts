import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistEvidence } from "../../src/audit/persist.js";
import { createNodeEvidenceStore } from "../../src/audit/store.js";
import { listEvidence, loadEvidence } from "../../src/audit/index-api.js";
import type { EvidenceBuildInput } from "../../src/audit/types.js";
import {
  DEFAULT_LIMITS,
  type HarnessEvent,
  type RunManifest,
  type RunResult,
  type TaskInput,
} from "../../src/harness/types.js";

const FP = "fp-int";

function base(
  runId: string,
  seq: number,
  ts: number,
): { schemaVersion: "1"; runId: string; fingerprint: string; seq: number; ts: number } {
  return { schemaVersion: "1", runId, fingerprint: FP, seq, ts };
}

function buildInput(runId: string, finishedAt: number): EvidenceBuildInput {
  const evs: readonly HarnessEvent[] = [
    {
      ...base(runId, 0, 100),
      type: "run:started",
      taskType: "explain-plan",
      modelId: "m1",
      limits: DEFAULT_LIMITS,
    },
    { ...base(runId, 1, finishedAt), type: "run:completed", report: "done" },
  ];
  const result: RunResult = {
    runId,
    fingerprint: FP,
    outcome: "completed",
    taskType: "explain-plan",
    startedAt: 100,
    finishedAt,
    events: evs,
  };
  const taskInput: TaskInput = { taskType: "explain-plan", input: { filePath: "src/x.ts" } };
  const manifest: RunManifest = {
    runId,
    fingerprint: FP,
    harnessVersion: "0.1.2",
    taskType: "explain-plan",
    taskInput,
    limits: DEFAULT_LIMITS,
    modelId: "m1",
    workingDirectory: "/repo",
    dryRun: true,
    startedAt: "2026-05-29T00:00:00.000Z",
    events: evs,
  };
  return { result, manifest };
}

describe("audit integration round-trip (node store under mkdtemp)", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keiko-audit-int-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a real <runId>.json, lists it, loads it back equal, and prunes to the cap", () => {
    const dir = freshDir();
    const store = createNodeEvidenceStore(dir);

    const first = persistEvidence(buildInput("run-1", 200), { store }, { maxRuns: 2 });
    expect(first.location.endsWith("run-1.json")).toBe(true);
    expect(readdirSync(dir)).toContain("run-1.json");

    const listed = listEvidence(store);
    expect(listed.map((e) => e.runId)).toEqual(["run-1"]);

    const loaded = loadEvidence(store, "run-1");
    expect(loaded).toEqual(first.manifest);

    persistEvidence(buildInput("run-2", 300), { store }, { maxRuns: 2 });
    persistEvidence(buildInput("run-3", 400), { store }, { maxRuns: 2 });

    // maxRuns: 2 → the oldest (run-1) is pruned; only run-2 and run-3 remain.
    expect([...store.list()].sort()).toEqual(["run-2", "run-3"]);
    expect(readdirSync(dir).sort()).toEqual(["run-2.json", "run-3.json"]);
  });
});
