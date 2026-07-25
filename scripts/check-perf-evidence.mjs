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
//   2. requires a commit, source-tree digest, and timestamp freshness stamp. A reachable commit is
//      fresh normally; a squash-only foreign commit is fresh only when its byte-level measurement
//      subject is identical to current HEAD.
//
// It never re-runs the browser suites — those regenerate the evidence in CI; this gate validates
// whatever evidence is on disk (freshly generated in CI, or committed locally).

import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  computeD12MeasurementToolchainDigest,
  D12_MEASUREMENT_TOOLCHAIN_PATHS,
} from "./d12-measurement-toolchain.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const WORKSPACE_EVIDENCE = join(repoRoot, "docs", "release", "1580-workspace-perf-evidence.json");
const EDITOR_EVIDENCE = join(repoRoot, "docs", "release", "1209-perf-evidence.json");

const PERFORMANCE_SUBJECT_DOMAIN = "keiko-performance-measurement-subject-v1\0";
const SOURCE_TREE_FRESHNESS_BINDING = "source-tree-v1";
// ADR-0139 D2: the evidence binds the measured product, not the repository. Only surfaces that
// can alter what the D12 suites load or exercise belong to the subject — the editor and UI
// packages, the server editor subsystem, the shared contracts, the runtime entry wiring, and the
// root build/dependency manifests. Repository tooling, workflows, docs, and test-only files are
// corrected by the scheduled evidence refresh instead of invalidating committed evidence; the
// measurement toolchain keeps its own dedicated digest (measurementHarnessSha256).
const PERFORMANCE_SUBJECT_PREFIXES = [
  "packages/keiko-contracts/",
  "packages/keiko-editor/",
  "packages/keiko-server/src/editor/",
  "packages/keiko-ui/",
  "src/",
];
const NON_SUBJECT_TEST_FILES =
  /(?:^|\/)__tests__\/|\.test\.|\.spec\.|(?:^|\/)vitest(?:\.[a-z-]+)?\.config\./u;
const NON_SUBJECT_ROOT_PREFIXES = [
  ".codex/",
  ".next/",
  "build/",
  "coverage/",
  "dist/",
  "docs/",
  "node_modules/",
  "out/",
  "playwright-report/",
  "reports/",
  "test-results/",
];
const PACKAGE_OUTPUT_SEGMENTS = new Set([
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "reports",
  "test-results",
]);
const COMMIT_SHA = /^[0-9a-f]{7,40}$/u;
const LOWERCASE_SHA_256 = /^[0-9a-f]{64}$/u;
const GESTURE_LONG_TASK_BUDGET_MS = 100;
const D12_BASELINE_COMMIT = "18750d079e2a61c7d7044f3f6ec977a104b9884f";
const D12_AGGREGATE_RULE = "median-run-level-percentile";
const D12_MIN_REPETITIONS = 3;
const D12_MIN_PERF_RUNS = 10;
const D12_BYTE_BUDGETS = { b1: 0, b2: 2_621_440, b3: 768_000, b10: 102_400 };
const D12_CAP_SAMPLE_COUNT = 10;
const D12_CAP_TIMING_BUDGET_MS = 200;
const D12_CAP_LONG_TASK_BUDGET_MS = 50;
const D12_CAP_OUTPUT_BYTES = 1_048_576;
const D12_CAP_RETAINED_BYTES = 524_288;
const D12_CAP_RETAINED_ENTRIES = 2_000;
const D12_CAP_RENDERED_ROWS = 200;
const D12_CAP_RESIDUAL_HEAP_BYTES = 16_777_216;
const D12_RAW_INPUT_DOMAIN = "keiko-d12-redacted-raw-input-v1\0";
const D12_BUNDLE_FINGERPRINT_DOMAIN = "keiko-d12-bundle-input-measurement-v1\0";
const B11_PEAK_GROWTH_BUDGET_BYTES = 128 * 1024 * 1024;
const B11_RESIDUAL_GROWTH_BUDGET_BYTES = 16 * 1024 * 1024;

function parseGitPathList(output) {
  return output.split("\0").filter((path) => path.length > 0);
}

function normalizeTrackedPath(path) {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function isPackageOutput(path) {
  const segments = path.split("/");
  return segments[0] === "packages" && PACKAGE_OUTPUT_SEGMENTS.has(segments[2]);
}

function isNonSubjectTree(path) {
  return (
    NON_SUBJECT_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix)) || isPackageOutput(path)
  );
}

// ADR-0139 D2: the lockfile is the authoritative build-affecting dependency state (what
// `npm ci` installs) and tsconfig drives the emitted output, so both bind the evidence.
// package.json itself is intentionally NOT a subject: renaming a script or editing metadata
// does not change the measured bundle, and the one package.json change that could — a build
// script that alters the output — is independently caught by the deterministic
// editor-release-evidence rebuild and editor-bundle-size checks on every pull request.
function isRootMeasurementConfig(path) {
  return /^package-lock\.json$/u.test(path) || /^tsconfig(?:\.[a-z-]+)?\.json$/u.test(path);
}

export function isPerformanceSubjectPath(path) {
  const normalized = normalizeTrackedPath(path);
  if (normalized === undefined) return false;
  if (isNonSubjectTree(normalized) || normalized.endsWith(".md")) return false;
  if (NON_SUBJECT_TEST_FILES.test(normalized)) return false;
  return (
    isRootMeasurementConfig(normalized) ||
    PERFORMANCE_SUBJECT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function sortPaths(paths) {
  return [...new Set(paths)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

export function selectPerformanceSubjectPaths(trackedPaths) {
  const normalized = trackedPaths.map((path) => normalizeTrackedPath(path));
  if (normalized.includes(undefined)) {
    throw new Error("tracked performance subject contains an invalid repository-relative path");
  }
  return sortPaths(normalized.filter((path) => isPerformanceSubjectPath(path)));
}

function listTrackedPaths(root) {
  return parseGitPathList(
    execFileSync(resolveHostExecutable("git"), ["ls-files", "--cached", "-z", "--"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

function updateSubjectDigest(hash, path, contents) {
  const pathBytes = Buffer.from(path, "utf8");
  const contentBytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  hash.update(`${pathBytes.length}:`, "utf8");
  hash.update(pathBytes);
  hash.update(`${contentBytes.length}:`, "utf8");
  hash.update(contentBytes);
}

export function computePerformanceSubjectDigest(options = {}) {
  const root = options.root ?? repoRoot;
  const trackedPaths = options.trackedPaths ?? listTrackedPaths(root);
  const readTrackedFile = options.readTrackedFile ?? ((path) => readFileSync(join(root, path)));
  const hash = createHash("sha256");
  hash.update(PERFORMANCE_SUBJECT_DOMAIN, "utf8");
  for (const path of selectPerformanceSubjectPaths(trackedPaths)) {
    updateSubjectDigest(hash, path, readTrackedFile(path));
  }
  return hash.digest("hex");
}

function listTrackedPathsAtCommit(root, commit) {
  return parseGitPathList(
    execFileSync(
      resolveHostExecutable("git"),
      ["ls-tree", "-r", "--name-only", "-z", commit, "--"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    ),
  );
}

function readTrackedFileAtCommit(root, commit, path) {
  return execFileSync(resolveHostExecutable("git"), ["show", `${commit}:${path}`], {
    cwd: root,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function computePerformanceSubjectDigestAtCommit(options = {}) {
  const root = options.root ?? repoRoot;
  const commit = options.commit ?? D12_BASELINE_COMMIT;
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("commit must be a full lowercase SHA");
  const trackedPaths =
    options.trackedPaths ??
    (options.listTrackedPathsAtCommit ?? listTrackedPathsAtCommit)(root, commit);
  const readTrackedFile =
    options.readTrackedFileAtCommit ?? ((path) => readTrackedFileAtCommit(root, commit, path));
  return computePerformanceSubjectDigest({ trackedPaths, readTrackedFile });
}

// True when the change under test edits the D12 measurement toolchain itself. Only then does the
// pull-request lane owe a re-measurement: a diff that leaves the ruler alone cannot be responsible
// for evidence measured with a different one, and must not be blocked by it (ADR-0139 D10).
function changedPathsAgainst(baseRef, root) {
  const output = execFileSync(
    resolveHostExecutable("git"),
    ["diff", "--name-only", "-z", `${baseRef}...HEAD`, "--"],
    { cwd: root, encoding: "utf8" },
  );
  return output.split("\0").filter((entry) => entry.length > 0);
}

export function toolchainTouchedAgainst(
  baseRef,
  root = repoRoot,
  listChangedPaths = changedPathsAgainst,
) {
  if (typeof baseRef !== "string" || baseRef.length === 0) return false;
  let changed;
  try {
    changed = new Set(listChangedPaths(baseRef, root));
  } catch (error) {
    // An unresolvable base ref must not silently disable the check: fail towards evaluating it.
    // Say so, redacted — an operator otherwise cannot tell an unknown base ref apart from a broken
    // git invocation, and both look like "the toolchain digest ran for no reason".
    console.error(
      `perf-evidence: could not resolve the change set against the base ref; evaluating the ` +
        `measurement-toolchain digest unconditionally (${error instanceof Error ? error.name : "unknown error"})`,
    );
    return true;
  }
  return D12_MEASUREMENT_TOOLCHAIN_PATHS.some((entry) => changed.has(entry));
}

export function listDirtyPerformanceSubjectPaths(root = repoRoot) {
  const trackedOutput = execFileSync(
    resolveHostExecutable("git"),
    ["diff", "--name-only", "-z", "HEAD", "--"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  const untrackedOutput = execFileSync(
    resolveHostExecutable("git"),
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return selectPerformanceSubjectPaths([
    ...parseGitPathList(trackedOutput),
    ...parseGitPathList(untrackedOutput),
  ]);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeD12RawInputSha256(value) {
  return createHash("sha256")
    .update(D12_RAW_INPUT_DOMAIN, "utf8")
    .update(stableJson(value), "utf8")
    .digest("hex");
}

function d12BundleFingerprintPayload(input) {
  const record = input ?? {};
  return {
    commit: record.commit,
    producerCommit: record.producerCommit,
    sourceTreeSha256: record.sourceTreeSha256,
    measurementHarnessSha256: record.measurementHarnessSha256,
    dependencyProvisioning: record.dependencyProvisioning,
    runtime: record.runtime,
    b1: record.b1,
    b2: record.b2,
    b3: record.b3,
    b10: record.b10,
  };
}

export function computeD12BundleMeasurementSha256(input) {
  return createHash("sha256")
    .update(D12_BUNDLE_FINGERPRINT_DOMAIN, "utf8")
    .update(stableJson(d12BundleFingerprintPayload(input)), "utf8")
    .digest("hex");
}

export function canonicalD12ArtifactBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function computeD12ArtifactSha256(value) {
  return createHash("sha256").update(canonicalD12ArtifactBytes(value)).digest("hex");
}

export function computeD12NearestRankPercentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentileValue / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentileValue / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[index] ?? 0);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
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
    return performanceBudgetFailure(
      `${label}: frame-gap p75 ${gesture.frameGapP75Ms}ms > budget ${gesture.frameGapBudgetP75Ms}ms`,
    );
  }
  return undefined;
}

function checkFrameGapMax(gesture, label) {
  if (
    isFiniteNumber(gesture.frameGapMaxMs) &&
    isFiniteNumber(gesture.frameGapBudgetMaxMs) &&
    gesture.frameGapMaxMs > gesture.frameGapBudgetMaxMs
  ) {
    return performanceBudgetFailure(
      `${label}: frame-gap max ${gesture.frameGapMaxMs}ms > budget ${gesture.frameGapBudgetMaxMs}ms`,
    );
  }
  return undefined;
}

function checkLongTask(gesture, label) {
  if (
    gesture.longTaskObserverInstalled === true &&
    isFiniteNumber(gesture.maxLongTaskMs) &&
    gesture.maxLongTaskMs > GESTURE_LONG_TASK_BUDGET_MS
  ) {
    return performanceBudgetFailure(
      `${label}: long task ${gesture.maxLongTaskMs}ms > ${GESTURE_LONG_TASK_BUDGET_MS}ms budget`,
    );
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

// A performance-budget verdict says the measured product got slower or heavier. Every other
// failure in this file says the measurement itself cannot be trusted — a malformed bundle, a wrong
// provenance, a digest that does not match its inputs. Only the second kind may abort a measurement
// lane: a producer that dies on a budget verdict destroys the very document that would have
// reported the regression (ADR-0156). Both kinds are equally fatal at the gate, which is where a
// verdict can be read.
//
// Membership is established by CONSTRUCTION, not by matching message text. Every budget verdict is
// registered as it is formatted, so a message can only be in the class if a budget comparison
// produced it. A site that forgets the wrapper stays fatal — the fail-closed direction — and no
// message reporting an untrustworthy measurement can ever be mistaken for a verdict.
const PERFORMANCE_BUDGET_FAILURES = new Set();

function performanceBudgetFailure(message) {
  PERFORMANCE_BUDGET_FAILURES.add(message);
  return message;
}

export function isPerformanceBudgetFailure(failure) {
  return typeof failure === "string" && PERFORMANCE_BUDGET_FAILURES.has(failure);
}

function checkColdStartP50Budget(b4) {
  if (isFiniteNumber(b4.p50) && isFiniteNumber(b4.budgetP50) && b4.p50 > b4.budgetP50) {
    return performanceBudgetFailure(`b4 cold-start p50 ${b4.p50}ms > budget ${b4.budgetP50}ms`);
  }
  return undefined;
}

function checkColdStartP95Budget(b4) {
  if (isFiniteNumber(b4.p95) && isFiniteNumber(b4.budgetP95) && b4.p95 > b4.budgetP95) {
    return performanceBudgetFailure(`b4 cold-start p95 ${b4.p95}ms > budget ${b4.budgetP95}ms`);
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
    return [
      performanceBudgetFailure(
        `b5 keystroke long task ${b5.maxLongTaskMs}ms > budget ${b5.budgetMax}ms`,
      ),
    ];
  }
  return [];
}

function evaluateIdleDebugCapture(b5) {
  const failures = [];
  if (b5.attempted !== true) failures.push("b5 idle-debug measurement was not attempted");
  if (b5.captured !== true) failures.push("b5 idle-debug evidence not captured");
  if (b5.traceCaptured !== true) failures.push("b5 idle-debug trace was not captured");
  return failures;
}

function evaluateExpectedSampleCount(expectedSampleCount) {
  return isPositiveInteger(expectedSampleCount)
    ? []
    : ["b5 idle-debug expectedSampleCount is not a positive integer"];
}

function evaluateProcessingSamples(samples, expectedSampleCount) {
  const failures = [];
  if (!Array.isArray(samples) || samples.length === 0) {
    return ["b5 idle-debug processing samples are missing"];
  }
  if (isPositiveInteger(expectedSampleCount) && samples.length !== expectedSampleCount) {
    failures.push(
      `b5 idle-debug recorded ${samples.length} processing samples; expected ${expectedSampleCount}`,
    );
  }
  if (samples.some((sample) => !isFiniteNumber(sample) || sample <= 0)) {
    failures.push("b5 idle-debug processing samples contain a non-positive measurement");
  }
  return failures;
}

function evaluateMatchedInputEvents(b5) {
  const failures = [];
  const eventCounts = b5.matchedInputEventCounts;
  if (!Array.isArray(eventCounts) || eventCounts.length === 0) {
    return ["b5 idle-debug matched input-event counts are missing"];
  }
  if (isPositiveInteger(b5.expectedSampleCount) && eventCounts.length !== b5.expectedSampleCount) {
    failures.push(
      `b5 idle-debug recorded ${eventCounts.length} input-event counts; expected ${b5.expectedSampleCount}`,
    );
  }
  if (eventCounts.some((count) => !isPositiveInteger(count))) {
    failures.push("b5 idle-debug input-event counts contain a zero or invalid match count");
    return failures;
  }
  const total = eventCounts.reduce((sum, count) => sum + count, 0);
  if (b5.totalMatchedInputEvents !== total) {
    failures.push(
      `b5 idle-debug totalMatchedInputEvents ${String(b5.totalMatchedInputEvents)} != ${total}`,
    );
  }
  return failures;
}

function evaluateIdleDebugSamples(b5) {
  return [
    ...evaluateExpectedSampleCount(b5.expectedSampleCount),
    ...evaluateProcessingSamples(b5.processingSamples, b5.expectedSampleCount),
    ...evaluateMatchedInputEvents(b5),
  ];
}

function evaluateIdleDebugP95(b5) {
  if (!isFiniteNumber(b5.p95)) return ["b5 idle-debug p95 is not a finite measurement"];
  const failures = [];
  const samples = b5.processingSamples;
  if (Array.isArray(samples) && samples.every(isFiniteNumber)) {
    const measuredP95 = percentile(samples, 95);
    if (b5.p95 !== measuredP95) {
      failures.push(`b5 idle-debug p95 ${b5.p95}ms != measured ${measuredP95}ms`);
    }
  }
  if (isFiniteNumber(b5.budgetMax) && b5.p95 >= b5.budgetMax) {
    failures.push(
      performanceBudgetFailure(`b5 idle-debug p95 ${b5.p95}ms >= budget ${b5.budgetMax}ms`),
    );
  }
  return failures;
}

function evaluateIdleDebugSampleCeiling(b5) {
  const samples = b5.processingSamples;
  if (
    Array.isArray(samples) &&
    isFiniteNumber(b5.budgetMax) &&
    samples.some((sample) => isFiniteNumber(sample) && sample >= b5.budgetMax)
  ) {
    return [
      performanceBudgetFailure(`b5 idle-debug processing sample reached budget ${b5.budgetMax}ms`),
    ];
  }
  return [];
}

function evaluateIdleDebugBudget(b5) {
  const failures = [];
  if (!(isFiniteNumber(b5.budgetMax) && b5.budgetMax > 0)) {
    failures.push("b5 idle-debug budgetMax is not a positive number");
  }
  failures.push(...evaluateIdleDebugP95(b5), ...evaluateIdleDebugSampleCeiling(b5));
  return failures;
}

function evaluateIdleDebugRuntime(b5) {
  const failures = [];
  if (b5.longTaskCount !== 0) failures.push("b5 idle-debug recorded one or more long tasks");
  if (b5.maxLongTaskMs !== 0) failures.push("b5 idle-debug maxLongTaskMs must be zero");
  if (b5.outputAcceptedBytes !== 0) {
    failures.push("b5 idle-debug accepted visible output during the idle interval");
  }
  if (b5.sessionStatus !== "paused" && b5.sessionStatus !== "running") {
    failures.push("b5 idle-debug session was neither paused nor running");
  }
  if (!(isFiniteNumber(b5.idleIntervalMs) && b5.idleIntervalMs > 0)) {
    failures.push("b5 idle-debug idleIntervalMs is not a positive measurement");
  }
  return failures;
}

function evaluateB5IdleDebugSession(b5) {
  if (typeof b5 !== "object" || b5 === null) {
    return ["editor evidence missing b5IdleDebugSession"];
  }
  return [
    ...evaluateIdleDebugCapture(b5),
    ...evaluateIdleDebugSamples(b5),
    ...evaluateIdleDebugBudget(b5),
    ...evaluateIdleDebugRuntime(b5),
  ];
}

function evaluateB6Interaction(b6) {
  if (typeof b6 !== "object" || b6 === null || b6.captured !== true) {
    return ["b6 interaction evidence not captured"];
  }
  if (isFiniteNumber(b6.p75) && isFiniteNumber(b6.budgetP75) && b6.p75 > b6.budgetP75) {
    return [performanceBudgetFailure(`b6 interaction p75 ${b6.p75}ms > budget ${b6.budgetP75}ms`)];
  }
  return [];
}

function evaluateB11Memory(b11) {
  if (typeof b11 !== "object" || b11 === null || b11.supported !== true) {
    return ["b11 memory evidence not supported/measured"];
  }
  const failures = [];
  const fields = [b11.baselineBytes, b11.peakBytes, b11.residualBytes];
  if (fields.some((value) => !isFiniteNumber(value) || value < 0)) {
    return ["b11 memory evidence contains an invalid byte measurement"];
  }
  if (!isPositiveInteger(b11.cycles)) failures.push("b11 memory cycles is not a positive integer");
  if (b11.peakBytes < b11.baselineBytes) {
    failures.push("b11 peakBytes is below baselineBytes (invalid peak measurement)");
  }
  const peakGrowth = b11.peakBytes - b11.baselineBytes;
  const residualGrowth = b11.residualBytes - b11.baselineBytes;
  if (peakGrowth > B11_PEAK_GROWTH_BUDGET_BYTES) {
    failures.push(
      performanceBudgetFailure(
        `b11 peak growth ${peakGrowth} bytes > budget ${B11_PEAK_GROWTH_BUDGET_BYTES} bytes`,
      ),
    );
  }
  if (residualGrowth > B11_RESIDUAL_GROWTH_BUDGET_BYTES) {
    failures.push(
      performanceBudgetFailure(
        `b11 residual growth ${residualGrowth} bytes > budget ${B11_RESIDUAL_GROWTH_BUDGET_BYTES} bytes`,
      ),
    );
  }
  return failures;
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

// D12 evidence is a closed paired-measurement record. Each repetition stores the actual execution
// order plus complete baseline/candidate measurements; `aggregates` and `deltas` are independently
// recomputed below, so a hand-edited summary cannot conceal stale raw samples or a breached run.

function evaluateD12ExactKeys(value, expectedKeys, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${label}: record is missing`];
  }
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  return isDeepStrictEqual(actual, expected)
    ? []
    : [`${label}: non-canonical or unknown field (expected ${expected.join(", ")})`];
}

function d12Record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function evaluateD12Hardware(hardware, label) {
  if (typeof hardware !== "object" || hardware === null) {
    return [`${label}: hardware provenance is missing`];
  }
  const failures = evaluateD12ExactKeys(
    hardware,
    ["cpuModel", "logicalCores", "memoryBytes"],
    `${label}: hardware`,
  );
  if (typeof hardware.cpuModel !== "string" || hardware.cpuModel.length === 0) {
    failures.push(`${label}: hardware cpuModel is missing`);
  }
  if (!isPositiveInteger(hardware.logicalCores)) {
    failures.push(`${label}: hardware logicalCores is not a positive integer`);
  }
  if (!isPositiveInteger(hardware.memoryBytes)) {
    failures.push(`${label}: hardware memoryBytes is not a positive integer`);
  }
  return failures;
}

function evaluateD12WarmUp(warmUp, label) {
  if (typeof warmUp !== "object" || warmUp === null) {
    return [`${label}: warm-up provenance is missing`];
  }
  const failures = evaluateD12ExactKeys(warmUp, ["procedure", "runs"], `${label}: warm-up`);
  if (!isPositiveInteger(warmUp.runs)) {
    failures.push(`${label}: warm-up runs is not a positive integer`);
  }
  if (typeof warmUp.procedure !== "string" || warmUp.procedure.length === 0) {
    failures.push(`${label}: warm-up procedure is missing`);
  }
  return failures;
}

function evaluateD12Toolchain(provenance, label) {
  const failures = [];
  const requiredStrings = [
    "architecture",
    "osRelease",
    "playwrightVersion",
    "chromiumVersion",
    "zlibVersion",
  ];
  if (provenance.platform !== "linux") failures.push(`${label}: platform must be linux`);
  if (provenance.nodeVersion !== "24.18.0") {
    failures.push(`${label}: Node.js version must be 24.18.0`);
  }
  if (provenance.npmVersion !== "11.16.0") {
    failures.push(`${label}: npm version must be 11.16.0`);
  }
  for (const field of requiredStrings) {
    if (typeof provenance[field] !== "string" || provenance[field].length === 0) {
      failures.push(`${label}: provenance ${field} is missing`);
    }
  }
  if (!/^[0-9a-f]{64}$/u.test(provenance.lockfileSha256 ?? "")) {
    failures.push(`${label}: lockfileSha256 is not a lowercase SHA-256 digest`);
  }
  return failures;
}

function evaluateD12Provenance(provenance, label) {
  if (typeof provenance !== "object" || provenance === null) {
    return [`${label}: provenance is missing`];
  }
  return [
    ...evaluateD12ExactKeys(
      provenance,
      [
        "architecture",
        "chromiumVersion",
        "hardware",
        "lockfileSha256",
        "nodeVersion",
        "npmVersion",
        "osRelease",
        "platform",
        "playwrightVersion",
        "warmUp",
        "zlibVersion",
      ],
      `${label}: provenance`,
    ),
    ...evaluateD12Toolchain(provenance, label),
    ...evaluateD12Hardware(provenance.hardware, label),
    ...evaluateD12WarmUp(provenance.warmUp, label),
  ];
}

function evaluateD12Samples(samples, perfRuns, label) {
  if (!Array.isArray(samples) || samples.length < perfRuns) {
    return [`${label}: raw samples are missing or fewer than KEIKO_PERF_RUNS (${perfRuns})`];
  }
  if (samples.some((sample) => !isFiniteNumber(sample) || sample <= 0)) {
    return [`${label}: raw samples contain a non-positive or invalid measurement`];
  }
  return [];
}

function evaluateD12NonNegativeSamples(samples, perfRuns, label) {
  // B5 keystroke samples are observed long-task durations. Zero means no long task; the separate
  // baseline/candidate CDP processing samples retain the strictly-positive measured-work proof.
  if (!Array.isArray(samples) || samples.length < perfRuns) {
    return [`${label}: raw samples are missing or fewer than KEIKO_PERF_RUNS (${perfRuns})`];
  }
  if (samples.some((sample) => !isFiniteNumber(sample) || sample < 0)) {
    return [`${label}: raw samples contain a negative or invalid measurement`];
  }
  return [];
}

function evaluateD12Percentile(metric, perfRuns, label, key, percentileValue) {
  if (typeof metric !== "object" || metric === null) return [`${label}: metric is missing`];
  const failures = evaluateD12Samples(metric.samples, perfRuns, label);
  if (!isFiniteNumber(metric[key])) failures.push(`${label}: ${key} is not a finite measurement`);
  if (failures.length > 0) return failures;
  const measured = percentile(metric.samples, percentileValue);
  if (metric[key] !== measured)
    failures.push(`${label}: ${key} ${metric[key]}ms != measured ${measured}ms`);
  return failures;
}

function evaluateD12B4(metric, perfRuns, label) {
  return [
    ...evaluateD12Percentile(metric, perfRuns, label, "p50", 50),
    ...evaluateD12Percentile(metric, perfRuns, label, "p95", 95),
  ];
}

function evaluateD12B5(metric, perfRuns, label) {
  const failures = evaluateD12Percentile(metric, perfRuns, label, "p95", 95);
  if (typeof metric !== "object" || metric === null) return failures;
  failures.push(...evaluateD12B5Trace(metric, label));
  if (!Number.isInteger(metric.longTaskCount) || metric.longTaskCount < 0) {
    failures.push(`${label}: longTaskCount is not a non-negative integer`);
  }
  if (!isFiniteNumber(metric.maxLongTaskMs) || metric.maxLongTaskMs < 0) {
    failures.push(`${label}: maxLongTaskMs is not a non-negative measurement`);
  }
  return failures;
}

function evaluateD12B5Trace(metric, label) {
  const failures = [];
  if (metric.traceCaptured !== true) failures.push(`${label}: traceCaptured must be true`);
  if (!isPositiveInteger(metric.expectedSampleCount)) {
    failures.push(`${label}: expectedSampleCount is not a positive integer`);
  } else if (
    Array.isArray(metric.samples) &&
    metric.expectedSampleCount !== metric.samples.length
  ) {
    failures.push(
      `${label}: expectedSampleCount ${metric.expectedSampleCount} != samples length ${metric.samples.length}`,
    );
  }
  failures.push(...evaluateD12MatchedInputEvents(metric, label));
  return failures;
}

function evaluateD12MatchedInputEvents(metric, label) {
  const counts = metric.matchedInputEventCounts;
  if (!Array.isArray(counts)) return [`${label}: matchedInputEventCounts are missing`];
  const failures = [];
  if (Array.isArray(metric.samples) && counts.length !== metric.samples.length) {
    failures.push(
      `${label}: matchedInputEventCounts length ${counts.length} != samples length ${metric.samples.length}`,
    );
  }
  if (counts.some((count) => !isPositiveInteger(count))) {
    failures.push(`${label}: matchedInputEventCounts contain a non-positive or invalid count`);
  }
  const measuredTotal = counts.reduce((total, count) => total + count, 0);
  if (metric.totalMatchedInputEvents !== measuredTotal) {
    failures.push(
      `${label}: totalMatchedInputEvents ${String(metric.totalMatchedInputEvents)} != measured ${measuredTotal}`,
    );
  }
  return failures;
}

function evaluateD12Bytes(bytes, label) {
  if (typeof bytes !== "object" || bytes === null)
    return [`${label}: byte measurements are missing`];
  const failures = evaluateD12ExactKeys(bytes, Object.keys(D12_BYTE_BUDGETS), label);
  for (const budget of Object.keys(D12_BYTE_BUDGETS)) {
    if (!Number.isInteger(bytes[budget]) || bytes[budget] < 0) {
      failures.push(`${label}: ${budget} byte measurement is not a non-negative integer`);
    }
  }
  return failures;
}

function evaluateD12B11(memory, label) {
  if (typeof memory !== "object" || memory === null) return [`${label}: B11 memory is missing`];
  const values = [memory.baselineBytes, memory.peakBytes, memory.residualBytes];
  const failures = [];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    failures.push(`${label}: B11 contains an invalid byte measurement`);
  }
  if (!isPositiveInteger(memory.cycles)) failures.push(`${label}: B11 cycles is not positive`);
  return failures;
}

function evaluateD12ExactInteger(value, expected, label) {
  return value === expected ? [] : [`${label} must equal ${expected}`];
}

function evaluateD12CapPercentile(samples, recorded, label) {
  const failures = evaluateD12Samples(samples, D12_CAP_SAMPLE_COUNT, label);
  if (!isFiniteNumber(recorded)) failures.push(`${label}: p75 is not a finite measurement`);
  if (failures.length === 0) {
    const measured = computeD12NearestRankPercentile(samples, 75);
    if (recorded !== measured) {
      failures.push(`${label}: p75 ${recorded}ms != measured ${measured}ms`);
    }
  }
  if (isFiniteNumber(recorded) && recorded > D12_CAP_TIMING_BUDGET_MS) {
    failures.push(
      performanceBudgetFailure(
        `${label}: p75 ${recorded}ms > budget ${D12_CAP_TIMING_BUDGET_MS}ms`,
      ),
    );
  }
  return failures;
}

function evaluateD12StoppedProjection(projection, label) {
  if (typeof projection !== "object" || projection === null) {
    return [`${label}: stoppedProjection is missing`];
  }
  const exact = {
    depth: 4,
    frames: 128,
    inlineDecorations: 200,
    nodes: 1_000,
    scopes: 32,
    variables: 200,
  };
  const failures = [];
  for (const [field, expected] of Object.entries(exact)) {
    failures.push(
      ...evaluateD12ExactInteger(
        projection[field],
        expected,
        `${label}: stoppedProjection ${field}`,
      ),
    );
  }
  failures.push(
    ...evaluateD12CapPercentile(projection.samples, projection.p75, `${label} stoppedProjection`),
  );
  if (!isFiniteNumber(projection.maxLongTaskMs) || projection.maxLongTaskMs < 0) {
    failures.push(`${label}: stoppedProjection maxLongTaskMs is invalid`);
  } else if (projection.maxLongTaskMs > D12_CAP_LONG_TASK_BUDGET_MS) {
    failures.push(
      performanceBudgetFailure(
        `${label}: stoppedProjection maxLongTaskMs ${projection.maxLongTaskMs}ms > budget ${D12_CAP_LONG_TASK_BUDGET_MS}ms`,
      ),
    );
  }
  return failures;
}

function evaluateD12OutputRetention(output, label) {
  const failures = [];
  if (
    !Number.isInteger(output.adapterOutputBytes) ||
    output.adapterOutputBytes < D12_CAP_OUTPUT_BYTES
  ) {
    failures.push(
      `${label}: outputFlood adapterOutputBytes must be at least ${D12_CAP_OUTPUT_BYTES}`,
    );
  }
  failures.push(
    ...evaluateD12ExactInteger(output.limitMarkers, 1, `${label}: outputFlood limitMarkers`),
    ...evaluateD12ExactInteger(
      output.renderedRowsCeiling,
      D12_CAP_RENDERED_ROWS,
      `${label}: outputFlood renderedRowsCeiling`,
    ),
  );
  for (const [field, ceiling] of [
    ["retainedBytes", D12_CAP_RETAINED_BYTES],
    ["retainedEntries", D12_CAP_RETAINED_ENTRIES],
    ["renderedRows", D12_CAP_RENDERED_ROWS],
  ]) {
    if (!Number.isInteger(output[field]) || output[field] < 0 || output[field] > ceiling) {
      failures.push(`${label}: outputFlood ${field} exceeds budget ${ceiling}`);
    }
  }
  return failures;
}

function evaluateD12OutputTiming(output, label) {
  const failures = evaluateD12CapPercentile(
    output.stopSamples,
    output.stopP75,
    `${label} outputFlood stop`,
  );
  if (!isFiniteNumber(output.maxLongTaskMs) || output.maxLongTaskMs < 0) {
    failures.push(`${label}: outputFlood maxLongTaskMs is invalid`);
  } else if (output.maxLongTaskMs > D12_CAP_LONG_TASK_BUDGET_MS) {
    failures.push(
      performanceBudgetFailure(
        `${label}: outputFlood maxLongTaskMs ${output.maxLongTaskMs}ms > budget ${D12_CAP_LONG_TASK_BUDGET_MS}ms`,
      ),
    );
  }
  if (
    !Number.isInteger(output.residualHeapBytes) ||
    output.residualHeapBytes < 0 ||
    output.residualHeapBytes > D12_CAP_RESIDUAL_HEAP_BYTES
  ) {
    failures.push(
      `${label}: outputFlood residualHeapBytes exceeds budget ${D12_CAP_RESIDUAL_HEAP_BYTES}`,
    );
  }
  return failures;
}

function evaluateD12OutputFlood(output, label) {
  if (typeof output !== "object" || output === null) {
    return [`${label}: outputFlood is missing`];
  }
  return [...evaluateD12OutputRetention(output, label), ...evaluateD12OutputTiming(output, label)];
}

function parseD12Timestamp(value, label, failures) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    failures.push(`${label} is not parseable`);
    return undefined;
  }
  return Date.parse(value);
}

function evaluateD12Digest(value, label) {
  return LOWERCASE_SHA_256.test(value ?? "") ? [] : [`${label} is not a lowercase SHA-256 digest`];
}

function evaluateD12RawInputEnvelope(rawInput, label) {
  const failures = evaluateD12ExactKeys(
    rawInput,
    ["artifact", "schemaVersion", "sha256"],
    `${label}: raw input envelope`,
  );
  const input = d12Record(rawInput);
  if (input.schemaVersion !== "2") failures.push(`${label}: raw input schemaVersion must be 2`);
  failures.push(...evaluateD12Digest(input.sha256, `${label}: raw input sha256`));
  if (typeof input.artifact !== "object" || input.artifact === null) {
    failures.push(`${label}: committed raw artifact is missing`);
  } else if (input.sha256 !== computeD12RawInputSha256(input.artifact)) {
    failures.push(`${label}: raw input sha256 does not match its canonical artifact`);
  }
  return { artifact: input.artifact, failures };
}

function evaluateD12RawProvenance(value, label) {
  const provenance = d12Record(value);
  return [
    ...evaluateD12ExactKeys(
      value,
      [
        "architecture",
        "chromiumVersion",
        "hardware",
        "lockfileSha256",
        "nodeVersion",
        "npmVersion",
        "osRelease",
        "platform",
        "playwrightVersion",
        "zlibVersion",
      ],
      `${label}: provenance`,
    ),
    ...evaluateD12Toolchain(provenance, label),
    ...evaluateD12Hardware(provenance.hardware, label),
  ];
}

function positiveD12RawValue(value, label, failures) {
  if (!isFiniteNumber(value) || value <= 0) failures.push(`${label} must be positive`);
  return value;
}

function deriveD12RawB4(value, perfRuns, label) {
  const metric = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    ["budgetP50", "budgetP95", "samples"],
    `${label}: B4`,
  );
  positiveD12RawValue(metric.budgetP50, `${label}: B4 budgetP50`, failures);
  positiveD12RawValue(metric.budgetP95, `${label}: B4 budgetP95`, failures);
  failures.push(...evaluateD12Samples(metric.samples, perfRuns, `${label}: B4`));
  const samples = Array.isArray(metric.samples) ? [...metric.samples] : [];
  return {
    failures,
    normalized: { samples, p50: percentile(samples, 50), p95: percentile(samples, 95) },
    raw: { budgetP50: metric.budgetP50, budgetP95: metric.budgetP95, samples },
  };
}

function deriveD12RawKeystroke(value, perfRuns, label) {
  const metric = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    ["budgetMax", "captured", "longTaskCount", "maxLongTaskMs", "samples"],
    `${label}: B5 keystroke`,
  );
  positiveD12RawValue(metric.budgetMax, `${label}: B5 budgetMax`, failures);
  if (metric.captured !== true) failures.push(`${label}: B5 captured must be true`);
  if (!Number.isInteger(metric.longTaskCount) || metric.longTaskCount < 0) {
    failures.push(`${label}: B5 longTaskCount is invalid`);
  }
  if (!isFiniteNumber(metric.maxLongTaskMs) || metric.maxLongTaskMs < 0) {
    failures.push(`${label}: B5 maxLongTaskMs is invalid`);
  }
  failures.push(
    ...evaluateD12NonNegativeSamples(metric.samples, perfRuns, `${label}: B5 keystroke`),
  );
  return {
    failures,
    raw: { ...metric, samples: Array.isArray(metric.samples) ? [...metric.samples] : [] },
  };
}

function evaluateD12RawMatchedWork(metric, perfRuns, label) {
  const failures = evaluateD12Samples(metric.processingSamples, perfRuns, label);
  if (metric.captured !== true) failures.push(`${label}: captured must be true`);
  if (metric.traceCaptured !== true) failures.push(`${label}: traceCaptured must be true`);
  if (metric.expectedSampleCount !== metric.processingSamples?.length) {
    failures.push(`${label}: expectedSampleCount must equal processingSamples length`);
  }
  const normalized = {
    ...metric,
    samples: Array.isArray(metric.processingSamples) ? [...metric.processingSamples] : [],
  };
  failures.push(...evaluateD12B5Trace(normalized, label));
  if (!Number.isInteger(metric.longTaskCount) || metric.longTaskCount < 0) {
    failures.push(`${label}: longTaskCount is invalid`);
  }
  if (!isFiniteNumber(metric.maxLongTaskMs) || metric.maxLongTaskMs < 0) {
    failures.push(`${label}: maxLongTaskMs is invalid`);
  }
  return { failures, normalized };
}

function deriveD12BaselineWork(value, perfRuns, label) {
  const metric = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    [
      "captured",
      "expectedSampleCount",
      "longTaskCount",
      "matchedInputEventCounts",
      "maxLongTaskMs",
      "processingSamples",
      "totalMatchedInputEvents",
      "traceCaptured",
    ],
    `${label}: baseline measured work`,
  );
  const derived = evaluateD12RawMatchedWork(metric, perfRuns, `${label}: baseline measured work`);
  failures.push(...derived.failures);
  return {
    failures,
    normalized: {
      ...derived.normalized,
      p95: percentile(derived.normalized.samples, 95),
    },
  };
}

function deriveD12CandidateWork(value, perfRuns, label) {
  const metric = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    [
      "attempted",
      "budgetMax",
      "captured",
      "expectedSampleCount",
      "idleIntervalMs",
      "longTaskCount",
      "matchedInputEventCounts",
      "maxLongTaskMs",
      "outputAcceptedBytes",
      "processingSamples",
      "sessionStatus",
      "totalMatchedInputEvents",
      "traceCaptured",
    ],
    `${label}: candidate measured work`,
  );
  const derived = evaluateD12RawMatchedWork(metric, perfRuns, `${label}: candidate measured work`);
  failures.push(...derived.failures);
  if (metric.attempted !== true) failures.push(`${label}: candidate attempted must be true`);
  positiveD12RawValue(metric.budgetMax, `${label}: candidate budgetMax`, failures);
  positiveD12RawValue(metric.idleIntervalMs, `${label}: candidate idleIntervalMs`, failures);
  if (metric.outputAcceptedBytes !== 0)
    failures.push(`${label}: candidate outputAcceptedBytes must be 0`);
  if (metric.sessionStatus !== "paused" && metric.sessionStatus !== "running") {
    failures.push(`${label}: candidate sessionStatus must be active`);
  }
  return {
    failures,
    normalized: { ...derived.normalized, p95: percentile(derived.normalized.samples, 95) },
  };
}

function deriveD12RawB6(value, perfRuns, label) {
  const metric = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    ["budgetP75", "captured", "samples"],
    `${label}: B6`,
  );
  positiveD12RawValue(metric.budgetP75, `${label}: B6 budgetP75`, failures);
  if (metric.captured !== true) failures.push(`${label}: B6 captured must be true`);
  failures.push(...evaluateD12Samples(metric.samples, perfRuns, `${label}: B6`));
  const samples = Array.isArray(metric.samples) ? [...metric.samples] : [];
  return {
    failures,
    normalized: { samples, p75: percentile(samples, 75) },
    raw: { budgetP75: metric.budgetP75, captured: metric.captured, samples },
  };
}

function deriveD12RawB11(value, label) {
  const metric = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    ["baselineBytes", "cycles", "peakBytes", "residualBytes", "supported"],
    `${label}: B11`,
  );
  if (metric.supported !== true) failures.push(`${label}: B11 supported must be true`);
  const normalized = {
    baselineBytes: metric.baselineBytes,
    peakBytes: metric.peakBytes,
    residualBytes: metric.residualBytes,
    cycles: metric.cycles,
  };
  failures.push(...evaluateD12B11(normalized, `${label}: B11`));
  if (
    Number.isInteger(metric.peakBytes) &&
    Number.isInteger(metric.baselineBytes) &&
    metric.peakBytes < metric.baselineBytes
  ) {
    failures.push(`${label}: B11 peakBytes is below baselineBytes`);
  }
  return { failures, normalized };
}

function deriveD12RawWorker(value, label) {
  const capture = d12Record(value);
  const keys = [
    "editorWorkerLoaded",
    "languageWorkerLoaded",
    "totalWorkerRequests",
    "tsLanguageWorkerLoaded",
  ];
  const failures = evaluateD12ExactKeys(value, keys, `${label}: workerLoadCapture`);
  if (!Number.isInteger(capture.totalWorkerRequests) || capture.totalWorkerRequests < 0) {
    failures.push(`${label}: totalWorkerRequests is invalid`);
  }
  for (const key of keys.filter((key) => key !== "totalWorkerRequests")) {
    if (typeof capture[key] !== "boolean") failures.push(`${label}: ${key} is invalid`);
  }
  return { failures, raw: { ...capture } };
}

function deriveD12RawProvenance(value, warmUp, label) {
  const provenance = d12Record(value);
  const failures = [...evaluateD12RawProvenance(value, label), ...evaluateD12WarmUp(warmUp, label)];
  return {
    failures,
    normalized: {
      ...provenance,
      hardware: { ...d12Record(provenance.hardware) },
      warmUp: { ...d12Record(warmUp) },
    },
  };
}

function evaluateD12CommonRawHeader(rawValue, raw, revision, label) {
  const revisionField = revision === "baseline" ? "d12BaselineMeasuredWork" : "b5IdleDebugSession";
  const keys = [
    "b11Memory",
    "b4ColdStartMs",
    "b5KeystrokeMs",
    "b6InteractionMs",
    "commit",
    "kind",
    "measuredAtIso",
    "measurementHarnessSha256",
    "provenance",
    "revision",
    "schemaVersion",
    "sourceTreeSha256",
    "workerLoadCapture",
    revisionField,
  ];
  const failures = evaluateD12ExactKeys(rawValue, keys, `${label}: raw artifact`);
  if (raw.schemaVersion !== "1") failures.push(`${label}: raw artifact schemaVersion must be 1`);
  if (raw.kind !== "common") failures.push(`${label}: raw artifact kind must be common`);
  if (raw.revision !== revision)
    failures.push(`${label}: raw artifact revision must be ${revision}`);
  const perfRuns = Array.isArray(raw.b4ColdStartMs?.samples) ? raw.b4ColdStartMs.samples.length : 0;
  if (perfRuns < D12_MIN_PERF_RUNS) {
    failures.push(`${label}: raw artifact requires at least 10 B4 samples`);
  }
  return { failures, perfRuns, revisionField };
}

function deriveD12CommonRawParts(raw, revision, revisionField, perfRuns, warmUp, label) {
  const b4 = deriveD12RawB4(raw.b4ColdStartMs, perfRuns, label);
  const keystroke = deriveD12RawKeystroke(raw.b5KeystrokeMs, perfRuns, label);
  const work =
    revision === "baseline"
      ? deriveD12BaselineWork(raw[revisionField], perfRuns, label)
      : deriveD12CandidateWork(raw[revisionField], perfRuns, label);
  return {
    b4,
    b6: deriveD12RawB6(raw.b6InteractionMs, perfRuns, label),
    b11: deriveD12RawB11(raw.b11Memory, label),
    keystroke,
    provenance: deriveD12RawProvenance(raw.provenance, warmUp, label),
    work,
    worker: deriveD12RawWorker(raw.workerLoadCapture, label),
  };
}

export function deriveD12CommonRawArtifact(rawValue, { bytes, label, revision, warmUp }) {
  const raw = d12Record(rawValue);
  const header = evaluateD12CommonRawHeader(rawValue, raw, revision, label);
  const parts = deriveD12CommonRawParts(
    raw,
    revision,
    header.revisionField,
    header.perfRuns,
    warmUp,
    label,
  );
  const { b4, b6, b11, keystroke, provenance, work, worker } = parts;
  const failures = [...header.failures];
  failures.push(
    ...b4.failures,
    ...keystroke.failures,
    ...work.failures,
    ...b6.failures,
    ...b11.failures,
    ...worker.failures,
    ...provenance.failures,
  );
  return {
    failures,
    metrics: {
      bytes: { ...d12Record(bytes) },
      b4: b4.normalized,
      b5IdleDebug: work.normalized,
      b6: b6.normalized,
      b11: b11.normalized,
    },
    overlay: {
      b4ColdStartMs: b4.raw,
      b5KeystrokeMs: keystroke.raw,
      b6InteractionMs: b6.raw,
      workerLoadCapture: worker.raw,
    },
    perfRuns: header.perfRuns,
    provenance: provenance.normalized,
  };
}

function deriveD12RawStoppedProjection(value, label) {
  const raw = d12Record(value);
  const keys = [
    "depth",
    "frames",
    "inlineDecorations",
    "maxLongTaskMs",
    "nodes",
    "samples",
    "scopes",
    "variables",
  ];
  const failures = evaluateD12ExactKeys(value, keys, `${label}: stoppedProjection`);
  const samples = Array.isArray(raw.samples) ? [...raw.samples] : [];
  const normalized = { ...raw, samples, p75: computeD12NearestRankPercentile(samples, 75) };
  failures.push(...evaluateD12StoppedProjection(normalized, label));
  return { failures, normalized };
}

function deriveD12RawOutputFlood(value, label) {
  const raw = d12Record(value);
  const keys = [
    "adapterOutputBytes",
    "limitMarkers",
    "maxLongTaskMs",
    "renderedRows",
    "renderedRowsCeiling",
    "residualHeapBytes",
    "retainedBytes",
    "retainedEntries",
    "stopSamples",
  ];
  const failures = evaluateD12ExactKeys(value, keys, `${label}: outputFlood`);
  const stopSamples = Array.isArray(raw.stopSamples) ? [...raw.stopSamples] : [];
  const normalized = {
    ...raw,
    stopP75: computeD12NearestRankPercentile(stopSamples, 75),
    stopSamples,
  };
  failures.push(...evaluateD12OutputFlood(normalized, label));
  return { failures, normalized };
}

export function deriveD12CapRawArtifact(rawValue, { label }) {
  const raw = d12Record(rawValue);
  const keys = [
    "commit",
    "kind",
    "measuredAtIso",
    "measurementHarnessSha256",
    "outputFlood",
    "provenance",
    "revision",
    "schemaVersion",
    "sourceTreeSha256",
    "stoppedProjection",
  ];
  const failures = evaluateD12ExactKeys(rawValue, keys, `${label}: raw artifact`);
  if (raw.schemaVersion !== "1") failures.push(`${label}: raw artifact schemaVersion must be 1`);
  if (raw.kind !== "cap") failures.push(`${label}: raw artifact kind must be cap`);
  if (raw.revision !== "candidate")
    failures.push(`${label}: raw artifact revision must be candidate`);
  const stopped = deriveD12RawStoppedProjection(raw.stoppedProjection, label);
  const output = deriveD12RawOutputFlood(raw.outputFlood, label);
  failures.push(
    ...evaluateD12RawProvenance(raw.provenance, label),
    ...stopped.failures,
    ...output.failures,
  );
  return {
    failures,
    outputFlood: output.normalized,
    provenance: raw.provenance,
    stoppedProjection: stopped.normalized,
  };
}

function evaluateD12ArtifactSha256(artifact, recordedSha256, label) {
  if (artifact !== undefined && recordedSha256 !== computeD12ArtifactSha256(artifact)) {
    return [`${label}: artifactSha256 does not match canonical committed raw artifact`];
  }
  return [];
}

function evaluateD12RawIdentity(raw, normalized, label, subject) {
  const failures = [];
  if (raw.commit !== normalized.commit || raw.measuredAtIso !== normalized.measuredAtIso) {
    failures.push(
      `${label}: committed raw ${subject} identity does not match normalized measurement`,
    );
  }
  if (
    raw.sourceTreeSha256 !== normalized.sourceTreeSha256 ||
    raw.measurementHarnessSha256 !== normalized.measurementHarnessSha256
  ) {
    failures.push(
      `${label}: committed raw ${subject} source/toolchain binding does not match normalized measurement`,
    );
  }
  return failures;
}

function d12CommonDerivationOptions(measurement, revision, comparison, label) {
  return {
    bytes: comparison.bundles?.[revision]?.bytes ?? measurement.metrics?.bytes,
    label,
    revision,
    warmUp: comparison.warmUp ?? measurement.provenance?.warmUp,
  };
}

function evaluateD12CommonNormalization(derived, measurement, label) {
  const failures = [];
  const normalizedMetrics = { ...d12Record(measurement.metrics) };
  delete normalizedMetrics.capScenarios;
  if (!isDeepStrictEqual(derived.metrics, normalizedMetrics)) {
    failures.push(
      `${label}: normalized common measurement does not match committed raw derivation`,
    );
  }
  if (!isDeepStrictEqual(derived.provenance, measurement.provenance)) {
    failures.push(`${label}: normalized provenance does not match committed raw derivation`);
  }
  return failures;
}

function evaluateD12CommonRawInput(measurement, revision, comparison, label) {
  const envelope = evaluateD12RawInputEnvelope(measurement.rawInput, label);
  const artifact = envelope.artifact;
  const derived = deriveD12CommonRawArtifact(
    artifact,
    d12CommonDerivationOptions(measurement, revision, comparison, label),
  );
  const raw = d12Record(artifact);
  return [
    ...envelope.failures,
    ...derived.failures,
    ...evaluateD12ArtifactSha256(artifact, measurement.artifactSha256, label),
    ...evaluateD12RawIdentity(raw, measurement, label, "common"),
    ...evaluateD12CommonNormalization(derived, measurement, label),
  ];
}

function expectedD12CapProvenance(derived, measurement) {
  return {
    ...d12Record(derived.provenance),
    hardware: { ...d12Record(derived.provenance?.hardware) },
    warmUp: { ...d12Record(measurement.provenance?.warmUp) },
  };
}

function evaluateD12CapNormalization(derived, cap, measurement, label) {
  const failures = [];
  if (
    !isDeepStrictEqual(derived.stoppedProjection, cap.stoppedProjection) ||
    !isDeepStrictEqual(derived.outputFlood, cap.outputFlood)
  ) {
    failures.push(`${label}: normalized cap measurement does not match committed raw derivation`);
  }
  if (!isDeepStrictEqual(expectedD12CapProvenance(derived, measurement), measurement.provenance)) {
    failures.push(`${label}: cap provenance does not match committed raw derivation`);
  }
  return failures;
}

function evaluateD12CapRawInput(cap, measurement, label) {
  const envelope = evaluateD12RawInputEnvelope(cap.rawInput, label);
  const artifact = envelope.artifact;
  const derived = deriveD12CapRawArtifact(artifact, { label });
  const raw = d12Record(artifact);
  return [
    ...envelope.failures,
    ...derived.failures,
    ...evaluateD12ArtifactSha256(artifact, cap.artifactSha256, label),
    ...evaluateD12RawIdentity(raw, cap, label, "cap"),
    ...evaluateD12CapNormalization(derived, cap, measurement, label),
  ];
}

function evaluateD12ClosedInterval(started, completed, label) {
  return started !== undefined && completed !== undefined && completed <= started
    ? [`${label}: completedAtIso must be after startedAtIso`]
    : [];
}

function evaluateD12ContainedTimestamp(value, started, completed, label) {
  return value !== undefined &&
    started !== undefined &&
    completed !== undefined &&
    (value < started || value > completed)
    ? [`${label} falls outside its execution interval`]
    : [];
}

function evaluateD12CapStart(started, commonCompleted, label) {
  return started !== undefined && Number.isFinite(commonCompleted) && started < commonCompleted
    ? [`${label}: startedAtIso precedes the common measurement completion`]
    : [];
}

function evaluateD12CapCompletion(cap, measurement, label) {
  return cap.completedAtIso === measurement.completedAtIso
    ? []
    : [`${label}: completedAtIso does not close the candidate interval`];
}

function evaluateD12CapBinding(cap, measurement, label) {
  const failures = [];
  failures.push(
    ...evaluateD12Digest(cap.artifactSha256, `${label}: artifactSha256`),
    ...evaluateD12Digest(cap.sourceTreeSha256, `${label}: sourceTreeSha256`),
    ...evaluateD12Digest(cap.measurementHarnessSha256, `${label}: measurementHarnessSha256`),
  );
  if (cap.commit !== measurement.commit) failures.push(`${label}: commit does not match candidate`);
  if (cap.sequence !== measurement.sequence)
    failures.push(`${label}: sequence does not match candidate`);
  if (cap.sourceTreeSha256 !== measurement.sourceTreeSha256) {
    failures.push(`${label}: sourceTreeSha256 does not match candidate`);
  }
  if (cap.measurementHarnessSha256 !== measurement.measurementHarnessSha256) {
    failures.push(`${label}: measurementHarnessSha256 does not match candidate`);
  }
  return failures;
}

function evaluateD12CapInterval(cap, measurement, label) {
  const failures = [];
  const started = parseD12Timestamp(cap.startedAtIso, `${label}: startedAtIso`, failures);
  const completed = parseD12Timestamp(cap.completedAtIso, `${label}: completedAtIso`, failures);
  const measured = parseD12Timestamp(cap.measuredAtIso, `${label}: measuredAtIso`, failures);
  const commonCompleted = Date.parse(measurement.commonCompletedAtIso);
  failures.push(
    ...evaluateD12ClosedInterval(started, completed, label),
    ...evaluateD12CapStart(started, commonCompleted, label),
    ...evaluateD12CapCompletion(cap, measurement, label),
    ...evaluateD12ContainedTimestamp(measured, started, completed, `${label}: measuredAtIso`),
  );
  return failures;
}

function evaluateD12CapScenarios(cap, measurement, label) {
  if (typeof cap !== "object" || cap === null) return [`${label}: capScenarios is missing`];
  return [
    ...evaluateD12ExactKeys(
      cap,
      [
        "artifactSha256",
        "commit",
        "completedAtIso",
        "measuredAtIso",
        "measurementHarnessSha256",
        "outputFlood",
        "rawInput",
        "sequence",
        "sourceTreeSha256",
        "startedAtIso",
        "stoppedProjection",
      ],
      `${label}: capScenarios`,
    ),
    ...evaluateD12CapBinding(cap, measurement, label),
    ...evaluateD12CapInterval(cap, measurement, label),
    ...evaluateD12StoppedProjection(cap.stoppedProjection, label),
    ...evaluateD12OutputFlood(cap.outputFlood, label),
  ];
}

function evaluateD12Metrics(metrics, perfRuns, revision, label) {
  if (typeof metrics !== "object" || metrics === null) return [`${label}: metrics are missing`];
  const keys = ["b11", "b4", "b5IdleDebug", "b6", "bytes"];
  if (revision === "candidate") keys.push("capScenarios");
  return [
    ...evaluateD12ExactKeys(metrics, keys, `${label}: metrics`),
    ...evaluateD12Bytes(metrics.bytes, `${label} bytes`),
    ...evaluateD12B4(metrics.b4, perfRuns, `${label} B4`),
    ...evaluateD12B5(metrics.b5IdleDebug, perfRuns, `${label} B5 idle-debug`),
    ...evaluateD12Percentile(metrics.b6, perfRuns, `${label} B6`, "p75", 75),
    ...evaluateD12B11(metrics.b11, label),
  ];
}

function evaluateD12CandidateRuntime(measurement, label) {
  const b5 = measurement.metrics?.b5IdleDebug;
  const failures = [];
  if (b5?.traceCaptured !== true) failures.push(`${label}: idle-debug trace was not captured`);
  if (b5?.outputAcceptedBytes !== 0) failures.push(`${label}: idle-debug accepted visible output`);
  if (b5?.sessionStatus !== "paused" && b5?.sessionStatus !== "running") {
    failures.push(`${label}: idle-debug session was neither paused nor running`);
  }
  return failures;
}

function evaluateD12Scenario(measurement, revision, label) {
  const expected = revision === "baseline" ? "baseline-editor" : "idle-debug-session";
  const failures = [];
  if (measurement.scenario !== expected) failures.push(`${label}: scenario must be ${expected}`);
  if (revision === "candidate") failures.push(...evaluateD12CandidateRuntime(measurement, label));
  return failures;
}

function evaluateD12CommonCompletion(started, commonCompleted, completed, label) {
  return started !== undefined &&
    commonCompleted !== undefined &&
    completed !== undefined &&
    (commonCompleted <= started || commonCompleted > completed)
    ? [`${label}: commonCompletedAtIso falls outside the run interval`]
    : [];
}

function evaluateD12BaselineCompletion(measurement, revision, label) {
  return revision === "baseline" && measurement.commonCompletedAtIso !== measurement.completedAtIso
    ? [`${label}: baseline contains unbound post-common execution`]
    : [];
}

function evaluateD12MeasurementInterval(measurement, revision, label) {
  const failures = [];
  const started = parseD12Timestamp(measurement.startedAtIso, `${label}: startedAtIso`, failures);
  const commonCompleted = parseD12Timestamp(
    measurement.commonCompletedAtIso,
    `${label}: commonCompletedAtIso`,
    failures,
  );
  const completed = parseD12Timestamp(
    measurement.completedAtIso,
    `${label}: completedAtIso`,
    failures,
  );
  const measured = parseD12Timestamp(
    measurement.measuredAtIso,
    `${label}: measuredAtIso`,
    failures,
  );
  failures.push(
    ...evaluateD12CommonCompletion(started, commonCompleted, completed, label),
    ...evaluateD12ClosedInterval(started, completed, label),
    ...evaluateD12ContainedTimestamp(measured, started, commonCompleted, `${label}: measuredAtIso`),
    ...evaluateD12BaselineCompletion(measurement, revision, label),
  );
  return failures;
}

function evaluateD12MeasurementBinding(measurement, revision, label) {
  const failures = [
    ...evaluateD12Digest(measurement.artifactSha256, `${label}: artifactSha256`),
    ...evaluateD12Digest(measurement.sourceTreeSha256, `${label}: sourceTreeSha256`),
    ...evaluateD12Digest(
      measurement.measurementHarnessSha256,
      `${label}: measurementHarnessSha256`,
    ),
    ...evaluateD12MeasurementInterval(measurement, revision, label),
  ];
  if (!isPositiveInteger(measurement.sequence)) {
    failures.push(`${label}: sequence is not a positive integer`);
  }
  if (revision === "candidate") {
    failures.push(
      ...evaluateD12CapScenarios(measurement.metrics?.capScenarios, measurement, label),
    );
  }
  return failures;
}

function evaluateD12Measurement(measurement, expectedCommit, revision, label) {
  if (typeof measurement !== "object" || measurement === null) {
    return [`${label}: complete revision measurement is missing`];
  }
  const failures = evaluateD12ExactKeys(
    measurement,
    [
      "artifactSha256",
      "commit",
      "commonCompletedAtIso",
      "complete",
      "completedAtIso",
      "measuredAtIso",
      "measurementHarnessSha256",
      "metrics",
      "perfRuns",
      "provenance",
      "rawInput",
      "scenario",
      "sequence",
      "sourceTreeSha256",
      "startedAtIso",
    ],
    label,
  );
  if (measurement.complete !== true) failures.push(`${label}: measurement is not complete`);
  if (measurement.commit !== expectedCommit) {
    failures.push(`${label}: commit ${String(measurement.commit)} != expected ${expectedCommit}`);
  }
  if (!isPositiveInteger(measurement.perfRuns) || measurement.perfRuns < D12_MIN_PERF_RUNS) {
    failures.push(`${label}: KEIKO_PERF_RUNS must be at least ${D12_MIN_PERF_RUNS}`);
  }
  if (
    typeof measurement.measuredAtIso !== "string" ||
    Number.isNaN(Date.parse(measurement.measuredAtIso))
  ) {
    failures.push(`${label}: measuredAtIso is not parseable`);
  }
  failures.push(
    ...evaluateD12Provenance(measurement.provenance, label),
    ...evaluateD12MeasurementBinding(measurement, revision, label),
  );
  if (isPositiveInteger(measurement.perfRuns)) {
    failures.push(
      ...evaluateD12Metrics(measurement.metrics, measurement.perfRuns, revision, label),
    );
  }
  failures.push(...evaluateD12Scenario(measurement, revision, label));
  return failures;
}

function isValidD12Order(order) {
  return (
    Array.isArray(order) &&
    order.length === 2 &&
    new Set(order).size === 2 &&
    order.includes("baseline") &&
    order.includes("candidate")
  );
}

function evaluateD12Order(repetitions) {
  const failures = [];
  let priorFirst;
  for (const [index, repetition] of repetitions.entries()) {
    const label = `d12 repetition ${index + 1}`;
    const order = repetition?.order;
    const valid = isValidD12Order(order);
    if (!valid) failures.push(`${label}: order must contain baseline and candidate exactly once`);
    if (valid && priorFirst === order[0])
      failures.push(`${label}: execution order did not alternate`);
    if (valid) priorFirst = order[0];
  }
  return failures;
}

function evaluateD12Repetitions(comparison) {
  const repetitions = comparison.repetitions;
  if (!Array.isArray(repetitions) || repetitions.length < D12_MIN_REPETITIONS) {
    return [`d12 comparison requires at least ${D12_MIN_REPETITIONS} complete paired repetitions`];
  }
  const failures = evaluateD12Order(repetitions);
  for (const [index, repetition] of repetitions.entries()) {
    const prefix = `d12 repetition ${index + 1}`;
    failures.push(
      ...evaluateD12ExactKeys(repetition, ["baseline", "candidate", "order"], prefix),
      ...evaluateD12Measurement(
        repetition?.baseline,
        comparison.baselineCommit,
        "baseline",
        `${prefix} baseline`,
      ),
      ...evaluateD12Measurement(
        repetition?.candidate,
        comparison.candidateCommit,
        "candidate",
        `${prefix} candidate`,
      ),
    );
  }
  return failures;
}

function d12ProvenanceWithoutLockfile(provenance) {
  const shared = { ...d12Record(provenance) };
  delete shared.lockfileSha256;
  return shared;
}

function evaluateD12RevisionProvenance(repetitions, revision, reference) {
  const failures = [];
  for (const [index, repetition] of repetitions.entries()) {
    if (!isDeepStrictEqual(repetition?.[revision]?.provenance, reference)) {
      failures.push(
        `d12 repetition ${index + 1} ${revision}: provenance does not match its first run`,
      );
    }
  }
  return failures;
}

function evaluateD12MatchingProvenance(repetitions) {
  const references = {
    baseline: repetitions[0]?.baseline?.provenance,
    candidate: repetitions[0]?.candidate?.provenance,
  };
  if (typeof references.baseline !== "object" || references.baseline === null) return [];
  const failures = [
    ...evaluateD12RevisionProvenance(repetitions, "baseline", references.baseline),
    ...evaluateD12RevisionProvenance(repetitions, "candidate", references.candidate),
  ];
  if (
    !isDeepStrictEqual(
      d12ProvenanceWithoutLockfile(references.baseline),
      d12ProvenanceWithoutLockfile(references.candidate),
    )
  ) {
    failures.push("d12 baseline and candidate provenance differs outside lockfileSha256");
  }
  return failures;
}

function orderedD12Measurements(repetitions) {
  return repetitions.flatMap((repetition) =>
    repetition.order.map((revision) => ({ measurement: repetition[revision], revision })),
  );
}

function evaluateD12ArtifactUniqueness(repetitions) {
  const digests = [];
  for (const repetition of repetitions) {
    digests.push(
      repetition.baseline.artifactSha256,
      repetition.candidate.artifactSha256,
      repetition.candidate.metrics.capScenarios.artifactSha256,
    );
  }
  return new Set(digests).size === digests.length
    ? []
    : ["d12 artifactSha256 bindings must be unique across all common and cap repetitions"];
}

function evaluateD12SequenceAndOrder(repetitions) {
  const failures = [];
  let previousCompleted = -Infinity;
  for (const [index, entry] of orderedD12Measurements(repetitions).entries()) {
    const expectedSequence = index + 1;
    if (entry.measurement.sequence !== expectedSequence) {
      failures.push(
        `d12 ${entry.revision} sequence ${String(entry.measurement.sequence)} != actual order ${expectedSequence}`,
      );
    }
    const started = Date.parse(entry.measurement.startedAtIso);
    if (started < previousCompleted) {
      failures.push(`d12 sequence ${expectedSequence} overlaps or precedes the prior run`);
    }
    previousCompleted = Date.parse(entry.measurement.completedAtIso);
  }
  return failures;
}

function evaluateD12DigestBindings(evidence, comparison) {
  const failures = [];
  const baselineSource = comparison.baselineSourceTreeSha256;
  for (const [index, repetition] of comparison.repetitions.entries()) {
    if (repetition.baseline.sourceTreeSha256 !== baselineSource) {
      failures.push(`d12 repetition ${index + 1} baseline: sourceTreeSha256 differs`);
    }
    for (const revision of ["baseline", "candidate"]) {
      const measurement = repetition[revision];
      if (measurement.measurementHarnessSha256 !== comparison.measurementHarnessSha256) {
        failures.push(
          `d12 repetition ${index + 1} ${revision}: measurementHarnessSha256 does not match comparison`,
        );
      }
    }
    const candidate = repetition.candidate;
    if (candidate.sourceTreeSha256 !== evidence.sourceTreeSha256) {
      failures.push(
        `d12 repetition ${index + 1} candidate: sourceTreeSha256 does not match top-level evidence`,
      );
    }
    const cap = candidate.metrics.capScenarios;
    if (cap.measurementHarnessSha256 !== comparison.measurementHarnessSha256) {
      failures.push(
        `d12 repetition ${index + 1} candidate cap: measurementHarnessSha256 does not match comparison`,
      );
    }
    if (cap.sourceTreeSha256 !== evidence.sourceTreeSha256) {
      failures.push(
        `d12 repetition ${index + 1} candidate cap: sourceTreeSha256 does not match top-level evidence`,
      );
    }
  }
  return failures;
}

function evaluateD12ExecutionBindings(evidence, comparison) {
  return [
    ...evaluateD12DigestBindings(evidence, comparison),
    ...evaluateD12SequenceAndOrder(comparison.repetitions),
    ...evaluateD12ArtifactUniqueness(comparison.repetitions),
  ];
}

function evaluateD12RawBindings(comparison) {
  const failures = [];
  for (const [index, repetition] of comparison.repetitions.entries()) {
    for (const revision of ["baseline", "candidate"]) {
      const measurement = repetition[revision];
      const label = `d12 repetition ${index + 1} ${revision}`;
      failures.push(...evaluateD12CommonRawInput(measurement, revision, comparison, label));
      if (revision === "candidate") {
        failures.push(
          ...evaluateD12CapRawInput(measurement.metrics.capScenarios, measurement, `${label} cap`),
        );
      }
    }
  }
  return failures;
}

function summarizeD12Measurement(measurement) {
  const { metrics } = measurement;
  return {
    b1Bytes: metrics.bytes.b1,
    b2Bytes: metrics.bytes.b2,
    b3Bytes: metrics.bytes.b3,
    b10Bytes: metrics.bytes.b10,
    b4P50Ms: metrics.b4.p50,
    b4P95Ms: metrics.b4.p95,
    b5IdleDebugP95Ms: metrics.b5IdleDebug.p95,
    b5IdleDebugLongTaskCount: metrics.b5IdleDebug.longTaskCount,
    b5IdleDebugMaxLongTaskMs: metrics.b5IdleDebug.maxLongTaskMs,
    b6P75Ms: metrics.b6.p75,
    b11PeakBytes: metrics.b11.peakBytes,
    b11ResidualBytes: metrics.b11.residualBytes,
  };
}

const D12_AGGREGATE_FIELDS = [
  "b1Bytes",
  "b2Bytes",
  "b3Bytes",
  "b10Bytes",
  "b4P50Ms",
  "b4P95Ms",
  "b5IdleDebugP95Ms",
  "b6P75Ms",
  "b11PeakBytes",
  "b11ResidualBytes",
];

function computeD12Aggregate(repetitions, revision) {
  const summaries = repetitions.map((repetition) => summarizeD12Measurement(repetition[revision]));
  const aggregate = {};
  for (const field of D12_AGGREGATE_FIELDS) {
    aggregate[field] = median(summaries.map((summary) => summary[field]));
  }
  aggregate.b5IdleDebugLongTaskCount = summaries.reduce(
    (total, summary) => total + summary.b5IdleDebugLongTaskCount,
    0,
  );
  aggregate.b5IdleDebugMaxLongTaskMs = Math.max(
    ...summaries.map((summary) => summary.b5IdleDebugMaxLongTaskMs),
  );
  return aggregate;
}

function evaluateRecordedFields(recorded, expected, label) {
  if (typeof recorded !== "object" || recorded === null) return [`${label} is missing`];
  const failures = [];
  for (const [field, value] of Object.entries(expected)) {
    if (recorded[field] !== value) {
      failures.push(`${label} ${field} ${String(recorded[field])} != measured ${value}`);
    }
  }
  return failures;
}

function evaluateRecordedValues(recorded, expected, label) {
  return [
    ...evaluateD12ExactKeys(recorded, Object.keys(expected), label),
    ...evaluateRecordedFields(recorded, expected, label),
  ];
}

function computeD12Deltas(baseline, candidate) {
  const deltas = {};
  for (const field of Object.keys(baseline)) deltas[field] = candidate[field] - baseline[field];
  return deltas;
}

function evaluateD12Regression(candidate, baseline, field, floor, label) {
  const delta = candidate[field] - baseline[field];
  const allowed = Math.max(floor, baseline[field] * 0.1);
  return delta > allowed
    ? [performanceBudgetFailure(`d12 ${label} regression ${delta}ms > allowed ${allowed}ms`)]
    : [];
}

function evaluateD12Thresholds(baseline, candidate) {
  const failures = [
    ...evaluateD12Regression(candidate, baseline, "b4P50Ms", 100, "B4 p50"),
    ...evaluateD12Regression(candidate, baseline, "b4P95Ms", 100, "B4 p95"),
    ...evaluateD12Regression(candidate, baseline, "b6P75Ms", 10, "B6 p75"),
  ];
  if (candidate.b6P75Ms > 200) {
    failures.push(performanceBudgetFailure(`d12 B6 p75 ${candidate.b6P75Ms}ms > budget 200ms`));
  }
  if (candidate.b5IdleDebugP95Ms >= 50) {
    failures.push(
      performanceBudgetFailure(
        `d12 B5 idle-debug p95 ${candidate.b5IdleDebugP95Ms}ms >= budget 50ms`,
      ),
    );
  }
  if (candidate.b5IdleDebugLongTaskCount !== 0 || candidate.b5IdleDebugMaxLongTaskMs !== 0) {
    failures.push("d12 B5 idle-debug candidate added one or more long tasks");
  }
  for (const [budget, ceiling] of Object.entries(D12_BYTE_BUDGETS)) {
    const field = `${budget}Bytes`;
    if (candidate[field] > ceiling) {
      failures.push(
        `d12 ${budget.toUpperCase()} ${candidate[field]} bytes > budget ${ceiling} bytes`,
      );
    }
  }
  return failures;
}

function evaluateD12CandidateAlignment(evidence, candidate) {
  const expected = {
    b4P50Ms: evidence.b4ColdStartMs?.p50,
    b4P95Ms: evidence.b4ColdStartMs?.p95,
    b5IdleDebugP95Ms: evidence.b5IdleDebugSession?.p95,
    b5IdleDebugLongTaskCount: evidence.b5IdleDebugSession?.longTaskCount,
    b5IdleDebugMaxLongTaskMs: evidence.b5IdleDebugSession?.maxLongTaskMs,
    b6P75Ms: evidence.b6InteractionMs?.p75,
    b11PeakBytes: evidence.b11Memory?.peakBytes,
    b11ResidualBytes: evidence.b11Memory?.residualBytes,
  };
  return evaluateRecordedFields(candidate, expected, "d12 candidate aggregate alignment");
}

function consistentD12RawValue(values, label, failures) {
  const reference = values[0];
  if (values.some((value) => !isDeepStrictEqual(value, reference))) {
    failures.push(`d12 candidate committed raw ${label} differs across repetitions`);
  }
  return reference;
}

function latestD12RawTimestamp(measurements) {
  return measurements.reduce(
    (latest, measurement) =>
      Date.parse(measurement.measuredAtIso) > Date.parse(latest)
        ? measurement.measuredAtIso
        : latest,
    measurements[0].measuredAtIso,
  );
}

function d12RawBudgets(overlays, failures) {
  const consistent = (read, label) =>
    consistentD12RawValue(
      overlays.map((overlay) => read(overlay)),
      label,
      failures,
    );
  return {
    b4P50: consistent((overlay) => overlay.b4ColdStartMs.budgetP50, "B4 budgetP50"),
    b4P95: consistent((overlay) => overlay.b4ColdStartMs.budgetP95, "B4 budgetP95"),
    b5Max: consistent((overlay) => overlay.b5KeystrokeMs.budgetMax, "B5 budgetMax"),
    b6P75: consistent((overlay) => overlay.b6InteractionMs.budgetP75, "B6 budgetP75"),
  };
}

function expectedD12B5Keystroke(overlays, budgetMax) {
  return {
    budgetMax,
    captured: overlays.every((overlay) => overlay.b5KeystrokeMs.captured === true),
    longTaskCount: overlays.reduce(
      (total, overlay) => total + overlay.b5KeystrokeMs.longTaskCount,
      0,
    ),
    maxLongTaskMs: Math.max(...overlays.map((overlay) => overlay.b5KeystrokeMs.maxLongTaskMs)),
  };
}

function expectedD12WorkerCapture(overlays) {
  return {
    totalWorkerRequests: Math.max(
      ...overlays.map((overlay) => overlay.workerLoadCapture.totalWorkerRequests),
    ),
    editorWorkerLoaded: overlays.every(
      (overlay) => overlay.workerLoadCapture.editorWorkerLoaded === true,
    ),
    tsLanguageWorkerLoaded: overlays.some(
      (overlay) => overlay.workerLoadCapture.tsLanguageWorkerLoaded === true,
    ),
    languageWorkerLoaded: overlays.some(
      (overlay) => overlay.workerLoadCapture.languageWorkerLoaded === true,
    ),
  };
}

function expectedD12Memory(measurements, candidate) {
  return {
    baselineBytes: median(measurements.map((measurement) => measurement.metrics.b11.baselineBytes)),
    peakBytes: candidate.b11PeakBytes,
    residualBytes: candidate.b11ResidualBytes,
    cycles: median(measurements.map((measurement) => measurement.metrics.b11.cycles)),
    supported: true,
  };
}

function expectedD12IdleDebug(measurements, candidate) {
  const representative = measurements.find(
    (measurement) => measurement.metrics.b5IdleDebug.p95 === candidate.b5IdleDebugP95Ms,
  );
  return {
    ...representative.metrics.b5IdleDebug,
    p95: candidate.b5IdleDebugP95Ms,
    longTaskCount: candidate.b5IdleDebugLongTaskCount,
    maxLongTaskMs: candidate.b5IdleDebugMaxLongTaskMs,
  };
}

function expectedD12RawOverlay(comparison, candidate) {
  const failures = [];
  const measurements = comparison.repetitions.map((repetition) => repetition.candidate);
  const overlays = measurements.map(
    (measurement, index) =>
      deriveD12CommonRawArtifact(measurement.rawInput.artifact, {
        bytes: comparison.bundles?.candidate?.bytes ?? measurement.metrics.bytes,
        label: `d12 candidate raw overlay ${index + 1}`,
        revision: "candidate",
        warmUp: comparison.warmUp ?? measurement.provenance.warmUp,
      }).overlay,
  );
  const budgets = d12RawBudgets(overlays, failures);
  return {
    expected: {
      measuredAtIso: latestD12RawTimestamp(measurements),
      b4ColdStartMs: {
        budgetP50: budgets.b4P50,
        budgetP95: budgets.b4P95,
        p50: candidate.b4P50Ms,
        p95: candidate.b4P95Ms,
      },
      b5KeystrokeMs: expectedD12B5Keystroke(overlays, budgets.b5Max),
      b5IdleDebugSession: expectedD12IdleDebug(measurements, candidate),
      b6InteractionMs: { budgetP75: budgets.b6P75, captured: true, p75: candidate.b6P75Ms },
      b11Memory: expectedD12Memory(measurements, candidate),
      workerLoadCapture: expectedD12WorkerCapture(overlays),
    },
    failures,
  };
}

function evaluateD12CommittedRawAlignment(evidence, comparison, candidate) {
  const { expected, failures } = expectedD12RawOverlay(comparison, candidate);
  for (const [field, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(evidence[field], value)) {
      failures.push(`d12 top-level ${field} does not match committed raw inputs`);
    }
  }
  return failures;
}

function evaluateD12ProvisioningCommand(provisioning, expectedKeys, label) {
  if (typeof provisioning !== "object" || provisioning === null) {
    return [`${label} is missing`];
  }
  const failures = evaluateD12ExactKeys(provisioning, expectedKeys, label);
  if (provisioning.command !== "npm") {
    failures.push(`${label} command must be npm`);
  }
  if (!isDeepStrictEqual(provisioning.args, ["ci", "--ignore-scripts"])) {
    failures.push(`${label} arguments must equal npm ci --ignore-scripts`);
  }
  return failures;
}

function evaluateD12BundleDependencyProvisioning(provisioning, label) {
  const failures = evaluateD12ProvisioningCommand(
    provisioning,
    ["args", "command", "lockfileSha256"],
    label,
  );
  failures.push(...evaluateD12Digest(provisioning?.lockfileSha256, `${label} lockfileSha256`));
  return failures;
}

function evaluateD12DependencyProvisioning(comparison) {
  const provisioning = comparison.dependencyProvisioning;
  const failures = evaluateD12ProvisioningCommand(
    provisioning,
    ["args", "command", "lockfileSha256ByRevision"],
    "d12 dependency provisioning",
  );
  const digests = provisioning?.lockfileSha256ByRevision;
  failures.push(
    ...evaluateD12ExactKeys(
      digests,
      ["baseline", "candidate"],
      "d12 dependency provisioning lockfileSha256ByRevision",
    ),
  );
  for (const revision of ["baseline", "candidate"]) {
    failures.push(
      ...evaluateD12Digest(
        digests?.[revision],
        `d12 dependency provisioning ${revision} lockfileSha256`,
      ),
    );
  }
  return failures;
}

function deriveD12BundleB1(value, label) {
  const record = d12Record(value);
  const failures = evaluateD12ExactKeys(value, ["monacoMarkersInFirstLoad", "ok"], `${label} B1`);
  if (record.ok !== true || record.monacoMarkersInFirstLoad !== 0) {
    failures.push(`${label} B1 must prove zero first-load editor markers`);
  }
  return { bytes: 0, failures };
}

function deriveD12BundleByteMetric(value, byteField, label) {
  const record = d12Record(value);
  const failures = evaluateD12ExactKeys(value, [byteField, "ok"], label);
  const bytes = record[byteField];
  if (record.ok !== true) failures.push(`${label} must record ok=true`);
  if (!Number.isInteger(bytes) || bytes < 0) {
    failures.push(`${label} byte measurement must be a non-negative integer`);
  }
  return { bytes, failures };
}

function deriveD12BundleB10(value, label) {
  const record = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    ["ceilingBytes", "fileCount", "ok", "totalGzipBytes"],
    `${label} B10`,
  );
  if (record.ok !== true) failures.push(`${label} B10 must record ok=true`);
  if (!isPositiveInteger(record.fileCount)) failures.push(`${label} B10 fileCount is invalid`);
  if (!isPositiveInteger(record.ceilingBytes))
    failures.push(`${label} B10 ceilingBytes is invalid`);
  if (!Number.isInteger(record.totalGzipBytes) || record.totalGzipBytes < 0) {
    failures.push(`${label} B10 totalGzipBytes is invalid`);
  } else if (record.totalGzipBytes > record.ceilingBytes) {
    failures.push(`${label} B10 exceeds its recorded ceiling`);
  }
  return { bytes: record.totalGzipBytes, failures };
}

function deriveD12BundleBytes(bundle, label) {
  const b1 = deriveD12BundleB1(bundle.b1, label);
  const b2 = deriveD12BundleByteMetric(bundle.b2, "shipsTotalBytes", `${label} B2`);
  const b3 = deriveD12BundleByteMetric(bundle.b3, "largestWorkerBytes", `${label} B3`);
  const b10 = deriveD12BundleB10(bundle.b10, label);
  return {
    bytes: { b1: b1.bytes, b2: b2.bytes, b3: b3.bytes, b10: b10.bytes },
    failures: [...b1.failures, ...b2.failures, ...b3.failures, ...b10.failures],
  };
}

function evaluateD12BundleRuntime(value, label) {
  const runtime = d12Record(value);
  const failures = evaluateD12ExactKeys(
    value,
    ["architecture", "nodeVersion", "npmVersion", "osRelease", "platform", "zlibVersion"],
    `${label} runtime`,
  );
  if (runtime.platform !== "linux") failures.push(`${label} runtime platform must be linux`);
  if (runtime.nodeVersion !== "24.18.0") {
    failures.push(`${label} runtime Node.js version must be 24.18.0`);
  }
  if (runtime.npmVersion !== "11.16.0") {
    failures.push(`${label} runtime npm version must be 11.16.0`);
  }
  for (const field of ["architecture", "osRelease", "zlibVersion"]) {
    if (typeof runtime[field] !== "string" || runtime[field].length === 0) {
      failures.push(`${label} runtime ${field} is missing`);
    }
  }
  return failures;
}

function d12ExpectedBundleRuntime(comparison) {
  const provenance = d12Record(comparison.repetitions?.[0]?.baseline?.provenance);
  return {
    architecture: provenance.architecture,
    nodeVersion: provenance.nodeVersion,
    npmVersion: provenance.npmVersion,
    osRelease: provenance.osRelease,
    platform: provenance.platform,
    zlibVersion: provenance.zlibVersion,
  };
}

function evaluateD12BundleDigests(record, label) {
  return [
    ...evaluateD12Digest(record.measurementSha256, `${label} measurementSha256`),
    ...evaluateD12Digest(record.sourceTreeSha256, `${label} sourceTreeSha256`),
    ...evaluateD12Digest(record.measurementHarnessSha256, `${label} measurementHarnessSha256`),
    ...evaluateD12BundleDependencyProvisioning(
      record.dependencyProvisioning,
      `${label} dependency provisioning`,
    ),
  ];
}

function d12ExpectedBundleBinding(revision, comparison) {
  const identity =
    revision === "baseline"
      ? {
          commit: D12_BASELINE_COMMIT,
          sourceTreeSha256: comparison.baselineSourceTreeSha256,
        }
      : {
          commit: comparison.candidateCommit,
          sourceTreeSha256: comparison.candidateSourceTreeSha256,
        };
  const provisioning = d12Record(comparison.dependencyProvisioning);
  const digests = d12Record(provisioning.lockfileSha256ByRevision);
  return {
    ...identity,
    dependencyProvisioning: {
      args: provisioning.args,
      command: provisioning.command,
      lockfileSha256: digests[revision],
    },
  };
}

function evaluateD12BundleIdentity(record, expected, comparison, label) {
  const failures = [];
  if (!/^[0-9a-f]{40}$/u.test(record.commit ?? "")) failures.push(`${label} commit is invalid`);
  if (record.commit !== expected.commit) failures.push(`${label} commit does not match comparison`);
  if (record.producerCommit !== comparison.candidateCommit) {
    failures.push(`${label} producer commit does not match comparison candidate`);
  }
  if (record.sourceTreeSha256 !== expected.sourceTreeSha256) {
    failures.push(`${label} source digest does not match comparison`);
  }
  if (record.measurementHarnessSha256 !== comparison.measurementHarnessSha256) {
    failures.push(`${label} toolchain digest does not match comparison`);
  }
  if (!isDeepStrictEqual(record.dependencyProvisioning, expected.dependencyProvisioning)) {
    failures.push(`${label} dependency provisioning does not match its comparison revision`);
  }
  return failures;
}

function evaluateD12BundleDerivation(record, derived, label) {
  const failures = [];
  if (!isDeepStrictEqual(record.bytes, derived.bytes)) {
    failures.push(`${label} normalized bytes do not match committed bundle measurements`);
  }
  if (record.measurementSha256 !== computeD12BundleMeasurementSha256(record)) {
    failures.push(`${label} measurementSha256 does not match committed bundle measurements`);
  }
  return failures;
}

function evaluateD12BundleBinding(bundle, revision, comparison) {
  const label = `d12 ${revision} bundle`;
  const failures = evaluateD12ExactKeys(
    bundle,
    [
      "b1",
      "b10",
      "b2",
      "b3",
      "bytes",
      "commit",
      "dependencyProvisioning",
      "measurementHarnessSha256",
      "measurementSha256",
      "producerCommit",
      "runtime",
      "sourceTreeSha256",
    ],
    label,
  );
  const record = d12Record(bundle);
  const derived = deriveD12BundleBytes(record, label);
  failures.push(
    ...derived.failures,
    ...evaluateD12Bytes(record.bytes, `${label} bytes`),
    ...evaluateD12BundleDigests(record, label),
    ...evaluateD12BundleRuntime(record.runtime, label),
    ...evaluateD12BundleIdentity(
      record,
      d12ExpectedBundleBinding(revision, comparison),
      comparison,
      label,
    ),
    ...evaluateD12BundleDerivation(record, derived, label),
  );
  if (!isDeepStrictEqual(record.runtime, d12ExpectedBundleRuntime(comparison))) {
    failures.push(`${label} runtime does not match common browser provenance`);
  }
  return failures;
}

function evaluateD12Bundles(comparison) {
  const failures = evaluateD12ExactKeys(
    comparison.bundles,
    ["baseline", "candidate"],
    "d12 bundles",
  );
  const bundles = d12Record(comparison.bundles);
  return [
    ...failures,
    ...evaluateD12BundleBinding(bundles.baseline, "baseline", comparison),
    ...evaluateD12BundleBinding(bundles.candidate, "candidate", comparison),
  ];
}

function evaluateD12DependencyBindings(comparison) {
  const expected = comparison.dependencyProvisioning.lockfileSha256ByRevision;
  const failures = [];
  for (const [index, repetition] of comparison.repetitions.entries()) {
    for (const revision of ["baseline", "candidate"]) {
      if (repetition[revision].provenance.lockfileSha256 !== expected[revision]) {
        failures.push(
          `d12 repetition ${index + 1} ${revision}: lockfileSha256 does not match dependency provisioning`,
        );
      }
    }
  }
  return failures;
}

export function evaluateD12Comparison(evidence) {
  const comparison = evidence?.d12Comparison;
  if (typeof comparison !== "object" || comparison === null) {
    return ["editor evidence missing d12Comparison"];
  }
  const failures = evaluateD12Header(evidence, comparison);
  failures.push(...evaluateD12Repetitions(comparison));
  // Stage 1 short-circuits because stage 2 reads values stage 1 proved well-formed. A budget verdict
  // proves nothing ill-formed, so it must not stop stage 2 — otherwise a slow measurement would mask
  // a genuine defect from the producer, which treats budget verdicts as advisory (ADR-0156 D5).
  if (failures.some((failure) => !isPerformanceBudgetFailure(failure))) return failures;
  return [...failures, ...evaluateCompleteD12Comparison(evidence, comparison)];
}

function evaluateD12HeaderIdentity(evidence, comparison) {
  const failures = [];
  if (comparison.schemaVersion !== "2") failures.push("d12 comparison schemaVersion must be 2");
  if (comparison.baselineCommit !== D12_BASELINE_COMMIT) {
    failures.push(`d12 baseline commit must be exactly ${D12_BASELINE_COMMIT}`);
  }
  if (
    comparison.candidateCommit !== evidence.commit ||
    !/^[0-9a-f]{40}$/u.test(comparison.candidateCommit ?? "")
  ) {
    failures.push("d12 candidate commit must be the full top-level evidence commit");
  }
  if (comparison.candidateSourceTreeSha256 !== evidence.sourceTreeSha256) {
    failures.push("d12 candidateSourceTreeSha256 must match top-level evidence");
  }
  if (comparison.aggregateRule !== D12_AGGREGATE_RULE) {
    failures.push(`d12 aggregateRule must be ${D12_AGGREGATE_RULE}`);
  }
  return failures;
}

function evaluateD12Header(evidence, comparison) {
  const failures = evaluateD12ExactKeys(
    comparison,
    [
      "aggregateRule",
      "aggregates",
      "baselineCommit",
      "baselineSourceTreeSha256",
      "bundles",
      "candidateCommit",
      "candidateSourceTreeSha256",
      "deltas",
      "dependencyProvisioning",
      "measurementHarnessSha256",
      "repetitions",
      "schemaVersion",
      "warmUp",
    ],
    "d12 comparison",
  );
  failures.push(
    ...evaluateD12HeaderIdentity(evidence, comparison),
    ...evaluateD12WarmUp(comparison.warmUp, "d12 comparison"),
    ...evaluateD12Bundles(comparison),
    ...evaluateD12Digest(
      comparison.baselineSourceTreeSha256,
      "d12 comparison baselineSourceTreeSha256",
    ),
    ...evaluateD12DependencyProvisioning(comparison),
    ...evaluateD12Digest(
      comparison.measurementHarnessSha256,
      "d12 comparison measurementHarnessSha256",
    ),
  );
  return failures;
}

function evaluateCompleteD12Comparison(evidence, comparison) {
  const baseline = computeD12Aggregate(comparison.repetitions, "baseline");
  const candidate = computeD12Aggregate(comparison.repetitions, "candidate");
  return [
    ...evaluateD12ExactKeys(comparison.aggregates, ["baseline", "candidate"], "d12 aggregates"),
    ...evaluateD12MatchingProvenance(comparison.repetitions),
    ...evaluateD12DependencyBindings(comparison),
    ...evaluateD12ExecutionBindings(evidence, comparison),
    ...evaluateD12RawBindings(comparison),
    ...evaluateRecordedValues(comparison.aggregates?.baseline, baseline, "d12 baseline aggregate"),
    ...evaluateRecordedValues(
      comparison.aggregates?.candidate,
      candidate,
      "d12 candidate aggregate",
    ),
    ...evaluateRecordedValues(
      comparison.deltas,
      computeD12Deltas(baseline, candidate),
      "d12 deltas",
    ),
    ...evaluateD12CandidateAlignment(evidence, candidate),
    ...evaluateD12CommittedRawAlignment(evidence, comparison, candidate),
    ...evaluateD12Thresholds(baseline, candidate),
  ];
}

export function evaluateEditorEvidence(evidence) {
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["editor evidence is not an object"] };
  }
  const failures = [
    ...evaluateD12FinalEvidenceEnvelope(evidence),
    ...evaluateB4ColdStart(evidence.b4ColdStartMs),
    ...evaluateB5Keystroke(evidence.b5KeystrokeMs),
    ...evaluateB5IdleDebugSession(evidence.b5IdleDebugSession),
    ...evaluateB6Interaction(evidence.b6InteractionMs),
    ...evaluateB11Memory(evidence.b11Memory),
    ...evaluateWorkerLoadCapture(evidence.workerLoadCapture),
    ...evaluateD12Comparison(evidence),
  ];
  return { passed: failures.length === 0, failures };
}

function evaluateD12FinalEvidenceEnvelope(evidence) {
  if (evidence.d12Comparison === undefined) return [];
  const failures = evaluateD12ExactKeys(
    evidence,
    [
      "b11Memory",
      "b4ColdStartMs",
      "b5IdleDebugSession",
      "b5KeystrokeMs",
      "b6InteractionMs",
      "commit",
      "d12Comparison",
      "freshnessBinding",
      "measuredAtIso",
      "sourceTreeSha256",
      "workerLoadCapture",
    ],
    "d12 final editor evidence",
  );
  if (evidence.freshnessBinding !== SOURCE_TREE_FRESHNESS_BINDING) {
    failures.push(
      `d12 final editor evidence freshnessBinding must be ${SOURCE_TREE_FRESHNESS_BINDING}`,
    );
  }
  return failures;
}

// ---- Freshness -------------------------------------------------------------

function defaultIsAncestor(sha) {
  try {
    execFileSync(resolveHostExecutable("git"), ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function evaluateDirtySubjectPaths(dirtySubjectPaths) {
  const paths = selectPerformanceSubjectPaths(dirtySubjectPaths);
  return paths.length === 0
    ? []
    : [`performance measurement subject has dirty inputs: ${paths.join(", ")}`];
}

function evaluateCurrentSourceTreeDigest(recordedDigest, computeSourceTreeSha256) {
  try {
    const currentDigest = computeSourceTreeSha256();
    if (!LOWERCASE_SHA_256.test(currentDigest)) {
      return ["current performance measurement subject did not produce a lowercase SHA-256 digest"];
    }
    return currentDigest === recordedDigest
      ? []
      : [
          `sourceTreeSha256 ${recordedDigest} != current ${currentDigest} ` +
            "(stale performance evidence)",
        ];
  } catch (error) {
    return [`could not recompute current performance measurement subject: ${String(error)}`];
  }
}

function defaultComputeMeasurementHarnessSha256() {
  return computeD12MeasurementToolchainDigest((path) =>
    execFileSync(resolveHostExecutable("git"), ["show", `HEAD:${path}`], {
      cwd: repoRoot,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

let cachedBaselineSourceTreeSha256;

function defaultComputeBaselineSourceTreeSha256() {
  cachedBaselineSourceTreeSha256 ??= computePerformanceSubjectDigestAtCommit({
    commit: D12_BASELINE_COMMIT,
    root: repoRoot,
  });
  return cachedBaselineSourceTreeSha256;
}

function evaluateCurrentD12BaselineDigest(evidence, computeBaselineSourceTreeSha256) {
  const recordedDigest = evidence.d12Comparison?.baselineSourceTreeSha256;
  if (recordedDigest === undefined) return [];
  try {
    const pinnedDigest = computeBaselineSourceTreeSha256();
    if (!LOWERCASE_SHA_256.test(pinnedDigest)) {
      return ["exact pinned baseline performance subject did not produce a lowercase SHA-256"];
    }
    return recordedDigest === pinnedDigest
      ? []
      : [
          `baselineSourceTreeSha256 ${recordedDigest} != pinned ${pinnedDigest} ` +
            "(stale or coherently drifted pinned baseline performance subject)",
        ];
  } catch (error) {
    return [`could not recompute pinned baseline performance subject: ${String(error)}`];
  }
}

function evaluateCurrentD12ToolchainDigest(evidence, computeMeasurementHarnessSha256) {
  const recordedDigest = evidence.d12Comparison?.measurementHarnessSha256;
  if (recordedDigest === undefined) return [];
  if (!LOWERCASE_SHA_256.test(recordedDigest)) {
    return ["D12 comparison is missing a valid measurementHarnessSha256 binding"];
  }
  try {
    const currentDigest = computeMeasurementHarnessSha256();
    if (!LOWERCASE_SHA_256.test(currentDigest)) {
      return ["current D12 measurement toolchain did not produce a lowercase SHA-256 digest"];
    }
    return currentDigest === recordedDigest
      ? []
      : [
          `measurementHarnessSha256 ${recordedDigest} != current committed ${currentDigest} ` +
            "(stale D12 measurement toolchain evidence)",
        ];
  } catch (error) {
    return [`could not recompute current committed D12 measurement toolchain: ${String(error)}`];
  }
}

function defaultComputeLockfileSha256() {
  return createHash("sha256")
    .update(readFileSync(join(repoRoot, "package-lock.json")))
    .digest("hex");
}

function evaluateCurrentD12LockfileDigest(evidence, computeLockfileSha256) {
  const recordedDigest =
    evidence.d12Comparison?.dependencyProvisioning?.lockfileSha256ByRevision?.candidate;
  if (recordedDigest === undefined) return [];
  if (!LOWERCASE_SHA_256.test(recordedDigest)) {
    return ["D12 comparison is missing a valid candidate dependencyProvisioning lockfile binding"];
  }
  try {
    const currentDigest = computeLockfileSha256();
    if (!LOWERCASE_SHA_256.test(currentDigest)) {
      return ["current package-lock.json did not produce a lowercase SHA-256 digest"];
    }
    return currentDigest === recordedDigest
      ? []
      : [
          `dependencyProvisioning candidate lockfileSha256 ${recordedDigest} != current ${currentDigest} ` +
            "(stale D12 dependency evidence)",
        ];
  } catch (error) {
    return [`could not recompute current package-lock.json digest: ${String(error)}`];
  }
}

function evaluateCommitStamp(commit) {
  return COMMIT_SHA.test(commit ?? "")
    ? []
    : ["evidence missing a valid `commit` stamp — regenerate the perf suite to stamp freshness"];
}

function evaluateSourceTreeStamp(sourceTreeSha256) {
  return LOWERCASE_SHA_256.test(sourceTreeSha256 ?? "")
    ? []
    : [
        "evidence missing a valid lowercase `sourceTreeSha256` — regenerate the perf suite to stamp freshness",
      ];
}

function evaluateMeasurementTimestamp(measuredAtIso) {
  return typeof measuredAtIso === "string" && !Number.isNaN(Date.parse(measuredAtIso))
    ? []
    : ["evidence missing a parseable `measuredAtIso`"];
}

function evaluateFreshnessBinding(evidence, isAncestor, computeSourceTreeSha256, enforceSource) {
  const failures = [];
  if (
    evidence.d12Comparison !== undefined &&
    evidence.freshnessBinding !== SOURCE_TREE_FRESHNESS_BINDING
  ) {
    failures.push(`D12 evidence freshnessBinding must be ${SOURCE_TREE_FRESHNESS_BINDING}`);
  }
  if (
    COMMIT_SHA.test(evidence.commit ?? "") &&
    !isAncestor(evidence.commit) &&
    evidence.freshnessBinding !== SOURCE_TREE_FRESHNESS_BINDING
  ) {
    failures.push(
      `evidence commit ${evidence.commit} is not reachable from HEAD ` +
        "(stale/foreign-branch evidence)",
    );
  }
  // ADR-0139 D10: exact-tree equality is a regeneration-lane property, not a pull-request one — on
  // the PR lane every unrelated subject change (another PR's UI/contracts/lockfile churn) would
  // force a full Linux re-measurement without changing what this PR ships.
  if (enforceSource && LOWERCASE_SHA_256.test(evidence.sourceTreeSha256 ?? "")) {
    failures.push(
      ...evaluateCurrentSourceTreeDigest(evidence.sourceTreeSha256, computeSourceTreeSha256),
    );
  }
  return failures;
}

// ADR-0139 D10 — two freshness modes:
//   * Pull-request mode (default): validates evidence INTEGRITY — stamps, canonical structure, the
//     pinned-baseline anchor, and the measurement-toolchain digest (changing the ruler always
//     requires re-measuring). It does NOT require the recorded source tree, lockfile, or working
//     tree to match HEAD: exact-source freshness is owned by the nightly regeneration lane, so
//     unrelated merged churn no longer forces a ~35-minute Linux re-measurement on every PR.
//     Real per-PR performance protection stays with the deterministic editor bundle gates
//     (check:editor-release-evidence / check:editor-bundle-size), which rebuild the product on
//     every PR and catch any change to what users actually load.
//   * Enforcing mode (`enforceSourceFreshness` / --enforce-source-freshness): additionally requires
//     exact source-tree equality, the current lockfile, and a clean subject working tree. Used by
//     the regeneration wrapper right after producing evidence (where the tree matches by
//     construction) and available to the nightly lane for drift diagnosis.
// The always-on integrity set: stamps, binding shape, and the pinned-baseline anchor.
function integrityFreshnessFailures(evidence, options, enforceSourceFreshness) {
  const {
    computeBaselineSourceTreeSha256 = defaultComputeBaselineSourceTreeSha256,
    computeMeasurementHarnessSha256 = defaultComputeMeasurementHarnessSha256,
    computeSourceTreeSha256 = computePerformanceSubjectDigest,
    isAncestor = defaultIsAncestor,
    toolchainTouched = false,
  } = options;
  return [
    ...evaluateCommitStamp(evidence.commit),
    ...evaluateSourceTreeStamp(evidence.sourceTreeSha256),
    ...evaluateMeasurementTimestamp(evidence.measuredAtIso),
    ...evaluateFreshnessBinding(
      evidence,
      isAncestor,
      computeSourceTreeSha256,
      enforceSourceFreshness,
    ),
    ...evaluateCurrentD12BaselineDigest(evidence, computeBaselineSourceTreeSha256),
    // Changing the ruler still requires re-measuring with it — but only the change that moved the
    // ruler answers for that. This digest compares the evidence against the CURRENT tree, so an
    // unconditional check here fails every OTHER open pull request the moment one of them edits a
    // D12_MEASUREMENT_TOOLCHAIN_PATHS member: a required check gone red with no fix available
    // inside the diff that trips it. The enforcing lane always evaluates it; the pull-request lane
    // evaluates it exactly when the diff touches the toolchain (ADR-0139 D10).
    ...(enforceSourceFreshness || toolchainTouched
      ? evaluateCurrentD12ToolchainDigest(evidence, computeMeasurementHarnessSha256)
      : []),
  ];
}

// The regeneration-lane extras: a clean subject working tree and the exact current lockfile.
function enforcedSourceFailures(evidence, options) {
  const { computeLockfileSha256 = defaultComputeLockfileSha256, dirtySubjectPaths = [] } = options;
  return [
    ...evaluateDirtySubjectPaths(dirtySubjectPaths),
    ...evaluateCurrentD12LockfileDigest(evidence, computeLockfileSha256),
  ];
}

export function evaluateFreshness(evidence, options = {}) {
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["evidence is not an object"] };
  }
  const enforceSourceFreshness = options.enforceSourceFreshness === true;
  const failures = [
    ...integrityFreshnessFailures(evidence, options, enforceSourceFreshness),
    ...(enforceSourceFreshness ? enforcedSourceFailures(evidence, options) : []),
  ];
  return { passed: failures.length === 0, failures };
}

// ---- CLI -------------------------------------------------------------------

export function readEvidence(path) {
  if (!existsSync(path)) return { error: `missing evidence file: ${path}` };
  try {
    const contents = readFileSync(path);
    const evidence = JSON.parse(contents.toString("utf8"));
    if (
      evidence?.d12Comparison !== undefined &&
      !contents.equals(canonicalD12ArtifactBytes(evidence))
    ) {
      return { error: `non-canonical D12 evidence file: ${path}` };
    }
    return { evidence };
  } catch (error) {
    return { error: `unreadable evidence file ${path}: ${String(error)}` };
  }
}

function selectGateTargets(targetName) {
  const allTargets = [
    { name: "workspace", path: WORKSPACE_EVIDENCE, evaluate: evaluateWorkspaceEvidence },
    { name: "editor", path: EDITOR_EVIDENCE, evaluate: evaluateEditorEvidence },
  ];
  return targetName === "all"
    ? allTargets
    : allTargets.filter((target) => target.name === targetName);
}

function gateModeLines(enforceSourceFreshness) {
  if (enforceSourceFreshness) {
    return {
      ok: (name, commit) =>
        `perf-evidence: ${name} OK (budgets within limits, evidence fresh @ ${commit})`,
      pass: "perf-evidence: PASS - all committed performance evidence is within budget and fresh.",
    };
  }
  return {
    ok: (name, commit) =>
      `perf-evidence: ${name} OK (budgets within limits, evidence integrity verified ` +
      `@ ${commit}; source freshness is owned by the nightly regeneration lane)`,
    pass:
      "perf-evidence: PASS - all committed performance evidence is within budget and " +
      "internally sound.",
  };
}

function evaluateGateTarget(target, freshnessOptions, okLine) {
  const { evidence, error } = readEvidence(target.path);
  if (error !== undefined) return [`${target.name}: ${error}`];
  const failures = [];
  const budget = target.evaluate(evidence);
  for (const failure of budget.failures) failures.push(`${target.name} budget: ${failure}`);
  const freshness = evaluateFreshness(evidence, freshnessOptions);
  for (const failure of freshness.failures) failures.push(`${target.name} freshness: ${failure}`);
  if (failures.length === 0) console.log(okLine(target.name, evidence.commit));
  return failures;
}

function runGate(targetName = "all", enforceSourceFreshness = false) {
  const lines = gateModeLines(enforceSourceFreshness);
  // KEIKO_PERF_EVIDENCE_BASE_REF is the pull request's merge base. When it is absent — the nightly
  // and regeneration lanes — the toolchain digest is evaluated unconditionally anyway.
  const baseRef = process.env.KEIKO_PERF_EVIDENCE_BASE_REF ?? "";
  const freshnessOptions = {
    dirtySubjectPaths: enforceSourceFreshness ? listDirtyPerformanceSubjectPaths() : [],
    enforceSourceFreshness,
    toolchainTouched: enforceSourceFreshness || baseRef === "" || toolchainTouchedAgainst(baseRef),
  };
  const allFailures = selectGateTargets(targetName).flatMap((target) =>
    evaluateGateTarget(target, freshnessOptions, lines.ok),
  );
  if (allFailures.length > 0) {
    for (const failure of allFailures) console.error(`perf-evidence: FAIL - ${failure}`);
    process.exit(1);
  }
  console.log(lines.pass);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cliArgs = process.argv.slice(2);
  const enforceSourceFreshness = cliArgs.includes("--enforce-source-freshness");
  const positional = cliArgs.filter((arg) => arg !== "--enforce-source-freshness");
  if (positional.length === 1 && positional[0] === "--print-source-tree-sha256") {
    console.log(computePerformanceSubjectDigest());
  } else if (
    positional.length === 2 &&
    positional[0] === "--target" &&
    positional[1] === "editor"
  ) {
    runGate("editor", enforceSourceFreshness);
  } else if (positional.length === 0) {
    runGate("all", enforceSourceFreshness);
  } else {
    console.error(
      "usage: check-perf-evidence.mjs " +
        "[--print-source-tree-sha256 | --target editor] [--enforce-source-freshness]",
    );
    process.exitCode = 2;
  }
}
