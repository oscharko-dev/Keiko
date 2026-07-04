#!/usr/bin/env node
// Performance-evidence freshness + verdict gate (GEN-PERF-BENCHMARK-001 / -014).
//
// The browser performance suites (tests/e2e/workspace-performance.spec.ts,
// tests/e2e/editor-performance.spec.ts) assert their budgets inline and run in CI, but nothing
// guarded the COMMITTED evidence JSONs: a stale or budget-breaching evidence file could sit in the
// tree indefinitely, and there was no signal that the numbers on disk still reflect the current
// code. This gate closes that hole. It:
//   1. re-derives pass/fail from the budget fields embedded in each evidence file (so a committed
//      file that records a budget breach fails the gate, independent of whether the suite re-ran);
//   2. requires a freshness stamp (a `commit` reachable from HEAD + a parseable `measuredAtIso`),
//      so evidence copied from an abandoned/rebased branch, or left unstamped, fails.
//
// It never re-runs the browser suites — those regenerate the evidence in CI; this gate validates
// whatever evidence is on disk (freshly generated in CI, or committed locally).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const WORKSPACE_EVIDENCE = join(repoRoot, "docs", "release", "1580-workspace-perf-evidence.json");
const EDITOR_EVIDENCE = join(repoRoot, "docs", "release", "1209-perf-evidence.json");

const GESTURE_LONG_TASK_BUDGET_MS = 100;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// ---- Workspace evidence ----------------------------------------------------

// eslint-disable-next-line complexity, max-lines-per-function -- budget gate deliberately re-derives every per-gesture verdict (samples, p75, max, long-task, view/PUT coalescing) in one linear pass so a single evidence file yields all breaches at once.
export function evaluateWorkspaceEvidence(evidence) {
  const failures = [];
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["workspace evidence is not an object"] };
  }
  const runs = evidence.runs;
  if (typeof runs !== "object" || runs === null || Object.keys(runs).length === 0) {
    return { passed: false, failures: ["workspace evidence has no runs"] };
  }
  for (const [project, run] of Object.entries(runs)) {
    if (
      typeof run !== "object" ||
      run === null ||
      !Array.isArray(run.gestures) ||
      run.gestures.length === 0
    ) {
      failures.push(`${project}: no gestures recorded`);
      continue;
    }
    for (const gesture of run.gestures) {
      const label = `${project}/${gesture.label ?? "?"}`;
      if (!isFiniteNumber(gesture.frameGapSamples) || gesture.frameGapSamples <= 3) {
        failures.push(
          `${label}: too few frame samples (${String(gesture.frameGapSamples)}) — vacuous evidence`,
        );
      }
      if (
        isFiniteNumber(gesture.frameGapP75Ms) &&
        isFiniteNumber(gesture.frameGapBudgetP75Ms) &&
        gesture.frameGapP75Ms > gesture.frameGapBudgetP75Ms
      ) {
        failures.push(
          `${label}: frame-gap p75 ${gesture.frameGapP75Ms}ms > budget ${gesture.frameGapBudgetP75Ms}ms`,
        );
      }
      if (
        isFiniteNumber(gesture.frameGapMaxMs) &&
        isFiniteNumber(gesture.frameGapBudgetMaxMs) &&
        gesture.frameGapMaxMs > gesture.frameGapBudgetMaxMs
      ) {
        failures.push(
          `${label}: frame-gap max ${gesture.frameGapMaxMs}ms > budget ${gesture.frameGapBudgetMaxMs}ms`,
        );
      }
      if (
        gesture.longTaskObserverInstalled === true &&
        isFiniteNumber(gesture.maxLongTaskMs) &&
        gesture.maxLongTaskMs > GESTURE_LONG_TASK_BUDGET_MS
      ) {
        failures.push(
          `${label}: long task ${gesture.maxLongTaskMs}ms > ${GESTURE_LONG_TASK_BUDGET_MS}ms budget`,
        );
      }
      if (isFiniteNumber(gesture.viewWrites) && gesture.viewWrites > 1) {
        failures.push(
          `${label}: viewWrites ${gesture.viewWrites} > 1 (write coalescing regressed)`,
        );
      }
      if (isFiniteNumber(gesture.workspacePuts) && gesture.workspacePuts > 1) {
        failures.push(
          `${label}: workspacePuts ${gesture.workspacePuts} > 1 (PUT coalescing regressed)`,
        );
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

// ---- Editor evidence -------------------------------------------------------

// eslint-disable-next-line complexity, max-lines-per-function -- budget gate deliberately re-derives every editor verdict (b4/b5/b6/b11 budgets plus worker-load guards) in one linear pass so a single evidence file yields all breaches at once.
export function evaluateEditorEvidence(evidence) {
  const failures = [];
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["editor evidence is not an object"] };
  }
  const b4 = evidence.b4ColdStartMs;
  if (typeof b4 !== "object" || b4 === null) {
    failures.push("editor evidence missing b4ColdStartMs");
  } else {
    if (isFiniteNumber(b4.p50) && isFiniteNumber(b4.budgetP50) && b4.p50 > b4.budgetP50) {
      failures.push(`b4 cold-start p50 ${b4.p50}ms > budget ${b4.budgetP50}ms`);
    }
    if (isFiniteNumber(b4.p95) && isFiniteNumber(b4.budgetP95) && b4.p95 > b4.budgetP95) {
      failures.push(`b4 cold-start p95 ${b4.p95}ms > budget ${b4.budgetP95}ms`);
    }
    if (!(isFiniteNumber(b4.p50) && b4.p50 > 0)) {
      failures.push("b4 cold-start p50 is not a positive measurement (probe broken)");
    }
  }
  const b5 = evidence.b5KeystrokeMs;
  if (typeof b5 !== "object" || b5 === null || b5.captured !== true) {
    failures.push("b5 keystroke evidence not captured");
  } else if (
    isFiniteNumber(b5.maxLongTaskMs) &&
    isFiniteNumber(b5.budgetMax) &&
    b5.maxLongTaskMs > b5.budgetMax
  ) {
    failures.push(`b5 keystroke long task ${b5.maxLongTaskMs}ms > budget ${b5.budgetMax}ms`);
  }
  const b6 = evidence.b6InteractionMs;
  if (typeof b6 !== "object" || b6 === null || b6.captured !== true) {
    failures.push("b6 interaction evidence not captured");
  } else if (isFiniteNumber(b6.p75) && isFiniteNumber(b6.budgetP75) && b6.p75 > b6.budgetP75) {
    failures.push(`b6 interaction p75 ${b6.p75}ms > budget ${b6.budgetP75}ms`);
  }
  const b11 = evidence.b11Memory;
  if (typeof b11 !== "object" || b11 === null || b11.supported !== true) {
    failures.push("b11 memory evidence not supported/measured");
  }
  const worker = evidence.workerLoadCapture;
  if (typeof worker !== "object" || worker === null) {
    failures.push("editor evidence missing workerLoadCapture");
  } else {
    if (worker.editorWorkerLoaded !== true) failures.push("editor worker not loaded in evidence");
    if (worker.languageWorkerLoaded === true) {
      failures.push("a Monaco language worker was loaded (editor-only budget breached)");
    }
    if (worker.tsLanguageWorkerLoaded === true) {
      failures.push(
        "the Monaco TypeScript language worker was loaded (editor-only budget breached)",
      );
    }
  }
  return { passed: failures.length === 0, failures };
}

// ---- Freshness -------------------------------------------------------------

function defaultIsAncestor(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function evaluateFreshness(evidence, { isAncestor = defaultIsAncestor } = {}) {
  const failures = [];
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["evidence is not an object"] };
  }
  const commit = evidence.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/u.test(commit)) {
    failures.push(
      "evidence missing a valid `commit` stamp — regenerate the perf suite to stamp freshness",
    );
  } else if (!isAncestor(commit)) {
    failures.push(
      `evidence commit ${commit} is not reachable from HEAD (stale/foreign-branch evidence)`,
    );
  }
  const measuredAt = evidence.measuredAtIso;
  if (typeof measuredAt !== "string" || Number.isNaN(Date.parse(measuredAt))) {
    failures.push("evidence missing a parseable `measuredAtIso`");
  }
  return { passed: failures.length === 0, failures };
}

// ---- CLI -------------------------------------------------------------------

function readEvidence(path) {
  if (!existsSync(path)) return { error: `missing evidence file: ${path}` };
  try {
    return { evidence: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { error: `unreadable evidence file ${path}: ${String(error)}` };
  }
}

function runGate() {
  const allFailures = [];
  const targets = [
    { name: "workspace", path: WORKSPACE_EVIDENCE, evaluate: evaluateWorkspaceEvidence },
    { name: "editor", path: EDITOR_EVIDENCE, evaluate: evaluateEditorEvidence },
  ];
  for (const target of targets) {
    const { evidence, error } = readEvidence(target.path);
    if (error !== undefined) {
      allFailures.push(`${target.name}: ${error}`);
      continue;
    }
    const budget = target.evaluate(evidence);
    for (const failure of budget.failures) allFailures.push(`${target.name} budget: ${failure}`);
    const freshness = evaluateFreshness(evidence);
    for (const failure of freshness.failures)
      allFailures.push(`${target.name} freshness: ${failure}`);
    if (budget.passed && freshness.passed) {
      console.log(
        `perf-evidence: ${target.name} OK (budgets within limits, evidence fresh @ ${evidence.commit})`,
      );
    }
  }
  if (allFailures.length > 0) {
    for (const failure of allFailures) console.error(`perf-evidence: FAIL - ${failure}`);
    process.exit(1);
  }
  console.log(
    "perf-evidence: PASS - all committed performance evidence is within budget and fresh.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGate();
}
