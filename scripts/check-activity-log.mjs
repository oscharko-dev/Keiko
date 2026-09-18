#!/usr/bin/env node
// The permanent Activity Log implementation quality gate: `npm run check:activity-log`.
//
// One local command, invoked unchanged by required CI, that evaluates the complete registered
// product-runtime inventory on every run. It is deliberately a thin composition: every rule lives
// in the focused check that owns it, so this file adds no scanner, catalog, analyzer or evidence
// model of its own and never restates a rule. Nothing here is diff-aware — no base ref, changed-file
// list or path filter reaches a constituent, so a narrower change set can never narrow the proof.
//
// Output is deterministic gate output (step, script, verdict, duration, remediation), never a
// product log line and never a rejected body: each constituent prints its own bounded findings.

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

// The checks below load built package output (the registry vocabularies, the BFF the failure-path
// probes drive). The build is therefore a prerequisite rather than a peer: a failed build would
// leave every later verdict judging stale code, so nothing else runs after it.
export const ACTIVITY_LOG_GATE_PREREQUISITE = Object.freeze({
  id: "build",
  script: "build:packages",
  proves: "the built package output every later check loads matches the current sources",
  remediation: "Repair the package build first; every later check reads its output.",
});

export const ACTIVITY_LOG_GATE_CHECKS = Object.freeze([
  Object.freeze({
    id: "registry",
    script: "check:op-catalog",
    proves:
      "typed registrations and emitters, closed fields and vocabularies, exemptions, " +
      "failure-class coverage, the failure-surface inventory, and proof and scenario resolution",
    remediation:
      "Run `npm run generate:op-catalog`, repair each reported violation at its site, " +
      "and commit the regenerated files.",
  }),
  Object.freeze({
    id: "failure-paths",
    script: "check:error-observability",
    proves: "production failure paths carry a correlation id to the owning diagnostic sink",
    remediation:
      "Route the reported failure path through its owning log port with a correlation id, " +
      "or propagate the error.",
  }),
  Object.freeze({
    id: "architecture",
    script: "arch:check",
    proves: "owning-layer dependency direction and contract-boundary rules",
    remediation:
      "Move the reported import to the layer that owns it, or route it through keiko-contracts.",
  }),
  Object.freeze({
    id: "architecture-negative",
    script: "arch:check:negative",
    proves: "every architecture rule still rejects its negative fixture",
    remediation: "Restore the architecture rule whose negative fixture no longer fails.",
  }),
  Object.freeze({
    id: "release-impact",
    script: "check:release-impact",
    proves: "reviewed release-impact ownership for the current package version",
    remediation: "Add or repair the reviewed entry in release-impact.catalog.json.",
  }),
]);

export const ACTIVITY_LOG_GATE_STEPS = Object.freeze([
  ACTIVITY_LOG_GATE_PREREQUISITE,
  ...ACTIVITY_LOG_GATE_CHECKS,
]);

function runNpmScript(script) {
  const result = spawnSync(resolveHostExecutable("npm"), ["run", script], {
    shell: false,
    stdio: "inherit",
  });
  return result.error === undefined && result.signal === null && result.status === 0;
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  runScript: runNpmScript,
  now: () => performance.now(),
  write: (line) => console.log(line),
});

function seconds(durationMs) {
  return `${(durationMs / 1000).toFixed(1)} s`;
}

function runStep(step, deps) {
  const started = deps.now();
  const passed = deps.runScript(step.script) === true;
  const result = { id: step.id, script: step.script, passed, durationMs: deps.now() - started };
  deps.write(
    `check:activity-log: ${step.id} (npm run ${step.script}) ` +
      `${passed ? "PASS" : "FAIL"} in ${seconds(result.durationMs)}`,
  );
  return result;
}

function reportFailures(results, deps) {
  for (const result of results.filter((entry) => !entry.passed)) {
    const step = ACTIVITY_LOG_GATE_STEPS.find((candidate) => candidate.id === result.id);
    deps.write(`check:activity-log: ${result.id} failed — ${step.remediation}`);
  }
}

/**
 * Runs the prerequisite build, then every constituent check in order. A failing check does not
 * stop the checks after it, so one run reports every failing rule family; only a failed build
 * stops the run, because every later verdict would judge stale output.
 */
export function runActivityLogGate(dependencies = {}) {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const started = deps.now();
  const results = [runStep(ACTIVITY_LOG_GATE_PREREQUISITE, deps)];
  if (results[0].passed) {
    for (const check of ACTIVITY_LOG_GATE_CHECKS) results.push(runStep(check, deps));
  }
  const failed = results.filter((result) => !result.passed).length;
  const skipped = ACTIVITY_LOG_GATE_STEPS.length - results.length;
  const passed = failed === 0 && skipped === 0;
  const durationMs = deps.now() - started;
  reportFailures(results, deps);
  deps.write(
    passed
      ? `check:activity-log PASS — ${String(results.length)} checks over the full registered ` +
          `inventory in ${seconds(durationMs)}.`
      : `check:activity-log FAIL — ${String(failed)} failed and ${String(skipped)} not run of ` +
          `${String(ACTIVITY_LOG_GATE_STEPS.length)} checks in ${seconds(durationMs)}.`,
  );
  return { passed, durationMs, results };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error(
      "check:activity-log takes no arguments: it always evaluates the full registered inventory.",
    );
    process.exitCode = 2;
  } else if (!runActivityLogGate().passed) {
    process.exitCode = 1;
  }
}
