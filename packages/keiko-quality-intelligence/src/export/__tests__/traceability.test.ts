// Requirement-to-test traceability export adapter tests (Epic #734, Issue #740).
//
// Validates: bidirectional matrix structure (Requirements→Tests and Tests→Requirements
// sections), row counts, mdCell encoding neutralises formula-lead and pipe in Markdown.

import { describe, expect, it } from "vitest";
import type { QualityIntelligenceTraceabilityRow } from "../adapters/traceability.js";
import {
  TRACEABILITY_HEADERS,
  TRACEABILITY_REVERSE_HEADERS,
  adaptToTraceabilityCsv,
  adaptToTraceabilityMarkdown,
} from "../adapters/traceability.js";

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------

function row(
  atomId: string,
  coveringCandidateIds: readonly string[],
  overrides?: Partial<QualityIntelligenceTraceabilityRow>,
): QualityIntelligenceTraceabilityRow {
  return {
    atomId,
    status: "covered",
    confidence: 0.9,
    coveringCandidateIds,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// adaptToTraceabilityCsv
// ---------------------------------------------------------------------------

describe("adaptToTraceabilityCsv", () => {
  it("emits a 'Requirements to tests' section header before the TRACEABILITY_HEADERS row", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"])]);
    expect(out).toContain("Requirements to tests");
    const reqIdx = out.indexOf("Requirements to tests");
    const headIdx = out.indexOf(TRACEABILITY_HEADERS[0] ?? "");
    expect(reqIdx).toBeLessThan(headIdx);
  });

  it("emits a 'Tests to requirements' section header for the reverse direction", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"])]);
    expect(out).toContain("Tests to requirements");
  });

  it("Requirements→Tests section appears before Tests→Requirements section", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"])]);
    expect(out.indexOf("Requirements to tests")).toBeLessThan(out.indexOf("Tests to requirements"));
  });

  it("contains the TRACEABILITY_HEADERS columns", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"])]);
    for (const header of TRACEABILITY_HEADERS) {
      expect(out).toContain(header);
    }
  });

  it("contains the TRACEABILITY_REVERSE_HEADERS columns", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"])]);
    for (const header of TRACEABILITY_REVERSE_HEADERS) {
      expect(out).toContain(header);
    }
  });

  it("includes the atomId in the requirements section", () => {
    const out = adaptToTraceabilityCsv([row("req-atom-42", ["tc-1"])]);
    expect(out).toContain("req-atom-42");
  });

  it("includes the covering candidate id in the requirements section", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-abc"])]);
    expect(out).toContain("tc-abc");
  });

  it("sorts requirement rows by atomId ascending", () => {
    const rows = [row("atom-z", ["tc-1"]), row("atom-a", ["tc-2"])];
    const out = adaptToTraceabilityCsv(rows);
    // atom-a must appear before atom-z in Requirements section
    expect(out.indexOf("atom-a")).toBeLessThan(out.indexOf("atom-z"));
  });

  it("inverts the matrix: candidateId appears in Tests→Requirements section", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-xyz"])]);
    // tc-xyz should appear in the reverse section as well
    const testsIdx = out.indexOf("Tests to requirements");
    expect(out.indexOf("tc-xyz", testsIdx)).toBeGreaterThan(testsIdx);
  });

  it("a candidate covering multiple requirements lists all of them in the reverse section", () => {
    const rows = [row("atom-1", ["tc-shared"]), row("atom-2", ["tc-shared"])];
    const out = adaptToTraceabilityCsv(rows);
    const testsIdx = out.indexOf("Tests to requirements");
    const reverseSection = out.slice(testsIdx);
    // Both atom-1 and atom-2 should appear after "Tests to requirements"
    expect(reverseSection).toContain("atom-1");
    expect(reverseSection).toContain("atom-2");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const rows = [row("atom-1", ["tc-1"]), row("atom-2", ["tc-2"])];
    expect(adaptToTraceabilityCsv(rows)).toBe(adaptToTraceabilityCsv(rows));
  });

  it("formula-lead atomId is escaped in the CSV output", () => {
    const out = adaptToTraceabilityCsv([row("=FORMULA", ["tc-1"])]);
    // The cell must get the ' prefix and NOT appear as raw =FORMULA at the start of a cell
    expect(out).toContain("'=FORMULA");
    // Raw unescaped =FORMULA must not appear at a cell boundary
    expect(out).not.toMatch(/(?:^|,)=FORMULA(?:,|\r\n)/mu);
  });

  it("handles an empty rows array without throwing", () => {
    expect(() => adaptToTraceabilityCsv([])).not.toThrow();
  });

  it("uses the requirementExcerptRedacted when provided", () => {
    const r = row("atom-1", ["tc-1"], { requirementExcerptRedacted: "Login must succeed" });
    const out = adaptToTraceabilityCsv([r]);
    expect(out).toContain("Login must succeed");
  });

  it("uses ABSENT placeholder when requirementExcerptRedacted is absent", () => {
    const r = row("atom-1", ["tc-1"]);
    const out = adaptToTraceabilityCsv([r]);
    // The ABSENT placeholder is "—" (em-dash)
    expect(out).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// adaptToTraceabilityMarkdown
// ---------------------------------------------------------------------------

describe("adaptToTraceabilityMarkdown", () => {
  it("emits the document title '# Requirement to test traceability matrix'", () => {
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-1"])]);
    expect(out).toContain("# Requirement to test traceability matrix");
  });

  it("emits '## Requirements → Tests' heading", () => {
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-1"])]);
    expect(out).toContain("## Requirements → Tests");
  });

  it("emits '## Tests → Requirements' heading", () => {
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-1"])]);
    expect(out).toContain("## Tests → Requirements");
  });

  it("Requirements→Tests heading appears before Tests→Requirements heading", () => {
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-1"])]);
    expect(out.indexOf("## Requirements → Tests")).toBeLessThan(
      out.indexOf("## Tests → Requirements"),
    );
  });

  it("contains the TRACEABILITY_HEADERS as a Markdown table row", () => {
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-1"])]);
    for (const header of TRACEABILITY_HEADERS) {
      expect(out).toContain(header);
    }
  });

  it("contains the TRACEABILITY_REVERSE_HEADERS as a Markdown table row", () => {
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-1"])]);
    for (const header of TRACEABILITY_REVERSE_HEADERS) {
      expect(out).toContain(header);
    }
  });

  it("mdCell: a formula-lead value gets the ' prefix to neutralise it", () => {
    // The atomId starts with '=' and appears in a Markdown table cell
    const out = adaptToTraceabilityMarkdown([row("=FORMULA", ["tc-1"])]);
    expect(out).toContain("'=FORMULA");
  });

  it("mdCell: a pipe character in an atomId is escaped as \\|", () => {
    const out = adaptToTraceabilityMarkdown([row("atom|with|pipe", ["tc-1"])]);
    expect(out).toContain("atom\\|with\\|pipe");
  });

  it("sorts requirement rows by atomId ascending in the Markdown table", () => {
    const rows = [row("z-atom", ["tc-1"]), row("a-atom", ["tc-2"])];
    const out = adaptToTraceabilityMarkdown(rows);
    expect(out.indexOf("a-atom")).toBeLessThan(out.indexOf("z-atom"));
  });

  it("row count in Requirements table equals the number of input rows", () => {
    const rows = [row("atom-1", ["tc-1"]), row("atom-2", ["tc-2"]), row("atom-3", ["tc-3"])];
    const out = adaptToTraceabilityMarkdown(rows);
    // Count data rows: lines starting with '|' that are not separator lines (---)
    const reqSection = out.split("## Tests → Requirements")[0] ?? "";
    const dataLines = reqSection.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    // Header row + 3 data rows = 4
    expect(dataLines).toHaveLength(4);
  });

  it("candidateTitleById is used in the reverse section when provided", () => {
    const titleMap = new Map([["tc-named", "My Test Case Title"]]);
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-named"])], {
      candidateTitleById: titleMap,
    });
    expect(out).toContain("My Test Case Title");
  });

  it("uses ABSENT placeholder in reverse section when no title map is provided", () => {
    const out = adaptToTraceabilityMarkdown([row("atom-1", ["tc-1"])]);
    const reverseIdx = out.indexOf("## Tests → Requirements");
    const reverseSection = out.slice(reverseIdx);
    expect(reverseSection).toContain("—");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const rows = [row("atom-1", ["tc-1"]), row("atom-2", ["tc-2"])];
    expect(adaptToTraceabilityMarkdown(rows)).toBe(adaptToTraceabilityMarkdown(rows));
  });

  it("handles an empty rows array without throwing", () => {
    expect(() => adaptToTraceabilityMarkdown([])).not.toThrow();
  });
});
