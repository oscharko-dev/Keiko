import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";
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
import { buildRecord, userScope } from "./_support.js";

// Records the floor removes never change which memories a question is given, or their order
// (#4228): the selection is a function of the admitted memories alone.
const DAY = 86_400_000;
const NOW = 400 * DAY;
const FLOOR = 0.4;
const QUESTION = "Which room is the audit review in?";
const NAME = "admitted-set ranking";
// The run count this suite asks for and at which its vacuity floor was validated.
const RUNS = 200;

interface Candidate {
  readonly admitted: boolean;
  readonly score: number;
  readonly ageDays: number;
  readonly pinned: boolean;
  readonly confidence: number;
}
interface Case {
  readonly candidates: readonly Candidate[];
  readonly fusion: RankingFusionMode;
  readonly maxIncluded: number;
}

function candidate(random: Random): Candidate {
  const admitted = random.chance(0.4);
  return {
    admitted,
    // Admitted memories score at or above the floor, removed ones below it.
    score: admitted ? FLOOR + random.next() * (1 - FLOOR) : random.next() * (FLOOR - 0.01),
    ageDays: random.integer(0, 360),
    pinned: random.chance(0.1),
    confidence: random.pick([0.4, 0.7, 0.95]),
  };
}

function generate(random: Random): Case {
  return {
    candidates: Array.from({ length: random.integer(1, 40) }, () => candidate(random)),
    fusion: random.pick(["rrf", "weighted-sum"] as const),
    maxIncluded: random.integer(1, 8),
  };
}

function record(value: Candidate, index: number): MemoryRecord {
  const at = NOW - value.ageDays * DAY;
  return buildRecord({
    id: `m${String(index)}`,
    // No word of the question: only the semantic path admits, so the floor alone decides.
    body: `Note ${String(index)} on gardening and weather.`,
    pinned: value.pinned,
    confidence: value.confidence,
    createdAt: at,
    updatedAt: at,
  });
}

function supplied(value: Case, records: readonly MemoryRecord[]): string[] {
  const semanticById = new Map<MemoryId, number>(
    value.candidates.map((entry, index) => [record(entry, index).id, entry.score]),
  );
  return retrieveMemoryContext(
    {
      scopes: [userScope()],
      nowMs: NOW,
      queryText: QUESTION,
      strictRelevanceFloor: true,
      semanticById,
      semanticMinScore: FLOOR,
      maxIncluded: value.maxIncluded,
      fusion: value.fusion,
    },
    { listByScope: () => records },
  ).included.map((entry) => entry.memoryId);
}

describe("admitted-set ranking (property)", () => {
  it("removing every record the floor refuses changes neither the selection nor its order", async () => {
    let reached = 0;
    await checkProperty<Case>({
      name: NAME,
      runs: RUNS,
      generate,
      shrink: (value) =>
        [...shrinkArray(value.candidates)]
          .filter((candidates) => candidates.length > 0)
          .map((candidates) => ({ ...value, candidates })),
      property: (value) => {
        const all = value.candidates.map(record);
        const admittedOnly = all.filter((_, index) => value.candidates[index]?.admitted === true);
        const crowded = supplied(value, all);
        expect(crowded).toEqual(supplied(value, admittedOnly));
        const removed = all.length - admittedOnly.length;
        if (removed > 0 && crowded.length > 1) reached += 1;
      },
    });
    const { runs } = propertySettings({ name: NAME, runs: RUNS });
    // Vacuity guard, validated at RUNS: refused records were present and several memories were
    // supplied to be ordered.
    assertFrequencyFloor({
      what: "several supplied memories among refused records",
      count: reached,
      runs,
      share: 1 / 4,
      validatedRuns: RUNS,
    });
  });
});
