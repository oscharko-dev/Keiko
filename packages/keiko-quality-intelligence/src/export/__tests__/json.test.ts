// Typed JSON export adapter tests (Epic #270, Issue #283).
//
// Validates: schemaVersion = "1", candidates sorted by id, all candidate fields present,
// output is valid JSON (JSON.parse round-trips without throwing).

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { adaptToJson } from "../adapters/json.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-json");

interface ParsedCandidate {
  id: string;
  runId: string;
  title: string;
  priority: string;
  riskClass: string;
  status: string;
  tags: string[];
  preconditions: string[];
  steps: string[];
  expectedResults: string[];
  derivedFromAtomIds: string[];
  coverageMapRefs: string[];
  findingRefs: string[];
}

interface ParsedEnvelope {
  schemaVersion: string;
  bundleId: string;
  runId: string;
  targetAdapter: string;
  createdAt: string;
  integrityHashSha256Hex: string;
  redactionAttested: boolean;
  candidates: ParsedCandidate[];
}

function candidate(
  id: string,
  overrides?: Partial<QualityIntelligenceTestCaseCandidate>,
): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title: `Test ${id}`,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved"],
    priority: "P2",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
    ...overrides,
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
  overrides?: Partial<QualityIntelligenceExportBundle>,
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-json"),
    runId: RUN,
    // json adapter is NOT TMS-bound so redactionAttested is not required
    targetAdapter: "json",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: false,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
    ...overrides,
  };
}

// Type-safe wrapper: JSON.parse returns `any`; the cast is explicit here so the
// lint rule (@typescript-eslint/no-unsafe-return) does not propagate to call sites.
function parseEnvelope(out: string): ParsedEnvelope {
  const raw: unknown = JSON.parse(out);
  return raw as ParsedEnvelope;
}

describe("adaptToJson", () => {
  it("produces valid JSON that can be JSON.parse round-tripped without throwing", () => {
    const c = candidate("tc-1");
    const out = adaptToJson(bundle([c]), [c]);
    let threw = false;
    try {
      JSON.parse(out);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("schemaVersion field is exactly '1'", () => {
    const c = candidate("tc-1");
    const parsed = parseEnvelope(adaptToJson(bundle([c]), [c]));
    expect(parsed.schemaVersion).toBe("1");
  });

  it("sorts candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", { title: "Alpha" });
    const z = candidate("tc-z", { title: "Zulu" });
    const parsed = parseEnvelope(adaptToJson(bundle([z, a]), [z, a]));
    expect(parsed.candidates[0]?.id).toBe(a.id);
    expect(parsed.candidates[1]?.id).toBe(z.id);
  });

  it("each candidate payload contains all required fields", () => {
    const c = candidate("tc-1");
    const parsed = parseEnvelope(adaptToJson(bundle([c]), [c]));
    expect(parsed.candidates[0]).toHaveProperty("id");
    expect(parsed.candidates[0]).toHaveProperty("runId");
    expect(parsed.candidates[0]).toHaveProperty("title");
    expect(parsed.candidates[0]).toHaveProperty("priority");
    expect(parsed.candidates[0]).toHaveProperty("riskClass");
    expect(parsed.candidates[0]).toHaveProperty("status");
    expect(parsed.candidates[0]).toHaveProperty("tags");
    expect(parsed.candidates[0]).toHaveProperty("preconditions");
    expect(parsed.candidates[0]).toHaveProperty("steps");
    expect(parsed.candidates[0]).toHaveProperty("expectedResults");
    expect(parsed.candidates[0]).toHaveProperty("derivedFromAtomIds");
    expect(parsed.candidates[0]).toHaveProperty("coverageMapRefs");
    expect(parsed.candidates[0]).toHaveProperty("findingRefs");
  });

  it("candidate fields match the input values", () => {
    const c = candidate("tc-1", {
      title: "Check form submission",
      priority: "P0",
      riskClass: "compliance",
      tags: ["auth"],
    });
    const parsed = parseEnvelope(adaptToJson(bundle([c]), [c]));
    expect(parsed.candidates[0]?.title).toBe("Check form submission");
    expect(parsed.candidates[0]?.priority).toBe("P0");
    expect(parsed.candidates[0]?.riskClass).toBe("compliance");
    expect(parsed.candidates[0]?.tags).toEqual(["auth"]);
  });

  it("envelope contains bundleId, runId, targetAdapter, createdAt, integrityHashSha256Hex", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    const parsed = parseEnvelope(adaptToJson(b, [c]));
    expect(parsed.bundleId).toBe(b.id);
    expect(parsed.runId).toBe(b.runId);
    expect(parsed.targetAdapter).toBe("json");
    expect(parsed.createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(parsed.integrityHashSha256Hex).toBe("0".repeat(64));
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    expect(adaptToJson(b, [c])).toBe(adaptToJson(b, [c]));
  });

  it("works when redactionAttested is false (json is not TMS-bound)", () => {
    const c = candidate("tc-1");
    const b = bundle([c], { redactionAttested: false });
    expect(() => adaptToJson(b, [c])).not.toThrow();
  });

  it("throws when integrityHashSha256Hex is malformed", () => {
    const c = candidate("tc-1");
    const b: QualityIntelligenceExportBundle = {
      ...bundle([c]),
      integrityHashSha256Hex: "not-64-hex",
    };
    expect(() => adaptToJson(b, [c])).toThrow();
  });
});
