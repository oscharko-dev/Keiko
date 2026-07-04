#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET = 85;
const DEFAULT_METRIC = "lines";
const ROUNDING_EPSILON = 0.004;
const RATCHET_EPSILON = 0.1;
const METRICS = ["lines", "statements", "branches", "functions"];
const LIST_OPTIONS = new Map([
  ["coverage", "coverage"],
  ["package", "package"],
  ["exclude-package", "excludePackage"],
]);
const VALUE_OPTION_HANDLERS = new Map([
  ["root", (parsed, value) => (parsed.root = value)],
  ["baseline", (parsed, value) => (parsed.baseline = value)],
  ["write-baseline", (parsed, value) => (parsed.writeBaseline = value)],
  ["markdown", (parsed, value) => (parsed.markdown = value)],
  ["json", (parsed, value) => (parsed.json = value)],
  ["target", (parsed, value) => (parsed.target = Number(value))],
  ["metric", (parsed, value) => (parsed.metric = value)],
  // GEN-TEST-COVERAGE-003: per-file floor governance. When writing a baseline, record a lines-floor
  // for every measured file below this threshold; --enforce-file-floors then fails if any recorded
  // file regresses below its floor (critical files hiding behind green package averages).
  ["file-floor-threshold", (parsed, value) => (parsed.fileFloorThreshold = Number(value))],
]);

// GEN-TEST-COVERAGE-003: headroom (percentage points) a floored file may drift below its recorded
// value before the per-file gate fails. Matches the package ratchet's platform-noise allowance.
const FILE_FLOOR_EPSILON = 0.5;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultOptions() {
  return {
    coverage: [],
    package: [],
    excludePackage: [],
    root: undefined,
    baseline: undefined,
    writeBaseline: undefined,
    markdown: undefined,
    json: undefined,
    target: DEFAULT_TARGET,
    metric: DEFAULT_METRIC,
    strict: false,
    enforceFileFloors: false,
    fileFloorThreshold: undefined,
  };
}

function parseOptionToken(arg) {
  if (!arg.startsWith("--") || arg === "--") {
    throw new Error(`Unknown option: ${arg}`);
  }
  const [name, inlineValue] = arg.slice(2).split("=", 2);
  return { name, inlineValue };
}

function readOptionArg(argv, index) {
  const { name, inlineValue } = parseOptionToken(argv[index]);
  if (inlineValue !== undefined) {
    return { name, value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for --${name}`);
  }
  return { name, value, nextIndex: index + 1 };
}

function applyValueOption(parsed, name, value, originalArg) {
  const listKey = LIST_OPTIONS.get(name);
  if (listKey !== undefined) {
    parsed[listKey].push(value);
    return;
  }
  const handler = VALUE_OPTION_HANDLERS.get(name);
  if (handler !== undefined) {
    handler(parsed, value);
    return;
  }
  throw new Error(`Unknown option: ${originalArg}`);
}

function validateOptions(parsed) {
  if (!Number.isFinite(parsed.target) || parsed.target < 0 || parsed.target > 100) {
    throw new Error(`Invalid --target value: ${String(parsed.target)}`);
  }
  if (!METRICS.includes(parsed.metric)) {
    throw new Error(`Invalid --metric value: ${parsed.metric}`);
  }
  if (
    parsed.fileFloorThreshold !== undefined &&
    (!Number.isFinite(parsed.fileFloorThreshold) ||
      parsed.fileFloorThreshold < 0 ||
      parsed.fileFloorThreshold > 100)
  ) {
    throw new Error(`Invalid --file-floor-threshold value: ${String(parsed.fileFloorThreshold)}`);
  }
}

function parseArgs(argv) {
  const parsed = defaultOptions();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const { name } = parseOptionToken(arg);
    if (name === "strict") {
      parsed.strict = true;
      continue;
    }
    if (name === "enforce-file-floors") {
      parsed.enforceFileFloors = true;
      continue;
    }
    const option = readOptionArg(argv, i);
    applyValueOption(parsed, option.name, option.value, arg);
    i = option.nextIndex;
  }

  validateOptions(parsed);
  return parsed;
}

function pct(metric) {
  return metric.total === 0 ? 100 : (metric.covered / metric.total) * 100;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function emptyMetric() {
  return { covered: 0, total: 0 };
}

function emptyPackage(name) {
  return {
    packageName: name,
    files: 0,
    uncoveredFiles: 0,
    lines: emptyMetric(),
    statements: emptyMetric(),
    branches: emptyMetric(),
    functions: emptyMetric(),
    lowFiles: [],
  };
}

export function listPackages(root) {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir)
    .filter((name) => existsSync(join(packagesDir, name, "package.json")))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeCoverageFile(root, file) {
  const normalized = file.startsWith(root) ? relative(root, file) : file;
  return normalized.split(sep).join("/");
}

function packageFromCoveragePath(root, file) {
  const normalized = normalizeCoverageFile(root, file);
  const parts = normalized.split("/");
  if (parts[0] === "packages" && parts.length > 2) {
    return parts[1];
  }
  return undefined;
}

function recordCoverageFile(root, byPackage, file, metrics) {
  const packageName = packageFromCoveragePath(root, file);
  const record = packageName === undefined ? undefined : byPackage.get(packageName);
  if (record === undefined) return;

  record.files += 1;
  for (const metricName of METRICS) {
    record[metricName].covered += metrics[metricName].covered;
    record[metricName].total += metrics[metricName].total;
  }
  recordLineGaps(root, record, file, metrics);
}

function recordLineGaps(root, record, file, metrics) {
  const linePct = pct(metrics.lines);
  if (metrics.lines.total > 0 && metrics.lines.covered === 0) {
    record.uncoveredFiles += 1;
  }
  if (metrics.lines.total > 0 && linePct < DEFAULT_TARGET) {
    record.lowFiles.push({
      file: normalizeCoverageFile(root, file),
      lines: round(linePct),
      uncoveredLines: metrics.lines.total - metrics.lines.covered,
      totalLines: metrics.lines.total,
    });
  }
}

function toPackageResult(record) {
  return {
    packageName: record.packageName,
    files: record.files,
    uncoveredFiles: record.uncoveredFiles,
    coverage: Object.fromEntries(
      METRICS.map((metricName) => [
        metricName,
        record.files === 0 ? 0 : round(pct(record[metricName])),
      ]),
    ),
    uncoveredLines: record.lines.total - record.lines.covered,
    totalLines: record.lines.total,
    lowFiles: record.lowFiles
      .sort((left, right) => right.uncoveredLines - left.uncoveredLines)
      .slice(0, 8),
  };
}

function baselineMetricValue(baselinePackages, packageName, metric) {
  const value = baselinePackages[packageName]?.coverage?.[metric];
  return typeof value === "number" ? value : undefined;
}

function coverageFloor({ baselineValue, target, strict }) {
  if (strict || baselineValue === undefined) {
    return target;
  }
  return Math.min(target, baselineValue);
}

function coverageFloorEpsilon({ baselineValue, target, strict }) {
  const isRatchetedFloor = !strict && baselineValue !== undefined && baselineValue < target;
  return isRatchetedFloor ? RATCHET_EPSILON : ROUNDING_EPSILON;
}

function coverageStatus({ passesFloor, reachesTarget }) {
  if (!passesFloor) {
    return "failed";
  }
  return reachesTarget ? "target-met" : "ratcheted";
}

function evaluatePackageRecord({ record, baselinePackages, target, metric, strict }) {
  const current = record.coverage[metric];
  const baselineValue = baselineMetricValue(baselinePackages, record.packageName, metric);
  const floor = coverageFloor({ baselineValue, target, strict });
  const passesFloor = current + coverageFloorEpsilon({ baselineValue, target, strict }) >= floor;
  const reachesTarget = current + ROUNDING_EPSILON >= target;
  return {
    ...record,
    metric,
    target,
    floor: round(floor),
    baseline: baselineValue === undefined ? null : round(baselineValue),
    status: coverageStatus({ passesFloor, reachesTarget }),
    passes: passesFloor,
  };
}

export function aggregatePackageCoverage({ root, coverageSummaries, packages }) {
  const byPackage = new Map(packages.map((name) => [name, emptyPackage(name)]));

  for (const summary of coverageSummaries) {
    for (const [file, metrics] of Object.entries(summary)) {
      if (file === "total") continue;
      recordCoverageFile(root, byPackage, file, metrics);
    }
  }

  return [...byPackage.values()].map(toPackageResult);
}

export function evaluatePackageCoverage({ packages, baseline, target, metric, strict }) {
  const baselinePackages = baseline?.packages ?? {};
  return packages.map((record) =>
    evaluatePackageRecord({ record, baselinePackages, target, metric, strict }),
  );
}

function renderMarkdown(results) {
  const lines = [
    "| Package | Lines | Statements | Branches | Functions | Floor | Status | Main gaps |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const result of results) {
    const gaps = result.lowFiles
      .slice(0, 3)
      .map((file) => `${file.file} (${file.lines}%)`)
      .join("<br>");
    lines.push(
      `| ${result.packageName} | ${result.coverage.lines.toFixed(2)} | ${result.coverage.statements.toFixed(2)} | ${result.coverage.branches.toFixed(2)} | ${result.coverage.functions.toFixed(2)} | ${result.floor.toFixed(2)} | ${result.status} | ${gaps} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadCoverageSummaries(root, paths) {
  return paths.map((coveragePath) => {
    const absolute = resolve(root, coveragePath);
    if (!existsSync(absolute)) {
      throw new Error(`Coverage summary not found: ${absolute}`);
    }
    return readJson(absolute);
  });
}

// GEN-TEST-COVERAGE-003: flatten every measured file's line coverage from the raw v8 summaries,
// keyed by repo-relative path. This is the substrate for per-file floor enforcement (package
// averages hide 0-8% critical files behind a green mean).
export function collectFileLinePercents(root, coverageSummaries) {
  const percents = {};
  for (const summary of coverageSummaries) {
    for (const [file, metrics] of Object.entries(summary)) {
      if (file === "total") continue;
      if (metrics?.lines === undefined) continue;
      percents[normalizeCoverageFile(root, file)] = round(pct(metrics.lines));
    }
  }
  return percents;
}

// GEN-TEST-COVERAGE-003: build a per-file floor map from the current measurement — every measured
// file at or below `threshold` line% is pinned at (current - FILE_FLOOR_EPSILON), rounded, floored
// at 0. Files above the threshold are left ungoverned (the package ratchet already protects them).
export function buildFileFloors(fileLinePercents, threshold) {
  const floors = {};
  for (const [file, current] of Object.entries(fileLinePercents)) {
    if (current <= threshold) {
      floors[file] = Math.max(0, round(current - FILE_FLOOR_EPSILON));
    }
  }
  return floors;
}

// GEN-TEST-COVERAGE-003: evaluate current per-file line coverage against recorded floors. A file
// that dropped below its floor (beyond epsilon) fails; a floored file that has since VANISHED from
// the summary also fails (it was likely renamed/deleted without updating the floor map — surface it
// rather than silently pass).
export function evaluateFileFloors({ fileLinePercents, fileFloors }) {
  return Object.entries(fileFloors ?? {})
    .map(([file, floor]) => {
      const current = fileLinePercents[file];
      if (current === undefined) {
        return { file, floor, current: null, passes: false, reason: "missing" };
      }
      return {
        file,
        floor,
        current,
        passes: current + FILE_FLOOR_EPSILON >= floor,
        reason: current + FILE_FLOOR_EPSILON >= floor ? "ok" : "regressed",
      };
    })
    .sort((left, right) => (left.current ?? -1) - (right.current ?? -1));
}

export function buildCoverageBaseline({ target, metric, packages, fileFloors }) {
  return {
    schemaVersion: 1,
    target,
    metric,
    generatedBy: "scripts/check-package-coverage.mjs",
    policy:
      "Packages below target are ratcheted at their recorded baseline until domain tests raise them; non-strict ratchet floors allow 0.10 percentage points of platform noise.",
    packages: Object.fromEntries(
      packages.map((record) => [
        record.packageName,
        {
          files: record.files,
          uncoveredFiles: record.uncoveredFiles,
          uncoveredLines: record.uncoveredLines,
          totalLines: record.totalLines,
          coverage: record.coverage,
        },
      ]),
    ),
    // GEN-TEST-COVERAGE-003: optional per-file line floors for critical files hiding behind green
    // package averages. Present only when a baseline is (re)generated with --file-floor-threshold.
    ...(fileFloors !== undefined && Object.keys(fileFloors).length > 0 ? { fileFloors } : {}),
  };
}

function defaultCoveragePaths(options) {
  if (options.coverage.length > 0) {
    return options.coverage;
  }
  return [
    "coverage/packages/coverage-summary.json",
    "packages/keiko-ui/coverage/coverage-summary.json",
  ];
}

function selectPackages(allPackages, options) {
  if (options.package.length > 0) {
    return allPackages.filter((name) => options.package.includes(name));
  }
  return allPackages.filter((name) => !options.excludePackage.includes(name));
}

function loadBaseline(root, options, generatedBaseline) {
  if (options.baseline !== undefined) {
    return readJson(resolve(root, options.baseline));
  }
  return options.writeBaseline === undefined ? undefined : generatedBaseline;
}

function writeReportOutputs(root, options, results, generatedBaseline) {
  if (options.writeBaseline !== undefined) {
    writeJson(resolve(root, options.writeBaseline), generatedBaseline);
  }
  if (options.markdown !== undefined) {
    const markdownPath = resolve(root, options.markdown);
    mkdirSync(dirname(markdownPath), { recursive: true });
    writeFileSync(markdownPath, renderMarkdown(results), "utf8");
  }
  if (options.json !== undefined) {
    writeJson(resolve(root, options.json), {
      target: options.target,
      metric: options.metric,
      results,
    });
  }
}

function printCoverageOutcome(options, results) {
  console.log(renderMarkdown(results));

  const failures = results.filter((result) => !result.passes);
  const targetMisses = results.filter((result) => result.status === "ratcheted");
  if (targetMisses.length > 0) {
    console.log(
      `coverage: ${targetMisses.length} package(s) are below ${options.target}% ${options.metric} and are protected by ratchet floors.`,
    );
  }
  if (failures.length === 0) {
    console.log(`coverage: PASS — all selected packages satisfy their ${options.metric} floors.`);
    return;
  }
  console.error(
    `coverage: FAIL — ${failures.length} package(s) fell below their ${options.metric} floor.`,
  );
  process.exitCode = 1;
}

function printFileFloorOutcome(evaluations) {
  const violations = evaluations.filter((entry) => !entry.passes);
  console.log(
    `file-floors: ${String(evaluations.length)} governed file(s) checked; ${String(violations.length)} violation(s).`,
  );
  if (violations.length === 0) {
    console.log(
      "file-floors: PASS — no governed critical file regressed below its recorded floor.",
    );
    return;
  }
  for (const violation of violations) {
    const current = violation.current === null ? "missing" : `${String(violation.current)}%`;
    console.error(
      `file-floors: FAIL — ${violation.file} is ${current} (floor ${String(violation.floor)}%, ${violation.reason}).`,
    );
  }
  process.exitCode = 1;
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = resolve(options.root ?? scriptRoot);
  const allPackages = listPackages(root);
  const coverageSummaries = loadCoverageSummaries(root, defaultCoveragePaths(options));
  const aggregated = aggregatePackageCoverage({
    root,
    coverageSummaries,
    packages: selectPackages(allPackages, options),
  });
  const fileLinePercents = collectFileLinePercents(root, coverageSummaries);
  const generatedBaseline = buildCoverageBaseline({
    target: options.target,
    metric: options.metric,
    packages: aggregated,
    fileFloors:
      options.fileFloorThreshold === undefined
        ? undefined
        : buildFileFloors(fileLinePercents, options.fileFloorThreshold),
  });
  const baseline = loadBaseline(root, options, generatedBaseline);
  const results = evaluatePackageCoverage({
    packages: aggregated,
    baseline,
    target: options.target,
    metric: options.metric,
    strict: options.strict,
  });

  writeReportOutputs(root, options, results, generatedBaseline);
  printCoverageOutcome(options, results);

  // GEN-TEST-COVERAGE-003: per-file floor enforcement runs alongside the package ratchet so a
  // critical file (e.g. a 0-8% requirements-ingestion or verification-monitor module) cannot regress
  // further while its package average stays green.
  if (options.enforceFileFloors) {
    printFileFloorOutcome(
      evaluateFileFloors({ fileLinePercents, fileFloors: baseline?.fileFloors ?? {} }),
    );
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
