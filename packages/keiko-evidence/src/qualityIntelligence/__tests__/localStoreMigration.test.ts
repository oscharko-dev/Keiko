// "Migration" semantics for the JSON-on-disk QI store:
//   - Fresh evidenceDir: V1 ready on first record (no prior dir, no prior file).
//   - Existing evidenceDir with prior QI manifests: re-instantiating the store is idempotent
//     (same manifests visible, no mutation). This is the additive-only invariant the brief
//     guarantees for the schema version literal.
//   - The qi/ subdir is created on first write; no existing-file is mutated.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeQualityIntelligenceLocalStore,
  QI_SUBDIR,
  recordQualityIntelligenceRun,
} from "../store.js";
import {
  QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION,
  type QualityIntelligenceEvidenceManifest,
} from "../manifestSchema.js";

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "keiko-qi-mig-"));
});

afterEach(async () => {
  await rm(evidenceDir, { recursive: true, force: true });
});

function recordInput(runId: string): Parameters<typeof recordQualityIntelligenceRun>[0] {
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
        "audit-x" as QualityIntelligenceEvidenceManifest["provenanceRefs"]["auditSummaryId"],
    },
  };
}

describe("QI store migration semantics", () => {
  it("a fresh evidenceDir lets the first record() succeed (V1 schema applied implicitly)", async () => {
    const { manifest } = recordQualityIntelligenceRun(recordInput("run-fresh-1"), {
      evidenceDir,
    });
    expect(manifest.qiEvidenceSchemaVersion).toBe(QUALITY_INTELLIGENCE_EVIDENCE_SCHEMA_VERSION);
    const expected = join(evidenceDir, QI_SUBDIR, "run-fresh-1.qi.json");
    const onDisk = JSON.parse(await readFile(expected, "utf8")) as {
      qiEvidenceSchemaVersion: number;
    };
    expect(onDisk.qiEvidenceSchemaVersion).toBe(1);
  });

  it("creates the qi/ subdir on first write and does not touch siblings", async () => {
    await writeFile(join(evidenceDir, "neighbour.json"), "{}", "utf8");
    recordQualityIntelligenceRun(recordInput("run-mig-2"), { evidenceDir });
    const qiDirStat = await stat(join(evidenceDir, QI_SUBDIR));
    expect(qiDirStat.isDirectory()).toBe(true);
    const sibling = await readFile(join(evidenceDir, "neighbour.json"), "utf8");
    expect(sibling).toBe("{}");
  });

  it("re-instantiating the store on a populated dir is idempotent (no mutation)", async () => {
    recordQualityIntelligenceRun(recordInput("run-mig-3"), { evidenceDir });
    const onDiskBefore = await readFile(join(evidenceDir, QI_SUBDIR, "run-mig-3.qi.json"), "utf8");
    // Fresh store on the same dir
    const store2 = createNodeQualityIntelligenceLocalStore(evidenceDir);
    expect(store2.list()).toEqual(["run-mig-3"]);
    const onDiskAfter = await readFile(join(evidenceDir, QI_SUBDIR, "run-mig-3.qi.json"), "utf8");
    expect(onDiskAfter).toBe(onDiskBefore);
  });
});
