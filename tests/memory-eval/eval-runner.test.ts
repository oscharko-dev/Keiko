// Orchestrator + scorecard writer for the memory evaluation harness (Epic #204 / Issue #215).
//
// A single vitest test that:
//   1. Runs every scenario `run(scorecard)` in a fixed order.
//   2. Asserts every scenario passed.
//   3. Builds the scorecard with a FIXED `generatedAt` (FIXED_NOW_MS from _support.ts) so
//      two consecutive runs produce a byte-identical serialised JSON.
//   4. Writes the serialised scorecard to tests/memory-eval/scorecard.json.
//   5. Re-runs every scenario AGAIN with a fresh accumulator and asserts the second
//      serialisation is byte-equal to the first — the determinism guard the issue brief
//      explicitly requires.
//
// The scorecard file in git is the canonical artifact for #216 epic verification; this
// test re-writes it on every run, so a behavioural drift surfaces as a git diff.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { run as runAccurateRetrieval } from "./scenarios/accurate-retrieval.test.js";
import { run as runLongRangeUnderstanding } from "./scenarios/long-range-understanding.test.js";
import { run as runTestTimeLearning } from "./scenarios/test-time-learning.test.js";
import { run as runCorrectionHandling } from "./scenarios/correction-handling.test.js";
import { run as runSelectiveForgetting } from "./scenarios/selective-forgetting.test.js";
import { run as runCrossScopeIsolation } from "./scenarios/cross-scope-isolation.test.js";
import { run as runNoMemoryMode } from "./scenarios/no-memory-mode.test.js";
import { run as runErrorPropagation } from "./scenarios/error-propagation.test.js";

import { createScorecard, serializeScorecard, type Scorecard } from "./scorecard.js";
import { FIXED_NOW_MS } from "./_support.js";

// Ordered list of scenarios. The orchestrator iterates this verbatim so the scorecard
// `scenarios[]` always appears in the same order regardless of vitest test-file ordering.
const SCENARIOS: readonly {
  readonly name: string;
  readonly run: (scorecard: Scorecard) => Promise<void>;
}[] = [
  { name: "accurate-retrieval", run: runAccurateRetrieval },
  { name: "long-range-understanding", run: runLongRangeUnderstanding },
  { name: "test-time-learning", run: runTestTimeLearning },
  { name: "correction-handling", run: runCorrectionHandling },
  { name: "selective-forgetting", run: runSelectiveForgetting },
  { name: "cross-scope-isolation", run: runCrossScopeIsolation },
  { name: "no-memory-mode", run: runNoMemoryMode },
  { name: "error-propagation", run: runErrorPropagation },
];

async function runAllScenarios(): Promise<Scorecard> {
  const scorecard = createScorecard();
  for (const scenario of SCENARIOS) {
    await scenario.run(scorecard);
  }
  return scorecard;
}

function scorecardPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "scorecard.json");
}

describe("memory evaluation orchestrator", () => {
  it("runs every scenario, writes a deterministic scorecard, asserts byte-equal across runs", async () => {
    const firstScorecard = await runAllScenarios();
    const firstBuilt = firstScorecard.build(FIXED_NOW_MS);
    const firstJson = serializeScorecard(firstBuilt);

    // Coverage / completeness — every scenario passed and every expected name appears.
    expect(firstBuilt.totals.scenarios).toBe(SCENARIOS.length);
    expect(firstBuilt.totals.passed).toBe(SCENARIOS.length);
    expect(firstBuilt.totals.failed).toBe(0);
    const observedNames = firstBuilt.scenarios.map((s) => s.name);
    const expectedNames = SCENARIOS.map((s) => s.name);
    expect(observedNames).toEqual(expectedNames);
    for (const s of firstBuilt.scenarios) {
      expect(s.passed, `${s.name}: ${s.evidence}`).toBe(true);
    }

    // Determinism guard — a second full run with a fresh accumulator must produce
    // byte-equal JSON. Same input + same clock => same output.
    const secondScorecard = await runAllScenarios();
    const secondBuilt = secondScorecard.build(FIXED_NOW_MS);
    const secondJson = serializeScorecard(secondBuilt);
    expect(secondJson).toBe(firstJson);

    // Persist the canonical scorecard. Writing AFTER the determinism check means a
    // regression in evidence text is caught BEFORE we overwrite the file on disk.
    writeFileSync(scorecardPath(), firstJson, "utf8");
  });
});
