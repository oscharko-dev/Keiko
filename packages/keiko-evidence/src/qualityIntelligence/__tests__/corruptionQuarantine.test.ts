// Corrupt-manifest quarantine: a single bad QI manifest file is moved to
// `<runId>.qi.json.corrupt.<iso>` so it cannot brick the rest of the QI store. After
// quarantine, list() and load() proceed as if the file had never existed (recovery is implicit
// because the filename no longer ends in `.qi.json`).

import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listQualityIntelligenceRuns,
  loadQualityIntelligenceRun,
  QI_SUBDIR,
  recordQualityIntelligenceRun,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import {
  enforceQualityIntelligenceQuarantineRetention,
  quarantineCorruptQualityIntelligenceManifest,
} from "../retention.js";
import { EvidenceReadError } from "../../errors.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-qi-corrupt-"));
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
        "audit-q" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

async function writeCorruptManifest(runId: string, body: string): Promise<string> {
  const dir = join(evidenceDir, QI_SUBDIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${runId}.qi.json`);
  await writeFile(path, body, "utf8");
  return path;
}

describe("quarantineCorruptQualityIntelligenceManifest", () => {
  it("loadQualityIntelligenceRun throws EvidenceReadError on malformed JSON (pre-quarantine signal)", async () => {
    await writeCorruptManifest("run-cq-1", "not-json-at-all");
    expect(() => loadQualityIntelligenceRun("run-cq-1", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("loadQualityIntelligenceRun throws EvidenceReadError on wrong schema-version (pre-quarantine signal)", async () => {
    await writeCorruptManifest(
      "run-cq-2",
      JSON.stringify({ qiEvidenceSchemaVersion: 99, status: "succeeded" }),
    );
    expect(() => loadQualityIntelligenceRun("run-cq-2", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("quarantine renames the file to <runId>.qi.json.corrupt.<filesystem-safe-timestamp>", async () => {
    await writeCorruptManifest("run-cq-3", "garbage");
    const at = "2026-06-05T12:00:00.000Z";
    const safeAt = "2026-06-05T12-00-00-000Z";
    const receipt = quarantineCorruptQualityIntelligenceManifest(evidenceDir, "run-cq-3", {
      now: () => Date.parse(at),
    });
    expect(receipt.status).toBe("quarantined");
    expect(receipt.quarantinedPath).toBe(receipt.originalPath + ".corrupt." + safeAt);
    const entries = await readdir(join(evidenceDir, QI_SUBDIR));
    expect(entries).toContain(`run-cq-3.qi.json.corrupt.${safeAt}`);
    expect(entries).not.toContain("run-cq-3.qi.json");
  });

  it("after quarantine, list() and load() proceed as if the file never existed", async () => {
    recordQualityIntelligenceRun(inputFor("run-cq-ok"), { evidenceDir });
    await writeCorruptManifest("run-cq-bad", "{ not-valid: true ");
    quarantineCorruptQualityIntelligenceManifest(evidenceDir, "run-cq-bad");
    // Only the well-formed run is visible — the corrupt-quarantine file's name no longer matches
    // the `<runId>.qi.json` suffix gate.
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(["run-cq-ok"]);
    expect(loadQualityIntelligenceRun("run-cq-bad", { evidenceDir })).toBeUndefined();
  });

  it("preserves the quarantined file contents byte-for-byte (forensic)", async () => {
    const body = "{ tampered but salvageable for forensic review }";
    const original = await writeCorruptManifest("run-cq-bytes", body);
    const receipt = quarantineCorruptQualityIntelligenceManifest(evidenceDir, "run-cq-bytes");
    expect(receipt.originalPath).toBe(original);
    const preserved = await readFile(receipt.quarantinedPath, "utf8");
    expect(preserved).toBe(body);
  });

  it("quarantine on an absent runId returns status=absent (no throw)", () => {
    const receipt = quarantineCorruptQualityIntelligenceManifest(
      evidenceDir,
      "run-cq-never-existed",
    );
    expect(receipt.status).toBe("absent");
  });

  it("rejects an invalid runId at the quarantine boundary", () => {
    expect(() => quarantineCorruptQualityIntelligenceManifest(evidenceDir, "../escape")).toThrow();
  });

  it("purges quarantined manifests by age without touching active manifests", async () => {
    recordQualityIntelligenceRun(inputFor("run-cq-live"), { evidenceDir });
    await writeCorruptManifest("run-cq-old", "old");
    await writeCorruptManifest("run-cq-new", "new");
    quarantineCorruptQualityIntelligenceManifest(evidenceDir, "run-cq-old", {
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    quarantineCorruptQualityIntelligenceManifest(evidenceDir, "run-cq-new", {
      now: () => Date.parse("2026-07-01T00:00:00.000Z"),
    });

    const result = enforceQualityIntelligenceQuarantineRetention({
      evidenceDir,
      now: () => Date.parse("2026-07-15T00:00:00.000Z"),
      retainedDays: 30,
    });

    expect(result.removed).toEqual([
      expect.objectContaining({ runId: "run-cq-old", reason: "age-exceeded" }),
    ]);
    const entries = await readdir(join(evidenceDir, QI_SUBDIR));
    expect(entries).toContain("run-cq-live.qi.json");
    expect(entries).toContain("run-cq-new.qi.json.corrupt.2026-07-01T00-00-00-000Z");
    expect(entries).not.toContain("run-cq-old.qi.json.corrupt.2026-01-01T00-00-00-000Z");
  });

  it("purges oldest quarantined manifests beyond the count cap", async () => {
    for (let i = 0; i < 3; i += 1) {
      const runId = `run-cq-count-${String(i)}`;
      await writeCorruptManifest(runId, String(i));
      quarantineCorruptQualityIntelligenceManifest(evidenceDir, runId, {
        now: () => Date.parse(`2026-06-0${String(i + 1)}T00:00:00.000Z`),
      });
    }

    const result = enforceQualityIntelligenceQuarantineRetention({
      evidenceDir,
      now: () => Date.parse("2026-06-10T00:00:00.000Z"),
      retainedDays: 365,
      maxQuarantinedManifests: 2,
    });

    expect(result.removed).toEqual([
      expect.objectContaining({ runId: "run-cq-count-0", reason: "count-exceeded" }),
    ]);
  });

  it("skips malformed quarantine names instead of deleting them", async () => {
    const dir = join(evidenceDir, QI_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "not-a-run!.qi.json.corrupt.2026-01-01T00-00-00-000Z"), "bad");

    const result = enforceQualityIntelligenceQuarantineRetention({
      evidenceDir,
      now: () => Date.parse("2026-07-15T00:00:00.000Z"),
      retainedDays: 30,
    });

    expect(result.removed).toEqual([]);
    expect(result.skippedPaths.join("\n")).toContain(
      "not-a-run!.qi.json.corrupt.2026-01-01T00-00-00-000Z",
    );
    expect((await readdir(dir)).join("\n")).toContain(
      "not-a-run!.qi.json.corrupt.2026-01-01T00-00-00-000Z",
    );
  });
});
