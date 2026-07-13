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
//
// Each per-gesture budget is checked by its own small predicate below; evaluateWorkspaceEvidence
// only wires the object/runs guards and the project/gesture walk together, so a single evidence
// file still yields all breaches at once without any one function carrying the whole decision tree.

function checkFrameGapSamples(gesture, label) {
  if (!isFiniteNumber(gesture.frameGapSamples) || gesture.frameGapSamples <= 3) {
    return `${label}: too few frame samples (${String(gesture.frameGapSamples)}) — vacuous evidence`;
  }
  return undefined;
}

function checkFrameGapP75(gesture, label) {
  if (
    isFiniteNumber(gesture.frameGapP75Ms) &&
    isFiniteNumber(gesture.frameGapBudgetP75Ms) &&
    gesture.frameGapP75Ms > gesture.frameGapBudgetP75Ms
  ) {
    return `${label}: frame-gap p75 ${gesture.frameGapP75Ms}ms > budget ${gesture.frameGapBudgetP75Ms}ms`;
  }
  return undefined;
}

function checkFrameGapMax(gesture, label) {
  if (
    isFiniteNumber(gesture.frameGapMaxMs) &&
    isFiniteNumber(gesture.frameGapBudgetMaxMs) &&
    gesture.frameGapMaxMs > gesture.frameGapBudgetMaxMs
  ) {
    return `${label}: frame-gap max ${gesture.frameGapMaxMs}ms > budget ${gesture.frameGapBudgetMaxMs}ms`;
  }
  return undefined;
}

function checkLongTask(gesture, label) {
  if (
    gesture.longTaskObserverInstalled === true &&
    isFiniteNumber(gesture.maxLongTaskMs) &&
    gesture.maxLongTaskMs > GESTURE_LONG_TASK_BUDGET_MS
  ) {
    return `${label}: long task ${gesture.maxLongTaskMs}ms > ${GESTURE_LONG_TASK_BUDGET_MS}ms budget`;
  }
  return undefined;
}

function checkViewWrites(gesture, label) {
  if (isFiniteNumber(gesture.viewWrites) && gesture.viewWrites > 1) {
    return `${label}: viewWrites ${gesture.viewWrites} > 1 (write coalescing regressed)`;
  }
  return undefined;
}

function checkWorkspacePuts(gesture, label) {
  if (isFiniteNumber(gesture.workspacePuts) && gesture.workspacePuts > 1) {
    return `${label}: workspacePuts ${gesture.workspacePuts} > 1 (PUT coalescing regressed)`;
  }
  return undefined;
}

const GESTURE_CHECKS = [
  checkFrameGapSamples,
  checkFrameGapP75,
  checkFrameGapMax,
  checkLongTask,
  checkViewWrites,
  checkWorkspacePuts,
];

function evaluateWorkspaceGesture(project, gesture) {
  const label = `${project}/${gesture.label ?? "?"}`;
  const failures = [];
  for (const check of GESTURE_CHECKS) {
    const failure = check(gesture, label);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

function evaluateWorkspaceRun(project, run) {
  if (
    typeof run !== "object" ||
    run === null ||
    !Array.isArray(run.gestures) ||
    run.gestures.length === 0
  ) {
    return [`${project}: no gestures recorded`];
  }
  const failures = [];
  for (const gesture of run.gestures) {
    failures.push(...evaluateWorkspaceGesture(project, gesture));
  }
  return failures;
}

export function evaluateWorkspaceEvidence(evidence) {
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["workspace evidence is not an object"] };
  }
  const runs = evidence.runs;
  if (typeof runs !== "object" || runs === null || Object.keys(runs).length === 0) {
    return { passed: false, failures: ["workspace evidence has no runs"] };
  }
  const failures = [];
  for (const [project, run] of Object.entries(runs)) {
    failures.push(...evaluateWorkspaceRun(project, run));
  }
  return { passed: failures.length === 0, failures };
}

// ---- Editor evidence -------------------------------------------------------
//
// Each editor budget section (b4/b5/b6/b11, worker-load guards) is evaluated by its own small
// helper below; evaluateEditorEvidence only wires the object guard and the section results
// together, so a single evidence file still yields all breaches at once.

function checkColdStartP50Budget(b4) {
  if (isFiniteNumber(b4.p50) && isFiniteNumber(b4.budgetP50) && b4.p50 > b4.budgetP50) {
    return `b4 cold-start p50 ${b4.p50}ms > budget ${b4.budgetP50}ms`;
  }
  return undefined;
}

function checkColdStartP95Budget(b4) {
  if (isFiniteNumber(b4.p95) && isFiniteNumber(b4.budgetP95) && b4.p95 > b4.budgetP95) {
    return `b4 cold-start p95 ${b4.p95}ms > budget ${b4.budgetP95}ms`;
  }
  return undefined;
}

function checkColdStartProbeHealth(b4) {
  if (!(isFiniteNumber(b4.p50) && b4.p50 > 0)) {
    return "b4 cold-start p50 is not a positive measurement (probe broken)";
  }
  return undefined;
}

const B4_CHECKS = [checkColdStartP50Budget, checkColdStartP95Budget, checkColdStartProbeHealth];

function evaluateB4ColdStart(b4) {
  if (typeof b4 !== "object" || b4 === null) {
    return ["editor evidence missing b4ColdStartMs"];
  }
  const failures = [];
  for (const check of B4_CHECKS) {
    const failure = check(b4);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

function evaluateB5Keystroke(b5) {
  if (typeof b5 !== "object" || b5 === null || b5.captured !== true) {
    return ["b5 keystroke evidence not captured"];
  }
  if (
    isFiniteNumber(b5.maxLongTaskMs) &&
    isFiniteNumber(b5.budgetMax) &&
    b5.maxLongTaskMs > b5.budgetMax
  ) {
    return [`b5 keystroke long task ${b5.maxLongTaskMs}ms > budget ${b5.budgetMax}ms`];
  }
  return [];
}

function evaluateB6Interaction(b6) {
  if (typeof b6 !== "object" || b6 === null || b6.captured !== true) {
    return ["b6 interaction evidence not captured"];
  }
  if (isFiniteNumber(b6.p75) && isFiniteNumber(b6.budgetP75) && b6.p75 > b6.budgetP75) {
    return [`b6 interaction p75 ${b6.p75}ms > budget ${b6.budgetP75}ms`];
  }
  return [];
}

function evaluateB11Memory(b11) {
  if (typeof b11 !== "object" || b11 === null || b11.supported !== true) {
    return ["b11 memory evidence not supported/measured"];
  }
  return [];
}

function evaluateWorkerLoadCapture(worker) {
  if (typeof worker !== "object" || worker === null) {
    return ["editor evidence missing workerLoadCapture"];
  }
  const failures = [];
  if (worker.editorWorkerLoaded !== true) failures.push("editor worker not loaded in evidence");
  if (worker.languageWorkerLoaded === true) {
    failures.push("a Monaco language worker was loaded (editor-only budget breached)");
  }
  if (worker.tsLanguageWorkerLoaded === true) {
    failures.push("the Monaco TypeScript language worker was loaded (editor-only budget breached)");
  }
  return failures;
}

export function evaluateEditorEvidence(evidence) {
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["editor evidence is not an object"] };
  }
  const failures = [
    ...evaluateB4ColdStart(evidence.b4ColdStartMs),
    ...evaluateB5Keystroke(evidence.b5KeystrokeMs),
    ...evaluateB6Interaction(evidence.b6InteractionMs),
    ...evaluateB11Memory(evidence.b11Memory),
    ...evaluateWorkerLoadCapture(evidence.workerLoadCapture),
  ];
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
