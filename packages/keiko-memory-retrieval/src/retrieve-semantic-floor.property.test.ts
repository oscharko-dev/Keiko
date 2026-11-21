import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { describe, expect, it } from "vitest";

import {
  assertFrequencyFloor,
  checkProperty,
  propertySettings,
  shrinkArray,
  type Random,
} from "../../../tests/support/property-testing.js";
import { retrieveMemoryContext } from "./retrieve.js";
import type { RankingFusionMode } from "./types.js";
import { buildRecord, memoryId, userScope } from "./_support.js";

// Raising the semantic floor only removes memories: it never admits one a lower floor refused and,
// where the semantic path alone admits, never reorders the memories both floors admit.
const NOW = 7 * 86_400_000;
const QUESTION = "alpha beta";
const SHARED_BODIES = ["alpha note", "beta note", "alpha beta note"] as const;
const OTHER_BODIES = ["omega note", "sigma note", "kappa note"] as const;
const MEMORIES_MAX = 10;
const NAME = "semantic floor monotonicity";
// The run count this suite asks for and at which its vacuity floors were validated.
const RUNS = 200;

interface Candidate {
  readonly shared: boolean;
  readonly body: number;
  readonly score: number;
  readonly confidence: number;
  readonly ageHours: number;
}
interface Case {
  readonly candidates: readonly Candidate[];
  readonly lowFloor: number;
  readonly highFloor: number;
  readonly fusion: RankingFusionMode;
}

function hundredth(random: Random): number {
  return Math.round(random.next() * 100) / 100;
}

function generate(random: Random): Case {
  const candidates = Array.from({ length: random.integer(1, MEMORIES_MAX) }, () => ({
    shared: random.chance(0.25),
    body: random.integer(0, 2),
    score: hundredth(random),
    confidence: random.pick([0.4, 0.7, 0.95]),
    ageHours: random.integer(0, 160),
  }));
  const a = hundredth(random);
  const b = hundredth(random);
  return {
    candidates,
    lowFloor: Math.min(a, b),
    highFloor: Math.max(a, b),
    fusion: random.pick(["rrf", "weighted-sum"] as const),
  };
}

function admitted(value: Case, floor: number): string[] {
  const records = value.candidates.map((candidate, index) =>
    buildRecord({
      id: `m${String(index)}`,
      body: (candidate.shared ? SHARED_BODIES : OTHER_BODIES)[candidate.body] ?? "x",
      status: "accepted",
      confidence: candidate.confidence,
      updatedAt: NOW - candidate.ageHours * 3_600_000,
    }),
  );
  const semanticById = new Map<MemoryId, number>(
    value.candidates.map((candidate, index) => [memoryId(`m${String(index)}`), candidate.score]),
  );
  return retrieveMemoryContext(
    {
      scopes: [userScope()],
      nowMs: NOW,
      queryText: QUESTION,
      strictRelevanceFloor: true,
      semanticById,
      semanticMinScore: floor,
      fusion: value.fusion,
    },
    { listByScope: () => records },
  ).included.map((entry) => entry.memoryId);
}

// The same case with every memory outside the given ids refused (score 0, ids kept).
function onlyIds(value: Case, ids: readonly string[]): Case {
  const keep = new Set(ids);
  return {
    ...value,
    candidates: value.candidates.map((candidate, index) =>
      keep.has(`m${String(index)}`) ? candidate : { ...candidate, score: 0 },
    ),
  };
}

describe("semantic floor monotonicity (property)", () => {
  it("a higher floor admits a subset of a lower floor's memories, ordered as when every other one is refused", async () => {
    const reached = { dropped: 0, multi: 0, lexical: 0 };
    await checkProperty<Case>({
      name: NAME,
      runs: RUNS,
      generate,
      shrink: (value) =>
        [...shrinkArray(value.candidates)]
          .filter((candidates) => candidates.length > 0)
          .map((candidates) => ({ ...value, candidates })),
      property: (value) => {
        const low = admitted(value, value.lowFloor);
        const high = admitted(value, value.highFloor);
        expect(low).toEqual(expect.arrayContaining(high));
        // The admitted memories are ranked among themselves (#4228), so dropping one may reorder
        // the rest; what a floor admits is ordered exactly as when every other memory is refused. A word-sharing
        // memory also scores on its semantic signal, which a higher floor zeroes when it falls
        // between the floors, so the claim holds for the memories the semantic path alone admits.
        if (!value.candidates.some((candidate) => candidate.shared)) {
          expect(high).toEqual(admitted(onlyIds(value, high), value.highFloor));
          if (high.length > 1) reached.multi += 1;
        }
        if (high.length < low.length) reached.dropped += 1;
        if (value.candidates.some((candidate) => candidate.shared)) reached.lexical += 1;
      },
    });
    const { runs } = propertySettings({ name: NAME, runs: RUNS });
    // Vacuity guards, validated at RUNS: the floor actually removed memories, several survived to
    // be ordered, and lexically admitted memories took part.
    const floor = { runs, share: 1 / 20, validatedRuns: RUNS };
    assertFrequencyFloor({
      ...floor,
      what: "a memory the higher floor drops",
      count: reached.dropped,
    });
    assertFrequencyFloor({ ...floor, what: "several survivors to order", count: reached.multi });
    assertFrequencyFloor({ ...floor, what: "a lexically admitted memory", count: reached.lexical });
  });
});
