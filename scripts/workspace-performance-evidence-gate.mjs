import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  computePerformanceSubjectDigest,
  listDirtyPerformanceSubjectPaths,
  subjectDriftFinding,
} from "./check-perf-evidence.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { computeWorkspacePerformanceMeasurementToolchainDigest } from "./workspace-performance-measurement-toolchain.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const COMMIT_SHA = /^[0-9a-f]{7,40}$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;

function defaultComputeMeasurementHarnessSha256() {
  return computeWorkspacePerformanceMeasurementToolchainDigest((path) =>
    readFileSync(join(repoRoot, path)),
  );
}

function stampFailures(evidence) {
  const failures = [];
  if (!COMMIT_SHA.test(evidence.commit ?? ""))
    failures.push("evidence missing a valid `commit` stamp");
  if (!SHA_256.test(evidence.sourceTreeSha256 ?? "")) {
    failures.push("evidence missing a valid lowercase `sourceTreeSha256` binding");
  }
  if (evidence.freshnessBinding !== "source-tree-v1") {
    failures.push("workspace evidence freshnessBinding must be source-tree-v1");
  }
  if (
    typeof evidence.measuredAtIso !== "string" ||
    Number.isNaN(Date.parse(evidence.measuredAtIso))
  ) {
    failures.push("evidence missing a parseable `measuredAtIso`");
  }
  return failures;
}

function measurementHarnessFailures(evidence, computeMeasurementHarnessSha256) {
  const recorded = evidence.measurementHarnessSha256;
  if (!SHA_256.test(recorded ?? "")) {
    return ["evidence is missing a valid measurementHarnessSha256 binding"];
  }
  try {
    const current = computeMeasurementHarnessSha256();
    if (!SHA_256.test(current))
      return ["current measurement harness did not produce a SHA-256 digest"];
    return current === recorded
      ? []
      : [
          `measurementHarnessSha256 ${recorded} != current committed ${current} (stale workspace measurement toolchain evidence)`,
        ];
  } catch (error) {
    return [
      `could not recompute workspace measurement harness: ${error instanceof Error ? error.name : "unknown error"}`,
    ];
  }
}

function sourceTreeFailures(evidence, computeSourceTreeSha256, dirtySubjectPaths) {
  const failures = [];
  try {
    const current = computeSourceTreeSha256();
    if (!SHA_256.test(current))
      return ["current performance subject did not produce a SHA-256 digest"];
    if (current !== evidence.sourceTreeSha256) {
      failures.push(
        subjectDriftFinding(
          `sourceTreeSha256 ${evidence.sourceTreeSha256} != current ${current} (stale performance evidence)`,
        ),
      );
    }
  } catch (error) {
    failures.push(
      `could not recompute performance subject: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
  if (dirtySubjectPaths.length > 0) {
    failures.push(
      `performance measurement subject has dirty inputs: ${dirtySubjectPaths.join(", ")}`,
    );
  }
  return failures;
}

export function evaluateWorkspaceEvidenceFreshness(evidence, options = {}) {
  if (typeof evidence !== "object" || evidence === null) {
    return { passed: false, failures: ["evidence is not an object"] };
  }
  const enforce = options.enforceSourceFreshness === true;
  const failures = stampFailures(evidence);
  failures.push(
    ...measurementHarnessFailures(
      evidence,
      options.computeMeasurementHarnessSha256 ?? defaultComputeMeasurementHarnessSha256,
    ),
  );
  if (enforce) {
    failures.push(
      ...sourceTreeFailures(
        evidence,
        options.computeSourceTreeSha256 ?? computePerformanceSubjectDigest,
        options.dirtySubjectPaths ?? listDirtyPerformanceSubjectPaths(),
      ),
    );
  }
  return { passed: failures.length === 0, failures };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.slice(2).join(" ") === "--print-measurement-harness-sha256") {
    console.log(defaultComputeMeasurementHarnessSha256());
  } else {
    console.error(
      "usage: workspace-performance-evidence-gate.mjs --print-measurement-harness-sha256",
    );
    process.exitCode = 2;
  }
}
