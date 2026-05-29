import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import * as sdk from "../../src/sdk/index.js";

// The D9 public export list (functions/values; types are erased at runtime so they cannot be
// asserted here, but the named-export blocks in the barrels keep them in lockstep).
const EXPECTED_VALUES = [
  "buildEvidenceManifest",
  "persistEvidence",
  "createAuditRedactor",
  "createNodeEvidenceStore",
  "createInMemoryEvidenceStore",
  "aggregateUsage",
  "resolveCostClass",
  "listEvidence",
  "loadEvidence",
  "applyRetention",
  "buildEvidenceReport",
  "renderEvidenceReport",
  "assertValidRunId",
  "EVIDENCE_SCHEMA_VERSION",
  "DEFAULT_RETENTION",
] as const;

describe("audit public surface", () => {
  it.each(EXPECTED_VALUES)("root barrel exports %s", (name) => {
    expect(name in root).toBe(true);
  });

  it.each(EXPECTED_VALUES)("sdk barrel exports %s", (name) => {
    expect(name in sdk).toBe(true);
  });

  it("does not regress the canonical workspace summarizeForAudit at the root", () => {
    expect(typeof root.summarizeForAudit).toBe("function");
    expect(typeof root.summarizeVerificationForAudit).toBe("function");
  });

  it("EVIDENCE_SCHEMA_VERSION is the literal '1'", () => {
    expect(root.EVIDENCE_SCHEMA_VERSION).toBe("1");
  });
});
