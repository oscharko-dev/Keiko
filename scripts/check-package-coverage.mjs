#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { KEIKO_REPOSITORY_GATE_CONTRACT } from "./sonar-quality-gate-contract.mjs";
import { readJsonFile } from "./lib/json.mjs";

// ADR-0158 D3: the constitutional 85 has exactly one definition. The package ratchet target and
// SonarCloud's `new_coverage` condition are the same number by construction rather than by two
// independently maintained copies that happen to agree today.
export const CONSTITUTIONAL_COVERAGE_MINIMUM =
  KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum;

// ADR-0158 D1: `fileFloors` is the single per-file floor store. Schema 2 carries all four metrics
// and a per-entry tolerance; schema 1 carried a bare lines number at a fixed tolerance. A mixed
// state is rejected rather than half-enforced.
export const COVERAGE_BASELINE_SCHEMA_VERSION = 2;

const DEFAULT_METRIC = "lines";
const ROUNDING_EPSILON = 0.004;
const RATCHET_EPSILON = 0.1;
const METRICS = ["lines", "statements", "branches", "functions"];
const FILE_FLOOR_GOVERNANCE = new Set(["ratcheted", "absolute"]);

// ADR-0158 D1: headroom (percentage points) a ratcheted floored file may drift below its recorded
// value before the per-file gate fails. Matches the package ratchet's platform-noise allowance.
// Entries governed as "absolute" carry tolerance 0 and are compared against the raw measurement.
const RATCHETED_FILE_FLOOR_TOLERANCE = 0.5;

const LIST_OPTIONS = new Map([
  ["coverage", "coverage"],
  ["package", "package"],
  ["exclude-package", "excludePackage"],
]);
const VALUE_OPTION_HANDLERS = new Map([
  ["root", (parsed, value) => (parsed.root = value)],
  ["baseline", (parsed, value) => (parsed.baseline = value)],
  ["write-baseline", (parsed, value) => (parsed.writeBaseline = value)],
  ["json", (parsed, value) => (parsed.json = value)],
  ["target", (parsed, value) => (parsed.target = Number(value))],
  ["metric", (parsed, value) => (parsed.metric = value)],
  // ADR-0158 D2: a strict release lines target for one package, evaluated in the same pass as the
  // ratchet instead of by a second process re-parsing the same summaries.
  ["release-target", (parsed, value) => parsed.releaseTargets.push(parseReleaseTarget(value))],
  // ADR-0158 D1: when writing a baseline, record a ratcheted floor for every measured file at or
  // below this lines threshold; --enforce-file-floors then fails if any governed file regresses
  // below its floor (critical files hiding behind green package averages).
  ["file-floor-threshold", (parsed, value) => (parsed.fileFloorThreshold = Number(value))],
]);

const BOOLEAN_OPTIONS = new Map([
  ["strict", "strict"],
  ["enforce-file-floors", "enforceFileFloors"],
  // ADR-0158 D2: evaluate lines, statements, branches and functions in one parse of the summaries.
  ["all-metrics", "allMetrics"],
]);

function isPercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function defaultOptions() {
  return {
    coverage: [],
    package: [],
    excludePackage: [],
    releaseTargets: [],
    root: undefined,
    baseline: undefined,
    writeBaseline: undefined,
    json: undefined,
    target: CONSTITUTIONAL_COVERAGE_MINIMUM,
    metric: DEFAULT_METRIC,
    strict: false,
    allMetrics: false,
    enforceFileFloors: false,
    fileFloorThreshold: undefined,
  };
}

function parseReleaseTarget(value) {
  const separator = value.lastIndexOf("=");
  const packageName = separator <= 0 ? "" : value.slice(0, separator);
  const target = separator <= 0 ? Number.NaN : Number(value.slice(separator + 1));
  if (packageName === "" || !isPercent(target)) {
    throw new Error(`Invalid --release-target value: ${value} (expected <package>=<percent>)`);
  }
  return { packageName, target };
}

function parseOptionToken(arg) {
  if (!arg.startsWith("--") || arg === "--") {
    throw new Error(`Unknown option: ${arg}`);
  }
  // Split on the FIRST "=" and keep the whole remainder: `String.split("=", 2)` silently discards
  // everything after the second separator, which truncated `--release-target=keiko-cli=87` to
  // `keiko-cli` and would have governed a package at an undefined target.
  const body = arg.slice(2);
  const separator = body.indexOf("=");
  if (separator === -1) return { name: body, inlineValue: undefined };
  return { name: body.slice(0, separator), inlineValue: body.slice(separator + 1) };
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
  if (!isPercent(parsed.target)) {
    throw new Error(`Invalid --target value: ${String(parsed.target)}`);
  }
  if (!METRICS.includes(parsed.metric)) {
    throw new Error(`Invalid --metric value: ${parsed.metric}`);
  }
  if (parsed.fileFloorThreshold !== undefined && !isPercent(parsed.fileFloorThreshold)) {
    throw new Error(`Invalid --file-floor-threshold value: ${String(parsed.fileFloorThreshold)}`);
  }
}

export function parseArgs(argv) {
  const parsed = defaultOptions();

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const { name } = parseOptionToken(arg);
    const booleanKey = BOOLEAN_OPTIONS.get(name);
    if (booleanKey !== undefined) {
      parsed[booleanKey] = true;
      i += 1;
      continue;
    }
    const option = readOptionArg(argv, i);
    applyValueOption(parsed, option.name, option.value, arg);
    i = option.nextIndex + 1;
  }

  validateOptions(parsed);
  return parsed;
}

export function selectedMetrics(options) {
  return options.allMetrics ? [...METRICS] : [options.metric];
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

// KEIKO-0125 — the baseline's `files` is derived from the v8 coverage summary, which only ever
// contains files a test actually imported. A source file no test touches never appears in the
// summary at all, so a package can silently record fewer files than it really has: keiko-sandbox
// recorded 6 against 9 real sources, and every one of the 3 invisible files was ungated. These two
// arrays are a duplicate of `coverage.include`/`coverage.exclude` in
// `vitest.coverage.packages.config.ts` kept honest by a parity test
// (`scripts/__tests__/check-package-coverage.test.mjs`), which imports the real config and asserts
// they are identical — the config cannot be imported from a plain `.mjs` script without pulling in
// vitest, so this is the "duplicate with a parity test" side of AGENTS.md's rule rather than a
// second hand-written definition that could drift.
export const PACKAGE_COVERAGE_INCLUDE = [
  "packages/*/src/**/*.{ts,tsx}",
  "src/**/*.{ts,tsx}",
  "scripts/check-lcov-source-mapping.mjs",
  "scripts/check-mutation-quality.mjs",
  "scripts/check-mutation-scope.mjs",
  "scripts/check-sonar-analysis-log.mjs",
  "scripts/check-sonar-main-quality-gate.mjs",
  "scripts/check-sonar-pr-quality-gate.mjs",
  "scripts/sonar-analysis-scope.mjs",
  "scripts/sonar-quality-gate-contract.mjs",
];
export const PACKAGE_COVERAGE_EXCLUDE = [
  "packages/keiko-ui/**",
  "**/*.test.*",
  "**/__tests__/**",
  "**/_support.ts",
  "**/test-support.ts",
  // KEIKO-0130: shared per-package test-fixture modules live under `src/test-support/` and are
  // never bundled into the package's public surface. Excluded from the coverage inventory for
  // the same reason `**/test-support.ts` is.
  "**/test-support/**",
  "**/test-fixtures.ts",
  "**/testing.ts",
  "**/*.config.ts",
  "dist/**",
  "node_modules/**",
];

// keiko-ui is excluded from the package coverage run because it is measured by its own
// (packages/keiko-ui/vitest.coverage.config.ts) — not because it has no sources. Asking "what would
// the coverage run measure here" therefore has to use the globs of the run that actually measures
// that package, or keiko-ui's live inventory comes back 0 against a real 248-file entry.
const UI_PACKAGE = "keiko-ui";
export const UI_COVERAGE_INCLUDE = ["packages/keiko-ui/src/**/*.{ts,tsx}"];
export const UI_COVERAGE_EXCLUDE = [
  "**/*.test.*",
  "**/__tests__/**",
  "**/_support.ts",
  "**/test-support.ts",
  "**/test-fixtures.ts",
  "**/testing.ts",
  "packages/keiko-ui/.next/**",
  "packages/keiko-ui/out/**",
];

function coverageGlobsFor(packageName) {
  return packageName === UI_PACKAGE
    ? { include: UI_COVERAGE_INCLUDE, exclude: UI_COVERAGE_EXCLUDE }
    : { include: PACKAGE_COVERAGE_INCLUDE, exclude: PACKAGE_COVERAGE_EXCLUDE };
}

function isMeasuredSourcePath(repoRelativePath, { include, exclude }) {
  if (exclude.some((glob) => matchesGlob(repoRelativePath, glob))) return false;
  return include.some((glob) => matchesGlob(repoRelativePath, glob));
}

// A symlink entry reports neither isDirectory() nor isFile(), so a naive walk silently skips a
// symlinked source file or directory — the live inventory would then undercount against a coverage
// run that follows it, and the reality guard would fail with a mismatch that names no cause. v8
// measures whatever the module graph resolves to, so this follows symlinks to match, and a broken
// one fails loudly rather than disappearing.
// `seen` holds the REAL path of every directory already walked. Following symlinks (above) without
// it lets a link pointing at an ancestor recurse until the path or the stack is exhausted, and lets
// two links to the same directory list its files twice — a hang or a double-count in a gate whose
// whole job is to produce one honest number.
function walkSourceFiles(directory, seen = new Set()) {
  const real = realpathSync(directory);
  if (seen.has(real)) return [];
  seen.add(real);
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    const stats = entry.isSymbolicLink() ? statSync(child) : entry;
    if (stats.isDirectory()) found.push(...walkSourceFiles(child, seen));
    else if (stats.isFile()) found.push(child);
  }
  return found;
}

/** Repository-relative source files the coverage run would measure for one workspace package. */
export function listPackageSourceFiles(root, packageName) {
  const packageSrc = join(root, "packages", packageName, "src");
  if (!existsSync(packageSrc)) return [];
  const globs = coverageGlobsFor(packageName);
  return walkSourceFiles(packageSrc)
    .map((absolute) => relative(root, absolute).split(sep).join("/"))
    .filter((repoRelativePath) => isMeasuredSourcePath(repoRelativePath, globs))
    .sort((left, right) => left.localeCompare(right));
}

export function countPackageSourceFiles(root, packageName) {
  return listPackageSourceFiles(root, packageName).length;
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
  if (metrics.lines.total > 0 && linePct < CONSTITUTIONAL_COVERAGE_MINIMUM) {
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

// ADR-0158 D2: the strict keiko-ui 88 / keiko-cli 87 release lines targets. They dominate the 85
// ratchet on the same metric, which is what makes removing the duplicate 85 evaluations valid — so
// they are evaluated here, in the same required pass, and fail closed when the package was not
// measured at all.
export function evaluateReleaseTargets({ packages, releaseTargets }) {
  const byName = new Map(packages.map((record) => [record.packageName, record]));
  return (releaseTargets ?? []).map(({ packageName, target }) => {
    const record = byName.get(packageName);
    if (record === undefined) {
      return { packageName, target, current: null, passes: false, reason: "not-measured" };
    }
    const current = record.coverage.lines;
    const passes = current + ROUNDING_EPSILON >= target;
    return { packageName, target, current, passes, reason: passes ? "ok" : "below-target" };
  });
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
    return readJsonFile(absolute);
  });
}

// ADR-0158 D1: flatten every measured file's four metrics from the raw v8 summaries, keyed by
// repo-relative path. Percentages stay UNROUNDED: the per-file engine compares against them
// directly, so a zero-tolerance floor cannot be satisfied by a rounding step the way it could if
// the comparison basis were rounded first.
export function collectFilePercents(root, coverageSummaries) {
  const percents = {};
  for (const summary of coverageSummaries) {
    for (const [file, metrics] of Object.entries(summary)) {
      if (file === "total") continue;
      if (metrics?.lines === undefined) continue;
      percents[normalizeCoverageFile(root, file)] = Object.fromEntries(
        METRICS.filter((metric) => metrics[metric] !== undefined).map((metric) => [
          metric,
          pct(metrics[metric]),
        ]),
      );
    }
  }
  return percents;
}

function sortedByKey(entries) {
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
  );
}

// ADR-0158 D1: rebuild the ratcheted half of the floor store from the current measurement — every
// measured file at or below `threshold` lines% is pinned at (current - tolerance), rounded, floored
// at 0. Files above the threshold stay ungoverned (the package ratchet already protects them).
// Entries governed as "absolute" encode a policy rather than a measurement, so they are carried
// over verbatim: a regeneration must never be able to erase the gate-script floors.
export function buildFileFloors(filePercents, threshold, carriedOver = {}) {
  const floors = Object.fromEntries(
    Object.entries(carriedOver).filter(([, entry]) => entry?.governance === "absolute"),
  );
  for (const [file, metrics] of Object.entries(filePercents)) {
    const lines = metrics.lines;
    if (floors[file] !== undefined || lines === undefined || lines > threshold) continue;
    floors[file] = {
      governance: "ratcheted",
      tolerance: RATCHETED_FILE_FLOOR_TOLERANCE,
      lines: ratchetedFloor(lines, carriedOver[file]),
    };
  }
  return sortedByKey(floors);
}

// A ratchet only turns one way. Deriving the floor purely from the current measurement meant that
// regenerating the baseline AFTER a regression wrote a LOWER floor and called it a new baseline —
// the one operation `docs/qa/coverage-truth-model.md` tells an operator never to perform, available
// as a side effect of the command that document recommends. A file that improved still raises its
// floor; a file that regressed keeps the one it has to earn back.
function ratchetedFloor(current, carriedOverEntry) {
  const derived = Math.max(0, round(current - RATCHETED_FILE_FLOOR_TOLERANCE));
  const previous =
    carriedOverEntry?.governance === "ratcheted" ? carriedOverEntry.lines : undefined;
  return typeof previous === "number" ? Math.max(previous, derived) : derived;
}

function evaluateFileFloorMetric({ file, metric, floor, tolerance, measured }) {
  const current = measured?.[metric];
  if (current === undefined) {
    return { file, metric, floor, tolerance, current: null, passes: false, reason: "missing" };
  }
  const passes = current + tolerance >= floor;
  return {
    file,
    metric,
    floor,
    tolerance,
    current: round(current),
    passes,
    reason: passes ? "ok" : "regressed",
  };
}

function compareFileFloorResults(left, right) {
  const byCurrent = (left.current ?? -1) - (right.current ?? -1);
  if (byCurrent !== 0) return byCurrent;
  return `${left.file}:${left.metric}`.localeCompare(`${right.file}:${right.metric}`);
}

// ADR-0158 D1: evaluate the current per-file measurement against the single floor store. A file that
// dropped below a governed floor (beyond its own tolerance) fails; a governed file that has since
// VANISHED from the summary also fails (it was likely renamed or deleted without updating the store
// — surface it rather than silently pass).
export function evaluateFileFloors({ filePercents, fileFloors }) {
  const results = [];
  for (const [file, entry] of Object.entries(fileFloors ?? {})) {
    const measured = filePercents[file];
    for (const metric of METRICS) {
      if (typeof entry[metric] !== "number") continue;
      results.push(
        evaluateFileFloorMetric({
          file,
          metric,
          floor: entry[metric],
          tolerance: entry.tolerance,
          measured,
        }),
      );
    }
  }
  return results.sort(compareFileFloorResults);
}

function fileFloorEntryFailures(file, entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [
      `file floor "${file}" uses the retired schema-1 shape (a bare lines number). ` +
        "Schema 1 was replaced by ADR-0158; restore the committed baseline instead of half-migrating it.",
    ];
  }
  if (!FILE_FLOOR_GOVERNANCE.has(entry.governance)) {
    return [`file floor "${file}" declares no governance ("ratcheted" or "absolute").`];
  }
  if (!isPercent(entry.tolerance)) {
    return [`file floor "${file}" declares no numeric tolerance.`];
  }
  const governed = METRICS.filter((metric) => entry[metric] !== undefined);
  if (governed.length === 0) {
    return [`file floor "${file}" governs no metric.`];
  }
  // An unrecognised key is rejected rather than ignored. `docs/qa/coverage-truth-model.md` tells an
  // operator to add "absolute" entries by hand, and a typo such as `lnes: 90` would otherwise leave
  // the file looking governed on that metric while nothing evaluated it — the silent under-governance
  // this whole consolidation exists to make impossible.
  const unknown = Object.keys(entry).filter(
    (key) => key !== "governance" && key !== "tolerance" && !METRICS.includes(key),
  );
  return [
    ...unknown.map((key) => `file floor "${file}" declares unknown key "${key}".`),
    ...governed
      .filter((metric) => !isPercent(entry[metric]))
      .map((metric) => `file floor "${file}" has an invalid ${metric} floor.`),
  ];
}

// ADR-0158 D1: a baseline that is not exactly the governed schema fails the gate closed. The
// schemaVersion bump is what makes a mixed old/new state impossible to half-enforce, and the target
// check is what keeps the constitutional minimum from drifting away from its one definition.
export function baselineSchemaFailures(baseline) {
  if (baseline === undefined) return [];
  const failures = [];
  if (baseline.schemaVersion !== COVERAGE_BASELINE_SCHEMA_VERSION) {
    failures.push(
      `coverage baseline schemaVersion ${String(baseline.schemaVersion)} is not the governed ` +
        `${String(COVERAGE_BASELINE_SCHEMA_VERSION)}.`,
    );
  }
  if (baseline.target !== CONSTITUTIONAL_COVERAGE_MINIMUM) {
    failures.push(
      `coverage baseline target ${String(baseline.target)} drifted from the one governed minimum ` +
        `${String(CONSTITUTIONAL_COVERAGE_MINIMUM)} (KEIKO_REPOSITORY_GATE_CONTRACT).`,
    );
  }
  for (const [file, entry] of Object.entries(baseline.fileFloors ?? {})) {
    failures.push(...fileFloorEntryFailures(file, entry));
  }
  return failures;
}

export function buildCoverageBaseline({ metric, packages, fileFloors }) {
  return {
    schemaVersion: COVERAGE_BASELINE_SCHEMA_VERSION,
    // The constitutional minimum is recorded, never chosen here: it has one definition
    // (KEIKO_REPOSITORY_GATE_CONTRACT.newCodeCoverageMinimum) and this file mirrors it.
    target: CONSTITUTIONAL_COVERAGE_MINIMUM,
    metric,
    generatedBy: "scripts/check-package-coverage.mjs",
    policy:
      "Packages below target are ratcheted at their recorded baseline until domain tests raise them; " +
      "non-strict ratchet floors allow 0.10 percentage points of platform noise. Per-file floors are " +
      'governed per entry: "ratcheted" floors are re-derived from measurement and allow 0.50 points, ' +
      '"absolute" floors encode policy, survive regeneration and allow none.',
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
    // ADR-0158 D1: the single per-file floor store — four metrics, per-entry tolerance and
    // governance. This is the only place a per-file floor lives.
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

function renderMarkdown(results) {
  const lines = [
    "| Package | Lines | Statements | Branches | Functions | Main gaps |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const result of results) {
    const gaps = result.lowFiles
      .slice(0, 3)
      .map((file) => `${file.file} (${String(file.lines)}%)`)
      .join("<br>");
    const columns = METRICS.map((metric) => result.coverage[metric].toFixed(2)).join(" | ");
    lines.push(`| ${result.packageName} | ${columns} | ${gaps} |`);
  }
  return `${lines.join("\n")}\n`;
}

function reportMetricOutcome(metric, results) {
  const failures = results.filter((result) => !result.passes);
  const ratcheted = results.filter((result) => result.status === "ratcheted");
  for (const failure of failures) {
    console.error(
      `coverage: FAIL — ${failure.packageName} ${metric} is ${String(failure.coverage[metric])}% ` +
        `(floor ${String(failure.floor)}%).`,
    );
  }
  if (failures.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `coverage: PASS — ${String(results.length)} package(s) satisfy their ${metric} floors ` +
      `(${String(ratcheted.length)} protected by a ratchet below target).`,
  );
}

function reportReleaseTargets(evaluations) {
  for (const evaluation of evaluations.filter((entry) => !entry.passes)) {
    const current = evaluation.current === null ? "not measured" : `${String(evaluation.current)}%`;
    console.error(
      `release-target: FAIL — ${evaluation.packageName} lines is ${current} ` +
        `(strict target ${String(evaluation.target)}%, ${evaluation.reason}).`,
    );
  }
  if (evaluations.some((entry) => !entry.passes)) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `release-target: PASS — ${String(evaluations.length)} strict release lines target(s) met.`,
  );
}

function reportFileFloors(evaluations) {
  const violations = evaluations.filter((entry) => !entry.passes);
  console.log(
    `file-floors: ${String(evaluations.length)} governed floor(s) checked; ` +
      `${String(violations.length)} violation(s).`,
  );
  for (const violation of violations) {
    const current = violation.current === null ? "missing" : `${String(violation.current)}%`;
    console.error(
      `file-floors: FAIL — ${violation.file} ${violation.metric} is ${current} ` +
        `(floor ${String(violation.floor)}%, tolerance ${String(violation.tolerance)}, ${violation.reason}).`,
    );
  }
  if (violations.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("file-floors: PASS — no governed file regressed below its recorded floor.");
}

function loadEvaluationContext(root, options) {
  const coverageSummaries = loadCoverageSummaries(root, defaultCoveragePaths(options));
  const packages = aggregatePackageCoverage({
    root,
    coverageSummaries,
    packages: selectPackages(listPackages(root), options),
  });
  const filePercents = collectFilePercents(root, coverageSummaries);
  const existing =
    options.baseline === undefined ? undefined : readJsonFile(resolve(root, options.baseline));
  const failures = baselineSchemaFailures(existing);
  if (failures.length > 0) {
    throw new Error(
      `coverage baseline is not the governed schema:\n  - ${failures.join("\n  - ")}`,
    );
  }
  const generated = buildCoverageBaseline({
    metric: options.metric,
    packages,
    fileFloors:
      options.fileFloorThreshold === undefined
        ? existing?.fileFloors
        : buildFileFloors(filePercents, options.fileFloorThreshold, existing?.fileFloors),
  });
  // No baseline on disk means no ratchet: every package is then judged against the bare target.
  // The generated baseline stands in ONLY while writing one, never as a self-referential floor that
  // every package would satisfy by construction. `existing` is carried separately because per-file
  // enforcement must read the committed store and nothing else (see requireFileFloorStore).
  const baseline = existing ?? (options.writeBaseline === undefined ? undefined : generated);
  return { packages, filePercents, generated, existing, baseline };
}

// ADR-0158 D1: an enforcement pass that governs nothing must not be indistinguishable from a
// satisfied one. `--enforce-file-floors` against a missing or empty store used to print
// "file-floors: PASS", so a dropped `--baseline` in CI wiring would have retired the per-file gate
// in silence — and pointing it at a self-generated baseline would have judged the run against floors
// derived from that same run. Both now fail closed, which is the whole reason this store is single.
function requireFileFloorStore(existingBaseline) {
  const floors = existingBaseline?.fileFloors;
  if (floors === undefined || Object.keys(floors).length === 0) {
    throw new Error(
      "--enforce-file-floors governs no file: pass --baseline <committed baseline> that carries a " +
        "non-empty fileFloors store. Enforcing nothing must not report PASS.",
    );
  }
  return floors;
}

function evaluateAll(options, context) {
  const metrics = selectedMetrics(options);
  return {
    metrics,
    byMetric: new Map(
      metrics.map((metric) => [
        metric,
        evaluatePackageCoverage({
          packages: context.packages,
          baseline: context.baseline,
          target: options.target,
          metric,
          strict: options.strict,
        }),
      ]),
    ),
    releaseTargets: evaluateReleaseTargets({
      packages: context.packages,
      releaseTargets: options.releaseTargets,
    }),
    fileFloors: options.enforceFileFloors
      ? evaluateFileFloors({
          filePercents: context.filePercents,
          fileFloors: requireFileFloorStore(context.existing),
        })
      : undefined,
  };
}

function writeReportOutputs(root, options, context, evaluation) {
  if (options.writeBaseline !== undefined) {
    writeJson(resolve(root, options.writeBaseline), context.generated);
  }
  if (options.json !== undefined) {
    writeJson(resolve(root, options.json), {
      target: options.target,
      metrics: evaluation.metrics,
      results: Object.fromEntries(evaluation.byMetric),
      releaseTargets: evaluation.releaseTargets,
      fileFloors: evaluation.fileFloors ?? [],
    });
  }
}

function printEvaluation(context, evaluation) {
  console.log(renderMarkdown(context.packages));
  for (const metric of evaluation.metrics) {
    reportMetricOutcome(metric, evaluation.byMetric.get(metric));
  }
  if (evaluation.releaseTargets.length > 0) {
    reportReleaseTargets(evaluation.releaseTargets);
  }
  if (evaluation.fileFloors !== undefined) {
    reportFileFloors(evaluation.fileFloors);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = resolve(options.root ?? scriptRoot);
  const context = loadEvaluationContext(root, options);
  const evaluation = evaluateAll(options, context);
  writeReportOutputs(root, options, context, evaluation);
  printEvaluation(context, evaluation);
  return evaluation;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
