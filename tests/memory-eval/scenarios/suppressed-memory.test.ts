// AC: stale / blocked memory suppression. Retrieval must not use stale or blocked memories
// even when they share scope and query terms with a fresh candidate.
//
// Mutation-robustness controls:
//  1. POSITIVE: only the fresh memory is included; the stale / blocked memories appear in
//     `omitted` with suppression reasons.
//  2. NEGATIVE/CONTROL: when the same fresh memory is loaded alone, retrieval still includes
//     it — proving the positive case is suppressing the bad records rather than dropping the
//     whole candidate set.

import { describe, expect, it } from "vitest";

import {
  retrieveMemoryContext,
  type MemoryRetrievalRequest,
  type OmittedReason,
} from "@oscharko-dev/keiko-memory-retrieval";

import {
  FIXED_NOW_MS,
  loadFixture,
  makeRecord,
  spyPortFromRecords,
  userScope,
} from "../_support.js";
import type { Scorecard } from "../scorecard.js";

const SCENARIO_NAME = "suppressed-memory";

function request(): MemoryRetrievalRequest {
  return {
    scopes: [userScope("user-alice")],
    queryText: "deploy script pipeline host",
    nowMs: FIXED_NOW_MS,
  };
}

function loadSuppressionResult(): {
  readonly records: readonly ReturnType<typeof makeRecord>[];
  readonly result: ReturnType<typeof retrieveMemoryContext>;
} {
  const fixture = loadFixture("stale-memories.json")[0];
  if (fixture === undefined) throw new Error("expected stale-memories fixture");
  const records = fixture.memories.map(makeRecord);
  return {
    records,
    result: retrieveMemoryContext(request(), spyPortFromRecords(records)),
  };
}

type OmittedEntry = ReturnType<typeof retrieveMemoryContext>["omitted"][number];
type OmittedMap = Map<string, OmittedEntry>;

function checkEntry(
  omitted: OmittedMap,
  id: string,
  detail: string,
  reason: OmittedReason,
): boolean {
  const entry = omitted.get(id);
  return entry?.suppressionDetail === detail && entry.reason === reason;
}

function assertSuppressedResult(result: ReturnType<typeof retrieveMemoryContext>): {
  passed: boolean;
  detail: string;
} {
  const includedIds = result.included.map((m) => String(m.memoryId));
  const omitted: OmittedMap = new Map(
    result.omitted.map((entry) => [String(entry.memoryId), entry]),
  );
  const ss: OmittedReason = "suppressed-by-status";
  const passed =
    includedIds.length === 1 &&
    includedIds[0] === "fresh-fact" &&
    result.omitted.length === 4 &&
    checkEntry(omitted, "stale-low-confidence", "stale-low-confidence", ss) &&
    checkEntry(omitted, "blocked-rejected", "rejected", ss) &&
    checkEntry(omitted, "blocked-conflicted", "conflicted", ss) &&
    checkEntry(omitted, "stale-expired", "expired", ss);
  return {
    passed,
    detail: `included=[${includedIds.join(",")}] omitted=[${result.omitted
      .map((entry) => `${String(entry.memoryId)}:${entry.suppressionDetail ?? entry.reason}`)
      .join(",")}]`,
  };
}

function runSuppressedMemory(): { passed: boolean; evidence: string } {
  const { records, result } = loadSuppressionResult();
  const positive = assertSuppressedResult(result);
  const controlRecords = records.filter((record) => String(record.id) === "fresh-fact");
  const control = retrieveMemoryContext(request(), spyPortFromRecords(controlRecords));
  const controlPass =
    control.included.length === 1 && String(control.included[0]?.memoryId) === "fresh-fact";
  return {
    passed: positive.passed && controlPass,
    evidence: `${positive.detail} control.included=${String(control.included[0]?.memoryId ?? "none")}`,
  };
}

export async function run(scorecard: Scorecard): Promise<void> {
  const { passed, evidence } = runSuppressedMemory();
  scorecard.recordResult(SCENARIO_NAME, passed, evidence);
  await Promise.resolve();
}

describe(SCENARIO_NAME, () => {
  it("suppresses stale and blocked memories while preserving the fresh candidate", () => {
    const { passed, evidence } = runSuppressedMemory();
    expect(passed, evidence).toBe(true);
  });
});
