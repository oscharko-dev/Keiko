// deleteQualityIntelligenceRun: idempotent removal of manifest + optional per-run side-file dir.
// Emits a `qi:run:deleted` audit event regardless of pre-existence (status distinguishes
// "deleted" from "absent" so the orchestrator can route both to the audit ledger).

import { mkdir, mkdtemp, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  QI_SUBDIR,
  recordQualityIntelligenceRun,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import { deleteQualityIntelligenceRun } from "../retention.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-qi-del-"));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

function inputFor(runId: string): QualityIntelligenceRecordInput {
  return {
    runId,
    planAt: "2026-06-05T10:00:00.000Z",
    completedAt: "2026-06-05T10:05:00.000Z",
    status: "succeeded",
    policyProfileIds: ["qi:short-30d"],
    retentionPolicyId: "qi:short-30d",
    modelGatewayCallCount: 0,
    totals: { candidates: 0, findings: 0, exports: 0 },
    findings: [],
    exports: [],
    evidenceRefs: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId:
        "audit-d1" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

describe("deleteQualityIntelligenceRun", () => {
  it("removes the on-disk manifest and reports status=deleted", async () => {
    recordQualityIntelligenceRun(inputFor("run-del-1"), { evidenceDir });
    const receipt = deleteQualityIntelligenceRun("run-del-1", { evidenceDir });
    expect(receipt.status).toBe("deleted");
    expect(receipt.auditEvent.type).toBe("qi:run:deleted");
    expect(receipt.auditEvent.runId).toBe("run-del-1");
    const entries = await readdir(join(evidenceDir, QI_SUBDIR));
    expect(entries).not.toContain("run-del-1.qi.json");
  });

  it("is idempotent: deleting an absent runId returns status=absent (no throw)", () => {
    const receipt = deleteQualityIntelligenceRun("run-never-existed", { evidenceDir });
    expect(receipt.status).toBe("absent");
    expect(receipt.auditEvent.runId).toBe("run-never-existed");
  });

  it("emits a typed audit event with an ISO-8601 timestamp", () => {
    const at = "2026-06-05T11:22:33.000Z";
    const receipt = deleteQualityIntelligenceRun("run-del-iso", {
      evidenceDir,
      now: () => Date.parse(at),
    });
    expect(receipt.auditEvent.at).toBe(at);
  });

  it("when sideFileRoot is supplied, recursively removes <sideFileRoot>/<runId>/", async () => {
    recordQualityIntelligenceRun(inputFor("run-del-side"), { evidenceDir });
    const sideFileRoot = join(evidenceDir, QI_SUBDIR);
    const runSideDir = join(sideFileRoot, "run-del-side");
    await mkdir(runSideDir, { recursive: true });
    await writeFile(join(runSideDir, "screenshot.png"), Buffer.from("img"));
    const receipt = deleteQualityIntelligenceRun("run-del-side", { evidenceDir, sideFileRoot });
    expect(receipt.status).toBe("deleted");
    await expect(stat(runSideDir)).rejects.toThrow();
  });

  it("refuses to follow a symlink at the per-run side-file dir (defence)", async () => {
    recordQualityIntelligenceRun(inputFor("run-del-link"), { evidenceDir });
    const sideFileRoot = join(evidenceDir, QI_SUBDIR);
    const target = await mkdtemp(join(tmpdir(), "keiko-qi-del-target-"));
    try {
      await symlink(target, join(sideFileRoot, "run-del-link"));
      expect(() =>
        deleteQualityIntelligenceRun("run-del-link", { evidenceDir, sideFileRoot }),
      ).toThrow(/symlink/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("requires options.store or options.evidenceDir", () => {
    expect(() => deleteQualityIntelligenceRun("anything")).toThrow();
  });
});
