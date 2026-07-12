#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const defaultReport = "reports/mutation/security/mutation-report.json";
const defaultBaseline = "docs/qa/security-mutation-baseline.json";

export function mutationFingerprint(file, mutant) {
  const value = JSON.stringify({
    file,
    location: mutant.location,
    mutatorName: mutant.mutatorName,
    replacement: mutant.replacement,
    static: mutant.static ?? false,
  });
  return createHash("sha256").update(value).digest("hex");
}

export function summarizeMutationReport(report, options = {}) {
  const summary = { killed: 0, noCoverage: 0, survived: 0, timeout: 0, total: 0 };
  const debt = [];
  const errors = [];
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
      if (options.includeMutant !== undefined && !options.includeMutant(file, mutant)) continue;
      recordMutant({ debt, errors, file, mutant, summary });
    }
  }
  const detected = summary.killed + summary.timeout;
  return {
    debt: debt.toSorted((left, right) => left.localeCompare(right)),
    errors,
    score: summary.total === 0 ? 0 : (detected / summary.total) * 100,
    summary,
  };
}

function recordMutant({ debt, errors, file, mutant, summary }) {
  if (mutant.status === "Ignored") return;
  summary.total += 1;
  if (mutant.status === "Killed") summary.killed += 1;
  else if (mutant.status === "Timeout") summary.timeout += 1;
  else if (mutant.status === "Survived") summary.survived += 1;
  else if (mutant.status === "NoCoverage") summary.noCoverage += 1;
  else errors.push(`${file}:${mutant.id ?? "unknown"}:${mutant.status ?? "missing"}`);
  if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
    debt.push(mutationFingerprint(file, mutant));
  }
}

function parseLineCount(value) {
  return value === undefined || value === "" ? 1 : Number.parseInt(value, 10);
}

function parseHunkRange(line) {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (match === null) return undefined;
  const start = Number.parseInt(match[1], 10);
  const count = parseLineCount(match[2]);
  return count <= 0 ? undefined : { end: start + count - 1, start };
}

export function parseChangedLineRanges(diff) {
  const ranges = new Map();
  let currentFile;
  for (const line of diff.split(/\r?\n/u)) {
    const fileMatch = /^diff --git a\/.+ b\/(.+)$/u.exec(line);
    if (fileMatch !== null) {
      currentFile = fileMatch[1];
      if (!ranges.has(currentFile)) ranges.set(currentFile, []);
      continue;
    }
    if (currentFile === undefined || !line.startsWith("@@ ")) continue;
    const range = parseHunkRange(line);
    if (range !== undefined) ranges.get(currentFile).push(range);
  }
  return ranges;
}

export function changedLineRanges(base, head, execute = execFileSync) {
  return parseChangedLineRanges(
    execute("/usr/bin/git", ["diff", "--unified=0", "--diff-filter=ACMR", `${base}...${head}`], {
      encoding: "utf8",
    }),
  );
}

function mutantLineRange(mutant) {
  const start = mutant.location?.start?.line;
  const end = mutant.location?.end?.line;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { end: Math.max(start, end), start: Math.min(start, end) };
}

function overlaps(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

export function mutantTouchesChangedLine(file, mutant, ranges) {
  const fileRanges = ranges.get(file);
  const mutantRange = mutantLineRange(mutant);
  if (fileRanges === undefined || mutantRange === undefined) return false;
  return fileRanges.some((range) => overlaps(mutantRange, range));
}

function changedLineRangeCount(changedLines) {
  if (changedLines === undefined) return 0;
  let count = 0;
  for (const ranges of changedLines.values()) count += ranges.length;
  return count;
}

export function evaluateMutationBaseline(report, baseline) {
  const current = summarizeMutationReport(report);
  const accepted = new Set(baseline.acceptedDebt ?? []);
  const newDebt = current.debt.filter((fingerprint) => !accepted.has(fingerprint));
  const failures = [...current.errors.map((value) => `Unexpected mutant result: ${value}`)];
  if (current.score + 1e-6 < baseline.minimumScore) {
    failures.push(
      `Mutation score ${current.score.toFixed(2)}% regressed below baseline ${baseline.minimumScore.toFixed(2)}%.`,
    );
  }
  if (newDebt.length > 0) failures.push(`${String(newDebt.length)} new mutation debt item(s).`);
  if (current.summary.survived > baseline.maximumSurvived)
    failures.push("Surviving mutant count regressed.");
  if (current.summary.noCoverage > baseline.maximumNoCoverage)
    failures.push("No-coverage mutant count regressed.");
  return { current, failures, newDebt };
}

export function evaluateScopedMutation(report, options = {}) {
  const current = summarizeMutationReport(report, {
    includeMutant:
      options.changedLines === undefined
        ? undefined
        : (file, mutant) => mutantTouchesChangedLine(file, mutant, options.changedLines),
  });
  const failures = [...current.errors.map((value) => `Unexpected mutant result: ${value}`)];
  if (current.summary.total === 0) {
    if (changedLineRangeCount(options.changedLines) === 0) {
      failures.push("Scoped mutation run produced no mutants.");
    }
    return { current, failures };
  }
  if (current.score < 80)
    failures.push(`Mutation score ${current.score.toFixed(2)}% is below 80%.`);
  if (current.summary.survived > 0) failures.push("Critical changed code has surviving mutants.");
  if (current.summary.noCoverage > 0)
    failures.push("Critical changed code has mutants without test coverage.");
  return { current, failures };
}

function scopedChangedLines(input) {
  if (input.mode !== "scoped" || input.base === undefined || input.head === undefined) {
    return undefined;
  }
  return changedLineRanges(input.base, input.head, input.execute);
}

async function evaluateReport(input, report, read) {
  if (input.mode === "scoped") {
    return evaluateScopedMutation(report, { changedLines: scopedChangedLines(input) });
  }
  return evaluateMutationBaseline(
    report,
    JSON.parse(await read(input.baselinePath ?? defaultBaseline)),
  );
}

export async function runMutationQuality(input = {}) {
  const read = input.read ?? ((path) => readFile(path, "utf8"));
  const report = JSON.parse(await read(input.reportPath ?? defaultReport));
  const result = await evaluateReport(input, report, read);
  if (result.failures.length > 0) throw new Error(result.failures.join(" "));
  (input.log ?? console.log)(
    `mutation-quality: PASS - ${result.current.score.toFixed(2)}% (${String(result.current.summary.killed)} killed, ${String(result.current.summary.timeout)} timeout, ${String(result.current.summary.survived)} survived, ${String(result.current.summary.noCoverage)} no coverage).`,
  );
  return result;
}

export function mutationQualityCliInput(args) {
  const runInput = { mode: args.includes("--scoped") ? "scoped" : "baseline" };
  const base = option(args, "--base");
  const head = option(args, "--head");
  if (base !== undefined) runInput.base = base;
  if (head !== undefined) runInput.head = head;
  return runInput;
}

export async function executeMutationQualityCli(input = {}) {
  const args = input.args ?? process.argv.slice(2);
  try {
    await (input.run ?? runMutationQuality)(mutationQualityCliInput(args));
  } catch (error) {
    (input.error ?? console.error)(
      `mutation-quality: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) await executeMutationQualityCli();
