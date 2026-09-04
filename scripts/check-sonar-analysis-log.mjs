#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { optionValue } from "./sonar-analysis-scope.mjs";

function warningLines(contents) {
  return contents
    .split(/\r?\n/u)
    .filter((line) => /(?:^|\s)WARN(?:ING)?(?:\s|:|-)/iu.test(line) || /\[WARN\]/u.test(line));
}

// SonarCloud emits this SCM-metadata WARN when git blame attributes zero changed lines to a file
// that is still in the changed-file set. This is common and benign for pull-request analysis of the
// GitHub merge ref: it carries no rule, coverage, or rating signal, and the SonarCloud quality gate
// continues to enforce all of those. Exempt only this exact wording so every other WARN/ERROR the
// scanner emits still fails the gate. See docs/adr/ADR-0139-agent-first-deterministic-quality-gates.md.
const benignScmMetadataWarning =
  /File '[^']*' was detected as changed but without having changed lines/u;

function isBenignScmMetadataWarning(line) {
  return benignScmMetadataWarning.test(line);
}

const forbiddenDiagnostics = [
  /CFamily analysis configuration mode:\s*AutoConfig/iu,
  /C# files which cannot be analyzed/iu,
  /Could not determine common base path/iu,
  /(?:LCOV|coverage report).*(?:could not|cannot|does not exist|not found|unresolved)/iu,
  /SCM.*(?:disabled|failed|missing|not available|no revision)/iu,
];

export function sonarLogFailures(contents) {
  const lines = contents.split(/\r?\n/u);
  const warnings = warningLines(contents)
    .filter((line) => !isBenignScmMetadataWarning(line))
    .map((line) => `scanner warning: ${line.trim()}`);
  const forbidden = lines
    .filter((line) => forbiddenDiagnostics.some((pattern) => pattern.test(line)))
    .map((line) => `forbidden scanner diagnostic: ${line.trim()}`);
  return [...new Set([...warnings, ...forbidden])];
}

const ANALYZED_SOURCE_SUFFIXES = [
  " source file has been analyzed",
  " source files have been analyzed",
];
const JAVASCRIPT_ANALYSIS_SENSOR = "Sensor JavaScript/TypeScript/CSS analysis [javascript]";
const JAVASCRIPT_CACHE_HIT_PREFIX = "Hit the cache for ";
const JAVASCRIPT_CACHE_MISS_PREFIX = "Miss the cache for ";
const UDG_CACHE_SOURCE_SUFFIX = " source file(s) without a UDG";
const SONARJASMIN_SOURCE_SUFFIX = " file(s) will be analysed by SonarJasmin.";
const UDG_RECEIPT_PREFIX = 'Files successfully loaded: "';
const UDG_RECEIPT_SEPARATOR = '" out of "';
const ARCHITECTURE_SENSORS = [
  { language: "js", name: "JsArchitectureSensor" },
  { language: "ts", name: "TsArchitectureSensor" },
];
// Sonar indexes repository material that is not eligible for its JavaScript/TypeScript program.
// Hosted full scans currently cover about 87% of that inventory. An 80% committed floor leaves
// room for those exclusions while rejecting a narrow self-consistent changed-file analysis.
const MINIMUM_FULL_ANALYSIS_RATIO = 0.8;

function decimalInteger(token) {
  const value = Number(token);
  return Number.isSafeInteger(value) && String(value) === token ? value : undefined;
}

function analyzedSourceProgress(line) {
  for (const suffix of ANALYZED_SOURCE_SUFFIXES) {
    const suffixAt = line.indexOf(suffix);
    if (suffixAt < 0) continue;
    const tokenAt = line.lastIndexOf(" ", suffixAt - 1) + 1;
    const token = line.slice(tokenAt, suffixAt);
    const separatorAt = token.indexOf("/");
    if (separatorAt <= 0 || separatorAt !== token.lastIndexOf("/")) return undefined;
    const analyzedText = token.slice(0, separatorAt);
    const totalText = token.slice(separatorAt + 1);
    const analyzed = decimalInteger(analyzedText);
    const total = decimalInteger(totalText);
    if (analyzed === undefined || total === undefined) return undefined;
    return { analyzed, total };
  }
  return undefined;
}

function largestAnalyzedSourceSet(lines) {
  return lines.reduce(
    (largest, line) => {
      const progress = analyzedSourceProgress(line);
      const isLarger =
        progress !== undefined &&
        (progress.total > largest.total ||
          (progress.total === largest.total && progress.analyzed > largest.analyzed));
      return isLarger ? progress : largest;
    },
    { analyzed: 0, total: 0 },
  );
}

function countPairAfterPrefix(line, prefix) {
  const prefixAt = line.indexOf(prefix);
  if (prefixAt < 0) return undefined;
  const match = /^(\d+) out of (\d+)(?:\D|$)/u.exec(line.slice(prefixAt + prefix.length));
  if (match === null) return undefined;
  const count = decimalInteger(match[1]);
  const total = decimalInteger(match[2]);
  return count === undefined || total === undefined ? undefined : { count, total };
}

function javascriptAnalysisCacheEvidence(lines) {
  const hits = [];
  const misses = [];
  let insideSensor = false;
  for (const line of lines) {
    if (line.includes(`${JAVASCRIPT_ANALYSIS_SENSOR} (done)`)) {
      insideSensor = false;
      continue;
    }
    if (line.includes(JAVASCRIPT_ANALYSIS_SENSOR)) {
      insideSensor = true;
      continue;
    }
    if (!insideSensor) continue;
    const hit = countPairAfterPrefix(line, JAVASCRIPT_CACHE_HIT_PREFIX);
    const miss = countPairAfterPrefix(line, JAVASCRIPT_CACHE_MISS_PREFIX);
    if (hit !== undefined) hits.push(hit);
    if (miss !== undefined) misses.push(miss);
  }
  return { hits, misses };
}

function isExactFreshJavascriptAnalysis(evidence) {
  if (evidence.hits.length !== 1 || evidence.misses.length !== 1) return false;
  const hit = evidence.hits[0];
  const miss = evidence.misses[0];
  if (hit === undefined || miss === undefined) return false;
  return hit.total > 0 && hit.count === 0 && miss.count === hit.total && miss.total === hit.total;
}

function cacheReceiptSummary(receipt) {
  return receipt === undefined ? "0/0" : `${String(receipt.count)}/${String(receipt.total)}`;
}

function javascriptAnalysisCacheFailures(lines) {
  const evidence = javascriptAnalysisCacheEvidence(lines);
  if (isExactFreshJavascriptAnalysis(evidence)) return [];
  return [
    `JavaScript/TypeScript cache evidence ${cacheReceiptSummary(evidence.hits[0])} hit and ` +
      `${cacheReceiptSummary(evidence.misses[0])} missed does not prove an exact fresh analysis`,
  ];
}

function integerBeforeSuffix(line, suffix) {
  const suffixAt = line.indexOf(suffix);
  if (suffixAt < 0) return undefined;
  const tokenAt = line.lastIndexOf(" ", suffixAt - 1) + 1;
  return decimalInteger(line.slice(tokenAt, suffixAt));
}

function architectureUdgReceipt(line) {
  const prefixAt = line.indexOf(UDG_RECEIPT_PREFIX);
  if (prefixAt < 0) return undefined;
  const loadedAt = prefixAt + UDG_RECEIPT_PREFIX.length;
  const separatorAt = line.indexOf(UDG_RECEIPT_SEPARATOR, loadedAt);
  if (separatorAt < 0) return undefined;
  const totalAt = separatorAt + UDG_RECEIPT_SEPARATOR.length;
  const totalEnd = line.indexOf('"', totalAt);
  if (totalEnd < 0) return undefined;
  const loaded = decimalInteger(line.slice(loadedAt, separatorAt));
  const total = decimalInteger(line.slice(totalAt, totalEnd));
  return loaded === undefined || total === undefined ? undefined : { loaded, total };
}

function architectureUdgEvidence(lines) {
  const largestCount = (suffix) =>
    lines.reduce((largest, line) => {
      const count = integerBeforeSuffix(line, suffix);
      if (count === undefined) return largest;
      return largest === undefined ? count : Math.max(largest, count);
    }, undefined);
  // The UDG-cache inventory is measured before SonarJasmin decides which files it will load, so
  // the two values may legitimately differ. Bind the receipts to SonarJasmin's own plan when the
  // current analyzer emits it; retain the cache inventory only as a legacy-log fallback.
  const sonarJasminExpected = largestCount(SONARJASMIN_SOURCE_SUFFIX);
  const expected = sonarJasminExpected ?? largestCount(UDG_CACHE_SOURCE_SUFFIX);
  const receiptLines = lines.filter((line) => line.includes("Files successfully loaded:"));
  const receipts = receiptLines.flatMap((line) => architectureUdgReceipt(line) ?? []);
  const totals = receipts.reduce(
    (evidence, receipt) => ({
      loaded: evidence.loaded + receipt.loaded,
      total: evidence.total + receipt.total,
    }),
    { loaded: 0, total: 0 },
  );
  return {
    ...totals,
    expected,
    hasMalformedReceipt: receiptLines.length !== receipts.length,
    hasSonarJasminPlan: sonarJasminExpected !== undefined,
    receipts,
  };
}

function indexesIncluding(lines, fragment) {
  return lines.flatMap((line, index) => (line.includes(fragment) ? [index] : []));
}

function receiptEntries(lines) {
  return lines.flatMap((line, index) => {
    const receipt = architectureUdgReceipt(line);
    return receipt === undefined ? [] : [{ index, receipt }];
  });
}

function architectureUdgReadLanguage(line) {
  const marker = "Reading SonarArchitecture UDG data from directory";
  const markerAt = line.indexOf(marker);
  if (markerAt < 0) return undefined;
  const segments = line
    .slice(markerAt + marker.length)
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  const language = segments.at(-1);
  return segments.at(-2) === "architecture" && language !== undefined ? language : undefined;
}

function architectureSensorEvidence(lines, specification) {
  const sensor = `Sensor ${specification.name} [architecture]`;
  const completionIndexes = indexesIncluding(lines, `${sensor} (done)`);
  const startIndexes = indexesIncluding(lines, sensor).filter(
    (index) => !lines[index]?.includes(`${sensor} (done)`),
  );
  const startIndex = startIndexes[0] ?? -1;
  const completionIndex = completionIndexes[0] ?? -1;
  const body = lines.slice(startIndex + 1, completionIndex);
  const locations = indexesIncluding(body, "potential Udg file location(s)");
  const matchingLocations = indexesIncluding(
    body,
    `Found 1 potential Udg file location(s) for "${specification.language}"`,
  );
  const reads = indexesIncluding(body, "Reading SonarArchitecture UDG data from directory");
  const matchingReads = body.flatMap((line, index) =>
    architectureUdgReadLanguage(line) === specification.language ? [index] : [],
  );
  const entries = receiptEntries(body);
  const ordered = [
    startIndex >= 0,
    completionIndex > startIndex,
    locations.length === 1,
    matchingLocations.length === 1,
    reads.length === 1,
    matchingReads.length === 1,
    entries.length === 1,
    (matchingLocations[0] ?? -1) < (matchingReads[0] ?? -1),
    (matchingReads[0] ?? -1) < (entries[0]?.index ?? -1),
  ].every(Boolean);
  return {
    completionIndex,
    completions: completionIndexes.length,
    locations: locations.length,
    ordered,
    reads: reads.length,
    receipts: entries.map((entry) => entry.receipt),
    startIndex,
    starts: startIndexes.length,
  };
}

function completeArchitectureSensorReceipt(lines, specification) {
  const evidence = architectureSensorEvidence(lines, specification);
  const hasClosedLifecycle = [
    evidence.starts === 1,
    evidence.completions === 1,
    evidence.locations === 1,
    evidence.reads === 1,
    evidence.receipts.length === 1,
    evidence.ordered,
  ].every(Boolean);
  if (!hasClosedLifecycle) return undefined;
  const receipt = evidence.receipts[0];
  const isComplete = [
    receipt !== undefined,
    receipt?.loaded !== 0,
    receipt?.loaded === receipt?.total,
  ].every(Boolean);
  return isComplete && receipt !== undefined ? { ...evidence, receipt } : undefined;
}

function architectureSequenceIsClosed(sourceIndex, sensors, uploadIndex, completionIndex) {
  const jsSensor = sensors[0];
  const tsSensor = sensors[1];
  if (jsSensor === undefined || tsSensor === undefined) return false;
  return [
    sourceIndex >= 0,
    sourceIndex < jsSensor.startIndex,
    jsSensor.completionIndex < tsSensor.startIndex,
    tsSensor.completionIndex < uploadIndex,
    uploadIndex < completionIndex,
  ].every(Boolean);
}

function hasFullSensorScopedArchitectureEvidence(lines, eligibleSourceCount, allEvidence) {
  const sensors = ARCHITECTURE_SENSORS.map((specification) =>
    completeArchitectureSensorReceipt(lines, specification),
  );
  const completeSensors = sensors.filter((sensor) => sensor !== undefined);
  if (completeSensors.length !== ARCHITECTURE_SENSORS.length) return false;
  const sourceCompletionIndex = lines.findLastIndex((line) =>
    ANALYZED_SOURCE_SUFFIXES.some((suffix) => line.includes(suffix)),
  );
  const uploadIndex = lines.findIndex((line) =>
    line.includes("Successfully sent architecture data"),
  );
  const scannerCompletionIndex = lines.findIndex((line) => line.includes("EXECUTION SUCCESS"));
  const scopedTotal = completeSensors.reduce((total, sensor) => total + sensor.receipt.total, 0);
  return [
    eligibleSourceCount > 0,
    allEvidence.receipts.length === completeSensors.length,
    allEvidence.loaded === scopedTotal,
    allEvidence.total === scopedTotal,
    scopedTotal <= eligibleSourceCount,
    architectureSequenceIsClosed(
      sourceCompletionIndex,
      completeSensors,
      uploadIndex,
      scannerCompletionIndex,
    ),
  ].every(Boolean);
}

function hasArchitectureSensorMarkers(lines) {
  return ARCHITECTURE_SENSORS.some((specification) =>
    lines.some((line) => line.includes(`Sensor ${specification.name} [architecture]`)),
  );
}

function matchesExplicitArchitectureInventory(evidence, hasSensorMarkers) {
  return [
    evidence.expected !== undefined,
    (evidence.expected ?? 0) > 0,
    evidence.total === evidence.expected,
    [evidence.hasSonarJasminPlan, !hasSensorMarkers].some(Boolean),
  ].every(Boolean);
}

function matchesSensorScopedArchitectureInventory(lines, eligibleSourceCount, evidence) {
  return [
    evidence.expected === undefined,
    hasFullSensorScopedArchitectureEvidence(lines, eligibleSourceCount, evidence),
  ].every(Boolean);
}

function architectureUdgEvidenceFailures(lines, eligibleSourceCount) {
  const evidence = architectureUdgEvidence(lines);
  const hasSensorMarkers = hasArchitectureSensorMarkers(lines);
  const hasIncompleteReceipt = evidence.receipts.some(
    (receipt) => receipt.loaded !== receipt.total,
  );
  const matchesExplicitInventory = matchesExplicitArchitectureInventory(evidence, hasSensorMarkers);
  const matchesSensorScopedInventory = matchesSensorScopedArchitectureInventory(
    lines,
    eligibleSourceCount,
    evidence,
  );
  const isIncomplete = [
    evidence.total === 0,
    evidence.hasMalformedReceipt,
    hasIncompleteReceipt,
    !matchesExplicitInventory && !matchesSensorScopedInventory,
  ].some(Boolean);
  return isIncomplete
    ? [
        `architecture UDG receipts ${evidence.loaded}/${evidence.total} for ` +
          `${String(evidence.expected ?? 0)} source files do not prove a full-project graph`,
      ]
    : [];
}

function isConsistentCompletedSourceSet(indexedSourceCount, analyzed) {
  return (
    indexedSourceCount > 0 &&
    analyzed.total > 0 &&
    analyzed.analyzed === analyzed.total &&
    analyzed.total <= indexedSourceCount
  );
}

function meetsFullAnalysisBreadth(indexedSourceCount, analyzedTotal, cacheMissTotal) {
  const minimumFreshCount = Math.ceil(indexedSourceCount * MINIMUM_FULL_ANALYSIS_RATIO);
  return (
    indexedSourceCount > 0 &&
    analyzedTotal >= minimumFreshCount &&
    cacheMissTotal >= minimumFreshCount
  );
}

// A PR analysis may index the whole repository but restore almost every JS/TS result from dev's
// sensor cache. That is not equivalent to the fresh analysis a push to dev receives: #3377 was
// green after analyzing 91 files, then the merged revision failed while freshly analyzing 4,844.
// Sonar's JavaScript sensor reports its own exclusion-aware eligible inventory as the denominator
// of both cache receipts. Require exactly zero hits and one miss receipt covering that entire
// inventory. Generic source-progress receipts remain a consistency check. Both eligible totals
// must also clear the committed inventory-ratio floor, so a narrow but self-consistent scan cannot
// present three freshly analyzed files as full-project evidence.
export function fullAnalysisEvidenceFailures(contents) {
  const lines = contents.split(/\r?\n/u);
  const failures = [];
  const cacheEvidence = javascriptAnalysisCacheEvidence(lines);
  failures.push(...javascriptAnalysisCacheFailures(lines));
  const indexedSourceCount = lines.reduce((largest, line) => {
    const match = line.match(/(?:^|\s)(\d+) files indexed(?:\s|$)/iu);
    const count = match === null ? undefined : decimalInteger(match[1]);
    return count === undefined ? largest : Math.max(largest, count);
  }, 0);
  const analyzed = largestAnalyzedSourceSet(lines);
  if (!isConsistentCompletedSourceSet(indexedSourceCount, analyzed)) {
    failures.push(
      `completed source set ${analyzed.analyzed}/${analyzed.total} against ` +
        `${indexedSourceCount} indexed files is inconsistent`,
    );
  }
  const cacheMissTotal = isExactFreshJavascriptAnalysis(cacheEvidence)
    ? (cacheEvidence.misses[0]?.total ?? 0)
    : 0;
  if (!meetsFullAnalysisBreadth(indexedSourceCount, analyzed.total, cacheMissTotal)) {
    failures.push(
      `fresh JavaScript/TypeScript breadth ${cacheMissTotal} eligible and ` +
        `${analyzed.total} analyzed against ${indexedSourceCount} indexed files is below the ` +
        `${String(MINIMUM_FULL_ANALYSIS_RATIO * 100)}% floor`,
    );
  }
  failures.push(...architectureUdgEvidenceFailures(lines, cacheMissTotal));
  return failures;
}

export function runSonarLogCheck(input = {}) {
  const path = input.path;
  if (path === undefined) throw new Error("--log is required");
  const contents = (input.read ?? readFileSync)(resolve(path), "utf8");
  const failures = [
    ...sonarLogFailures(contents),
    ...(input.requireFullAnalysis === true ? fullAnalysisEvidenceFailures(contents) : []),
  ];
  if (failures.length > 0) throw new Error(failures.join("\n"));
  (input.log ?? console.log)("sonar-analysis-log: PASS - no scanner warnings.");
  return failures;
}

export function executeSonarLogCli(input = {}) {
  try {
    const argv = input.argv ?? process.argv.slice(2);
    const requireFullAnalysis = argv.includes("--require-full-analysis");
    (input.run ?? runSonarLogCheck)({
      path: optionValue(argv, "--log"),
      ...(requireFullAnalysis ? { requireFullAnalysis } : {}),
    });
  } catch (error) {
    (input.error ?? console.error)(
      `sonar-analysis-log: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) executeSonarLogCli();
