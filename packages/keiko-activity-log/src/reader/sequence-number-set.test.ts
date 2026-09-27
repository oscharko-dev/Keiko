import { describe, expect, it } from "vitest";

import { SequenceNumberSet } from "./sequence-number-set.js";

// Deterministic PRNG (mulberry32): the property runs are reproducible from their seed.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// The probes on which the subject and a plain Set disagree. One assertion per state keeps the
// property run cheap while a failure still names every disagreeing probe.
function membershipMismatches(
  subject: SequenceNumberSet,
  reference: ReadonlySet<number>,
  probes: readonly number[],
): readonly number[] {
  return probes.filter((probe) => subject.has(probe) !== reference.has(probe));
}

function addBoth(subject: SequenceNumberSet, reference: Set<number>, value: number): void {
  subject.add(value);
  reference.add(value);
}

describe("SequenceNumberSet", () => {
  it("answers exactly like a Set for random orders, gaps, duplicates and resets", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed);
      const subject = new SequenceNumberSet();
      const reference = new Set<number>();
      // Integer probes plus half-steps: a value between two members of the run was never added.
      const probes = Array.from({ length: 88 }, (_, index) => index / 2 - 2);
      for (let step = 0; step < 60; step += 1) {
        const roll = next();
        const previous = [...reference].at(-1) ?? 0;
        const value =
          roll < 0.55
            ? previous + 1
            : roll < 0.7
              ? previous + 2 + Math.floor(next() * 4)
              : roll < 0.8
                ? 1
                : Math.floor(next() * 40);
        addBoth(subject, reference, value);
        expect(
          membershipMismatches(subject, reference, probes),
          `seed ${String(seed)}, step ${String(step)}`,
        ).toEqual([]);
      }
    }
  });

  it("keeps a gap-free stream, including a later reset replay, in constant memory", () => {
    const subject = new SequenceNumberSet();
    for (let seq = 1; seq <= 100_000; seq += 1) subject.add(seq);
    for (let seq = 1; seq <= 500; seq += 1) subject.add(seq);
    expect(subject.outsideRunCount).toBe(0);
    expect(subject.has(1)).toBe(true);
    expect(subject.has(100_000)).toBe(true);
    expect(subject.has(100_001)).toBe(false);
    expect(subject.has(0)).toBe(false);
  });

  it("never reports a non-integer inside the run as a member", () => {
    const subject = new SequenceNumberSet();
    for (const seq of [1, 2, 3, 4]) subject.add(seq);
    expect(subject.has(2.5)).toBe(false);
    expect(subject.has(1.000_000_1)).toBe(false);
    subject.add(2.5);
    expect(subject.has(2.5)).toBe(true);
    expect(subject.outsideRunCount).toBe(1);
  });

  it("folds values that arrived ahead of the run into it once the gap closes", () => {
    const subject = new SequenceNumberSet();
    for (const seq of [1, 2, 5, 6, 4, 9]) subject.add(seq);
    expect(subject.outsideRunCount).toBe(4);
    subject.add(3);
    expect(subject.outsideRunCount).toBe(1);
    expect([1, 2, 3, 4, 5, 6, 9].every((seq) => subject.has(seq))).toBe(true);
    expect(subject.has(7)).toBe(false);
    expect(subject.has(8)).toBe(false);
  });

  it("never retains more than a Set on a hostile descending stream", () => {
    const subject = new SequenceNumberSet();
    for (let seq = 1_000; seq >= 1; seq -= 1) subject.add(seq);
    expect(subject.outsideRunCount).toBe(999);
    expect(subject.has(1)).toBe(true);
    expect(subject.has(1_000)).toBe(true);
    expect(subject.has(1_001)).toBe(false);
  });

  it("gives Set answers for non-integer, signed-zero and boundary values", () => {
    const subject = new SequenceNumberSet();
    const reference = new Set<number>();
    const values = [
      Number.NaN,
      1.5,
      -0,
      1,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      -5,
    ];
    const probes = [
      ...values,
      0,
      2,
      2.5,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      -4,
    ];
    for (const value of values) {
      addBoth(subject, reference, value);
      expect(membershipMismatches(subject, reference, probes), `after ${String(value)}`).toEqual(
        [],
      );
    }
  });
});
