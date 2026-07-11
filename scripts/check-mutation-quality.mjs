#!/usr/bin/env node

import { createHash } from "node:crypto";
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

export function summarizeMutationReport(report) {
  const summary = { killed: 0, noCoverage: 0, survived: 0, timeout: 0, total: 0 };
  const debt = [];
  const errors = [];
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const mutant of entry.mutants ?? []) {
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

export function evaluateScopedMutation(report) {
  const current = summarizeMutationReport(report);
  const failures = [...current.errors.map((value) => `Unexpected mutant result: ${value}`)];
  if (current.summary.total === 0) failures.push("Scoped mutation run produced no mutants.");
  if (current.score < 80)
    failures.push(`Mutation score ${current.score.toFixed(2)}% is below 80%.`);
  if (current.summary.survived > 0) failures.push("Critical changed code has surviving mutants.");
  if (current.summary.noCoverage > 0)
    failures.push("Critical changed code has mutants without test coverage.");
  return { current, failures };
}

export async function runMutationQuality(input = {}) {
  const read = input.read ?? ((path) => readFile(path, "utf8"));
  const report = JSON.parse(await read(input.reportPath ?? defaultReport));
  const result =
    input.mode === "scoped"
      ? evaluateScopedMutation(report)
      : evaluateMutationBaseline(
          report,
          JSON.parse(await read(input.baselinePath ?? defaultBaseline)),
        );
  if (result.failures.length > 0) throw new Error(result.failures.join(" "));
  (input.log ?? console.log)(
    `mutation-quality: PASS - ${result.current.score.toFixed(2)}% (${String(result.current.summary.killed)} killed, ${String(result.current.summary.timeout)} timeout, ${String(result.current.summary.survived)} survived, ${String(result.current.summary.noCoverage)} no coverage).`,
  );
  return result;
}

export async function executeMutationQualityCli(input = {}) {
  const args = input.args ?? process.argv.slice(2);
  try {
    await (input.run ?? runMutationQuality)({
      mode: args.includes("--scoped") ? "scoped" : "baseline",
    });
  } catch (error) {
    (input.error ?? console.error)(
      `mutation-quality: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await executeMutationQualityCli();
