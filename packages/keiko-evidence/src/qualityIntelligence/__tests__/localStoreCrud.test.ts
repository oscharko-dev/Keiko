// Record + read + list using a mkdtemp ephemeral evidenceDir. Asserts:
// - Redaction happens BEFORE persist (the on-disk file contains no caller secret).
// - The totals-vs-collection-length invariant fails closed.
// - Schema validation rejects a stored manifest with an unknown top-level key (defensive read).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";
import { EvidenceReadError, EvidenceWriteError } from "../../errors.js";

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-qi-crud-"));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

function baseInput(runId: string): QualityIntelligenceRecordInput {
  return {
    runId,
    planAt: "2026-06-05T10:00:00.000Z",
    completedAt: "2026-06-05T10:05:00.000Z",
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

describe("recordQualityIntelligenceRun + load + list", () => {
  it("persists a redacted manifest, list+load round-trip", () => {
    const result = recordQualityIntelligenceRun(baseInput("run-crud-1"), { evidenceDir });
    expect(result.manifest.qiEvidenceSchemaVersion).toBe(1);
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(["run-crud-1"]);
    const loaded = loadQualityIntelligenceRun("run-crud-1", { evidenceDir });
    expect(loaded?.runId).toBe("run-crud-1");
    expect(loaded?.status).toBe("succeeded");
  });

  it("redaction happens BEFORE persist: on-disk file contains no caller secret", async () => {
    const input: QualityIntelligenceRecordInput = {
      ...baseInput("run-crud-2"),
      totals: { candidates: 1, findings: 1, exports: 0 },
      findings: [
        {
          id: "f-1",
          kind: "logic-defect",
          severity: "medium",
          summaryRedacted: "raw: Bearer leaked-token-from-caller-XYZ",
        },
      ],
    };
    recordQualityIntelligenceRun(input, {
      evidenceDir,
      redaction: { additionalSecrets: ["leaked-token-from-caller-XYZ"] },
    });
    const onDisk = await readFile(join(evidenceDir, QI_SUBDIR, "run-crud-2.qi.json"), "utf8");
    expect(onDisk).not.toContain("leaked-token-from-caller-XYZ");
    expect(onDisk).toContain("[REDACTED]");
  });

  it("the persisted manifest carries a non-zero redactionSummary when secrets were present", () => {
    const result = recordQualityIntelligenceRun(
      {
        ...baseInput("run-crud-3"),
        totals: { candidates: 0, findings: 1, exports: 0 },
        findings: [
          {
            id: "f-1",
            kind: "logic-defect",
            severity: "medium",
            // Bare JWT shape exercises the QI jwt pattern; a `id_token=<jwt>` form is now redacted
            // earlier by the security package's key-name pass and would not reach the jwt bucket.
            summaryRedacted: "trace aaaaaaaa.bbbbbbbb.cccccccc tail",
          },
        ],
      },
      { evidenceDir },
    );
    expect(result.manifest.redactionSummary.stringsRedacted).toBeGreaterThan(0);
    expect(result.manifest.redactionSummary.patternsMatched.jwt).toBeGreaterThan(0);
  });

  it("rejects a totals/collection-length mismatch with EvidenceWriteError", () => {
    const input: QualityIntelligenceRecordInput = {
      ...baseInput("run-crud-mismatch"),
      totals: { candidates: 0, findings: 5, exports: 0 },
      findings: [], // length 0, totals.findings says 5
    };
    expect(() => recordQualityIntelligenceRun(input, { evidenceDir })).toThrow(EvidenceWriteError);
  });

  it("loadQualityIntelligenceRun returns undefined for a missing runId", () => {
    expect(loadQualityIntelligenceRun("run-absent", { evidenceDir })).toBeUndefined();
  });

  it("defensive read rejects a tampered on-disk manifest with an unknown key", async () => {
    recordQualityIntelligenceRun(baseInput("run-crud-tamper"), { evidenceDir });
    const path = join(evidenceDir, QI_SUBDIR, "run-crud-tamper.qi.json");
    const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const tampered = { ...original, sneakyExtraField: 42 };
    await writeFile(path, JSON.stringify(tampered), "utf8");
    expect(() => loadQualityIntelligenceRun("run-crud-tamper", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("listQualityIntelligenceRuns returns a sorted, deduplicated set", () => {
    recordQualityIntelligenceRun(baseInput("run-crud-b"), { evidenceDir });
    recordQualityIntelligenceRun(baseInput("run-crud-a"), { evidenceDir });
    recordQualityIntelligenceRun(baseInput("run-crud-c"), { evidenceDir });
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual([
      "run-crud-a",
      "run-crud-b",
      "run-crud-c",
    ]);
  });

  it("rejects an invalid runId at the record boundary (assertValidRunId)", () => {
    const input: QualityIntelligenceRecordInput = {
      ...baseInput("../escape"),
    };
    expect(() => recordQualityIntelligenceRun(input, { evidenceDir })).toThrow();
  });
});
