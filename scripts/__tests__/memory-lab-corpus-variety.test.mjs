// Variety figures of a corpus (#4208): near-duplicate rate, generator share, turn length spread and
// type-token ratio, as pure functions. The near-duplicate join is exact; the tests pin it against a
// naive comparison of every pair.
import { describe, expect, it } from "vitest";
import { validateBlueprint } from "../testing/memory-lab/corpus/blueprint.mjs";
import { generateScenario } from "../testing/memory-lab/corpus/generate.mjs";
import { createRandom } from "../testing/memory-lab/corpus/random.mjs";
import {
  NEAR_DUPLICATE_THRESHOLD,
  SHINGLE_SIZE,
  generatorShare,
  jaccard,
  nearDuplicateRate,
  shingleSet,
  tokenize,
  turnLengthSpread,
  typeTokenRatio,
  varietyReport,
} from "../testing/memory-lab/corpus/variety.mjs";
import { createScriptedWriter } from "../testing/memory-lab/corpus/writer-scripted.mjs";
import { fixtureBlueprint } from "./support/memory-lab-corpus-fixture.mjs";

const TWENTY =
  "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";

function naive(texts, threshold = NEAR_DUPLICATE_THRESHOLD) {
  const sets = texts.map((text) => shingleSet(text));
  const flagged = new Set();
  let pairs = 0;
  for (let left = 0; left < sets.length; left += 1)
    for (let right = left + 1; right < sets.length; right += 1)
      if (jaccard(sets[left], sets[right]) >= threshold) {
        pairs += 1;
        flagged.add(left);
        flagged.add(right);
      }
  return { duplicated: flagged.size, pairs };
}

describe("shingles and similarity", () => {
  it("tokenizes letters and digits, lowercased, across scripts", () => {
    expect(tokenize("Hallo, Welt! 42 Äpfel-Saft")).toEqual([
      "hallo",
      "welt",
      "42",
      "äpfel",
      "saft",
    ]);
    expect(tokenize("")).toEqual([]);
  });

  it("builds five-word shingles and a single shingle for a short text", () => {
    expect(SHINGLE_SIZE).toBe(5);
    expect(shingleSet("a b c d e f g").size).toBe(3);
    expect([...shingleSet("one two three")]).toEqual(["one two three"]);
    expect(shingleSet("   ").size).toBe(0);
  });

  it("measures Jaccard similarity and treats empty sets as dissimilar", () => {
    const left = new Set(["a", "b", "c"]);
    expect(jaccard(left, new Set(["b", "c", "d"]))).toBeCloseTo(0.5, 10);
    expect(jaccard(left, left)).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(left, new Set())).toBe(0);
  });
});

describe("near-duplicate rate", () => {
  it("is zero for distinct turns and for no turns", () => {
    expect(nearDuplicateRate([]).rate).toBe(0);
    const distinct = [
      "alpha beta gamma delta epsilon",
      "zeta eta theta iota kappa lambda",
      "mu nu xi",
    ];
    expect(nearDuplicateRate(distinct)).toMatchObject({
      turns: 3,
      duplicated: 0,
      pairs: 0,
      rate: 0,
    });
  });

  it("is not zero for a set with exact duplicates", () => {
    const texts = [TWENTY, TWENTY, "something else entirely different from the rest of these"];
    expect(nearDuplicateRate(texts)).toMatchObject({ turns: 3, duplicated: 2, pairs: 1 });
    expect(nearDuplicateRate(texts).rate).toBeCloseTo(0.6667, 4);
  });

  it("finds a turn that differs in its last word and misses one that differs in the middle", () => {
    const last = TWENTY.replace("twenty", "zwanzig");
    const middle = TWENTY.replace("ten", "zehn");
    expect(nearDuplicateRate([TWENTY, last]).duplicated).toBe(2);
    expect(nearDuplicateRate([TWENTY, middle]).duplicated).toBe(0);
  });

  it("counts short repeated turns as duplicates of each other", () => {
    expect(nearDuplicateRate(["Danke dir!", "danke dir", "Gern geschehen."]).duplicated).toBe(2);
  });

  it("agrees with a comparison of every pair on a random set", () => {
    const random = createRandom(2024);
    const vocabulary = Array.from({ length: 14 }, (_, index) => `w${String(index)}`);
    const sentence = () => Array.from({ length: random.int(4, 14) }, () => random.pick(vocabulary));
    const base = Array.from({ length: 40 }, () => sentence());
    const texts = Array.from({ length: 160 }, () => {
      const words = [...random.pick(base)];
      if (random.chance(0.5)) words[random.int(0, words.length - 1)] = random.pick(vocabulary);
      if (random.chance(0.3)) words.push(random.pick(vocabulary));
      return words.join(" ");
    });
    const expected = naive(texts);
    const actual = nearDuplicateRate(texts);
    expect(actual.duplicated).toBe(expected.duplicated);
    expect(actual.pairs).toBe(expected.pairs);
    expect(actual.duplicated).toBeGreaterThan(0);
    expect(actual.duplicated).toBeLessThan(texts.length);
    for (const threshold of [0.5, 0.9]) {
      const reference = naive(texts, threshold);
      expect(nearDuplicateRate(texts, { threshold })).toMatchObject(reference);
    }
  });
});

describe("generator share, spread and vocabulary", () => {
  it("reports each generator's scenarios, user turns and share, sorted by name", () => {
    const shares = generatorShare([
      { generator: "model-b", userTurns: 30 },
      { generator: "model-a", userTurns: 50 },
      { generator: "model-b", userTurns: 20 },
    ]);
    expect(shares).toEqual([
      { generator: "model-a", scenarios: 1, userTurns: 50, share: 0.5 },
      { generator: "model-b", scenarios: 2, userTurns: 50, share: 0.5 },
    ]);
    expect(generatorShare([])).toEqual([]);
    expect(generatorShare([{ generator: "x", userTurns: 0 }])[0].share).toBe(0);
  });

  it("reports minimum, median and maximum length in characters", () => {
    expect(turnLengthSpread(["a", "abc", "ab"])).toEqual({ min: 1, median: 2, max: 3 });
    expect(turnLengthSpread(["a", "abcd"])).toEqual({ min: 1, median: 2.5, max: 4 });
    expect(turnLengthSpread(["😀😀"])).toEqual({ min: 2, median: 2, max: 2 });
    expect(turnLengthSpread([])).toEqual({ min: null, median: null, max: null });
  });

  it("divides distinct tokens by all tokens", () => {
    expect(typeTokenRatio(["a b a b", "a c"])).toBeCloseTo(0.5, 4);
    expect(typeTokenRatio([""])).toBeNull();
    expect(typeTokenRatio(["one two three"])).toBe(1);
  });

  it("assembles every figure from per-scenario records", () => {
    const report = varietyReport([
      { generator: "a", userTexts: [TWENTY, TWENTY] },
      { generator: "b", userTexts: ["short text"] },
    ]);
    expect(report.userTurns).toBe(3);
    expect(report.nearDuplicate.duplicated).toBe(2);
    expect(report.generators.map((entry) => entry.generator)).toEqual(["a", "b"]);
    expect(report.turnLength.max).toBe(TWENTY.length);
    expect(report.typeTokenRatio).toBeGreaterThan(0);
  });
});

describe("variety of a scripted corpus", () => {
  it("is reproducible and reports the regularity of the scripted floor honestly", async () => {
    const blueprint = validateBlueprint(fixtureBlueprint());
    const record = async () => {
      const { scenario } = await generateScenario(blueprint, {
        size: 1000,
        seed: 3,
        writer: createScriptedWriter(),
      });
      return { generator: "scripted", userTexts: scenario.turns.map((turn) => turn.user) };
    };
    const first = varietyReport([await record()]);
    expect(varietyReport([await record()])).toEqual(first);
    expect(first.userTurns).toBe(500);
    expect(first.nearDuplicate.rate).toBeGreaterThan(0);
    expect(first.nearDuplicate.rate).toBeLessThan(1);
    expect(first.generators).toEqual([
      { generator: "scripted", scenarios: 1, userTurns: 500, share: 1 },
    ]);
    expect(first.turnLength.min).toBeGreaterThan(0);
  });
});
