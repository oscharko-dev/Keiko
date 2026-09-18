// End-to-end Activity Log scenarios (#3532): the curated fault-injection matrix.
//
// A scenario drives a production entry point of one product surface into one failure mode
// (rejection, dependency failure or timeout, crash or abort, loss or backpressure) with the real
// production file writer under a temporary `KEIKO_STATE_DIR`, and then calls
//
//   expectActivityLogScenario("<surface>.<mode>", { stateDir, startedAtMs, expectedOps })
//
// with a literal scenario id — `scripts/generate-op-catalog.mjs` resolves the inventory's scenario
// matrix from those literals, and every registered failure class maps to the scenario of its
// surface and mode. The helper reconstructs the persisted log with `keiko support analyze`'s own
// `analyzeLogText` and asserts what the scenario proves:
//
//   * every line is supported v2 evidence of this build (no corrupt, truncated or foreign line);
//   * the expected operations were persisted in causal order;
//   * the trace exercises at least one failure class the inventory maps to this scenario;
//   * the analyzer's per-failure-class sufficiency projection is `complete`.
//
// Failure messages name the scenario, the class and the closed reason — never a field value. The
// returned trace measurements (bytes, lines, lines per second) calibrate segment and retention
// budgets; set KEIKO_ACTIVITY_LOG_SCENARIO_METRICS to a directory to also record them there.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { analyzeLogText } from "../../packages/keiko-cli/src/support-analyze.js";
import { readPersistedActivityLog } from "./activity-log-proof.js";

export interface ActivityLogScenarioRun {
  /** The temporary state directory the production writer persisted the scenario into. */
  readonly stateDir: string;
  /** `Date.now()` taken immediately before the scenario drove its entry point. */
  readonly startedAtMs: number;
  /** Operations the scenario must have persisted, in causal order (other lines may interleave). */
  readonly expectedOps: readonly string[];
}

export interface ActivityLogScenarioTrace {
  readonly scenario: string;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly elapsedMs: number;
  readonly linesPerSecond: number;
  readonly failureClasses: readonly string[];
}

interface FailureSurfaceInventory {
  readonly failureClassScenarios: Readonly<Record<string, readonly string[]>>;
}

function scenarioInventory(): FailureSurfaceInventory {
  const path = new URL(
    "../../docs/observability/failure-surface-inventory.generated.json",
    import.meta.url,
  );
  return JSON.parse(readFileSync(path, "utf8")) as FailureSurfaceInventory;
}

function persistedOps(text: string): readonly string[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { readonly op?: unknown }).op)
    .filter((op): op is string => typeof op === "string");
}

function expectOrderedSubsequence(
  scenario: string,
  ops: readonly string[],
  expectedOps: readonly string[],
): void {
  let cursor = 0;
  for (const expected of expectedOps) {
    const index = ops.indexOf(expected, cursor);
    expect(index, `scenario ${scenario}: ${expected} persisted in causal order`).toBeGreaterThan(
      -1,
    );
    cursor = index + 1;
  }
}

function recordTrace(trace: ActivityLogScenarioTrace): void {
  const directory = process.env.KEIKO_ACTIVITY_LOG_SCENARIO_METRICS;
  if (directory === undefined || directory === "") return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${trace.scenario}.json`), `${JSON.stringify(trace)}\n`, "utf8");
}

/**
 * Reconstructs the scenario's persisted Activity Log through the support analyzer and asserts a
 * complete report. `scenario` must be a string literal: the op-catalog generator resolves the
 * scenario matrix from these calls.
 */
export function expectActivityLogScenario(
  scenario: string,
  run: ActivityLogScenarioRun,
): ActivityLogScenarioTrace {
  const text = readPersistedActivityLog(run.stateDir);
  const elapsedMs = Math.max(1, Date.now() - run.startedAtMs);
  const result = analyzeLogText(text);
  expect(result.evidence.classification, `scenario ${scenario}: evidence integrity`).toBe(
    "supported",
  );
  expectOrderedSubsequence(scenario, persistedOps(text), run.expectedOps);
  const failureClasses = result.sufficiency.classes.map((entry) => entry.failureClass);
  const mapped = scenarioInventory().failureClassScenarios;
  expect(
    failureClasses.some((failureClass) => mapped[failureClass]?.includes(scenario) === true),
    `scenario ${scenario}: exercises a failure class the inventory maps to it`,
  ).toBe(true);
  const incomplete = result.sufficiency.classes
    .filter((entry) => entry.status !== "complete")
    .map((entry) => `${entry.failureClass}:${entry.reasons.join("+")}`);
  expect(incomplete, `scenario ${scenario}: every observed class is complete`).toEqual([]);
  expect(result.sufficiency.status, `scenario ${scenario}: report sufficiency`).toBe("complete");
  const lineCount = persistedOps(text).length;
  const trace = {
    scenario,
    lineCount,
    byteCount: Buffer.byteLength(text, "utf8"),
    elapsedMs,
    linesPerSecond: Math.round((lineCount * 1000) / elapsedMs),
    failureClasses,
  };
  recordTrace(trace);
  return trace;
}
