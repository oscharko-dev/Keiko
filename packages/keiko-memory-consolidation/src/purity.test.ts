// Purity and determinism guard for the consolidation engine. Two distinct properties verified:
//
//   1. Input immutability: passing Object.freeze'd records inside an Object.freeze'd array
//      must NOT throw. The engine is forbidden from in-place mutation of caller-owned data.
//
//   2. Deterministic output: invoking runConsolidation twice with the SAME input and a
//      FRESH-but-equivalent options bundle (same nowMs, fresh id factories that allocate
//      ids in the same order) must produce byte-identical JSON.
//
// These guards back the Epic #204 reproducibility invariant: same input + same options =>
// byte-identical result. Drift here breaks the audit-ledger (#214) and evaluation harness
// (#215) reproducibility guarantees.

import { describe, expect, it } from "vitest";

import {
  JACCARD_DEFAULT,
  MAX_AGE_MS_DEFAULT,
  MAX_CLUSTERS_PER_RUN_DEFAULT,
  MAX_RECORDS_PER_RUN_DEFAULT,
  STALE_CONFIDENCE_DEFAULT,
} from "./_constants.js";
import { FIXED_NOW_MS, makeEdgeIdFactory, makeIdFactory, makeRecord } from "./_support.js";
import { runConsolidation } from "./consolidate.js";
import { findDuplicateClusters } from "./dedupe.js";
import { findStaleMemories } from "./stale.js";
import type { ConsolidationOptions } from "./types.js";

function freshOptions(): ConsolidationOptions {
  return {
    nowMs: FIXED_NOW_MS,
    newEdgeId: makeEdgeIdFactory(),
    newReviewItemId: makeIdFactory("rv"),
    jaccardThreshold: JACCARD_DEFAULT,
    staleConfidenceThreshold: STALE_CONFIDENCE_DEFAULT,
    maxAgeMs: MAX_AGE_MS_DEFAULT,
    maxClustersPerRun: MAX_CLUSTERS_PER_RUN_DEFAULT,
    maxRecordsPerRun: MAX_RECORDS_PER_RUN_DEFAULT,
  };
}

describe("runConsolidation - input immutability", () => {
  it("does not throw when called with deeply-frozen records inside a frozen array", () => {
    const a = Object.freeze(makeRecord({ id: "m-a", body: "same body", createdAt: 100 }));
    const b = Object.freeze(makeRecord({ id: "m-b", body: "same body", createdAt: 200 }));
    const input = Object.freeze([a, b]);
    expect(() => runConsolidation(input, freshOptions())).not.toThrow();
  });

  it("does not throw with stale + duplicate + conflict mixed input, all frozen", () => {
    const stale = Object.freeze(makeRecord({ id: "m-s", validUntil: FIXED_NOW_MS - 1 }));
    const dupA = Object.freeze(makeRecord({ id: "m-da", body: "x", createdAt: 100 }));
    const dupB = Object.freeze(makeRecord({ id: "m-db", body: "x", createdAt: 200 }));
    const conflictA = Object.freeze(
      makeRecord({ id: "m-ca", body: "we ship on Friday", createdAt: 100, type: "decision" }),
    );
    const conflictB = Object.freeze(
      makeRecord({
        id: "m-cb",
        body: "we do not ship on Friday",
        createdAt: 200,
        type: "decision",
      }),
    );
    const input = Object.freeze([stale, dupA, dupB, conflictA, conflictB]);
    expect(() => runConsolidation(input, freshOptions())).not.toThrow();
  });
});

describe("findDuplicateClusters - input immutability", () => {
  it("does not throw on a deeply-frozen input array", () => {
    const a = Object.freeze(makeRecord({ id: "m-a", body: "x", createdAt: 100 }));
    const b = Object.freeze(makeRecord({ id: "m-b", body: "x", createdAt: 200 }));
    expect(() => findDuplicateClusters(Object.freeze([a, b]), JACCARD_DEFAULT)).not.toThrow();
  });
});

describe("findStaleMemories - input immutability", () => {
  it("does not throw on a deeply-frozen input array", () => {
    const r = Object.freeze(makeRecord({ id: "m-1", validUntil: FIXED_NOW_MS - 1 }));
    expect(() =>
      findStaleMemories(Object.freeze([r]), {
        nowMs: FIXED_NOW_MS,
        staleConfidenceThreshold: STALE_CONFIDENCE_DEFAULT,
        maxAgeMs: MAX_AGE_MS_DEFAULT,
      }),
    ).not.toThrow();
  });
});

describe("runConsolidation - deterministic output (byte-equal JSON across runs)", () => {
  it("produces byte-equal output for identical input over two runs", () => {
    const a = makeRecord({ id: "m-a", body: "shared body", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "shared body", createdAt: 200 });
    const r1 = runConsolidation([a, b], freshOptions());
    const r2 = runConsolidation([a, b], freshOptions());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("produces byte-equal output regardless of input order (shuffle invariance)", () => {
    const a = makeRecord({ id: "m-a", body: "alpha", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "alpha", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "beta", createdAt: 300, type: "semantic-fact" });
    const d = makeRecord({ id: "m-d", body: "beta", createdAt: 400, type: "semantic-fact" });
    const r1 = runConsolidation([a, b, c, d], freshOptions());
    const r2 = runConsolidation([d, c, b, a], freshOptions());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("produces byte-equal output on mixed-category input (stale + dup + conflict)", () => {
    const stale = makeRecord({ id: "m-s", validUntil: FIXED_NOW_MS - 1 });
    const dupA = makeRecord({ id: "m-da", body: "x", createdAt: 100 });
    const dupB = makeRecord({ id: "m-db", body: "x", createdAt: 200 });
    const cA = makeRecord({
      id: "m-ca",
      body: "we ship on Friday",
      createdAt: 100,
      type: "decision",
    });
    const cB = makeRecord({
      id: "m-cb",
      body: "we do not ship on Friday",
      createdAt: 200,
      type: "decision",
    });
    const input = [stale, dupA, dupB, cA, cB];
    const r1 = runConsolidation(input, freshOptions());
    const r2 = runConsolidation(input, freshOptions());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
