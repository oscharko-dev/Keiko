#!/usr/bin/env node
// Explicit paired-host migration/refresh. Never changes any reviewed time ceiling.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { canonicalD12ArtifactBytes } from "./check-perf-evidence.mjs";
import {
  buildToolCatalogPerformanceDocument,
  evaluateToolCatalogPerformanceEvidence,
  measureToolCatalogPerformanceInFreshProcess,
  ratchetToolCatalogPerformanceBudgets,
  toolCatalogPerformanceRulerDigest,
  toolCatalogPerformanceSubject,
  TOOL_CATALOG_PERFORMANCE_FILES,
} from "./check-tool-catalog-performance.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));

export function portableHostEnvironment() {
  return {
    kind: "paired-host-v1",
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    logicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
    osRelease: release(),
    cpuModelsSha256: hash(JSON.stringify(cpus().map(({ model }) => model))),
    nodeBinarySha256: hash(readFileSync(process.execPath)),
  };
}

function requirePassing(result) {
  if (result.defects.length > 0 || result.verdicts.length > 0)
    throw new TypeError([...result.defects, ...result.verdicts].join("; "));
}

function requireSame(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new TypeError(label);
}

function preparePair(context, deps) {
  const { root, baselineRoot, baselineCommit, candidateCommit } = context;
  const previous = deps.read(root, TOOL_CATALOG_PERFORMANCE_FILES.calibration);
  const previousBudget = deps.read(root, TOOL_CATALOG_PERFORMANCE_FILES.budget);
  requirePassing(
    evaluateToolCatalogPerformanceEvidence(
      deps.read(root, TOOL_CATALOG_PERFORMANCE_FILES.measurement),
      previous,
      previousBudget,
    ),
  );
  const environment = deps.environment();
  const measurementHarnessSha256 = deps.ruler(root);
  const baselineSubject = deps.subject(baselineRoot);
  const candidateSubject = deps.subject(root);
  const portablePair = {
    baselineCommit,
    candidateCommit,
    previousCalibrationSha256: previous.documentSha256,
    previousBudgetSha256: hash(canonicalD12ArtifactBytes(previousBudget)),
  };
  const input = { environment, measurementHarnessSha256, portablePair };
  const childEnvironment = Object.fromEntries(
    ["platform", "architecture", "nodeVersion"].map((key) => [key, environment[key]]),
  );
  return { input, childEnvironment, baselineSubject, candidateSubject, previousBudget };
}

/** Both processes load this candidate's ruler, but each loads its own built producer/dependencies. */
export async function measurePortableToolCatalogPair(context, overrides = {}) {
  const { root, baselineRoot } = context;
  const deps = {
    environment: portableHostEnvironment,
    read: readJson,
    subject: toolCatalogPerformanceSubject,
    ruler: toolCatalogPerformanceRulerDigest,
    measure: measureToolCatalogPerformanceInFreshProcess,
    now: () => new Date().toISOString(),
    ...overrides,
  };
  const state = preparePair(context, deps);
  const { input, childEnvironment, baselineSubject, candidateSubject, previousBudget } = state;
  const baselineRaw = await deps.measure(baselineRoot, root);
  requireSame(
    baselineRaw.environment,
    childEnvironment,
    "catalog baseline process environment differs",
  );
  requireSame(baselineRaw.subject, baselineSubject, "catalog baseline inputs changed");
  const calibration = buildToolCatalogPerformanceDocument(baselineRaw, {
    ...input,
    role: "calibration",
    measuredAtIso: deps.now(),
  });
  const budget = ratchetToolCatalogPerformanceBudgets(calibration, previousBudget);
  // A slow baseline must not authorize a slower candidate or a wider threshold.
  const baselineCheck = buildToolCatalogPerformanceDocument(baselineRaw, {
    ...input,
    role: "measurement",
    measuredAtIso: deps.now(),
    calibrationSha256: calibration.documentSha256,
  });
  requirePassing(evaluateToolCatalogPerformanceEvidence(baselineCheck, calibration, budget));
  const candidateRaw = await deps.measure(root, root);
  requireSame(
    candidateRaw.environment,
    childEnvironment,
    "catalog candidate process environment differs",
  );
  requireSame(candidateRaw.subject, candidateSubject, "catalog candidate inputs changed");
  const measurement = buildToolCatalogPerformanceDocument(candidateRaw, {
    ...input,
    role: "measurement",
    measuredAtIso: deps.now(),
    calibrationSha256: calibration.documentSha256,
  });
  requirePassing(evaluateToolCatalogPerformanceEvidence(measurement, calibration, budget));
  verifyStablePair(context, deps, state);
  return { calibration, measurement, budget };
}

function verifyStablePair(
  { root, baselineRoot },
  deps,
  { input, baselineSubject, candidateSubject },
) {
  requireSame(deps.environment(), input.environment, "catalog host changed during measurement");
  requireSame(
    deps.ruler(root),
    input.measurementHarnessSha256,
    "catalog ruler changed during measurement",
  );
  requireSame(deps.subject(baselineRoot), baselineSubject, "catalog baseline inputs changed");
  requireSame(deps.subject(root), candidateSubject, "catalog candidate inputs changed");
}

export function portableRegenerationOptions(args) {
  if (args.length !== 2 || args[0] !== "--baseline" || !args[1] || args[1].startsWith("-"))
    throw new TypeError(
      "usage: npm run perf:evidence:regen:tool-catalog:portable -- --baseline <git-ref>",
    );
  return { baseline: args[1] };
}

function pinnedNpm(deps) {
  const npmCli = deps.npmCli;
  if (!npmCli || !npmCli.endsWith("npm-cli.js"))
    throw new TypeError("run the portable producer through npm");
  const npmVersion = deps.run(process.execPath, [npmCli, "--version"], { encoding: "utf8" }).trim();
  if (deps.nodeVersion !== "v24.18.0" || npmVersion !== "11.16.0")
    throw new TypeError("portable catalog producer requires Node 24.18.0 and npm 11.16.0");
  return (cwd, args) => deps.run(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit" });
}

export async function regeneratePortableToolCatalogEvidence(
  { baseline },
  root = process.cwd(),
  overrides = {},
) {
  const deps = {
    run: execFileSync,
    resolve: resolveHostExecutable,
    mkdtemp: mkdtempSync,
    mkdir: mkdirSync,
    write: writeFileSync,
    measure: measurePortableToolCatalogPair,
    log: console.log,
    npmCli: process.env.npm_execpath,
    nodeVersion: process.version,
    ...overrides,
  };
  const gitExecutable = deps.resolve("git");
  const git = (args) => deps.run(gitExecutable, args, { cwd: root, encoding: "utf8" }).trim();
  const clean = () => {
    if (git(["status", "--porcelain", "--untracked-files=all"]) !== "")
      throw new TypeError("portable catalog measurement requires a clean working tree");
  };
  clean();
  const candidateCommit = git(["rev-parse", "HEAD"]);
  const baselineCommit = git(["rev-parse", "--verify", "--end-of-options", `${baseline}^{commit}`]);
  git(["merge-base", "--is-ancestor", baselineCommit, candidateCommit]);
  const npm = pinnedNpm(deps);
  const scratch = deps.mkdtemp(join(tmpdir(), "keiko-catalog-pair-"));
  const baselineRoot = join(scratch, "baseline");
  deps.mkdir(baselineRoot);
  const archive = join(scratch, "baseline.tar");
  git(["archive", "--format=tar", "--output", archive, baselineCommit]);
  deps.run(deps.resolve("tar"), ["-xf", archive, "-C", baselineRoot]);
  for (const subject of [baselineRoot, root]) {
    npm(subject, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    npm(subject, ["run", "build:packages"]);
  }
  const documents = await deps.measure({ root, baselineRoot, baselineCommit, candidateCommit });
  clean();
  requireSame(git(["rev-parse", "HEAD"]), candidateCommit, "catalog candidate revision changed");
  for (const [key, path] of Object.entries(TOOL_CATALOG_PERFORMANCE_FILES))
    deps.write(join(root, path), canonicalD12ArtifactBytes(documents[key]));
  deps.log(
    `tool-catalog-portable: PASS — paired ${baselineCommit} and ${candidateCommit}; all six ceilings unchanged`,
  );
  deps.log(`Baseline build retained for inspection: ${baselineRoot}`);
  return documents;
}

if (isMainModule(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  await regeneratePortableToolCatalogEvidence(
    portableRegenerationOptions(process.argv.slice(2)),
    root,
  );
}
