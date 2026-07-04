// GEN-PERF-PERSISTENCE-009 regression: handleListQiRuns re-parses + SHA-256-re-hashes up to 100
// manifests per request. QI manifests are write-once (only an export append bumps mtime+size), so
// a positive verification is memoised keyed by path + mtimeMs + size. This proves:
//   - a second list of unchanged manifests performs ZERO additional parse+verify passes;
//   - modifying a manifest on disk (export append / tamper) forces a re-verify (cache miss);
//   - 100 manifests list + re-list stays bounded without reintroducing per-list verification work.
// The verification counter (__qiVerificationStats) increments once per full parse+integrity pass,
// so a delta of 0 across the second list proves the expensive re-hash was skipped.

import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __qiVerificationStats,
  __resetQiVerificationCacheForTests,
  listQualityIntelligenceRuns,
  loadQualityIntelligenceRun,
  recordQualityIntelligenceRun,
  QI_SUBDIR,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

let evidenceDir: string;
const BOUNDED_LIST_BUDGET_MS = 2_000;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-qi-vcache-"));
  __resetQiVerificationCacheForTests();
  __qiVerificationStats.verifications = 0;
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

function baseInput(runId: string): QualityIntelligenceRecordInput {
  return {
    runId,
    planAt: "2026-07-03T10:00:00.000Z",
    completedAt: "2026-07-03T10:05:00.000Z",
    status: "succeeded",
    policyProfileIds: ["qi:short-30d"],
    retentionPolicyId: "qi:short-30d",
    modelGatewayCallCount: 1,
    totals: { candidates: 0, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId:
        "audit-r1" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

function listAll(): void {
  for (const runId of listQualityIntelligenceRuns({ evidenceDir })) {
    loadQualityIntelligenceRun(runId, { evidenceDir });
  }
}

describe("QI manifest verification cache (GEN-PERF-PERSISTENCE-009)", () => {
  it("re-verifies ZERO unchanged manifests on a second list, and stays bounded for 100", () => {
    const count = 100;
    for (let i = 0; i < count; i += 1) {
      recordQualityIntelligenceRun(baseInput(`run-vcache-${String(i).padStart(3, "0")}`), {
        evidenceDir,
      });
    }
    // recordQualityIntelligenceRun does not read/verify, so the first list is the priming pass.
    __qiVerificationStats.verifications = 0;

    const firstStart = performance.now();
    listAll();
    const firstMs = performance.now() - firstStart;
    // First list verifies every manifest exactly once.
    expect(__qiVerificationStats.verifications).toBe(count);

    const before = __qiVerificationStats.verifications;
    const secondStart = performance.now();
    listAll();
    const secondMs = performance.now() - secondStart;
    // PRE-FIX this delta would equal `count` (every manifest re-parsed + re-hashed). POST-FIX: 0.
    expect(__qiVerificationStats.verifications - before).toBe(0);

    // The hard regression guard is the counter above. Keep the wall-clock check broad enough to
    // survive local/CI load while still catching pathological cache misses or filesystem stalls.
    expect(secondMs).toBeLessThan(firstMs);
    expect(firstMs + secondMs).toBeLessThan(BOUNDED_LIST_BUDGET_MS);
  });

  it("re-verifies a manifest after an on-disk change bumps its mtime (tamper-evidence preserved)", async () => {
    const runId = "run-vcache-mtime";
    recordQualityIntelligenceRun(baseInput(runId), { evidenceDir });
    __qiVerificationStats.verifications = 0;

    loadQualityIntelligenceRun(runId, { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(1);

    // Warm hit: no new verification.
    loadQualityIntelligenceRun(runId, { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(1);

    // Bump mtime (simulating an export append / at-rest touch) -> cache miss -> re-verify.
    const target = join(evidenceDir, QI_SUBDIR, `${runId}.qi.json`);
    const future = new Date(Date.now() + 5_000);
    await utimes(target, future, future);
    loadQualityIntelligenceRun(runId, { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(2);
  });
});
