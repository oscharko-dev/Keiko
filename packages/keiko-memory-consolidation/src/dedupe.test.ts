import { describe, expect, it } from "vitest";

import { JACCARD_DEFAULT } from "./_constants.js";
import { makeRecord, must, userScope } from "./_support.js";
import { findDuplicateClusters } from "./dedupe.js";

describe("findDuplicateClusters - grouping by exact body match", () => {
  it("groups two records with identical bodies (same scope and type)", () => {
    const a = makeRecord({ id: "m-1", body: "use tabs not spaces" });
    const b = makeRecord({ id: "m-2", body: "use tabs not spaces", createdAt: a.createdAt + 1 });
    const clusters = findDuplicateClusters([a, b], JACCARD_DEFAULT);
    expect(clusters).toHaveLength(1);
    expect(must(clusters[0]).members.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  it("returns no clusters for a single record (singletons are not clusters)", () => {
    expect(findDuplicateClusters([makeRecord()], JACCARD_DEFAULT)).toEqual([]);
  });

  it("returns no clusters for two records with no similarity at all", () => {
    const a = makeRecord({ id: "m-1", body: "alpha beta gamma" });
    const b = makeRecord({ id: "m-2", body: "xyz qrs tuv", createdAt: a.createdAt + 1 });
    expect(findDuplicateClusters([a, b], JACCARD_DEFAULT)).toEqual([]);
  });
});

describe("findDuplicateClusters - grouping by normalized body match", () => {
  it("groups two records whose bodies differ only by punctuation and case", () => {
    const a = makeRecord({ id: "m-1", body: "Use tabs, not spaces." });
    const b = makeRecord({ id: "m-2", body: "use tabs not spaces", createdAt: a.createdAt + 1 });
    const clusters = findDuplicateClusters([a, b], JACCARD_DEFAULT);
    expect(clusters).toHaveLength(1);
    expect(must(clusters[0]).members.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });
});

describe("findDuplicateClusters - grouping by Jaccard similarity over bigrams", () => {
  it("groups two records when bigram Jaccard is at or above threshold", () => {
    const body = "the build tool always prefers tabs over spaces for all source files";
    const a = makeRecord({ id: "m-1", body });
    // Tiny edit -> very high Jaccard. Should cluster at 0.85 default.
    const b = makeRecord({
      id: "m-2",
      body: "the build tool always prefers tabs over spaces for all source file",
      createdAt: a.createdAt + 1,
    });
    const clusters = findDuplicateClusters([a, b], JACCARD_DEFAULT);
    expect(clusters).toHaveLength(1);
  });

  it("does NOT group two records when bigram Jaccard is below threshold", () => {
    const a = makeRecord({ id: "m-1", body: "user prefers tabs" });
    const b = makeRecord({
      id: "m-2",
      body: "the deploy pipeline runs in europe-west",
      createdAt: a.createdAt + 1,
    });
    expect(findDuplicateClusters([a, b], JACCARD_DEFAULT)).toEqual([]);
  });
});

describe("findDuplicateClusters - scope and type partitioning", () => {
  it("does NOT merge across different scope kinds", () => {
    const a = makeRecord({ id: "m-1", body: "same body", scope: userScope("u-1") });
    const b = makeRecord({
      id: "m-2",
      body: "same body",
      scope: { kind: "workspace", workspaceId: "w-1" as never },
      createdAt: a.createdAt + 1,
    });
    expect(findDuplicateClusters([a, b], JACCARD_DEFAULT)).toEqual([]);
  });

  it("does NOT merge across different scope coordinates (same kind)", () => {
    const a = makeRecord({ id: "m-1", body: "same body", scope: userScope("u-1") });
    const b = makeRecord({
      id: "m-2",
      body: "same body",
      scope: userScope("u-2"),
      createdAt: a.createdAt + 1,
    });
    expect(findDuplicateClusters([a, b], JACCARD_DEFAULT)).toEqual([]);
  });

  it("does NOT merge across different types (same scope)", () => {
    const a = makeRecord({ id: "m-1", body: "same body", type: "preference" });
    const b = makeRecord({
      id: "m-2",
      body: "same body",
      type: "semantic-fact",
      createdAt: a.createdAt + 1,
    });
    expect(findDuplicateClusters([a, b], JACCARD_DEFAULT)).toEqual([]);
  });
});

describe("findDuplicateClusters - deterministic ordering", () => {
  it("returns clusters with members sorted oldest-first (createdAt ASC, id ASC tiebreak)", () => {
    const a = makeRecord({ id: "m-b", body: "same body", createdAt: 100 });
    const b = makeRecord({ id: "m-a", body: "same body", createdAt: 100 });
    const c = makeRecord({ id: "m-c", body: "same body", createdAt: 50 });
    const clusters = findDuplicateClusters([a, b, c], JACCARD_DEFAULT);
    expect(must(clusters[0]).members.map((m) => m.id)).toEqual(["m-c", "m-a", "m-b"]);
  });

  it("returns the same clusters regardless of input order (input shuffle)", () => {
    const a = makeRecord({ id: "m-1", body: "same body", createdAt: 10 });
    const b = makeRecord({ id: "m-2", body: "same body", createdAt: 20 });
    const c = makeRecord({ id: "m-3", body: "other thing entirely", createdAt: 30 });
    const c1 = findDuplicateClusters([a, b, c], JACCARD_DEFAULT);
    const c2 = findDuplicateClusters([c, b, a], JACCARD_DEFAULT);
    expect(c1).toEqual(c2);
  });
});

describe("findDuplicateClusters - input immutability", () => {
  it("does not mutate input array or member records", () => {
    const a = Object.freeze(makeRecord({ id: "m-1", body: "x" }));
    const b = Object.freeze(makeRecord({ id: "m-2", body: "x", createdAt: a.createdAt + 1 }));
    const input = Object.freeze([a, b]);
    expect(() => findDuplicateClusters(input, JACCARD_DEFAULT)).not.toThrow();
  });
});
