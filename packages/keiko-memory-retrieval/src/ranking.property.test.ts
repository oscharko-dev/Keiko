import type { MemoryEdge, MemoryId, MemorySourceKind } from "@oscharko-dev/keiko-contracts/memory";
import { describe, expect, it } from "vitest";

import {
  assertFrequencyFloor,
  checkProperty,
  propertySettings,
  shrinkArray,
  type Random,
} from "../../../tests/support/property-testing.js";
import { buildEdge, buildRecord, memoryId } from "./_support.js";
import { rankMemories } from "./ranking.js";
import { DEFAULT_RANKING_WEIGHTS, type RankingWeights } from "./types.js";

// Seeded properties of tie-aware rank fusion (#4228). Under `fusion: "rrf"` a signal that does not
// distinguish records must not decide their order: equal subscores share one rank, and only fused scores that are exactly equal fall back to (updatedAt, id).

const DAY = 86_400_000;
const NOW = 100 * DAY;
const QUERY = "alpha beta gamma delta";
const QUERY_WORDS = ["alpha", "beta", "gamma", "delta"] as const;
const FILLER_WORDS = ["omega", "sigma", "kappa", "theta"] as const;

const SOURCE_KINDS: readonly MemorySourceKind[] = [
  "system-default",
  "consolidation",
  "workflow-outcome",
  "explicit-user-instruction",
];
const AGE_DAYS = [90, 30, 7, 0] as const;
const CONFIDENCE = [0, 0.3, 0.6, 0.9] as const;
const SEMANTIC = [0, 0.35, 0.6, 0.85] as const;
const STRENGTH = [0, 0.3, 0.7] as const;

// One level per signal; a higher level is a strictly higher subscore of that signal.
interface Spec {
  readonly relevance: number; // 0..3 shared query words
  readonly recency: number; // 0..3 (index into AGE_DAYS)
  readonly confidence: number; // 0..3
  readonly pinned: number; // 0..1
  readonly correction: number; // 0..1
  readonly semantic: number; // 0..3
  readonly strength: number; // 0..2
  readonly importance: number; // 0..3 (index into SOURCE_KINDS)
}
type SignalName = keyof Spec;
const MAX_LEVEL: Readonly<Record<SignalName, number>> = {
  relevance: 3,
  recency: 3,
  confidence: 3,
  pinned: 1,
  correction: 1,
  semantic: 3,
  strength: 2,
  importance: 3,
};
const SIGNALS = Object.keys(MAX_LEVEL) as readonly SignalName[];
const RUNS = 300;

// Vacuity floors of this suite, validated at RUNS (see `assertFrequencyFloor` in the harness).
function expectFloor(what: string, count: number, runs: number, share: number): void {
  assertFrequencyFloor({ what, count, runs, share, validatedRuns: RUNS });
}

function randomSpec(random: Random, constant: ReadonlyMap<SignalName, number>): Spec {
  const draw = (name: SignalName): number =>
    constant.get(name) ?? random.integer(0, MAX_LEVEL[name]);
  return {
    relevance: draw("relevance"),
    recency: draw("recency"),
    confidence: draw("confidence"),
    pinned: draw("pinned"),
    correction: draw("correction"),
    semantic: draw("semantic"),
    strength: draw("strength"),
    importance: draw("importance"),
  };
}

// An ordinary store: about half of the signals are identical for every candidate, and records are
// often exact clones of an earlier one so that genuinely equal fused scores occur.
function generateSpecs(random: Random): Spec[] {
  const constant = new Map<SignalName, number>();
  for (const name of SIGNALS) {
    if (random.chance(0.5)) constant.set(name, random.integer(0, MAX_LEVEL[name]));
  }
  const specs: Spec[] = [];
  const count = random.integer(4, 24);
  while (specs.length < count) {
    const earlier = specs.length > 0 && random.chance(0.35) ? random.pick(specs) : undefined;
    specs.push(earlier === undefined ? randomSpec(random, constant) : { ...earlier });
  }
  return specs;
}

function uniqueIds(random: Random, count: number): string[] {
  const ids = new Set<string>();
  while (ids.size < count) ids.add(random.integer(0, 0xffffff).toString(16).padStart(6, "0"));
  return [...ids];
}

interface Ranked {
  readonly order: readonly number[]; // spec index per position
  readonly scoreOfSpec: readonly number[];
}

function bodyOf(relevance: number): string {
  return [...QUERY_WORDS.slice(0, relevance), ...FILLER_WORDS.slice(0, 4 - relevance)].join(" ");
}

// Edges between spec indices and the size of the graph high-rank set.
interface GraphInput {
  readonly edges: readonly (readonly [number, number])[];
  readonly cut: number;
}

interface Inputs {
  readonly records: ReturnType<typeof buildRecord>[];
  readonly semanticById: Map<MemoryId, number>;
  readonly strengthById: Map<MemoryId, number>;
  readonly indexById: Map<string, number>;
}

function inputsOf(specs: readonly Spec[], ids: readonly string[]): Inputs {
  const semanticById = new Map<MemoryId, number>();
  const strengthById = new Map<MemoryId, number>();
  const indexById = new Map<string, number>();
  const records = specs.map((spec, index) => {
    const id = ids[index] ?? "missing";
    indexById.set(id, index);
    semanticById.set(memoryId(id), SEMANTIC[spec.semantic] ?? 0);
    strengthById.set(memoryId(id), STRENGTH[spec.strength] ?? 0);
    return buildRecord({
      id,
      body: bodyOf(spec.relevance),
      updatedAt: NOW - (AGE_DAYS[spec.recency] ?? 0) * DAY,
      confidence: CONFIDENCE[spec.confidence] ?? 0,
      pinned: spec.pinned === 1,
      type: spec.correction === 1 ? "correction" : "semantic-fact",
      sourceKind: SOURCE_KINDS[spec.importance] ?? "system-default",
    });
  });
  return { records, semanticById, strengthById, indexById };
}

function rank(
  specs: readonly Spec[],
  ids: readonly string[],
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
  graph?: GraphInput,
): Ranked {
  const { records, semanticById, strengthById, indexById } = inputsOf(specs, ids);
  const ranked = rankMemories(
    records,
    { queryText: QUERY, nowMs: NOW, weights, semanticById, strengthById, fusion: "rrf" },
    graph === undefined
      ? {}
      : { edgesByMemory: edgeMap(graph, ids), graphHighRankCount: graph.cut },
  );
  const order = ranked.map((entry) => indexById.get(entry.memoryId) ?? -1);
  const scoreOfSpec: number[] = [];
  for (const entry of ranked) scoreOfSpec[indexById.get(entry.memoryId) ?? -1] = entry.score;
  return { order, scoreOfSpec };
}

function edgeMap(graph: GraphInput, ids: readonly string[]): Map<MemoryId, MemoryEdge[]> {
  const map = new Map<MemoryId, MemoryEdge[]>();
  for (const [from, to] of graph.edges) {
    const edge = buildEdge({ from: ids[from] ?? "", to: ids[to] ?? "" });
    for (const end of [from, to]) {
      const key = memoryId(ids[end] ?? "");
      map.set(key, [...(map.get(key) ?? []), edge]);
    }
  }
  return map;
}

// The spec indices tied (on weighted-sum score and updatedAt) with the last record inside the cut,
// when that tie straddles the cut; empty otherwise. Computed without edges, as the library does.
function straddlingGroup(specs: readonly Spec[], ids: readonly string[], cut: number): number[] {
  const { records, semanticById, strengthById, indexById } = inputsOf(specs, ids);
  const baseline = rankMemories(records, {
    queryText: QUERY,
    nowMs: NOW,
    weights: DEFAULT_RANKING_WEIGHTS,
    semanticById,
    strengthById,
    fusion: "weighted-sum",
  });
  const key = (entry: (typeof baseline)[number] | undefined): string | undefined => {
    const index = indexById.get(entry?.memoryId ?? "");
    return entry === undefined || index === undefined
      ? undefined
      : `${String(entry.score)}|${String(specs[index]?.recency)}`;
  };
  const last = key(baseline[cut - 1]);
  if (last === undefined || key(baseline[cut]) !== last) return [];
  return baseline.filter((e) => key(e) === last).map((e) => indexById.get(e.memoryId) ?? -1);
}

// Positions grouped into runs of exactly equal fused score, each as a sorted spec-index set.
function equalScoreRuns(ranked: Ranked): string[] {
  const runs: number[][] = [];
  let previous: number | undefined;
  for (const index of ranked.order) {
    const score = ranked.scoreOfSpec[index];
    if (score !== previous) runs.push([]);
    runs[runs.length - 1]?.push(index);
    previous = score;
  }
  return runs.map((run) => [...run].sort((a, b) => a - b).join(","));
}

function weightsWithout(signal: SignalName): RankingWeights {
  return { ...DEFAULT_RANKING_WEIGHTS, [signal]: 0 };
}

function* shrinkSpecs<T extends { readonly specs: readonly Spec[] }>(
  value: T,
  rebuild: (value: T, specs: Spec[]) => T,
): Iterable<T> {
  for (const specs of shrinkArray(value.specs)) {
    if (specs.length >= 2) yield rebuild(value, specs);
  }
}

describe("rrf fusion — tie-aware properties (#4228)", () => {
  it("permutation invariance: other ids change the order only between exactly equal fused scores", async () => {
    const name = "rrf: permuting memory ids never reorders records with different fused scores";
    let tiedCases = 0;
    let distinctCases = 0;
    let idOrderedTies = 0;
    let straddled = 0;
    let edgeIntoGroup = 0;
    interface Case {
      readonly specs: readonly Spec[];
      readonly idsA: readonly string[];
      readonly idsB: readonly string[];
      readonly graph: GraphInput;
    }
    await checkProperty<Case>({
      name,
      runs: RUNS,
      generate: (random) => {
        const specs = generateSpecs(random);
        const edges = Array.from({ length: random.integer(0, 6) }, (): [number, number] => [
          random.integer(0, specs.length - 1),
          random.integer(0, specs.length - 1),
        ]).filter(([from, to]) => from !== to);
        const graph = { edges, cut: random.integer(1, Math.max(1, specs.length - 1)) };
        return {
          specs,
          idsA: uniqueIds(random, specs.length),
          idsB: uniqueIds(random, specs.length),
          graph,
        };
      },
      shrink: (value) => shrinkSpecs(value, (v, specs) => ({ ...v, specs })),
      property: ({ specs, idsA, idsB, graph }) => {
        const a = rank(specs, idsA, DEFAULT_RANKING_WEIGHTS, graph);
        const b = rank(specs, idsB, DEFAULT_RANKING_WEIGHTS, graph);
        const group = straddlingGroup(specs, idsA, graph.cut);
        straddled += group.length > 0 ? 1 : 0;
        edgeIntoGroup += graph.edges.some(([x, y]) => group.includes(x) || group.includes(y))
          ? 1
          : 0;
        const runsA = equalScoreRuns(a);
        expect(equalScoreRuns(b)).toEqual(runsA);
        expect(b.order.map((i) => b.scoreOfSpec[i])).toEqual(a.order.map((i) => a.scoreOfSpec[i]));
        tiedCases += runsA.some((run) => run.includes(",")) ? 1 : 0;
        distinctCases += runsA.length > 1 ? 1 : 0;
        idOrderedTies += a.order.join() === b.order.join() ? 0 : 1;
      },
    });
    const { runs } = propertySettings({ name, runs: RUNS });
    // Vacuity: most cases held exactly equal AND different fused scores, and the other ids did
    // reorder the records inside an equal run (the id tie-break was exercised, not skipped).
    expectFloor("a tied fused score", tiedCases, runs, 0.5);
    expectFloor("distinct fused scores", distinctCases, runs, 0.9);
    expectFloor("a tie reordered by other ids", idOrderedTies, runs, 0.2);
    // Vacuity for the graph signal: a tied group straddled the cut, and an edge pointed into it.
    expectFloor("a tied group straddling the graph cut", straddled, runs, 0.2);
    expectFloor("an edge into the straddling group", edgeIntoGroup, runs, 0.1);
  });

  it("a signal that is constant across all candidates never changes the order", async () => {
    const name = "rrf: a constant signal leaves the order of weight 0 for that signal unchanged";
    let positiveConstant = 0;
    let comparedPairs = 0;
    interface Case {
      readonly specs: readonly Spec[];
      readonly ids: readonly string[];
      readonly signal: SignalName;
      readonly level: number;
    }
    await checkProperty<Case>({
      name,
      runs: RUNS,
      generate: (random) => {
        const signal = random.pick(SIGNALS);
        const level = random.integer(0, MAX_LEVEL[signal]);
        const specs = generateSpecs(random).map((spec) => ({ ...spec, [signal]: level }));
        return { specs, ids: uniqueIds(random, specs.length), signal, level };
      },
      shrink: (value) =>
        shrinkSpecs(value, (v, specs) => ({ ...v, specs, ids: v.ids.slice(0, specs.length) })),
      property: ({ specs, ids, signal, level }) => {
        const withSignal = rank(specs, ids);
        const without = rank(specs, ids, weightsWithout(signal));
        positiveConstant += level > 0 ? 1 : 0;
        // A pair the baseline separates by more than rounding noise keeps its order.
        withSignal.order.forEach((x, position) => {
          for (const y of withSignal.order.slice(position + 1)) {
            const gap = (without.scoreOfSpec[x] ?? 0) - (without.scoreOfSpec[y] ?? 0);
            comparedPairs += 1;
            expect(gap).toBeGreaterThanOrEqual(-1e-9);
          }
        });
      },
    });
    const { runs } = propertySettings({ name, runs: RUNS });
    // Vacuity: a zero constant is trivial, so most cases used a positive one; pairs were compared.
    expectFloor("a positive constant signal", positiveConstant, runs, 0.3);
    expectFloor("a compared pair", comparedPairs, runs, 10);
  });

  it("raising one record's subscore on one signal never lowers its position", async () => {
    const name = "rrf: a higher subscore on one signal never lowers a record's position";
    let raised = 0;
    let climbed = 0;
    interface Case {
      readonly specs: readonly Spec[];
      readonly ids: readonly string[];
      readonly target: number;
      readonly signal: SignalName;
    }
    await checkProperty<Case>({
      name,
      runs: RUNS,
      generate: (random) => {
        const specs = generateSpecs(random);
        const target = random.integer(0, specs.length - 1);
        const open = SIGNALS.filter((s) => (specs[target]?.[s] ?? 0) < MAX_LEVEL[s]);
        const signal = open.length === 0 ? "relevance" : random.pick(open);
        return { specs, ids: uniqueIds(random, specs.length), target, signal };
      },
      property: ({ specs, ids, target, signal }) => {
        const base = specs[target];
        if (base === undefined || base[signal] >= MAX_LEVEL[signal]) return;
        const before = rank(specs, ids);
        const higher = specs.map((spec, i) =>
          i === target ? { ...spec, [signal]: spec[signal] + 1 } : spec,
        );
        const after = rank(higher, ids);
        raised += 1;
        const was = before.order.indexOf(target);
        const now = after.order.indexOf(target);
        climbed += now < was ? 1 : 0;
        expect(now).toBeLessThanOrEqual(was);
      },
    });
    const { runs } = propertySettings({ name, runs: RUNS });
    // Vacuity: nearly every case raised a signal, and the record actually climbed in a share of them.
    expectFloor("a raised subscore", raised, runs, 0.9);
    expectFloor("a record that climbed", climbed, runs, 0.1);
  });
});
