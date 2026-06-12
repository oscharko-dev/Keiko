// Markdown export adapter tests (Epic #711, Issue #720).
//
// Determinism is the load-bearing property: identical input must yield byte-identical output so the
// export bundle integrity hash is stable across runs. No timestamps, no random content.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { adaptToMarkdown } from "../adapters/markdown.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-md");

function candidate(id: string, title: string): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-md"),
    runId: RUN,
    targetAdapter: "markdown",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToMarkdown", () => {
  it("renders the candidate fields as a Markdown section", () => {
    const c = candidate("tc-1", "Login succeeds with valid credentials");
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).toContain("# Quality Intelligence Export");
    expect(out).toContain("## Login succeeds with valid credentials");
    expect(out).toContain("**Priority:** P1");
    expect(out).toContain("User is logged in");
    expect(out).toContain("The record is saved");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1", "A");
    const b = bundle([c]);
    expect(adaptToMarkdown(b, [c])).toBe(adaptToMarkdown(b, [c]));
  });

  it("sorts sections by candidate id ascending regardless of input order", () => {
    const a = candidate("tc-a", "Alpha");
    const z = candidate("tc-z", "Zulu");
    const out = adaptToMarkdown(bundle([z, a]), [z, a]);
    expect(out.indexOf("## Alpha")).toBeLessThan(out.indexOf("## Zulu"));
  });

  it("emits no ISO timestamp in the rendered body (fully deterministic)", () => {
    const c = candidate("tc-1", "A");
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  });

  it("folds an embedded newline in a step into one space so the list stays intact", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      steps: ["First line\nsecond line", "Tab\tseparated"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    // The step renders as a single numbered list item, not two stray lines.
    expect(out).toContain("1. First line second line");
    expect(out).toContain("2. Tab separated");
    // No bare continuation line that would break the ordered list.
    expect(out).not.toContain("\nsecond line");
  });

  it("folds an embedded newline in the title so the heading stays on one line", () => {
    const c = candidate("tc-1", "Title with\na break");
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).toContain("## Title with a break");
  });

  it("renders empty field lists as _none_ rather than emitting broken markup", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      preconditions: [],
      steps: [],
      expectedResults: [],
      tags: [],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).toContain("**Tags:** _none_");
    expect(out.match(/_none_/gu)?.length).toBeGreaterThanOrEqual(4);
  });

  it("introduces no provider URL, bearer token, or prompt scaffolding of its own", () => {
    const c = candidate("tc-1", "Plain redacted title");
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).not.toMatch(/https?:\/\//iu);
    expect(out).not.toMatch(/bearer\s|api[_-]?key|sk-[a-z0-9]/iu);
    expect(out).not.toMatch(/system prompt|you are an? /iu);
  });
});

// ─── export sanitisation (Issue #284 AC2) ─────────────────────────────────────

describe("adaptToMarkdown — export sanitisation", () => {
  it("neutralises a spreadsheet formula lead in the title so it stays inert if pasted into a sheet", () => {
    const c = candidate("tc-1", '=HYPERLINK("http://evil","x")');
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).toContain("## '=HYPERLINK(");
  });

  it("neutralises a formula lead hidden behind leading whitespace", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      steps: ["  =1+1"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).toContain("1. '  =1+1");
  });

  it("escapes a markdown link in a step so a javascript: href cannot render as a live link", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      steps: ["Click [here](javascript:alert(1)) to continue"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    // The active link syntax is escaped; the raw clickable form is gone.
    expect(out).toContain("\\[here\\](");
    expect(out).not.toContain("[here](");
  });

  it("escapes a markdown image so a tracking/SSRF pixel cannot render from an exported field", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      expectedResults: ["![pixel](http://evil/p.png)"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    // The active image syntax is neutralised (no live `![..](..)`); the bracket is escaped.
    expect(out).not.toContain("![");
    expect(out).toContain("\\[pixel\\]");
  });

  it("escapes a fenced-code run smuggled into a field", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      preconditions: ["```js"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).not.toContain("```js");
    expect(out).toContain("\\`\\`\\`js");
  });

  it("stays deterministic with adversarial field content", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "=cmd"),
      steps: ["[x](javascript:1)", "![y](z)"],
    };
    const b = bundle([c]);
    expect(adaptToMarkdown(b, [c])).toBe(adaptToMarkdown(b, [c]));
  });
});
