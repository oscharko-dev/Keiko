#!/usr/bin/env node
// The judge. Reads the committed performance evidence, applies the budgets and the freshness rules,
// and decides the exit code.
//
// It lives apart from scripts/check-perf-evidence.mjs for one reason, and the reason is measured:
// that file is a member of D12_MEASUREMENT_TOOLCHAIN_PATHS, the digest is FILE-granular, and so any
// edit anywhere in its 3000 lines invalidates the committed evidence and costs a ~35-minute
// re-measurement on the reference environment. The producers import eighteen digest and derivation
// helpers from it — those genuinely shape the numbers and belong in the digest. They import nothing
// from the gate. A change to a log sink or an exit code here cannot move a measured millisecond, and
// before this split it cost a measurement anyway; that happened three times in one day.
//
// It is the same argument check-perf-evidence.mjs already makes about package.json — "renaming a
// script or editing metadata does not change the measured bundle" — applied to itself at last.
// ADR-0156 puts it as a title: a measurement lane measures; the gate judges. This file is the judge,
// and it is deliberately not part of the ruler.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalD12ArtifactBytes,
  computePerformanceSubjectDigest,
  evaluateEditorEvidence,
  evaluateFreshness,
  evaluateWorkspaceEvidence,
  listDirtyPerformanceSubjectPaths,
  partitionFreshnessFindings,
  toolchainTouchedAgainst,
} from "./check-perf-evidence.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { computeWorkspacePerformanceMeasurementToolchainDigest } from "./workspace-performance-measurement-toolchain.mjs";
import { evaluateWorkspaceEvidenceFreshness } from "./workspace-performance-evidence-gate.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_EVIDENCE = join(repoRoot, "docs", "release", "1580-workspace-perf-evidence.json");
const EDITOR_EVIDENCE = join(repoRoot, "docs", "release", "1209-perf-evidence.json");
// The CI producer intentionally selects Chromium, which emits the representative workspace run
// and the mixed-heavy-window run. WebKit is a local functional aid, not comparable timing evidence
// on the headless CI renderer. The judge owns this document-shape policy, rather than the
// measurement helper, so changing it cannot invalidate measured timings.
const REQUIRED_WORKSPACE_EVIDENCE_RUNS = Object.freeze(["chromium", "chromium-mixed-windows"]);
export const D12_PINNED_BASELINE_SOURCE_TREE_SHA256 =
  "0dd8c879889c3449157e6527c651f30b6481422a0ade0bfed36e354ec5ba1664";

function compareRunNames(left, right) {
  return left.localeCompare(right);
}

function workspaceRuns(evidence) {
  if (typeof evidence !== "object" || evidence === null) return undefined;
  const runs = evidence.runs;
  if (typeof runs !== "object" || runs === null || Array.isArray(runs)) return undefined;
  return runs;
}

function workspaceRunIdentityFailures(runs) {
  const failures = [];
  for (const name of REQUIRED_WORKSPACE_EVIDENCE_RUNS) {
    const run = runs[name];
    if (typeof run !== "object" || run === null || run.project !== name) {
      failures.push(`workspace evidence run ${name} is missing its matching project identity`);
    }
  }
  return failures;
}

export function evaluateWorkspaceEvidenceDocument(evidence) {
  const evaluated = evaluateWorkspaceEvidence(evidence);
  const runs = workspaceRuns(evidence);
  if (runs === undefined) return evaluated;
  const actual = Object.keys(runs).sort(compareRunNames);
  const expected = [...REQUIRED_WORKSPACE_EVIDENCE_RUNS].sort(compareRunNames);
  const failures = [...evaluated.failures];
  if (actual.join("\0") !== expected.join("\0")) {
    failures.push(
      `workspace evidence runs ${actual.join(", ") || "(none)"} != required ${expected.join(", ")}`,
    );
  }
  failures.push(...workspaceRunIdentityFailures(runs));
  return { passed: failures.length === 0, failures };
}

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
    {
      name: "workspace",
      path: WORKSPACE_EVIDENCE,
      evaluate: evaluateWorkspaceEvidenceDocument,
      evaluateFreshness: evaluateWorkspaceEvidenceFreshness,
      freshnessOptions: (options) => ({
        ...options,
        computeMeasurementHarnessSha256: defaultComputeWorkspaceMeasurementHarnessSha256,
      }),
    },
    { name: "editor", path: EDITOR_EVIDENCE, evaluate: evaluateEditorEvidence },
  ];
  return targetName === "all"
    ? allTargets
    : allTargets.filter((target) => target.name === targetName);
}

function defaultComputeWorkspaceMeasurementHarnessSha256() {
  return computeWorkspacePerformanceMeasurementToolchainDigest((path) =>
    readFileSync(join(repoRoot, path)),
  );
}

const SUBJECT_DRIFT_NOTE =
  "the measured subject has moved on since the committed evidence was produced; only the " +
  "reference environment can re-measure (docs/qa/perf-evidence.md), and no pull request is " +
  "blocked by this";

export function gateModeLines(enforceSourceFreshness, reportSubjectDrift) {
  if (reportSubjectDrift) {
    return {
      ok: (name, commit) =>
        `perf-evidence: ${name} OK (budgets within limits, evidence sound and measured with the ` +
        `current ruler @ ${commit})`,
      pass:
        "perf-evidence: PASS - committed performance evidence is within budget, sound, and " +
        "measured with the current toolchain.",
    };
  }
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

export function evaluateGateTarget(
  target,
  freshnessOptions,
  lines,
  reportSubjectDrift,
  log = console.log,
) {
  const { evidence, error } = readEvidence(target.path);
  if (error !== undefined) return { failures: [`${target.name}: ${error}`], notes: [] };
  const failures = target
    .evaluate(evidence)
    .failures.map((failure) => `${target.name} budget: ${failure}`);
  const options = target.freshnessOptions?.(freshnessOptions) ?? freshnessOptions;
  const freshness = partitionFreshnessFindings(
    (target.evaluateFreshness ?? evaluateFreshness)(evidence, options).failures,
    reportSubjectDrift,
  );
  failures.push(...freshness.failures.map((failure) => `${target.name} freshness: ${failure}`));
  if (failures.length === 0) log(lines.ok(target.name, evidence.commit));
  return { failures, notes: freshness.notes.map((note) => `${target.name} freshness: ${note}`) };
}

export function freshnessOptionsFor(enforceSourceFreshness) {
  // KEIKO_PERF_EVIDENCE_BASE_REF is the pull request's merge base. When it is absent — the nightly
  // and regeneration lanes — the toolchain digest is evaluated unconditionally anyway.
  const baseRef = process.env.KEIKO_PERF_EVIDENCE_BASE_REF ?? "";
  return {
    computeBaselineSourceTreeSha256: () => D12_PINNED_BASELINE_SOURCE_TREE_SHA256,
    dirtySubjectPaths: enforceSourceFreshness ? listDirtyPerformanceSubjectPaths() : [],
    enforceSourceFreshness,
    toolchainTouched: enforceSourceFreshness || baseRef === "" || toolchainTouchedAgainst(baseRef),
  };
}

export function reportSubjectDriftNotes(notes, log = console.log) {
  for (const note of notes) log(`perf-evidence: NOTE - ${note}`);
  if (notes.length > 0) log(`perf-evidence: NOTE - ${SUBJECT_DRIFT_NOTE}`);
}

/** The sinks and collaborators the gate verdict uses, resolved in one place. */
export function resolveGateIo(io = {}) {
  return {
    log: io.log ?? console.log,
    error: io.error ?? console.error,
    fail: io.fail ?? ((code) => process.exit(code)),
    evaluateTarget: io.evaluateTarget ?? evaluateGateTarget,
    targets: io.targets,
  };
}

// Exported with injectable sinks: this is the half that decides the exit code, and a verdict that
// only ever runs in the CLI is a verdict nothing proves.
export function runGate(
  targetName = "all",
  enforceSourceFreshness = false,
  reportSubjectDrift = false,
  io = {},
) {
  const deps = resolveGateIo(io);
  const lines = gateModeLines(enforceSourceFreshness, reportSubjectDrift);
  const freshnessOptions = freshnessOptionsFor(enforceSourceFreshness);
  const targets = deps.targets ?? selectGateTargets(targetName);
  // Every line the gate emits goes through the injected sink, including the per-target OK lines and
  // the drift notes. A partly-injected surface is worse than none: a caller believes it captured the
  // output and silently loses half of it.
  const results = targets.map((target) =>
    deps.evaluateTarget(target, freshnessOptions, lines, reportSubjectDrift, deps.log),
  );
  reportSubjectDriftNotes(
    results.flatMap((result) => result.notes),
    deps.log,
  );
  const failures = results.flatMap((result) => result.failures);
  if (failures.length === 0) {
    deps.log(lines.pass);
    return 0;
  }
  for (const failure of failures) deps.error(`perf-evidence: FAIL - ${failure}`);
  return deps.fail(1);
}

const USAGE =
  "usage: perf-evidence-gate.mjs [--print-source-tree-sha256 | --target editor|workspace] " +
  "[--enforce-source-freshness [--report-subject-drift]]";

const CLI_FLAGS = new Set(["--enforce-source-freshness", "--report-subject-drift"]);

/**
 * Exported so the argument dispatch is unit-tested directly. It decides which lane runs and what the
 * exit code is, and a dispatch that only ever runs from the shebang is a dispatch nothing proves.
 */
export function resolveCliIo(io = {}) {
  return {
    log: io.log ?? console.log,
    error: io.error ?? console.error,
    setExitCode: io.setExitCode ?? ((value) => (process.exitCode = value)),
    gate: io.gate ?? runGate,
    digest: io.digest ?? computePerformanceSubjectDigest,
  };
}

/** The invocation, reduced to the three things the dispatch branches on. */
export function parseCliArgs(cliArgs) {
  return {
    enforceSourceFreshness: cliArgs.includes("--enforce-source-freshness"),
    reportSubjectDrift: cliArgs.includes("--report-subject-drift"),
    positional: cliArgs.filter((arg) => !CLI_FLAGS.has(arg)),
  };
}

function selectedTarget(positional) {
  if (positional.length === 0) return "all";
  if (positional.length !== 2 || positional[0] !== "--target") return undefined;
  const target = positional[1];
  return target === "editor" || target === "workspace" ? target : undefined;
}

export function executePerfEvidenceCli(cliArgs = process.argv.slice(2), io = {}) {
  const deps = resolveCliIo(io);
  const { enforceSourceFreshness, reportSubjectDrift, positional } = parseCliArgs(cliArgs);

  // Without the enforcing mode the subject digests are never evaluated, so there is nothing to
  // downgrade. Accepting the flag there would read as "this lane is more forgiving" while changing
  // nothing — refuse instead of pretending.
  if (reportSubjectDrift && !enforceSourceFreshness) {
    deps.error("perf-evidence: --report-subject-drift requires --enforce-source-freshness");
    return deps.setExitCode(2);
  }
  if (positional.length === 1 && positional[0] === "--print-source-tree-sha256") {
    return deps.log(deps.digest());
  }
  const target = selectedTarget(positional);
  if (target === undefined) {
    deps.error(USAGE);
    return deps.setExitCode(2);
  }
  return deps.gate(target, enforceSourceFreshness, reportSubjectDrift);
}

if (isMainModule(import.meta.url)) executePerfEvidenceCli();
