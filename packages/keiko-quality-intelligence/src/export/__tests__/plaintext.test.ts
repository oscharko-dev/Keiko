// Plain-text export adapter tests (Epic #711, Issue #720).
//
// Determinism is load-bearing: identical input -> byte-identical output (stable integrity hash).

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { adaptToPlainText } from "../adapters/plaintext.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-txt");

function candidate(id: string, title: string): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved"],
    priority: "P2",
    riskClass: "regression",
    tags: ["smoke"],
    status: "proposed",
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-txt"),
    runId: RUN,
    targetAdapter: "plain-text",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToPlainText", () => {
  it("renders the candidate fields as a plain-text block", () => {
    const c = candidate("tc-1", "Login succeeds");
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).toContain("Login succeeds");
    expect(out).toContain("P2");
    expect(out).toContain("User is logged in");
    expect(out).toContain("The record is saved");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1", "A");
    const b = bundle([c]);
    expect(adaptToPlainText(b, [c])).toBe(adaptToPlainText(b, [c]));
  });

  it("orders candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", "Alpha");
    const z = candidate("tc-z", "Zulu");
    const out = adaptToPlainText(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("emits no ISO timestamp in the rendered body", () => {
    const c = candidate("tc-1", "A");
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  });

  it("folds an embedded newline in a step so each step stays on one row", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      steps: ["Open\nthe page", "Submit"],
    };
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).toContain("1. Open the page");
    expect(out).toContain("2. Submit");
    expect(out).not.toContain("\nthe page");
  });

  it("renders empty field lists as (none)", () => {
    const c: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-1", "X"),
      preconditions: [],
      steps: [],
      expectedResults: [],
      tags: [],
    };
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).toContain("Tags:       (none)");
    expect(out.match(/\(none\)/gu)?.length).toBeGreaterThanOrEqual(4);
  });

  it("introduces no provider URL, bearer token, or prompt scaffolding of its own", () => {
    const c = candidate("tc-1", "Plain redacted title");
    const out = adaptToPlainText(bundle([c]), [c]);
    expect(out).not.toMatch(/https?:\/\//iu);
    expect(out).not.toMatch(/bearer\s|api[_-]?key|sk-[a-z0-9]/iu);
    expect(out).not.toMatch(/system prompt|you are an? /iu);
  });
});

// ─── GAP-1: skip-unmatched-entry branch ──────────────────────────────────────

describe("adaptToPlainText — skip-unmatched-entry", () => {
  it("silently omits a dangling entry and keeps candidate numbering contiguous", () => {
    // Mutation (a): removing `if (candidate === undefined) continue;` renders `undefined`.
    // Mutation (b): moving `index += 1` BEFORE the skip-guard would make the surviving
    // candidate "CANDIDATE 2" — the dangling id is sorted FIRST (tc-0… < tc-1) to expose it.
    const present = candidate("tc-1", "Present Candidate");
    const b: QualityIntelligenceExportBundle = {
      ...bundle([present]),
      contents: [
        {
          candidateId: Q.asQualityIntelligenceTestCaseId("tc-0-missing"),
          coverageMapRefs: [],
          findingRefs: [],
        },
        { candidateId: present.id, coverageMapRefs: [], findingRefs: [] },
      ],
    };
    const out = adaptToPlainText(b, [present]);
    // The surviving candidate keeps index 1 — the skipped entry did not advance the counter.
    expect(out).toContain("CANDIDATE 1: Present Candidate");
    expect(out).not.toContain("CANDIDATE 2");
    // The dangling entry leaves no trace.
    expect(out).not.toContain("tc-0-missing");
    expect(out).not.toContain("undefined");
    // Deterministic.
    expect(out).toBe(adaptToPlainText(b, [present]));
  });
});

// ─── GAP-2: large case list — all-render + deterministic ordering ─────────────

describe("adaptToPlainText — large case list", () => {
  it("renders ALL 50 candidates with contiguous numbering matching ascending id order", () => {
    // Mutation (a): an early break/slice drops trailing candidates → count < 50.
    // Mutation (b): a partial comparator correct for 2 ids but wrong at scale.
    // Zero-padded ids (tc-001..tc-050) ensure lexical order == intended order.
    const cs = Array.from({ length: 50 }, (_v, i) => {
      const n = String(i + 1).padStart(3, "0");
      return candidate(`tc-${n}`, `Title ${n}`);
    });
    const reversed = [...cs].reverse(); // deterministic non-sorted input, no RNG
    const out = adaptToPlainText(bundle(reversed), reversed);

    const headers = out.match(/^CANDIDATE \d+: Title \d{3}$/gmu) ?? [];
    expect(headers.length).toBe(50);
    // Candidate N must render the Nth title in ascending id order (pins ordering at scale).
    headers.forEach((header, i) => {
      const pad = String(i + 1).padStart(3, "0");
      expect(header).toBe(`CANDIDATE ${String(i + 1)}: Title ${pad}`);
    });
  });
});

// ─── GAP-5: empty bundle — valid header-only output ──────────────────────────

describe("adaptToPlainText — empty bundle", () => {
  it("renders a valid header/footer-only document with no candidate sections", () => {
    // Mutation: a guard that drops the header/footer block on empty contents, or that
    // skips the unconditional closing RULE, would produce malformed output.
    const out = adaptToPlainText(bundle([]), []);
    expect(out).toContain("QUALITY INTELLIGENCE EXPORT");
    expect(out).toContain("Bundle:");
    expect(out).toContain(RUN);
    // No candidate block was emitted.
    expect(out).not.toContain("CANDIDATE");
    // The opening pair + the unconditional closing rule → at least three full RULE lines.
    expect((out.match(/^={60}$/gmu) ?? []).length).toBeGreaterThanOrEqual(3);
    // Well-formed: ends with a newline. Deterministic.
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toBe(adaptToPlainText(bundle([]), []));
  });
});

// ─── GAP-8: determinism under adversarial / control-char-laden input ──────────

describe("adaptToPlainText — adversarial determinism", () => {
  it("stays byte-identical across calls with control-char-laden multi-candidate input", () => {
    const a: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-a", "T\u2028itle"),
      steps: ["s\t1", "s\r\n2"],
      tags: ["x\fy"],
    };
    const z: QualityIntelligenceTestCaseCandidate = {
      ...candidate("tc-z", "Z\u000bitle"),
      steps: ["only"],
    };
    const b = bundle([z, a]);
    expect(adaptToPlainText(b, [z, a])).toBe(adaptToPlainText(b, [z, a]));
  });
});
