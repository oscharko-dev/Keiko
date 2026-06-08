import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Qi from "../index.js";
import * as Contracts from "../../index.js";

const QI_SRC_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// ─── Required value exports on the QI barrel ───────────────────────────────────
const requiredValueExports: readonly string[] = [
  "QUALITY_INTELLIGENCE_SCHEMA_VERSION",
  "QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION",
  "QUALITY_INTELLIGENCE_AUDIT_MANIFEST_SCHEMA_VERSION",
  "QUALITY_INTELLIGENCE_SOURCE_KINDS",
  "QUALITY_INTELLIGENCE_EVIDENCE_ATOM_KINDS",
  "QUALITY_INTELLIGENCE_REDACTION_STATUSES",
  "QUALITY_INTELLIGENCE_LIFECYCLE_STATUSES",
  "QUALITY_INTELLIGENCE_PRIORITIES",
  "QUALITY_INTELLIGENCE_RISK_CLASSES",
  "QUALITY_INTELLIGENCE_TEST_CASE_STATUSES",
  "QUALITY_INTELLIGENCE_COVERAGE_KINDS",
  "QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS",
  "QUALITY_INTELLIGENCE_SEVERITIES",
  "QUALITY_INTELLIGENCE_SEVERITY_RANK",
  "QUALITY_INTELLIGENCE_PLANNER_KINDS",
  "QUALITY_INTELLIGENCE_RUN_EVENT_KINDS",
  "QUALITY_INTELLIGENCE_REVIEWER_KINDS",
  "QUALITY_INTELLIGENCE_REVIEW_STATES",
  "QUALITY_INTELLIGENCE_EXPORT_ADAPTERS",
  "QUALITY_INTELLIGENCE_TMS_ADAPTERS",
  "QUALITY_INTELLIGENCE_HANDOFF_PROMPTED_ACTIONS",
  "asQualityIntelligenceRunId",
  "asQualityIntelligenceTestCaseId",
  "asQualityIntelligenceCoverageMapId",
  "asQualityIntelligenceValidationFindingId",
  "asQualityIntelligenceReviewRecordId",
  "asQualityIntelligenceExportBundleId",
  "asQualityIntelligenceSourceEnvelopeId",
  "asQualityIntelligenceEvidenceAtomId",
  "asQualityIntelligenceAuditSummaryId",
  "validateQualityIntelligenceIdString",
  "assertQualityIntelligenceNever",
  "assertCoverageMapInvariant",
  "assertExportBundleInvariant",
  "assertRunEventSequenceMonotonic",
  "hasCanonicalSha256Hash",
  "looksLikeBrowserSafeSourceEnvelope",
];

const QI_SOURCE_FILES: readonly string[] = [
  "ids.ts",
  "assertNever.ts",
  "sourceEnvelope.ts",
  "evidenceAtom.ts",
  "testCaseCandidate.ts",
  "editableRevision.ts",
  "coverageMap.ts",
  "validationFinding.ts",
  "runPlanAndEvents.ts",
  "reviewRecord.ts",
  "exportBundle.ts",
  "auditSummary.ts",
  "handoffEnvelope.ts",
  "bffWire.ts",
  "index.ts",
];

const FORBIDDEN_IMPORT_TARGETS: readonly string[] = [
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:http",
  "node:https",
  "node:tls",
  "node:dns",
  "node:child_process",
  "@oscharko-dev/test-intelligence",
  "@oscharko-dev/ti-",
];

const readQiSource = (file: string): string => readFileSync(join(QI_SRC_DIR, file), "utf8");

describe("QI module barrel — value exports", () => {
  for (const name of requiredValueExports) {
    it(`exports ${name}`, () => {
      expect(Object.keys(Qi)).toContain(name);
    });
  }

  it("pins QUALITY_INTELLIGENCE_SCHEMA_VERSION to '1'", () => {
    expect(Qi.QUALITY_INTELLIGENCE_SCHEMA_VERSION).toBe("1");
  });
});

describe("Outer package barrel — namespace re-export", () => {
  it("re-exports QI as the QualityIntelligence namespace", () => {
    expect(Contracts.QualityIntelligence).toBeDefined();
  });

  it("the namespace surfaces the same shape as the QI barrel", () => {
    for (const name of requiredValueExports) {
      expect(Object.keys(Contracts.QualityIntelligence)).toContain(name);
    }
  });
});

describe("QI sources — forbidden import scan", () => {
  for (const file of QI_SOURCE_FILES) {
    it(`${file} has no forbidden imports`, () => {
      const source = readQiSource(file);
      for (const target of FORBIDDEN_IMPORT_TARGETS) {
        expect(source).not.toContain(`"${target}`);
        expect(source).not.toContain(`'${target}`);
      }
    });
  }

  it("the QI source directory does not contain any file we forgot to scan", () => {
    const present = readdirSync(QI_SRC_DIR).filter((f) => f.endsWith(".ts"));
    const sorted = [...present].sort();
    const expected = [...QI_SOURCE_FILES].sort();
    expect(sorted).toEqual(expected);
  });
});
