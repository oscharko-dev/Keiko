import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistEvidence } from "../../src/audit/persist.js";
import { createInMemoryEvidenceStore } from "../../src/audit/store.js";
import { loadEvidence } from "../../src/audit/index-api.js";
import type { EvidenceBuildInput } from "../../src/audit/types.js";
import {
  DEFAULT_LIMITS,
  type HarnessEvent,
  type RunManifest,
  type RunResult,
  type TaskInput,
} from "../../src/harness/types.js";

const RUN_ID = "run-persist";
const FP = "fp-1";
const GITHUB = `ghp_${"A".repeat(36)}`;

function base(
  seq: number,
  ts: number,
): { schemaVersion: "1"; runId: string; fingerprint: string; seq: number; ts: number } {
  return { schemaVersion: "1", runId: RUN_ID, fingerprint: FP, seq, ts };
}

function events(): readonly HarnessEvent[] {
  return [
    {
      ...base(0, 100),
      type: "run:started",
      taskType: "explain-plan",
      modelId: "m1",
      limits: DEFAULT_LIMITS,
    },
    {
      ...base(1, 110),
      type: "state:transition",
      from: "intake",
      to: "planning",
      reason: `token ${GITHUB}`,
    },
    { ...base(2, 200), type: "run:completed", report: "done" },
  ];
}

function buildInput(): EvidenceBuildInput {
  const evs = events();
  const result: RunResult = {
    runId: RUN_ID,
    fingerprint: FP,
    outcome: "completed",
    taskType: "explain-plan",
    startedAt: 100,
    finishedAt: 200,
    events: evs,
  };
  const taskInput: TaskInput = { taskType: "explain-plan", input: { filePath: "src/x.ts" } };
  const manifest: RunManifest = {
    runId: RUN_ID,
    fingerprint: FP,
    harnessVersion: "0.1.0",
    taskType: "explain-plan",
    taskInput,
    limits: DEFAULT_LIMITS,
    modelId: "m1",
    startedAt: "2026-05-29T00:00:00.000Z",
    events: evs,
  };
  return { result, manifest };
}

describe("persistEvidence", () => {
  it("builds, writes, and returns the manifest/location/report", () => {
    const store = createInMemoryEvidenceStore();
    const out = persistEvidence(buildInput(), { store });
    expect(out.location).toBe("run-persist.json");
    expect(out.manifest.run.runId).toBe(RUN_ID);
    expect(out.report.runId).toBe(RUN_ID);
    expect(store.list()).toEqual([RUN_ID]);
  });

  it("persists a redacted document — the GitHub token never reaches the store", () => {
    const store = createInMemoryEvidenceStore();
    persistEvidence(buildInput(), { store });
    const raw = store.get(RUN_ID);
    expect(raw).toBeDefined();
    expect(raw).not.toContain(GITHUB);
    expect(raw).toContain("[REDACTED]");
  });

  it("round-trips: the loaded manifest equals the returned manifest", () => {
    const store = createInMemoryEvidenceStore();
    const out = persistEvidence(buildInput(), { store });
    expect(loadEvidence(store, RUN_ID)).toEqual(out.manifest);
  });

  it("applies retention after writing (deletes older runs beyond the cap)", () => {
    const store = createInMemoryEvidenceStore();
    const first = buildInput();
    persistEvidence(first, { store }, { maxRuns: 1 });
    // A second run with a later finishedAt and a different id.
    const second = buildInput();
    const secondResult = { ...second.result, runId: "run-newer", finishedAt: 999 };
    const secondManifest = { ...second.manifest, runId: "run-newer" };
    persistEvidence({ result: secondResult, manifest: secondManifest }, { store }, { maxRuns: 1 });
    expect(store.list()).toEqual(["run-newer"]);
  });

  it("defense-in-depth: a non-redacted secret smuggled past the builder is still scrubbed before write", () => {
    // The context summary is embedded verbatim by the builder (not redacted there). If a secret
    // appears in a context path, the persist-time deep re-redaction must still scrub it.
    const input = buildInput();
    const withContext: EvidenceBuildInput = {
      ...input,
      context: {
        workspaceRoot: "/repo",
        totalCandidates: 1,
        usedBytes: 1,
        budgetBytes: 1,
        droppedForBudget: 0,
        entries: [
          {
            path: `src/${GITHUB}.ts`,
            sizeBytes: 1,
            excerptBytes: 0,
            selectionReason: "source",
            truncated: false,
          },
        ],
      },
    };
    const store = createInMemoryEvidenceStore();
    persistEvidence(withContext, { store });
    expect(store.get(RUN_ID)).not.toContain(GITHUB);
  });
});

describe("persistEvidence — default store writes to a predictable local dir (C5)", () => {
  const dirs: string[] = [];
  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keiko-persist-default-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists to a real node store at the resolved KEIKO_EVIDENCE_DIR when no store is injected", () => {
    const dir = freshDir();
    // No deps.store: persistEvidence must default to the node store at the resolved dir (NOT an
    // in-memory store that would silently discard the evidence). KEIKO_EVIDENCE_DIR points at an
    // os-tmpdir so nothing lands in the repo tree.
    const out = persistEvidence(buildInput(), { env: { KEIKO_EVIDENCE_DIR: dir } });
    expect(out.location.endsWith(`${RUN_ID}.json`)).toBe(true);
    expect(readdirSync(dir)).toContain(`${RUN_ID}.json`);
  });
});
