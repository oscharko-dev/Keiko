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
    const result = recordQualityIntelligenceRun(
      {
        ...baseInput("run-crud-1"),
        atomFingerprints: [
          {
            atomId: "atom-1",
            envelopeId: "env-1",
            canonicalHashSha256Hex: "a".repeat(64),
          },
        ],
      },
      { evidenceDir },
    );
    expect(result.manifest.qiEvidenceSchemaVersion).toBe(1);
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(["run-crud-1"]);
    const loaded = loadQualityIntelligenceRun("run-crud-1", { evidenceDir });
    expect(loaded?.runId).toBe("run-crud-1");
    expect(loaded?.status).toBe("succeeded");
    expect(loaded?.atomFingerprints?.[0]?.atomId).toBe("atom-1");
  });

  it("persists and reloads a coverageMatrix round-trip (Epic #734)", () => {
    const result = recordQualityIntelligenceRun(
      {
        ...baseInput("run-crud-cov"),
        coverageMatrix: [
          { atomId: "atom-1", status: "covered", confidence: 0.9, coveringCandidateIds: ["tc-1"] },
          { atomId: "atom-2", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
        ],
      },
      { evidenceDir },
    );
    expect(result.manifest.integrityHashes.coverageMatrix).toBeDefined();
    const loaded = loadQualityIntelligenceRun("run-crud-cov", { evidenceDir });
    expect(loaded?.coverageMatrix).toHaveLength(2);
    expect(loaded?.coverageMatrix?.[0]?.status).toBe("covered");
    expect(loaded?.coverageMatrix?.[1]?.atomId).toBe("atom-2");
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

// Issue #637 — manifest load must enforce per-group SHA-256 integrity hashes AND totals against
// the live collections so a tampered persisted manifest is rejected before any UI/BFF consumer
// sees corrupted data.
describe("load-time integrity verification (issue #637)", () => {
  async function readManifest(runId: string): Promise<Record<string, unknown>> {
    const path = join(evidenceDir, QI_SUBDIR, `${runId}.qi.json`);
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  }

  async function writeManifest(runId: string, manifest: unknown): Promise<void> {
    const path = join(evidenceDir, QI_SUBDIR, `${runId}.qi.json`);
    await writeFile(path, JSON.stringify(manifest), "utf8");
  }

  function inputWithFinding(runId: string): QualityIntelligenceRecordInput {
    return {
      ...baseInput(runId),
      totals: { candidates: 1, findings: 1, exports: 0 },
      findings: [
        {
          id: "f-1",
          kind: "logic-defect",
          severity: "medium",
          summaryRedacted: "summary-1",
        },
      ],
    };
  }

  it("rejects a load when a finding payload is mutated without recomputing the integrity hash", async () => {
    recordQualityIntelligenceRun(inputWithFinding("run-tamper-findings"), { evidenceDir });
    const original = await readManifest("run-tamper-findings");
    const findings = original.findings as readonly Record<string, unknown>[];
    const tampered = {
      ...original,
      findings: findings.map((f, i) =>
        i === 0 ? { ...f, summaryRedacted: "mutated-summary" } : f,
      ),
    };
    await writeManifest("run-tamper-findings", tampered);
    expect(() => loadQualityIntelligenceRun("run-tamper-findings", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("rejects a load when totals.findings drift from findings.length", async () => {
    recordQualityIntelligenceRun(inputWithFinding("run-tamper-totals"), { evidenceDir });
    const original = await readManifest("run-tamper-totals");
    const totals = original.totals as Record<string, number>;
    const tampered = { ...original, totals: { ...totals, findings: 99 } };
    await writeManifest("run-tamper-totals", tampered);
    expect(() => loadQualityIntelligenceRun("run-tamper-totals", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("rejects a load when an evidenceRefs entry is added without recomputing the integrity hash", async () => {
    recordQualityIntelligenceRun(baseInput("run-tamper-evidence"), { evidenceDir });
    const original = await readManifest("run-tamper-evidence");
    const tampered = {
      ...original,
      evidenceRefs: [
        { envelopeId: "env-injected", atomId: "atom-injected", lifecycleStatus: "active" },
      ],
    };
    await writeManifest("run-tamper-evidence", tampered);
    expect(() => loadQualityIntelligenceRun("run-tamper-evidence", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("rejects a load when an atomFingerprints entry is added without recomputing the integrity hash", async () => {
    recordQualityIntelligenceRun(
      {
        ...baseInput("run-tamper-atoms"),
        atomFingerprints: [
          {
            atomId: "atom-1",
            envelopeId: "env-1",
            canonicalHashSha256Hex: "a".repeat(64),
          },
        ],
      },
      { evidenceDir },
    );
    const original = await readManifest("run-tamper-atoms");
    const atomFingerprints = original.atomFingerprints as readonly Record<string, unknown>[];
    await writeManifest("run-tamper-atoms", {
      ...original,
      atomFingerprints: [
        ...atomFingerprints,
        {
          atomId: "atom-2",
          envelopeId: "env-2",
          canonicalHashSha256Hex: "b".repeat(64),
        },
      ],
    });
    expect(() => loadQualityIntelligenceRun("run-tamper-atoms", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("integrity-hashes sourceFingerprints and round-trips them (Epic #735)", () => {
    const result = recordQualityIntelligenceRun(
      {
        ...baseInput("run-crud-srcfp"),
        sourceFingerprints: [{ envelopeId: "env-1", integrityHashSha256Hex: "a".repeat(64) }],
      },
      { evidenceDir },
    );
    expect(result.manifest.integrityHashes.sourceFingerprints).toBeDefined();
    const loaded = loadQualityIntelligenceRun("run-crud-srcfp", { evidenceDir });
    expect(loaded?.sourceFingerprints?.[0]?.envelopeId).toBe("env-1");
  });

  it("rejects a load when a sourceFingerprints entry is tampered without recomputing the integrity hash (Epic #735)", async () => {
    recordQualityIntelligenceRun(
      {
        ...baseInput("run-tamper-srcfp"),
        sourceFingerprints: [{ envelopeId: "env-1", integrityHashSha256Hex: "a".repeat(64) }],
      },
      { evidenceDir },
    );
    const original = await readManifest("run-tamper-srcfp");
    const sourceFingerprints = original.sourceFingerprints as readonly Record<string, unknown>[];
    await writeManifest("run-tamper-srcfp", {
      ...original,
      // Flip the recorded hash of the existing envelope — drift detection would otherwise trust a
      // forged "unchanged" fingerprint. The recomputed hash no longer matches the stored one.
      sourceFingerprints: [{ ...sourceFingerprints[0], integrityHashSha256Hex: "b".repeat(64) }],
    });
    expect(() => loadQualityIntelligenceRun("run-tamper-srcfp", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("skips a tampered manifest in list when load is the iteration mechanism (BFF parity)", async () => {
    recordQualityIntelligenceRun(inputWithFinding("run-tamper-list-bad"), { evidenceDir });
    recordQualityIntelligenceRun(baseInput("run-tamper-list-good"), { evidenceDir });
    const original = await readManifest("run-tamper-list-bad");
    const findings = original.findings as readonly Record<string, unknown>[];
    await writeManifest("run-tamper-list-bad", {
      ...original,
      findings: findings.map((f) => ({ ...f, summaryRedacted: "mutated" })),
    });
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(
      expect.arrayContaining(["run-tamper-list-bad", "run-tamper-list-good"]),
    );
    // The store's list returns runIds (filesystem-only). BFF iteration handles per-load failures
    // and skips them — this test asserts the contract by calling load on the tampered id and
    // verifying it throws.
    expect(() => loadQualityIntelligenceRun("run-tamper-list-bad", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
    expect(loadQualityIntelligenceRun("run-tamper-list-good", { evidenceDir })?.runId).toBe(
      "run-tamper-list-good",
    );
  });

  it("rejects a load when the coverageMatrix is mutated without recomputing the integrity hash", async () => {
    recordQualityIntelligenceRun(
      {
        ...baseInput("run-tamper-cov"),
        coverageMatrix: [
          { atomId: "atom-1", status: "covered", confidence: 0.9, coveringCandidateIds: ["tc-1"] },
        ],
      },
      { evidenceDir },
    );
    const original = await readManifest("run-tamper-cov");
    const matrix = original.coverageMatrix as readonly Record<string, unknown>[];
    // Flip a covered atom to "uncovered" without recomputing the hash — must be rejected.
    await writeManifest("run-tamper-cov", {
      ...original,
      coverageMatrix: matrix.map((row, i) => (i === 0 ? { ...row, status: "uncovered" } : row)),
    });
    expect(() => loadQualityIntelligenceRun("run-tamper-cov", { evidenceDir })).toThrow(
      EvidenceReadError,
    );
  });

  it("untampered manifests still load cleanly after the integrity check (happy path)", () => {
    recordQualityIntelligenceRun(inputWithFinding("run-integrity-happy"), { evidenceDir });
    const loaded = loadQualityIntelligenceRun("run-integrity-happy", { evidenceDir });
    expect(loaded?.runId).toBe("run-integrity-happy");
    expect(loaded?.findings.length).toBe(1);
  });
});
