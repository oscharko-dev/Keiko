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
  const expected = sonarJasminExpected ?? largestCount(UDG_CACHE_SOURCE_SUFFIX) ?? 0;
  const receipts = lines.flatMap((line) => architectureUdgReceipt(line) ?? []);
  return receipts.reduce(
    (evidence, receipt) => ({
      expected,
      loaded: evidence.loaded + receipt.loaded,
      total: evidence.total + receipt.total,
    }),
    { expected, loaded: 0, total: 0 },
  );
}

function architectureUdgEvidenceFailures(lines) {
  const evidence = architectureUdgEvidence(lines);
  const isIncomplete =
    evidence.expected === 0 ||
    evidence.total === 0 ||
    evidence.loaded !== evidence.total ||
    evidence.total !== evidence.expected;
  return isIncomplete
    ? [
        `architecture UDG receipts ${evidence.loaded}/${evidence.total} for ` +
          `${evidence.expected} source files do not prove a full-project graph`,
      ]
    : [];
}

// A PR analysis may index the whole repository but restore almost every JS/TS result from dev's
// sensor cache. That is not equivalent to the fresh analysis a push to dev receives: #3377 was
// green after analyzing 91 files, then the merged revision failed while freshly analyzing 4,844.
// Sonar's JavaScript sensor reports its own exclusion-aware eligible inventory as the denominator
// of both cache receipts. Require exactly zero hits and one miss receipt covering that entire
// inventory. Generic source-progress receipts remain a consistency check only: other sensors own
// them, so they may cover fewer files, but they may never claim more files than were indexed.
export function fullAnalysisEvidenceFailures(contents) {
  const lines = contents.split(/\r?\n/u);
  const failures = [];
  if (lines.some((line) => /Sensor cache enabled/iu.test(line))) {
    failures.push("sensor cache remained enabled");
  }
  failures.push(...javascriptAnalysisCacheFailures(lines));
  const indexedSourceCount = lines.reduce((largest, line) => {
    const match = line.match(/(?:^|\s)(\d+) files indexed(?:\s|$)/iu);
    return match === null ? largest : Math.max(largest, Number(match[1]));
  }, 0);
  const analyzed = largestAnalyzedSourceSet(lines);
  if (
    indexedSourceCount === 0 ||
    analyzed.total === 0 ||
    analyzed.analyzed !== analyzed.total ||
    analyzed.total > indexedSourceCount
  ) {
    failures.push(
      `completed source set ${analyzed.analyzed}/${analyzed.total} against ` +
        `${indexedSourceCount} indexed files is inconsistent`,
    );
  }
  failures.push(...architectureUdgEvidenceFailures(lines));
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
