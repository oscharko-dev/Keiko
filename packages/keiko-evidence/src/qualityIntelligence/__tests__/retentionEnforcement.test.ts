// enforceQualityIntelligenceRetentionPolicy: the production orchestration that wires the pure
// retention decision (`applyQualityIntelligenceRetention`) to the hardened deletion primitive
// (`deleteQualityIntelligenceRun`) over a real on-disk store (Issue #1323 AC4 — retention policy
// ids become operational, not passive metadata).
//
// DESTRUCTIVE-path discipline: every uncertainty (corrupt manifest, integrity-throw, unparseable
// timestamp, unknown policy, newest-N) MUST RETAIN. These tests pin that contract so a single-line
// mutation of the purge predicate fails.

import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  QI_SUBDIR,
  recordQualityIntelligenceRun,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import { recordQualityIntelligenceCandidates } from "../candidatesArtifact.js";
import { enforceQualityIntelligenceRetentionPolicy } from "../retention.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

const identity = (value: unknown): unknown => value;

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-qi-ret-"));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

interface SeedOptions {
  readonly retentionPolicyId?: string;
  readonly completedAt?: string | undefined;
  readonly planAt?: string;
}

function inputFor(runId: string, options: SeedOptions = {}): QualityIntelligenceRecordInput {
  return {
    runId,
    planAt: options.planAt ?? "2026-01-01T00:00:00.000Z",
    completedAt: options.completedAt ?? "2026-01-01T00:05:00.000Z",
    status: "succeeded",
    policyProfileIds: [options.retentionPolicyId ?? "qi:short-30d"],
    retentionPolicyId: options.retentionPolicyId ?? "qi:short-30d",
    modelGatewayCallCount: 0,
    totals: { candidates: 0, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId:
        "audit-ret" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

function seedRun(runId: string, options: SeedOptions = {}): void {
  recordQualityIntelligenceRun(inputFor(runId, options), { evidenceDir });
  recordQualityIntelligenceCandidates({
    runId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    candidates: [],
    evidenceDir,
    redact: identity,
  });
}

// A wall-clock far enough past the short-30d window that any run timestamped at the 2026-01-01
// epoch is age-expired.
const NOW_FAR_FUTURE = (): number => Date.parse("2026-06-01T00:00:00.000Z");

describe("enforceQualityIntelligenceRetentionPolicy — age expiry", () => {
  it("deletes a run older than its profile's retainedDays and sweeps its companion", async () => {
    seedRun("run-old");
    const qiDir = join(evidenceDir, QI_SUBDIR);
    expect(await readdir(qiDir)).toContain("run-old.candidates.json");

    const { receipts, result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });

    expect(result.expiredRunIds).toEqual(["run-old"]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe("deleted");
    expect(receipts[0]?.auditEvent.type).toBe("qi:run:deleted");
    expect(receipts[0]?.removedCompanionSuffixes).toEqual([".candidates.json"]);
    const entries = await readdir(qiDir);
    expect(entries).not.toContain("run-old.qi.json");
    expect(entries).not.toContain("run-old.candidates.json");
  });

  it("retains a run still inside its profile's retainedDays window", () => {
    seedRun("run-fresh", { completedAt: "2026-05-31T00:00:00.000Z" });
    const { receipts, result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    expect(result.expiredRunIds).toEqual([]);
    expect(receipts).toEqual([]);
  });

  it("removes side-file dirs of purged runs when sideFileRoot is supplied", async () => {
    seedRun("run-side");
    const sideFileRoot = join(evidenceDir, QI_SUBDIR);
    const runSideDir = join(sideFileRoot, "run-side");
    await mkdir(runSideDir, { recursive: true });
    await writeFile(join(runSideDir, "blob.bin"), Buffer.from("x"));

    enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
      sideFileRoot,
    });

    await expect(stat(runSideDir)).rejects.toThrow();
  });
});

describe("enforceQualityIntelligenceRetentionPolicy — count expiry + newest-N retention", () => {
  it("keeps the newest maxRunArtifacts and evicts older count-exceeded runs", () => {
    // qi:short-30d caps at 100; seed 102 runs, all within the age window so only count fires.
    const base = Date.parse("2026-05-15T00:00:00.000Z");
    for (let i = 0; i < 102; i += 1) {
      const at = new Date(base + i * 1000).toISOString();
      seedRun(`run-c-${String(i).padStart(3, "0")}`, { completedAt: at });
    }
    const { result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: () => base + 200 * 1000,
    });
    // The two oldest (index 0, 1 newest-first → the last beyond 100) are evicted.
    expect(result.expiredRunIds).toEqual(["run-c-000", "run-c-001"]);
    expect(result.retainedRunIds).toHaveLength(100);
  });
});

describe("enforceQualityIntelligenceRetentionPolicy — fail-safe retention (never delete on doubt)", () => {
  it("RETAINS a run whose retentionPolicyId is unknown (forward-compat)", () => {
    seedRun("run-unknown", { retentionPolicyId: "qi:future-9000d" });
    const { receipts, result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    expect(result.expiredRunIds).toEqual([]);
    expect(receipts).toEqual([]);
  });

  it("NEVER deletes a run whose manifest is corrupt (invalid JSON)", async () => {
    const qiDir = join(evidenceDir, QI_SUBDIR);
    await mkdir(qiDir, { recursive: true });
    await writeFile(join(qiDir, "run-corrupt.qi.json"), "{ not json ");
    const { receipts, result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    expect(receipts).toEqual([]);
    expect(result.expiredRunIds).toEqual([]);
    // The corrupt file is still on disk (never purged on a load fault).
    expect(await readdir(qiDir)).toContain("run-corrupt.qi.json");
  });

  it("NEVER deletes a run whose manifest fails the integrity gate (tampered)", async () => {
    seedRun("run-tamper");
    const qiDir = join(evidenceDir, QI_SUBDIR);
    const manifestPath = join(qiDir, "run-tamper.qi.json");
    // Flip totals.findings to a value that no longer matches findings.length → integrity throws.
    const raw = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as QualityIntelligenceEvidenceManifest;
    const tampered = { ...raw, totals: { ...raw.totals, findings: 99 } };
    await writeFile(manifestPath, JSON.stringify(tampered));

    const { receipts, result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    expect(receipts).toEqual([]);
    expect(result.expiredRunIds).toEqual([]);
    expect(await readdir(qiDir)).toContain("run-tamper.qi.json");
  });

  it("NEVER ages out a run with an unparseable completedAt/planAt timestamp", async () => {
    // Build a schema-valid manifest whose timestamps are non-ISO so Date.parse → NaN. Integrity
    // hashes are over the (empty) collections, so a scalar timestamp edit still loads.
    seedRun("run-nat");
    const qiDir = join(evidenceDir, QI_SUBDIR);
    const manifestPath = join(qiDir, "run-nat.qi.json");
    const raw = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as QualityIntelligenceEvidenceManifest;
    const nat = { ...raw, completedAt: "not-a-date", planAt: "also-not-a-date" };
    await writeFile(manifestPath, JSON.stringify(nat));

    const { receipts, result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    expect(receipts).toEqual([]);
    expect(result.expiredRunIds).toEqual([]);
    // The NaN-timestamp guard EXCLUDES the run from the decision snapshot entirely — so it is not
    // even counted as a retained decision (distinguishes the guard from the pure fn's incidental
    // NaN-comparison safety; removing the guard would surface run-nat in retainedRunIds).
    expect(result.retainedRunIds).toEqual([]);
    expect(await readdir(qiDir)).toContain("run-nat.qi.json");
  });

  it("uses planAt when completedAt is undefined (running run)", () => {
    seedRun("run-running", {
      completedAt: undefined,
      planAt: "2026-01-01T00:00:00.000Z",
    });
    const { result } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    // planAt is 5 months old → age-expired under qi:short-30d.
    expect(result.expiredRunIds).toEqual(["run-running"]);
  });
});

describe("enforceQualityIntelligenceRetentionPolicy — idempotence", () => {
  it("a second enforcement after the first deletes nothing", () => {
    seedRun("run-idem");
    const first = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    expect(first.result.expiredRunIds).toEqual(["run-idem"]);
    const second = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
    });
    expect(second.result.expiredRunIds).toEqual([]);
    expect(second.receipts).toEqual([]);
  });

  it("returns an empty result when the store is empty", () => {
    const { receipts, result } = enforceQualityIntelligenceRetentionPolicy({ evidenceDir });
    expect(receipts).toEqual([]);
    expect(result.expiredRunIds).toEqual([]);
    expect(result.retainedRunIds).toEqual([]);
  });

  it("forwards companionSuffixes to the deletion primitive", async () => {
    seedRun("run-srv-comp");
    const qiDir = join(evidenceDir, QI_SUBDIR);
    await writeFile(join(qiDir, "run-srv-comp.review.json"), '{"reviewState":"pending"}');
    const { receipts } = enforceQualityIntelligenceRetentionPolicy({
      evidenceDir,
      now: NOW_FAR_FUTURE,
      companionSuffixes: [".review.json"],
    });
    expect(receipts[0]?.removedCompanionSuffixes).toContain(".review.json");
    expect(await readdir(qiDir)).not.toContain("run-srv-comp.review.json");
  });

  it("defaults now to Date.now when not injected (does not throw)", () => {
    seedRun("run-default-now", { completedAt: new Date().toISOString() });
    const { result } = enforceQualityIntelligenceRetentionPolicy({ evidenceDir });
    // A run completed 'now' is well inside the 30d window → retained.
    expect(result.expiredRunIds).toEqual([]);
  });
});

// Mixed-policy bucket independence: a long-policy run inside its window survives while a
// short-policy run of the same age is purged — proves per-policy decisioning is wired, not a
// single global threshold.
describe("enforceQualityIntelligenceRetentionPolicy — per-policy bucketing", () => {
  it("purges short-policy but retains long-policy at the same age", () => {
    const old = "2026-02-01T00:00:00.000Z"; // ~4 months before NOW_FAR_FUTURE
    seedRun("run-short", { retentionPolicyId: "qi:short-30d", completedAt: old });
    seedRun("run-long", { retentionPolicyId: "qi:long-365d", completedAt: old });
    const now = (): number => Date.parse("2026-06-01T00:00:00.000Z");
    const { result } = enforceQualityIntelligenceRetentionPolicy({ evidenceDir, now });
    expect(result.expiredRunIds).toEqual(["run-short"]);
    expect(result.retainedRunIds).toEqual(["run-long"]);
  });
});
