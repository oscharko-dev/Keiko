// Deterministic judge only. No native process or wall-clock benchmark runs in the PR lane.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalD12ArtifactBytes } from "./check-perf-evidence.mjs";
import { evaluateCodingPerformanceEvidence } from "./coding-runtime-performance-evidence.mjs";
import { CODING_PERFORMANCE_FILES } from "./coding-runtime-performance-producer.mjs";
import {
  CODING_PERFORMANCE_COMMAND,
  codingPerformanceRulerChanged,
  codingPerformanceSource,
  codingPerformanceToolchainDigest,
  dirtyCodingPerformanceInputs,
} from "./coding-runtime-performance-toolchain.mjs";
import { listChangedGitPaths } from "./lib/git-changed-paths.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function canonicalDocument(path) {
  const bytes = readFileSync(join(ROOT, path));
  const document = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(canonicalD12ArtifactBytes(document)))
    throw new TypeError("performance artifact is not canonical");
  return document;
}

function commandAt(base) {
  const content = execFileSync(resolveHostExecutable("git"), ["show", `${base}:package.json`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(content).scripts?.[CODING_PERFORMANCE_COMMAND];
}

export function codingPerformanceNeedsRulerCheck(base, changed = listChangedGitPaths) {
  if (base === "") return true;
  try {
    const paths = changed(base, ROOT);
    const currentCommand = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts?.[
      CODING_PERFORMANCE_COMMAND
    ];
    return codingPerformanceRulerChanged(paths, {
      beforeCommand: paths.includes("package.json") ? commandAt(base) : currentCommand,
      afterCommand: currentCommand,
    });
  } catch {
    process.stderr.write("coding performance base unavailable; ruler freshness is enforced\n");
    return true;
  }
}

export function evaluateCodingPerformanceFreshness(evidence, options) {
  const defects = [];
  const subjectDrift = [];
  const digest = /^[a-f\d]{64}$/u;
  if (options.checkRuler) {
    if (!digest.test(options.measurementHarnessSha256))
      defects.push("invalid current measurement toolchain digest");
    else if (evidence.measurementHarnessSha256 !== options.measurementHarnessSha256)
      defects.push(
        "coding runtime measurement toolchain changed; remeasure on the native reference",
      );
  }
  if (options.enforceSourceFreshness) {
    for (const key of ["sourceTreeSha256", "lockfileSha256"]) {
      if (!digest.test(options.source?.[key]))
        defects.push("invalid current measurement subject digest");
      else if (evidence.subject[key] !== options.source[key])
        subjectDrift.push(`coding runtime ${key} moved since measurement`);
    }
    if (options.dirtyInputs.length > 0) defects.push("coding runtime measurement inputs are dirty");
  }
  return { defects, subjectDrift };
}

export function checkCodingPerformanceEvidence({
  enforceSourceFreshness = false,
  reportSubjectDrift = false,
} = {}) {
  const calibration = canonicalDocument(CODING_PERFORMANCE_FILES.calibration);
  const evidence = canonicalDocument(CODING_PERFORMANCE_FILES.measurement);
  const budget = canonicalDocument(CODING_PERFORMANCE_FILES.budget);
  const findings = evaluateCodingPerformanceEvidence(evidence, calibration, budget);
  if (findings.defects.length > 0) return findings;
  const freshness = currentFreshness(evidence, enforceSourceFreshness);
  findings.defects.push(...freshness.defects);
  if (!reportSubjectDrift) findings.defects.push(...freshness.subjectDrift);
  return { ...findings, advisories: reportSubjectDrift ? freshness.subjectDrift : [] };
}

function currentFreshness(evidence, enforceSourceFreshness) {
  const checkRuler =
    enforceSourceFreshness ||
    codingPerformanceNeedsRulerCheck(process.env.KEIKO_PERF_EVIDENCE_BASE_REF ?? "");
  return evaluateCodingPerformanceFreshness(evidence, {
    checkRuler,
    enforceSourceFreshness,
    measurementHarnessSha256: checkRuler ? codingPerformanceToolchainDigest() : undefined,
    source: enforceSourceFreshness ? codingPerformanceSource() : undefined,
    dirtyInputs: enforceSourceFreshness ? dirtyCodingPerformanceInputs() : [],
  });
}

export function parseCodingPerformanceGateArgs(args) {
  const flags = new Set(["--enforce-source-freshness", "--report-subject-drift"]);
  if (args.some((arg) => !flags.has(arg)) || new Set(args).size !== args.length)
    throw new TypeError(
      "usage: coding-runtime-performance-gate.mjs [--enforce-source-freshness [--report-subject-drift]]",
    );
  const enforceSourceFreshness = args.includes("--enforce-source-freshness");
  const reportSubjectDrift = args.includes("--report-subject-drift");
  if (reportSubjectDrift && !enforceSourceFreshness)
    throw new TypeError("--report-subject-drift requires --enforce-source-freshness");
  return { enforceSourceFreshness, reportSubjectDrift };
}

if (isMainModule(import.meta.url)) {
  try {
    const {
      defects,
      verdicts,
      advisories = [],
    } = checkCodingPerformanceEvidence(parseCodingPerformanceGateArgs(process.argv.slice(2)));
    for (const advisory of advisories)
      process.stdout.write(`coding performance: SUBJECT DRIFT ${advisory}\n`);
    for (const failure of [...defects, ...verdicts])
      process.stderr.write(`coding performance: FAIL ${failure}\n`);
    process.exitCode = defects.length + verdicts.length === 0 ? 0 : 1;
    if (process.exitCode === 0) process.stdout.write("coding-runtime performance evidence: PASS\n");
  } catch (error) {
    process.stderr.write(
      `coding performance: FAIL ${error instanceof TypeError ? error.message : "evidence unavailable or unreadable"}\n`,
    );
    process.exitCode = 1;
  }
}
