// Effect adapter for the assured pre-filter (Issue #1202 wave-2; ADR-0043).
//
// Composes an injected sandboxed-command runner (in production: keiko-tools `runCommand` with
// `network: "none"`, rooted at a disposable execution copy) and an injected report reader into the
// AssuredGateRunner the pure orchestrator drives. The vitest-coverage-delta and Stryker-mutation
// parsers are pure and unit-tested; the command execution + report reads are the injected effects, so
// every gate runs inside the enforced egress boundary and the user's workspace is never written.

import type {
  AssuredGateRunner,
  CoverageOutcome,
  GateOutcome,
  MutationOutcome,
} from "./assuredPreFilter.js";

export interface SandboxedCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface SandboxedRunResult {
  readonly exitCode: number | null;
}

// Runs one untrusted command inside the enforced sandbox (network:"none") in the disposable root.
export type SandboxedRun = (cmd: SandboxedCommand) => Promise<SandboxedRunResult>;

// Reads a JSON report the gate command wrote into the disposable root; undefined when absent/invalid.
export type ReportReader = (relativePath: string) => unknown;

// ─── Pure parsers ──────────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coveredCount(fileCoverage: unknown, metric: "lines" | "branches"): number {
  if (!isRecord(fileCoverage)) {
    return 0;
  }
  const dimension = fileCoverage[metric];
  if (!isRecord(dimension)) {
    return 0;
  }
  const covered = dimension.covered;
  return typeof covered === "number" && Number.isFinite(covered) ? covered : 0;
}

function sumCovered(
  summary: unknown,
  targetKeys: readonly string[],
  metric: "lines" | "branches",
): number {
  if (!isRecord(summary)) {
    return 0;
  }
  let total = 0;
  for (const key of targetKeys) {
    total += coveredCount(summary[key], metric);
  }
  return total;
}

// The strict increase in covered lines/branches for the target files between the pre-patch baseline
// and the patched run. A vitest json-summary maps a file path to `{ lines: { covered }, branches: { covered } }`.
export function coveredDelta(
  baseline: unknown,
  patched: unknown,
  targetKeys: readonly string[],
): { readonly lineDelta: number; readonly branchDelta: number } {
  return {
    lineDelta: sumCovered(patched, targetKeys, "lines") - sumCovered(baseline, targetKeys, "lines"),
    branchDelta:
      sumCovered(patched, targetKeys, "branches") - sumCovered(baseline, targetKeys, "branches"),
  };
}

// Killed vs total injected mutants from a Stryker JSON report. A mutant is "detected" when Killed or
// Timeout; Ignored/NoCoverage mutants are excluded from the total so a non-covered region does not
// dilute the oracle-strength ratio.
function countFileMutants(file: unknown): { readonly killed: number; readonly total: number } {
  if (!isRecord(file) || !Array.isArray(file.mutants)) {
    return { killed: 0, total: 0 };
  }
  let killed = 0;
  let total = 0;
  for (const mutant of file.mutants) {
    const status = isRecord(mutant) ? mutant.status : undefined;
    if (status === "Ignored" || status === "NoCoverage") {
      continue;
    }
    total += 1;
    if (status === "Killed" || status === "Timeout") {
      killed += 1;
    }
  }
  return { killed, total };
}

export function strykerKilled(report: unknown): {
  readonly killed: number;
  readonly total: number;
} {
  if (!isRecord(report) || !isRecord(report.files)) {
    return { killed: 0, total: 0 };
  }
  let killed = 0;
  let total = 0;
  for (const file of Object.values(report.files)) {
    const counts = countFileMutants(file);
    killed += counts.killed;
    total += counts.total;
  }
  return { killed, total };
}

// ─── Gate runner ─────────────────────────────────────────────────────────────────────────────────

export interface SandboxedGateRunnerSpec {
  // True iff `run` executes inside an enforced deny-by-default egress boundary (keiko-sandbox).
  readonly enforced: boolean;
  readonly run: SandboxedRun;
  readonly readReport: ReportReader;
  readonly buildCommand: SandboxedCommand;
  readonly testCommand: SandboxedCommand;
  readonly coverageCommand: SandboxedCommand;
  readonly mutationCommand: SandboxedCommand;
  // Pre-measured baseline vitest coverage summary (before the candidate was applied) and the path the
  // patched coverage run writes; both read via `readReport`.
  readonly baselineCoverageReportPath: string;
  readonly patchedCoverageReportPath: string;
  readonly mutationReportPath: string;
  // The vitest-summary keys (file paths) for the target under test whose covered lines must increase.
  readonly targetCoverageKeys: readonly string[];
  readonly minMutantsKilled: number;
}

function ok(result: SandboxedRunResult): boolean {
  return result.exitCode === 0;
}

export function createSandboxedGateRunner(spec: SandboxedGateRunnerSpec): AssuredGateRunner {
  return {
    enforced: spec.enforced,
    build: async (): Promise<GateOutcome> => ({ ok: ok(await spec.run(spec.buildCommand)) }),
    runTests: async (): Promise<GateOutcome> => ({ ok: ok(await spec.run(spec.testCommand)) }),
    coverage: async (): Promise<CoverageOutcome> => {
      const run = await spec.run(spec.coverageCommand);
      if (!ok(run)) {
        return { ok: false, lineDelta: 0, branchDelta: 0 };
      }
      const delta = coveredDelta(
        spec.readReport(spec.baselineCoverageReportPath),
        spec.readReport(spec.patchedCoverageReportPath),
        spec.targetCoverageKeys,
      );
      return { ok: delta.lineDelta > 0 || delta.branchDelta > 0, ...delta };
    },
    mutation: async (): Promise<MutationOutcome> => {
      const run = await spec.run(spec.mutationCommand);
      if (!ok(run)) {
        return { ok: false, killed: 0, total: 0 };
      }
      const counts = strykerKilled(spec.readReport(spec.mutationReportPath));
      return { ok: counts.killed >= spec.minMutantsKilled, ...counts };
    },
  };
}
