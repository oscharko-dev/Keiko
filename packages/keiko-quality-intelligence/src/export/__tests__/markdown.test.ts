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

  // GAP-7: multi-link and image-vs-link disambiguation

  it("escapes EVERY link in a multi-link field, not just the first (pins `g` flag on LINK_OPEN)", () => {
    // Mutation: dropping the `g` flag on the LINK_OPEN regex leaves the second link live.
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      steps: ["see [a](javascript:1) then [b](javascript:2)"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    expect(out).toContain("\\[a\\](");
    expect(out).toContain("\\[b\\](");
    // Neither raw link form survives.
    expect(out).not.toMatch(/[^\\]\[a\]\(/u);
    expect(out).not.toMatch(/[^\\]\[b\]\(/u);
  });

  it("neutralises BOTH an image and a link in a mixed field to inert escaped forms", () => {
    // mdText escapes the image prefix (`![` -> `\!\[`) before the link pass. Because that strips the
    // `!` adjacency, the link pass also escapes the image's now-`!`-less bracket, so the image bracket
    // is escaped a second time (`\!\\[img\]`). That extra backslash is a benign, deterministic cosmetic
    // artifact — the load-bearing guarantee (AC2) is that NEITHER an active image NOR an active link
    // survives, which holds. Mutation kills: dropping IMAGE_OPEN leaves a live `![img](`; dropping
    // LINK_OPEN leaves a live `[link](`.
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      expectedResults: ["![img](http://evil/a.png) and [link](http://evil/b)"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    // No live image syntax survives (IMAGE_OPEN escaped the `![`).
    expect(out).not.toContain("![img](");
    // No live (unescaped) link syntax survives (LINK_OPEN escaped the `[link](`).
    expect(out).not.toMatch(/(?<!\\)\[link\]\(/u);
    // The literal text is preserved so an auditor still reads the original content (AC1 faithfulness).
    expect(out).toContain("img");
    expect(out).toContain("link");
    // Deterministic.
    expect(out).toBe(adaptToMarkdown(bundle([c]), [c]));
  });
});

// ─── GAP-1: skip-unmatched-entry branch ──────────────────────────────────────

describe("adaptToMarkdown — skip-unmatched-entry", () => {
  it("silently omits a bundle entry whose candidateId has no matching candidate", () => {
    // Mutation: removing `if (candidate === undefined) continue;` causes `undefined` to be
    // passed into renderCandidate, which would throw or produce "[object Object]" / blank heading.
    const present = candidate("tc-1", "Present Candidate");
    const bundleWithDangling: QualityIntelligenceExportBundle = {
      ...bundle([present]),
      contents: [
        { candidateId: present.id, coverageMapRefs: [], findingRefs: [] },
        {
          candidateId: Q.asQualityIntelligenceTestCaseId("tc-missing"),
          coverageMapRefs: [],
          findingRefs: [],
        },
      ],
    };
    const out = adaptToMarkdown(bundleWithDangling, [present]);
    // The present candidate renders correctly.
    expect(out).toContain("## Present Candidate");
    // The dangling entry leaves no trace.
    expect(out).not.toContain("tc-missing");
    expect(out).not.toContain("undefined");
    // No blank or empty heading line was emitted.
    expect(out).not.toMatch(/^## \s*$/mu);
    // Output remains deterministic.
    expect(out).toBe(adaptToMarkdown(bundleWithDangling, [present]));
  });
});

// ─── GAP-2: large case list — all-render + deterministic ordering ─────────────

describe("adaptToMarkdown — large case list", () => {
  it("renders ALL 50 candidates and emits headings in strictly ascending id order", () => {
    // Mutation (a): an early break/slice in the render loop drops trailing candidates.
    // Mutation (b): a partial comparator correct for 2 ids but wrong at scale.
    // Zero-padded ids (tc-001..tc-050) ensure lexical order == intended order.
    const cs = Array.from({ length: 50 }, (_v, i) => {
      const n = String(i + 1).padStart(3, "0");
      return candidate(`tc-${n}`, `Title ${n}`);
    });
    // Deterministic non-sorted input: reversed (no RNG).
    const reversed = [...cs].reverse();
    const out = adaptToMarkdown(bundle(reversed), reversed);

    // Every candidate must appear exactly once.
    for (const c of cs) {
      expect(out).toContain(`## Title ${c.title.slice(6)}`);
    }

    // Count: exactly 50 level-2 headings.
    const headings = out.match(/^## /gmu);
    expect(headings?.length).toBe(50);

    // Strict ascending positional order: each heading appears after the previous one.
    const positions = cs.map((c) => out.indexOf(`## ${c.title}`));
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      expect(prev).toBeGreaterThanOrEqual(0);
      expect(curr).toBeGreaterThan(prev ?? -1);
    }
  });
});

// ─── GAP-4: secret-shaped field rendered inert ────────────────────────────────

describe("adaptToMarkdown — secret-shaped field rendered as inert literal (AC2)", () => {
  it("renders a secret-URL-shaped step as an escaped literal, not a live link, while preserving the literal text", () => {
    // AC2: no secret/URL passes through as *active content*.
    // The adapter must escape the link syntax so it cannot render as clickable in a Markdown viewer.
    // Critically, the literal token text is still preserved (faithful per AC1).
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      steps: ["[tok](https://api.provider.example/v1?api_key=sk-DEADBEEF)"],
    };
    const out = adaptToMarkdown(bundle([c]), [c]);
    // Link syntax is escaped — not a live clickable link.
    expect(out).toContain("\\[tok\\](");
    expect(out).not.toContain("[tok](https");
    // Literal token text is preserved (faithful representation per AC1).
    expect(out).toContain("sk-DEADBEEF");
  });
});

// ─── GAP-5: empty bundle — valid header-only output ──────────────────────────

describe("adaptToMarkdown — empty bundle", () => {
  it("renders a valid header-only document with no candidate sections when bundle is empty", () => {
    // Mutation: a guard that short-circuits the header block when contents is empty would
    // produce invalid/empty output. The trailing `+ "\\n"` must also be present.
    const out = adaptToMarkdown(bundle([]), []);
    expect(out).toContain("# Quality Intelligence Export");
    expect(out).toContain(`**Run:** ${RUN}`);
    expect(out).toContain("**Bundle:**");
    // No candidate heading was emitted.
    expect(out).not.toContain("## ");
    // Output is well-formed: ends with a newline.
    expect(out.endsWith("\n")).toBe(true);
    // Deterministic.
    expect(out).toBe(adaptToMarkdown(bundle([]), []));
  });
});

// ─── Optional: duplicate candidateId in contents ─────────────────────────────

describe("adaptToMarkdown — duplicate candidateId in contents", () => {
  it("renders the section twice when bundle.contents lists the same id twice (faithful to contents)", () => {
    // The adapter iterates bundle.contents; it is faithful (not deduplicating) by design.
    const c = candidate("tc-1", "Repeated");
    const bundleWithDupe: QualityIntelligenceExportBundle = {
      ...bundle([c]),
      contents: [
        { candidateId: c.id, coverageMapRefs: [], findingRefs: [] },
        { candidateId: c.id, coverageMapRefs: [], findingRefs: [] },
      ],
    };
    const out = adaptToMarkdown(bundleWithDupe, [c]);
    // Both entries render, so the heading appears twice.
    const headingCount = (out.match(/^## Repeated$/gmu) ?? []).length;
    expect(headingCount).toBe(2);
    // Still deterministic.
    expect(out).toBe(adaptToMarkdown(bundleWithDupe, [c]));
  });
});
