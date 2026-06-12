// deleteQualityIntelligenceRun: idempotent removal of manifest + optional per-run side-file dir.
// Emits a `qi:run:deleted` audit event regardless of pre-existence (status distinguishes
// "deleted" from "absent" so the orchestrator can route both to the audit ledger).

import { mkdir, mkdtemp, readdir, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryQualityIntelligenceLocalStore,
  QI_SUBDIR,
  recordQualityIntelligenceRun,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import { deleteQualityIntelligenceRun } from "../retention.js";
import { recordQualityIntelligenceCandidates } from "../candidatesArtifact.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

const identity = (value: unknown): unknown => value;

// Writes the always-present `.candidates.json` companion for a run (empty body is enough to prove
// the on-disk file exists and gets swept).
function writeCandidatesCompanion(runId: string, dir: string): void {
  recordQualityIntelligenceCandidates({
    runId,
    generatedAt: "2026-06-05T10:00:00.000Z",
    candidates: [],
    evidenceDir: dir,
    redact: identity,
  });
}

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

// Issue #274 AC4: "Deleting a run removes associated local artifacts." Before this, deletion left
// the run's companion artifacts (e.g. the always-present `.candidates.json` test bodies derived
// from customer source) orphaned in the same `qi/` dir → a privacy/retention leak.
describe("deleteQualityIntelligenceRun — companion sweep (#274 AC4)", () => {
  it("removes the evidence-owned `.candidates.json` companion and reports it on the receipt", async () => {
    recordQualityIntelligenceRun(inputFor("run-comp-1"), { evidenceDir });
    writeCandidatesCompanion("run-comp-1", evidenceDir);
    const qiDir = join(evidenceDir, QI_SUBDIR);
    expect(await readdir(qiDir)).toContain("run-comp-1.candidates.json");

    const receipt = deleteQualityIntelligenceRun("run-comp-1", { evidenceDir });

    expect(receipt.status).toBe("deleted");
    expect(receipt.removedCompanionSuffixes).toEqual([".candidates.json"]);
    expect(receipt.auditEvent.removedCompanionSuffixes).toEqual([".candidates.json"]);
    const entries = await readdir(qiDir);
    expect(entries).not.toContain("run-comp-1.qi.json");
    expect(entries).not.toContain("run-comp-1.candidates.json");
  });

  it("removes caller-supplied server-owned companion suffixes (e.g. `.review.json`)", async () => {
    recordQualityIntelligenceRun(inputFor("run-comp-srv"), { evidenceDir });
    writeCandidatesCompanion("run-comp-srv", evidenceDir);
    const qiDir = join(evidenceDir, QI_SUBDIR);
    await writeFile(join(qiDir, "run-comp-srv.review.json"), '{"reviewState":"pending"}');

    const receipt = deleteQualityIntelligenceRun("run-comp-srv", {
      evidenceDir,
      companionSuffixes: [".review.json"],
    });

    expect(receipt.removedCompanionSuffixes).toEqual([".candidates.json", ".review.json"]);
    const entries = await readdir(qiDir);
    expect(entries).not.toContain("run-comp-srv.review.json");
    expect(entries).not.toContain("run-comp-srv.candidates.json");
  });

  // Regression guard for the dotted-runId collision hazard: `.` is a legal non-leading runId
  // character, so `run-1` and `run-1.2` coexist. A `startsWith(runId)` sweep would let deleting
  // `run-1` destroy `run-1.2`'s companion — exact-suffix matching MUST prevent that.
  it("does NOT touch a different run whose id is a dotted superstring (collision-safety)", async () => {
    recordQualityIntelligenceRun(inputFor("run-1"), { evidenceDir });
    writeCandidatesCompanion("run-1", evidenceDir);
    recordQualityIntelligenceRun(inputFor("run-1.2"), { evidenceDir });
    writeCandidatesCompanion("run-1.2", evidenceDir);

    deleteQualityIntelligenceRun("run-1", { evidenceDir });

    const entries = await readdir(join(evidenceDir, QI_SUBDIR));
    expect(entries).not.toContain("run-1.candidates.json");
    expect(entries).not.toContain("run-1.qi.json");
    // run-1.2's artifacts survive — they belong to a different run.
    expect(entries).toContain("run-1.2.candidates.json");
    expect(entries).toContain("run-1.2.qi.json");
  });

  it("is idempotent: a second delete removes nothing and reports no companions (no throw)", () => {
    recordQualityIntelligenceRun(inputFor("run-comp-idem"), { evidenceDir });
    writeCandidatesCompanion("run-comp-idem", evidenceDir);
    deleteQualityIntelligenceRun("run-comp-idem", { evidenceDir });

    const receipt = deleteQualityIntelligenceRun("run-comp-idem", { evidenceDir });

    expect(receipt.status).toBe("absent");
    expect(receipt.removedCompanionSuffixes).toEqual([]);
  });

  it("skips the on-disk sweep for an in-memory store (no evidenceDir)", () => {
    const store = createInMemoryQualityIntelligenceLocalStore();
    recordQualityIntelligenceRun(inputFor("run-comp-mem"), { store });

    const receipt = deleteQualityIntelligenceRun("run-comp-mem", { store });

    expect(receipt.status).toBe("deleted");
    expect(receipt.removedCompanionSuffixes).toEqual([]);
  });
});
