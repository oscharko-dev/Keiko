// Requirement-to-test traceability export adapter tests (Epic #734, Issue #740).
//
// Validates: bidirectional matrix structure (Requirements→Tests and Tests→Requirements
// sections), row counts, mdCell encoding neutralises formula-lead and pipe in Markdown.

import { describe, expect, it } from "vitest";
import type { QualityIntelligenceTraceabilityRow } from "../adapters/traceability.js";
import {
  TRACEABILITY_CSV_HEADERS,
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
  it("emits exactly one CSV header row with a RecordType discriminator", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"])]);
    const lines = out.trimEnd().split("\r\n");
    expect(lines[0]).toBe(TRACEABILITY_CSV_HEADERS.join(","));
    expect(lines.filter((line) => line.includes("Requirement ID"))).toHaveLength(1);
    expect(out).not.toContain("Requirements to tests");
    expect(out).not.toContain("Tests to requirements");
  });

  it("contains the TRACEABILITY_CSV_HEADERS columns", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"])]);
    for (const header of TRACEABILITY_CSV_HEADERS) {
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

  it("emits both requirement-to-test and test-to-requirement records", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-xyz"])]);
    expect(out).toContain("requirement-to-test");
    expect(out).toContain("test-to-requirement");
    expect(out).toMatch(/test-to-requirement,atom-1,—,covered,"0,90",tc-xyz,—/u);
  });

  it("a candidate covering multiple requirements produces one reverse row per requirement", () => {
    const rows = [row("atom-1", ["tc-shared"]), row("atom-2", ["tc-shared"])];
    const out = adaptToTraceabilityCsv(rows);
    const reverseRows = out
      .trimEnd()
      .split("\r\n")
      .filter((line) => line.startsWith("test-to-requirement"));
    expect(reverseRows).toHaveLength(2);
    expect(reverseRows.join("\n")).toContain("atom-1");
    expect(reverseRows.join("\n")).toContain("atom-2");
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

  it("formats confidence with a decimal comma for local spreadsheet readability", () => {
    const out = adaptToTraceabilityCsv([row("atom-1", ["tc-1"], { confidence: 0.5 })]);
    expect(out).toContain('"0,50"');
    expect(out).not.toContain("0.50");
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

  it("writes the weakly-covered status verbatim into the requirements row (Epic #734 D2/D3)", () => {
    // The row() factory defaults to "covered"; the third CoverageStatus value, "weakly-covered",
    // must reach the audit-ready export as a standalone status cell so an auditor can distinguish a
    // weakly-covered requirement from a fully-covered one.
    const r = row("atom-weak", ["tc-broad"], { status: "weakly-covered", confidence: 0.5 });
    const out = adaptToTraceabilityCsv([r]);
    const weakRow = out
      .split("\r\n")
      .find((line) => line.includes("atom-weak") && !line.includes("Requirement ID"));
    expect(weakRow).toBeDefined();
    // Standalone token (word boundary), not a substring of an id — mirrors #741.
    expect(weakRow).toMatch(/(?<![a-z])weakly-covered(?![\w-])/u);
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

  it("renders the weakly-covered status verbatim in the requirements table (Epic #734 D2/D3)", () => {
    const r = row("atom-weak", ["tc-broad"], { status: "weakly-covered", confidence: 0.5 });
    const out = adaptToTraceabilityMarkdown([r]);
    const reqSection = out.split("## Tests → Requirements")[0] ?? "";
    const weakRow = reqSection.split("\n").find((line) => line.includes("atom-weak"));
    expect(weakRow).toBeDefined();
    expect(weakRow).toMatch(/(?<![a-z])weakly-covered(?![\w-])/u);
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const rows = [row("atom-1", ["tc-1"]), row("atom-2", ["tc-2"])];
    expect(adaptToTraceabilityMarkdown(rows)).toBe(adaptToTraceabilityMarkdown(rows));
  });

  it("handles an empty rows array without throwing", () => {
    expect(() => adaptToTraceabilityMarkdown([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T1 — newline folding (Slice A regression, CWE-1284)
// ---------------------------------------------------------------------------
// A candidate title or requirementExcerptRedacted containing an embedded \n
// must render as a SINGLE physical line in the Markdown output (the logical
// table row is not split). The CSV cell must also be single-line/folded.

describe("T1: embedded newline in title/excerpt renders as single physical line", () => {
  const titleWithNewline = "Line one\nLine two";
  const excerptWithNewline = "Excerpt first\nExcerpt second";
  const titleMap = new Map([["tc-1", titleWithNewline]]);

  it("Markdown: reverse-section candidateTitle with \\n stays on one physical line", () => {
    const r = row("atom-1", ["tc-1"]);
    const out = adaptToTraceabilityMarkdown([r], { candidateTitleById: titleMap });
    const reverseIdx = out.indexOf("## Tests → Requirements");
    const reverseSection = out.slice(reverseIdx);
    // The whole reverse row — including the folded title — stays on one physical line; an
    // unfolded "\n" would split it and this exact single-line row would be absent.
    expect(reverseSection).toContain("| tc-1 | Line one Line two | atom-1 | 1 |");
  });

  it("Markdown: requirementExcerptRedacted with \\n stays on one physical line", () => {
    const r = row("atom-1", ["tc-1"], { requirementExcerptRedacted: excerptWithNewline });
    const out = adaptToTraceabilityMarkdown([r]);
    const reqIdx = out.indexOf("## Requirements → Tests");
    const reqSection = out.slice(reqIdx, out.indexOf("## Tests → Requirements"));
    const dataLines = reqSection.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    // The data row should be a single entry (header + 1 data row = 2 total lines)
    expect(dataLines).toHaveLength(2);
    expect(dataLines[1]).toContain("Excerpt first Excerpt second");
  });

  it("CSV: candidateTitle with \\n is folded to a single-line cell", () => {
    const r = row("atom-1", ["tc-1"]);
    const out = adaptToTraceabilityCsv([r], { candidateTitleById: titleMap });
    expect(out).not.toContain("\nLine two");
    expect(out).toContain("Line one Line two");
  });

  it("CSV: requirementExcerptRedacted with \\n is folded to a single-line cell", () => {
    const r = row("atom-1", ["tc-1"], { requirementExcerptRedacted: excerptWithNewline });
    const out = adaptToTraceabilityCsv([r]);
    expect(out).not.toContain("\nExcerpt second");
    expect(out).toContain("Excerpt first Excerpt second");
  });
});

// ---------------------------------------------------------------------------
// T2 — backslash+pipe smuggling (CWE-20, mutation-blind in prior suite)
// ---------------------------------------------------------------------------
// mdCell must escape backslash BEFORE pipe. A value "a\|b" must render with
// every backslash escaped before the pipe delimiter is escaped. If the order is swapped
// (pipe-first) the backslash introduced for the pipe is itself consumed by the
// subsequent backslash-escape, yielding "a\\\\|b" — an unescaped pipe.

describe("T2: mdCell backslash-first ordering for backslash adjacent to pipe", () => {
  it("atomId with backslash adjacent to pipe renders a fully escaped safe form in Markdown", () => {
    // JS string "a\\|b" is the two-character sequence: a, \, |, b
    const out = adaptToTraceabilityMarkdown([row("a\\|b", ["tc-1"])]);
    // Expected: all literal backslashes are escaped, then the pipe delimiter is escaped.
    expect(out).toContain("a\\\\\\\\\\|b");
  });

  it("excerpt with backslash adjacent to pipe renders safe form in Markdown", () => {
    const r = row("atom-1", ["tc-1"], { requirementExcerptRedacted: "check\\|fail" });
    const out = adaptToTraceabilityMarkdown([r]);
    expect(out).toContain("check\\\\\\\\\\|fail");
  });
});
