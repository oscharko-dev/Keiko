// Restart-recovery semantics: after an unclean shutdown, the list/load surfaces never expose a
// partially-written run. The store filters on the `<runId>.qi.json` suffix; .tmp files (the
// atomic-temp-rename failure mode) are not surfaced. snapshotQualityIntelligenceRunsForRecovery
// returns the (loadable, skipped) partition so callers can attest to the property.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeQualityIntelligenceLocalStore,
  listQualityIntelligenceRuns,
  QI_SUBDIR,
  recordQualityIntelligenceRun,
  type QualityIntelligenceRecordInput,
} from "../store.js";
import { snapshotQualityIntelligenceRunsForRecovery } from "../retention.js";
import type { QualityIntelligenceEvidenceManifest } from "../manifestSchema.js";

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-qi-recov-"));
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
        "audit-rec" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

describe("restart recovery", () => {
  it("a stray .tmp file from an interrupted write is invisible to list()", async () => {
    recordQualityIntelligenceRun(inputFor("run-rec-1"), { evidenceDir });
    // Simulate an interrupted atomic write: the temp file landed but rename never ran.
    await writeFile(
      join(evidenceDir, QI_SUBDIR, "run-rec-partial.qi.json.deadbeef.tmp"),
      "{ partial",
      "utf8",
    );
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual(["run-rec-1"]);
  });

  it("snapshotQualityIntelligenceRunsForRecovery returns loaded runs and no skipped on a clean store", () => {
    recordQualityIntelligenceRun(inputFor("run-rec-2a"), { evidenceDir });
    recordQualityIntelligenceRun(inputFor("run-rec-2b"), { evidenceDir });
    const store = createNodeQualityIntelligenceLocalStore(evidenceDir);
    const snapshot = snapshotQualityIntelligenceRunsForRecovery(store);
    expect(snapshot.loadedRunIds).toEqual(["run-rec-2a", "run-rec-2b"]);
    expect(snapshot.skippedRunIds).toEqual([]);
  });

  it("a manifest with an invalid runId-shaped filename is skipped silently", async () => {
    // The .qi.json suffix is present but the runId portion is empty → assertValidRunId fails →
    // isQiManifestName returns false → entry is filtered out of list().
    await writeFile(join(evidenceDir, QI_SUBDIR, ".qi.json"), "{}", "utf8").catch(async () => {
      // The qi/ subdir doesn't exist yet on a fresh tmpdir; create it first.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(evidenceDir, QI_SUBDIR), { recursive: true });
      await writeFile(join(evidenceDir, QI_SUBDIR, ".qi.json"), "{}", "utf8");
    });
    expect(listQualityIntelligenceRuns({ evidenceDir })).toEqual([]);
  });
});
