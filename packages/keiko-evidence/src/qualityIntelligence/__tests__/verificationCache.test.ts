// GEN-PERF-PERSISTENCE-009 regression: handleListQiRuns re-parses + SHA-256-re-hashes up to 100
// manifests per request. QI manifests are write-once (only an export append bumps mtime+size), so
// a positive verification is memoised keyed by path + mtimeMs + size. Writes prime the same cache
// with the already-built manifest, so immediate post-write lists do not re-read/re-hash. This proves:
//   - unchanged manifests perform ZERO additional parse+verify passes after write-cache priming;
//   - modifying a manifest on disk (export append / tamper) forces a re-verify (cache miss);
//   - 100 manifests list + re-list stays well under the finding's 150ms budget.
// The verification counter (__qiVerificationStats) increments once per full parse+integrity pass,
// so a delta of 0 across the second list proves the expensive re-hash was skipped.

import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceFs, WorkspaceStat } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __qiVerificationStats,
  __resetQiVerificationCacheForTests,
  createNodeQualityIntelligenceLocalStore,
  listQualityIntelligenceRuns,
  loadQualityIntelligenceRun,
  recordQualityIntelligenceRun,
  QI_SUBDIR,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

let evidenceDir: string;

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

function withoutMtime(stat: WorkspaceStat): WorkspaceStat {
  const base = {
    size: stat.size,
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    isSymbolicLink: stat.isSymbolicLink,
  };
  return stat.hardLinkCount === undefined ? base : { ...base, hardLinkCount: stat.hardLinkCount };
}

function noMtimeFs(): WorkspaceFs {
  return {
    ...nodeWorkspaceFs,
    stat: (absolutePath: string): WorkspaceStat => withoutMtime(nodeWorkspaceFs.stat(absolutePath)),
  };
}

describe("QI manifest verification cache (GEN-PERF-PERSISTENCE-009)", () => {
  it("re-verifies ZERO unchanged manifests on a second list, and stays under budget for 100", () => {
    const count = 100;
    for (let i = 0; i < count; i += 1) {
      recordQualityIntelligenceRun(baseInput(`run-vcache-${String(i).padStart(3, "0")}`), {
        evidenceDir,
      });
    }
    // recordQualityIntelligenceRun builds and writes the manifest, then primes the verification cache
    // with that already-built object. A following list must not re-read/re-verify unchanged manifests.
    __qiVerificationStats.verifications = 0;

    const firstStart = performance.now();
    listAll();
    const firstMs = performance.now() - firstStart;
    expect(__qiVerificationStats.verifications).toBe(0);

    const before = __qiVerificationStats.verifications;
    const secondStart = performance.now();
    listAll();
    const secondMs = performance.now() - secondStart;
    // PRE-FIX this delta would equal `count` (every manifest re-parsed + re-hashed). POST-FIX: 0.
    expect(__qiVerificationStats.verifications - before).toBe(0);

    // Combined budget: both a cold and a warm pass over 100 manifests must be well under 150ms.
    expect(firstMs + secondMs).toBeLessThan(150);
  });

  it("re-verifies a manifest after an on-disk change bumps its mtime (tamper-evidence preserved)", async () => {
    const runId = "run-vcache-mtime";
    recordQualityIntelligenceRun(baseInput(runId), { evidenceDir });
    __qiVerificationStats.verifications = 0;

    loadQualityIntelligenceRun(runId, { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(0);

    // Warm hit: no new verification.
    loadQualityIntelligenceRun(runId, { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(0);

    // Bump mtime (simulating an export append / at-rest touch) -> cache miss -> re-verify.
    const target = join(evidenceDir, QI_SUBDIR, `${runId}.qi.json`);
    const future = new Date(Date.now() + 5_000);
    await utimes(target, future, future);
    loadQualityIntelligenceRun(runId, { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(1);
  });

  it("does not cache when the filesystem cannot report mtimeMs", () => {
    const runId = "run-vcache-no-mtime";
    const store = createNodeQualityIntelligenceLocalStore(evidenceDir, { fs: noMtimeFs() });
    recordQualityIntelligenceRun(baseInput(runId), { store });
    __qiVerificationStats.verifications = 0;

    loadQualityIntelligenceRun(runId, { store });
    expect(__qiVerificationStats.verifications).toBe(1);

    loadQualityIntelligenceRun(runId, { store });
    expect(__qiVerificationStats.verifications).toBe(2);
  });

  it("bounds the verification cache and re-verifies the evicted oldest manifest", () => {
    const count = 257;
    for (let i = 0; i < count; i += 1) {
      recordQualityIntelligenceRun(baseInput(`run-vcache-evict-${String(i).padStart(3, "0")}`), {
        evidenceDir,
      });
    }
    __qiVerificationStats.verifications = 0;

    loadQualityIntelligenceRun("run-vcache-evict-000", { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(1);

    loadQualityIntelligenceRun("run-vcache-evict-256", { evidenceDir });
    expect(__qiVerificationStats.verifications).toBe(1);
  });
});
