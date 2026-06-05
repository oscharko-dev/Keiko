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
import { quarantineCorruptQualityIntelligenceManifest } from "../retention.js";
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

  it("quarantine renames the file to <runId>.qi.json.corrupt.<iso>", async () => {
    await writeCorruptManifest("run-cq-3", "garbage");
    const at = "2026-06-05T12:00:00.000Z";
    const receipt = quarantineCorruptQualityIntelligenceManifest(evidenceDir, "run-cq-3", {
      now: () => Date.parse(at),
    });
    expect(receipt.status).toBe("quarantined");
    expect(receipt.quarantinedPath).toBe(receipt.originalPath + ".corrupt." + at);
    const entries = await readdir(join(evidenceDir, QI_SUBDIR));
    expect(entries).toContain(`run-cq-3.qi.json.corrupt.${at}`);
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
});
