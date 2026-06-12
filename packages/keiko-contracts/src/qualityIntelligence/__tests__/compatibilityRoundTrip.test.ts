import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { QualityIntelligenceSourceEnvelope } from "../sourceEnvelope.js";
import type { QualityIntelligenceTestCaseCandidate } from "../testCaseCandidate.js";
import type { QualityIntelligenceValidationFinding } from "../validationFinding.js";
import type { QualityIntelligenceRunEvent } from "../runPlanAndEvents.js";
import { assertRunEventSequenceMonotonic } from "../runPlanAndEvents.js";
import {
  QUALITY_INTELLIGENCE_PRIORITIES,
  QUALITY_INTELLIGENCE_RISK_CLASSES,
  QUALITY_INTELLIGENCE_TEST_CASE_STATUSES,
} from "../testCaseCandidate.js";
import { QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS } from "../validationFinding.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stripHeaderKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripHeaderKeys);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("_")) continue;
      out[k] = stripHeaderKeys(v);
    }
    return out;
  }
  return value;
};

const loadFixture = (filename: string): { raw: unknown; stripped: unknown; rawText: string } => {
  const rawText = readFileSync(join(FIXTURES_DIR, filename), "utf8");
  const raw = JSON.parse(rawText) as unknown;
  return { raw, stripped: stripHeaderKeys(raw), rawText };
};

describe("Compatibility round-trip — figmaEvidence.synthetic.json", () => {
  const { raw, stripped, rawText } = loadFixture("figmaEvidence.synthetic.json");

  it("carries the synthetic-header marker", () => {
    expect(rawText).toContain("synthetic — no customer data; safe to bundle");
  });

  it("decodes into a figma-evidence source envelope shape", () => {
    const env = stripped as QualityIntelligenceSourceEnvelope;
    expect(env.kind).toBe("figma-evidence");
    expect(env.id).toBe("env-figma-synthetic-01");
    expect(env.provenance.integrityHashSha256Hex).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("re-serialises to a structurally equal object", () => {
    const round = JSON.parse(JSON.stringify(stripped)) as unknown;
    expect(round).toEqual(stripped);
    // The original raw still contains the header key — guard it remains present.
    expect(isRecord(raw) ? raw._header : undefined).toBeDefined();
  });
});

describe("Compatibility round-trip — testCaseCandidate.synthetic.json", () => {
  const { stripped, rawText } = loadFixture("testCaseCandidate.synthetic.json");

  it("carries the synthetic-header marker", () => {
    expect(rawText).toContain("synthetic — no customer data; safe to bundle");
  });

  it("decodes into a test-case candidate shape with valid enum values", () => {
    const tc = stripped as QualityIntelligenceTestCaseCandidate;
    expect(QUALITY_INTELLIGENCE_PRIORITIES).toContain(tc.priority);
    expect(QUALITY_INTELLIGENCE_RISK_CLASSES).toContain(tc.riskClass);
    expect(QUALITY_INTELLIGENCE_TEST_CASE_STATUSES).toContain(tc.status);
    expect(tc.steps.length).toBeGreaterThan(0);
  });

  it("re-serialises to a structurally equal object", () => {
    expect(JSON.parse(JSON.stringify(stripped)) as unknown).toEqual(stripped);
  });
});

describe("Compatibility round-trip — validationFindings.synthetic.json", () => {
  const { stripped, rawText } = loadFixture("validationFindings.synthetic.json");

  it("carries the synthetic-header marker", () => {
    expect(rawText).toContain("synthetic — no customer data; safe to bundle");
  });

  it("decodes three findings of three distinct kinds", () => {
    const { findings } = stripped as {
      readonly findings: readonly QualityIntelligenceValidationFinding[];
    };
    expect(findings).toHaveLength(3);
    const kinds = new Set(findings.map((f) => f.kind));
    expect(kinds.size).toBe(3);
    for (const kind of kinds) {
      expect(QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS).toContain(kind);
    }
  });

  it("re-serialises to a structurally equal object", () => {
    expect(JSON.parse(JSON.stringify(stripped)) as unknown).toEqual(stripped);
  });
});

describe("Compatibility round-trip — runEvents.synthetic.json", () => {
  const { stripped, rawText } = loadFixture("runEvents.synthetic.json");

  it("carries the synthetic-header marker", () => {
    expect(rawText).toContain("synthetic — no customer data; safe to bundle");
  });

  it("decodes a 5-event monotonic sequence", () => {
    const { events } = stripped as { readonly events: readonly QualityIntelligenceRunEvent[] };
    expect(events).toHaveLength(5);
    expect(() => {
      assertRunEventSequenceMonotonic(events);
    }).not.toThrow();
  });

  it("events appear in the exact ordered kind sequence from the fixture", () => {
    // This pins the MEANINGFUL sequence, not just the count. If the fixture order is
    // permuted, or if a kind is swapped, this test fails while the count test would pass.
    // Mutation killed: removing any kind from the expected list or reordering would fail.
    const { events } = stripped as { readonly events: readonly QualityIntelligenceRunEvent[] };
    const kinds = events.map((e) => e.payload.kind);
    expect(kinds).toEqual([
      "run:queued",
      "run:started",
      "stage:started",
      "stage:completed",
      "run:succeeded",
    ]);
  });

  it("re-serialises to a structurally equal object", () => {
    expect(JSON.parse(JSON.stringify(stripped)) as unknown).toEqual(stripped);
  });
});

// ─── Fixture sanitization — no secrets or PII in any fixture file ──────────────

describe("Fixture sanitization scan", () => {
  const fixturesDir = FIXTURES_DIR;

  // Patterns that must never appear in any fixture file.
  // All are case-insensitive to catch mixed-case variants.
  const SECRET_PATTERNS: readonly RegExp[] = [
    /AKIA/i,
    /-----BEGIN (RSA|EC|OPENSSH|PRIVATE)/i,
    /Bearer /i,
    /sk-[a-z0-9]/i,
    /xox[baprs]-/i,
    /\/Users\//i,
    /\/home\//i,
    /password/i,
    /secret_key/i,
  ];

  const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

  it("fixture directory contains at least one json file (self-check)", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const filename of fixtureFiles) {
    it(`${filename} contains no secrets or PII patterns`, () => {
      // Mutation killed: adding a fake secret to any fixture breaks exactly this test.
      const content = readFileSync(join(fixturesDir, filename), "utf8");
      for (const pattern of SECRET_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});
