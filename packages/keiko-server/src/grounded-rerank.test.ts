// Unit tests for the RRF rerank+select module (ADR-0036). All tests are deterministic and pure —
// no IO, no mocks, no real workspace. Inputs use opaque string payloads so the tests are
// decoupled from folder/connector citation shapes.

import { describe, expect, it } from "vitest";
import {
  RRF_K,
  rerankAndSelect,
  type RerankBudget,
  type RerankInput,
  type SelectedCandidate,
} from "./grounded-rerank.js";

// ─── Snapshot helper ──────────────────────────────────────────────────────────

function toSnapshot(s: readonly SelectedCandidate<string>[]): readonly string[] {
  return s.map(
    (c) => `${c.kind}|${c.sourceLabel}|rank=${String(c.engineRank)}|fused=${String(c.fusedScore)}`,
  );
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function folder(tieKey: string, engineScore: number, text = "folder excerpt"): RerankInput<string> {
  return {
    kind: "folder",
    redactedText: text,
    engineScore,
    sourceLabel: `folder-${tieKey}`,
    tieKey,
    payload: `folder-payload-${tieKey}`,
  };
}

function connector(
  tieKey: string,
  engineScore: number,
  text = "connector excerpt",
): RerankInput<string> {
  return {
    kind: "connector",
    redactedText: text,
    engineScore,
    sourceLabel: `connector-${tieKey}`,
    tieKey,
    payload: `connector-payload-${tieKey}`,
  };
}

const GENEROUS_BUDGET: RerankBudget = {
  maxCandidates: 100,
  maxExcerptBytes: 1_000_000,
};

// ─── RRF_K constant ───────────────────────────────────────────────────────────

describe("RRF_K", () => {
  it("is 60 (Cormack et al. 2009 standard constant)", () => {
    expect(RRF_K).toBe(60);
  });
});

// ─── Fusion by rank, not by kind ─────────────────────────────────────────────

describe("rerankAndSelect — fusion by rank", () => {
  it("a high-rank connector outranks a low-rank folder", () => {
    // connector rank 1 → score 1/(60+1); folder rank 5 → score 1/(60+5)
    const inputs: RerankInput<string>[] = [
      folder("f-a", 0.9),
      folder("f-b", 0.8),
      folder("f-c", 0.7),
      folder("f-d", 0.6),
      folder("f-e", 0.5), // folder rank 5
      connector("c-a", 0.4), // connector rank 1
    ];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    // connector rank-1 fusedScore = 1/(60+1) > folder rank-5 fusedScore = 1/(60+5)
    const connectorIdx = selected.findIndex((s) => s.kind === "connector");
    const folderLowRankIdx = selected.findIndex(
      (s) => s.kind === "folder" && s.sourceLabel === "folder-f-e",
    );
    expect(connectorIdx).toBeGreaterThanOrEqual(0);
    expect(folderLowRankIdx).toBeGreaterThanOrEqual(0);
    expect(connectorIdx).toBeLessThan(folderLowRankIdx);
  });

  it("a high-rank folder outranks a low-rank connector", () => {
    // folder rank 1 → score 1/(60+1); connector rank 5 → score 1/(60+5)
    const inputs: RerankInput<string>[] = [
      connector("c-a", 0.9),
      connector("c-b", 0.8),
      connector("c-c", 0.7),
      connector("c-d", 0.6),
      connector("c-e", 0.5), // connector rank 5
      folder("f-a", 0.4), // folder rank 1
    ];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    const folderIdx = selected.findIndex((s) => s.kind === "folder");
    const connectorLowRankIdx = selected.findIndex(
      (s) => s.kind === "connector" && s.sourceLabel === "connector-c-e",
    );
    expect(folderIdx).toBeGreaterThanOrEqual(0);
    expect(connectorLowRankIdx).toBeGreaterThanOrEqual(0);
    expect(folderIdx).toBeLessThan(connectorLowRankIdx);
  });
});

// ─── Anti-dominance tie rule ──────────────────────────────────────────────────

describe("rerankAndSelect — tie rule: connector before folder at equal engineRank", () => {
  it("connector is ordered before folder when both have rank 1 within their engine", () => {
    // One folder rank-1, one connector rank-1 → identical fusedScore → connector wins tie.
    const inputs: RerankInput<string>[] = [folder("f-a", 0.9), connector("c-a", 0.7)];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    expect(selected.length).toBe(2);
    expect(selected[0]?.kind).toBe("connector");
    expect(selected[1]?.kind).toBe("folder");
  });

  it("proves anti-dominance: connector never loses a same-rank tie to a folder", () => {
    // Three connectors rank 1/2/3, three folders rank 1/2/3 — interleave by connector first.
    const inputs: RerankInput<string>[] = [
      folder("f-a", 0.9),
      folder("f-b", 0.8),
      folder("f-c", 0.7),
      connector("c-a", 0.9),
      connector("c-b", 0.8),
      connector("c-c", 0.7),
    ];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    expect(selected.length).toBe(6);
    // Positions 0,2,4 are connectors (tie won); 1,3,5 are folders.
    expect(selected[0]?.kind).toBe("connector");
    expect(selected[1]?.kind).toBe("folder");
    expect(selected[2]?.kind).toBe("connector");
    expect(selected[3]?.kind).toBe("folder");
  });
});

// ─── Byte budget ──────────────────────────────────────────────────────────────

describe("rerankAndSelect — byte budget", () => {
  it("skips a large excerpt that would overflow but keeps smaller later candidates", () => {
    // large folder (300 bytes) then two small connectors (10 bytes each).
    // Budget = 50 bytes. Large folder at rank 1 is SKIPPED after the first candidate fills 10 bytes.
    const largeText = "x".repeat(300);
    const smallText = "y".repeat(10);
    const inputs: RerankInput<string>[] = [
      connector("c-a", 0.9, smallText), // rank 1 in connectors → fusedScore 1/(60+1)
      folder("f-a", 0.9, largeText), // rank 1 in folders → same fusedScore, but connector wins tie
      connector("c-b", 0.5, smallText), // rank 2 in connectors → fusedScore 1/(60+2)
    ];
    // Budget: 50 bytes, 100 candidates.
    const budget: RerankBudget = { maxCandidates: 100, maxExcerptBytes: 50 };
    const selected = rerankAndSelect(inputs, budget);

    // c-a (10 bytes) is selected first; f-a (300 bytes) is skipped; c-b (10 bytes) fits.
    expect(selected.length).toBe(2);
    expect(selected.every((s) => s.kind === "connector")).toBe(true);

    const totalBytes = selected.reduce((acc, s) => acc + s.bytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(50);
  });

  it("total selected bytes do not exceed maxExcerptBytes (except single-candidate floor)", () => {
    const text = "abc".repeat(20); // 60 bytes each
    const inputs: RerankInput<string>[] = [
      folder("f-a", 0.9, text),
      folder("f-b", 0.8, text),
      connector("c-a", 0.9, text),
    ];
    const budget: RerankBudget = { maxCandidates: 10, maxExcerptBytes: 100 };
    const selected = rerankAndSelect(inputs, budget);
    const totalBytes = selected.reduce((acc, s) => acc + s.bytes, 0);
    // At most 1 extra item can push past the limit only if it's the first (floor).
    // Here first item = 60 bytes < 100, so the invariant holds strictly.
    expect(totalBytes).toBeLessThanOrEqual(100);
  });
});

// ─── Single-candidate floor ───────────────────────────────────────────────────

describe("rerankAndSelect — floor: single oversized candidate is always selected", () => {
  it("selects one candidate even if it alone exceeds maxExcerptBytes", () => {
    const oversized = "z".repeat(500);
    const inputs: RerankInput<string>[] = [connector("c-a", 0.9, oversized)];
    const budget: RerankBudget = { maxCandidates: 10, maxExcerptBytes: 10 };
    const selected = rerankAndSelect(inputs, budget);
    expect(selected.length).toBe(1);
    expect(selected[0]?.bytes).toBe(500);
  });
});

// ─── maxCandidates cap ────────────────────────────────────────────────────────

describe("rerankAndSelect — maxCandidates", () => {
  it("never returns more candidates than maxCandidates", () => {
    const inputs: RerankInput<string>[] = Array.from({ length: 20 }, (_, i) =>
      folder(`f-${String(i).padStart(2, "0")}`, 1 - i * 0.01),
    );
    const budget: RerankBudget = { maxCandidates: 5, maxExcerptBytes: 1_000_000 };
    const selected = rerankAndSelect(inputs, budget);
    expect(selected.length).toBe(5);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe("rerankAndSelect — determinism", () => {
  it("same inputs in different array order produce identical selected order and markers", () => {
    const base: RerankInput<string>[] = [
      folder("f-a", 0.9),
      folder("f-b", 0.7),
      connector("c-a", 0.85),
      connector("c-b", 0.6),
      folder("f-c", 0.5),
    ];
    // Reverse order variant
    const shuffled = [...base].reverse();

    const a = rerankAndSelect(base, GENEROUS_BUDGET);
    const b = rerankAndSelect(shuffled, GENEROUS_BUDGET);

    expect(toSnapshot(a)).toStrictEqual(toSnapshot(b));
    expect(a.map((s) => s.marker)).toStrictEqual(b.map((s) => s.marker));
  });

  it("further permutation produces the same result (snapshot-stable)", () => {
    const base: RerankInput<string>[] = [
      connector("c-b", 0.6),
      folder("f-a", 0.9),
      connector("c-a", 0.85),
      folder("f-c", 0.5),
      folder("f-b", 0.7),
    ];
    const reversed = [...base].reverse();
    const a = rerankAndSelect(base, GENEROUS_BUDGET);
    const b = rerankAndSelect(reversed, GENEROUS_BUDGET);
    expect(toSnapshot(a)).toStrictEqual(toSnapshot(b));
  });
});

// ─── Markers ─────────────────────────────────────────────────────────────────

describe("rerankAndSelect — markers", () => {
  it("markers are 1..N contiguous in selection order", () => {
    const inputs: RerankInput<string>[] = [
      folder("f-a", 0.9),
      connector("c-a", 0.8),
      folder("f-b", 0.7),
    ];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    expect(selected.map((s) => s.marker)).toStrictEqual(
      Array.from({ length: selected.length }, (_, i) => i + 1),
    );
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("rerankAndSelect — edge cases", () => {
  it("returns empty array for empty inputs", () => {
    expect(rerankAndSelect([], GENEROUS_BUDGET)).toStrictEqual([]);
  });

  it("single candidate within budget: selected with marker 1", () => {
    const inputs: RerankInput<string>[] = [folder("f-a", 0.5, "hello world")];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    expect(selected.length).toBe(1);
    expect(selected[0]?.marker).toBe(1);
    expect(selected[0]?.engineRank).toBe(1);
    expect(selected[0]?.fusedScore).toBeCloseTo(1 / (RRF_K + 1), 5);
  });

  it("payload is passed through opaquely", () => {
    const inputs: RerankInput<{ id: number }>[] = [
      {
        kind: "connector",
        redactedText: "text",
        engineScore: 0.9,
        sourceLabel: "src",
        tieKey: "k",
        payload: { id: 42 },
      },
    ];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    expect(selected[0]?.payload).toStrictEqual({ id: 42 });
  });
});

// ─── Fused score calculation ──────────────────────────────────────────────────

describe("rerankAndSelect — fusedScore calculation", () => {
  it("fusedScore equals quantize(1 / (RRF_K + engineRank))", () => {
    const inputs: RerankInput<string>[] = [
      folder("f-a", 0.9), // rank 1
      folder("f-b", 0.8), // rank 2
      folder("f-c", 0.7), // rank 3
    ];
    const selected = rerankAndSelect(inputs, GENEROUS_BUDGET);
    for (const s of selected) {
      const expected = Math.round((1 / (RRF_K + s.engineRank)) * 1e6) / 1e6;
      expect(s.fusedScore).toBe(expected);
    }
  });
});
