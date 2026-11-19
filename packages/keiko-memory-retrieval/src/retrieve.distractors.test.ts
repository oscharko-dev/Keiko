// Diagnosis pins for the measured recall failures of the 2026-11-19 lab run (branch
// mv/diag-recall-distractors): `long-horizon-distractors-en` (probes "room" and "room-plain") and
// `two-memories-compare-en` sent six memories and not the one the question needs.
//
// PROVEN MECHANISM (hermetic, deterministic vectors): under `fusion: "rrf"` (the default of
// conversation recall) `rrfRank` ranks EVERY positive-weight signal, including signals that are equal
// for all candidates (confidence, importance, pinned, correction, graph). A tie is broken by memory id,
// so each of those signals hands out the ranks 1..N in memory-id order and the fused score receives
// Σ w/(60 + idRank) with Σ w = 0.77 of 1.49 total weight. That id-ordered noise is up to about five
// times the whole advantage of being the semantically closest record, so which memory wins is decided
// by its random UUID. In the live run the six supplied memories of both probes sat among the 60
// lowest of 321 ids and the target's id was at rank 151.
//
// FIXED by tie-aware rank fusion (ranking.ts, #4228): equal subscores share one rank, so a signal
// that does not distinguish records no longer hands out id-ordered ranks. The consequence is
// intended and not neutral: where one signal separates records and the others tie, that signal now
// decides. The reproductions are plain `it` now; the two `it.fails` left are pins for the diversity
// (MMR) stage, which is outside rank fusion (see their comments). The controls prove the other
// inputs (semantic scores, floor, cap, budget) are sufficient.
//
// Not reproducible hermetically: whether the real embedding gave the target the nearest vector.
// The vectors below MODEL the situation; see the diagnosis report for what a live run must record.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import { buildRecord, memoryId, projectScope } from "./_support.js";
import { cosineSimilarity } from "./diversity.js";
import { rankMemories } from "./ranking.js";
import { retrieveMemoryContext } from "./retrieve.js";
import { DEFAULT_RANKING_WEIGHTS, type MemoryRetrievalRequest } from "./types.js";

const DAY = 86_400_000;
const NOW = 400 * DAY;
const SCOPE = projectScope("p");

// The five signals that are identical for every record of the labs: all records are learned
// (`system-default`, confidence 0.85), unpinned, no correction, no graph edges.
const ID_TIED_SIGNALS_OFF = {
  pinnedBoost: 0,
  correctionBoost: 0,
  graphProximityBoost: 0,
  confidenceWeight: 0,
  importanceWeight: 0,
} as const;

// Plain deterministic uuid-shaped ids. The property under test is that the outcome does not depend on
// the ids, so no copy of the lab planner's id function is kept here (it could drift silently); the
// 50 id draws below cover the id independence and the fixed draw is just one more id assignment.
function fixtureId(label: string): string {
  const hex = createHash("sha256").update(`recall-distractors-fixture:${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// A unit vector at cosine `cos` to the query vector e0; `angle` places it around that axis.
function vectorAt(cos: number, angle: number): Float32Array {
  const side = Math.sqrt(Math.max(0, 1 - cos * cos));
  const vector = new Float32Array(6);
  vector[0] = cos;
  vector[1] = side * Math.cos(angle);
  vector[2] = side * Math.sin(angle);
  return vector;
}

interface Store {
  readonly records: MemoryRecord[];
  readonly embeddings: Map<MemoryId, Float32Array>;
  readonly semantic: Map<MemoryId, number>;
}

function newStore(): Store {
  return { records: [], embeddings: new Map(), semantic: new Map() };
}

function addRecord(
  store: Store,
  entry: { id: string; body: string; ageDays: number; cosine: number; angle: number },
): void {
  const at = NOW - entry.ageDays * DAY;
  store.records.push(
    buildRecord({
      id: entry.id,
      body: entry.body,
      scope: SCOPE,
      sourceKind: "system-default",
      confidence: 0.85,
      updatedAt: at,
      createdAt: at,
      validFrom: at,
    }),
  );
  const vector = vectorAt(entry.cosine, entry.angle);
  store.embeddings.set(memoryId(entry.id), vector);
  store.semantic.set(memoryId(entry.id), cosineSimilarity(vectorAt(1, 0), vector));
}

interface Scenario {
  readonly seed: { readonly records: readonly { key: string; body: string; ageDays: number }[] };
}

function loadScenario(name: string): Scenario {
  return JSON.parse(
    readFileSync(
      new URL(`../../../scripts/testing/memory-lab/scenarios-next/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Scenario;
}

const SCENARIO_A = loadScenario("long-horizon-distractors-en");
const SCENARIO_B = loadScenario("two-memories-compare-en");
const QUESTION_A_PLAIN = "Where is the audit review?";
const QUESTION_B = "Which storage did I choose for the projects Atlas and Borealis?";
const TARGET_A_BODY = "The audit review is in room Sycamore.";

// Scenario A: the target (age 30 d) is the semantically nearest record of the store; 20 newer
// near-topic distractors are moderately close; 300 filler records are far (`fillerCosine`).
// `idSeed` undefined keeps the fixed ids; a number re-draws every id (a permutation of the ordering).
function storeA(fillerCosine: number, idSeed?: number): Store {
  const store = newStore();
  const random = generator(7);
  const id = (label: string): string =>
    fixtureId(idSeed === undefined ? label : `perm${String(idSeed)}:${label}`);
  SCENARIO_A.seed.records.forEach((spec, index) => {
    const isTarget = spec.body === TARGET_A_BODY;
    addRecord(store, {
      id: id(`record:${spec.key}`),
      body: spec.body,
      ageDays: spec.ageDays,
      cosine: isTarget ? 0.8 : 0.62 + (random() - 0.5) * 0.04,
      angle: 0.2 * index + (isTarget ? 1 : 0),
    });
  });
  for (let index = 0; index < 300; index += 1) {
    addRecord(store, {
      id: id(`filler:0:${String(index)}`),
      body: `Ablage ${String(index + 1).padStart(4, "0")}: zorlek vimtra gehoert zu nelpho.`,
      ageDays: 1 + random() * 79,
      cosine: fillerCosine + (random() - 0.5) * 0.06,
      angle: random() * 6.28,
    });
  }
  return store;
}

// Scenario B: the two facts the question needs are "oracle" records (ids as in the run file) written
// just now; the 16 seeded distractors are about the same two projects. The facts are mirror images.
const ATLAS_FACT = "I chose PostgreSQL for the storage of project Atlas.";
const BOREALIS_FACT = "I chose MongoDB for the storage of project Borealis.";
const ATLAS_FACT_ID = "572ad355-9bde-44d2-bfe2-cca3b9ee5b04";
const BOREALIS_FACT_ID = "d8e49029-be76-4c7e-a0e5-0c88750b2a45";

function storeB(idSeed?: number): Store {
  const store = newStore();
  const id = (label: string): string =>
    fixtureId(idSeed === undefined ? label : `perm${String(idSeed)}:${label}`);
  SCENARIO_B.seed.records.forEach((spec, index) => {
    addRecord(store, {
      id: id(`record:${spec.key}`),
      body: spec.body,
      ageDays: spec.ageDays,
      cosine: 0.55 + (index % 4) * 0.01,
      angle: 0.37 * index,
    });
  });
  const atlas = idSeed === undefined ? ATLAS_FACT_ID : id("oracle:atlas");
  const borealis = idSeed === undefined ? BOREALIS_FACT_ID : id("oracle:borealis");
  addRecord(store, { id: atlas, body: ATLAS_FACT, ageDays: 0.01, cosine: 0.75, angle: 1.1 });
  addRecord(store, { id: borealis, body: BOREALIS_FACT, ageDays: 0.01, cosine: 0.75, angle: 2.1 });
  return store;
}

// Exactly what `retrieveChatMemory` passes for a Chat question (no profile, no strength history).
function recall(
  store: Store,
  queryText: string,
  overrides: Partial<MemoryRetrievalRequest> = {},
): readonly string[] {
  const request: MemoryRetrievalRequest = {
    scopes: [SCOPE],
    queryText,
    nowMs: NOW,
    semanticById: store.semantic,
    embeddingById: store.embeddings,
    fusion: "rrf",
    strictRelevanceFloor: true,
    maxIncluded: 6,
    ...overrides,
  };
  return retrieveMemoryContext(request, { listByScope: () => store.records }).included.map(
    (entry) => entry.memoryId,
  );
}

function fillerAmong(store: Store, supplied: readonly string[]): string[] {
  return supplied.filter((id) => store.records.find((r) => r.id === id)?.body.startsWith("Ablage"));
}

function idOfBody(store: Store, body: string): string {
  const found = store.records.find((record) => record.body === body);
  if (found === undefined) throw new Error("fixture body missing");
  return found.id;
}

const ID_PERMUTATIONS = Array.from({ length: 50 }, (_, index) => index);

describe("recall among near-topic distractors (diagnosis mv/diag-recall-distractors)", () => {
  describe("mechanism: rank fusion of signals that are equal for every record", () => {
    // Two records identical in every ranking signal; only the id differs. Fused scores must be equal.
    const twins = ["0000", "ffff"].map((id) =>
      buildRecord({ id, body: "unrelated words entirely", sourceKind: "system-default" }),
    );

    it("gives records identical in every signal an identical rrf score (id breaks ties only)", () => {
      const ranked = rankMemories(twins, {
        nowMs: 1_000,
        weights: DEFAULT_RANKING_WEIGHTS,
        fusion: "rrf",
      });
      const score = (id: string): number => ranked.find((e) => e.memoryId === id)?.score ?? -1;
      expect(score("0000")).toBeCloseTo(score("ffff"), 12);
    });

    it("control: the same twins tie under weighted-sum fusion", () => {
      const ranked = rankMemories([...twins], {
        nowMs: 1_000,
        weights: DEFAULT_RANKING_WEIGHTS,
        fusion: "weighted-sum",
      });
      expect(ranked[0]?.score).toBe(ranked[1]?.score);
    });
  });

  describe("scenario A: long-horizon-distractors-en, probe room-plain", () => {
    it("supplies the target with fixed ids and unrelated filler below the floor", () => {
      const store = storeA(0.1);
      expect(recall(store, QUESTION_A_PLAIN)).toContain(idOfBody(store, TARGET_A_BODY));
    });

    it("supplies the target with fixed ids when filler clears the 0.3 semantic floor (target only)", () => {
      const store = storeA(0.35);
      expect(recall(store, QUESTION_A_PLAIN)).toContain(idOfBody(store, TARGET_A_BODY));
    });

    // Not rank fusion: with the target supplied, the sixth slot goes to an unrelated filler record
    // because the MMR reorder (`diversity.ts`, default lambda 0.7) prefers a vector far from the
    // clustered near-topic records. Pure relevance (lambda 1) and a store without embeddings supply the
    // target plus five near-topic records and no filler.
    it("supplies the target and no filler when MMR is off (lambda 1, or no embeddings)", () => {
      const store = storeA(0.35);
      for (const overrides of [{ mmrLambda: 1 }, { embeddingById: new Map() }]) {
        const supplied = recall(store, QUESTION_A_PLAIN, overrides);
        expect(supplied).toContain(idOfBody(store, TARGET_A_BODY));
        expect(fillerAmong(store, supplied)).toEqual([]);
      }
    });

    // Pin for the diversity stage (#4228, next step): at the default lambda a filler is supplied.
    it.fails("supplies no filler among the six at the default MMR lambda", () => {
      const store = storeA(0.35);
      expect(fillerAmong(store, recall(store, QUESTION_A_PLAIN))).toEqual([]);
    });

    // Pin for the diversity stage (#4228, next step): two mutually similar records that are both the
    // nearest to the question (cosine about 0.96 to each other) lose one of them to the MMR penalty.
    it.fails(
      "supplies both of two mutually similar nearest records at the default MMR lambda",
      () => {
        const store = storeA(0.35);
        const twins = [
          ["The audit review is in room Willow.", 1.0],
          ["The audit review is in room Birch.", 1.66],
        ] as const;
        for (const [body, angle] of twins) {
          addRecord(store, {
            id: fixtureId(`twin:${body}`),
            body,
            ageDays: 5,
            cosine: 0.9,
            angle,
          });
        }
        const supplied = recall(store, QUESTION_A_PLAIN);
        for (const [body] of twins) expect(supplied).toContain(idOfBody(store, body));
      },
    );

    it("is independent of the memory ids: supplied for every one of 50 id draws", () => {
      const missed = ID_PERMUTATIONS.filter((seed) => {
        const store = storeA(0.1, seed);
        return !recall(store, QUESTION_A_PLAIN).includes(idOfBody(store, TARGET_A_BODY));
      });
      expect(missed).toEqual([]);
    });

    it("control: weighted-sum fusion supplies the target for every id draw (inputs suffice)", () => {
      for (const seed of ID_PERMUTATIONS) {
        const store = storeA(0.35, seed);
        expect(recall(store, QUESTION_A_PLAIN, { fusion: "weighted-sum" })).toContain(
          idOfBody(store, TARGET_A_BODY),
        );
      }
    });

    it("control: rrf with the five id-tied signals weighted to zero supplies the target", () => {
      for (const seed of ID_PERMUTATIONS) {
        const store = storeA(0.35, seed);
        const supplied = recall(store, QUESTION_A_PLAIN, ID_TIED_SIGNALS_OFF);
        expect(supplied).toContain(idOfBody(store, TARGET_A_BODY));
      }
    });

    it("control: the target passes the strict floor and a larger cap reaches it (not floor, not budget)", () => {
      const store = storeA(0.1);
      expect(recall(store, QUESTION_A_PLAIN, { maxIncluded: 30 })).toContain(
        idOfBody(store, TARGET_A_BODY),
      );
    });

    it("control: a question about nothing stored supplies no filler (abstention is the floor's job)", () => {
      const store = storeA(0.1);
      expect(recall(store, "Which colour is the moon?", { semanticById: new Map() })).toEqual([]);
    });
  });

  describe("scenario B: two-memories-compare-en (both facts needed)", () => {
    it("supplies the Atlas fact and the Borealis fact with the run file's ids", () => {
      const supplied = recall(storeB(), QUESTION_B);
      expect(supplied).toContain(ATLAS_FACT_ID);
      expect(supplied).toContain(BOREALIS_FACT_ID);
    });

    it("supplies both facts for every one of 50 id draws", () => {
      const missed = ID_PERMUTATIONS.filter((seed) => {
        const store = storeB(seed);
        const supplied = recall(store, QUESTION_B);
        return !(
          supplied.includes(idOfBody(store, ATLAS_FACT)) &&
          supplied.includes(idOfBody(store, BOREALIS_FACT))
        );
      });
      expect(missed).toEqual([]);
    });

    it("control: weighted-sum fusion supplies both facts with the run file's ids", () => {
      const supplied = recall(storeB(), QUESTION_B, { fusion: "weighted-sum" });
      expect(supplied).toContain(ATLAS_FACT_ID);
      expect(supplied).toContain(BOREALIS_FACT_ID);
    });
  });
});
