// The run's governed verification history, for the check list of the pull request a Code task
// delivers (F57, Coding Workbench runs 19–28). Every completed `keiko_verification` call is kept as
// closed vocabulary and numbers only: never a command, an argument, output, a path or model text.
// The verified-commit service freezes the history into the commit proof's evidence record, and the
// draft delivery reads it back from there for the server-owned "Checks" section (ADR-0086 D9).

import type {
  VerificationDependencyState,
  VerificationKind,
  VerificationLockfileState,
  VerificationReport,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";

/** How many verification calls one run's history keeps; older ones are counted as omitted. */
export const VERIFICATION_CHECK_HISTORY_MAX = 24;

export interface VerificationCheckStep {
  readonly kind: VerificationKind;
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

/** The dependency install a verification ran before its step (ADR-0043 D17), counts only. */
export interface VerificationCheckInstall {
  readonly state: VerificationDependencyState;
  readonly lockfile: VerificationLockfileState;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly egressAllowed?: number;
  readonly egressRefused?: number;
}

export interface VerificationCheckRecord {
  readonly startedAtMs: number;
  /** The fully staged candidate the verification ran on; absent while the work was not staged. */
  readonly stagedTreeDigest?: string;
  readonly install?: VerificationCheckInstall;
  readonly steps: readonly VerificationCheckStep[];
}

export interface VerificationCheckHistory {
  readonly records: readonly VerificationCheckRecord[];
  /** Older records dropped beyond VERIFICATION_CHECK_HISTORY_MAX. */
  readonly omitted: number;
}

export const EMPTY_VERIFICATION_CHECK_HISTORY: VerificationCheckHistory = Object.freeze({
  records: Object.freeze([]),
  omitted: 0,
});

function installRecord(report: VerificationReport): VerificationCheckInstall | undefined {
  const dependencies = report.dependencies;
  if (dependencies === undefined) return undefined;
  return {
    state: dependencies.state,
    lockfile: dependencies.lockfile,
    exitCode: dependencies.exitCode,
    durationMs: dependencies.durationMs,
    ...(dependencies.egress === undefined
      ? {}
      : { egressAllowed: dependencies.egress.allowed, egressRefused: dependencies.egress.refused }),
  };
}

/** One completed verification, projected to what the check list may show. */
export function verificationCheckRecord(
  report: VerificationReport,
  stagedTreeDigest?: string,
): VerificationCheckRecord {
  const install = installRecord(report);
  return {
    startedAtMs: report.startedAtMs,
    ...(stagedTreeDigest === undefined ? {} : { stagedTreeDigest }),
    ...(install === undefined ? {} : { install }),
    steps: report.results.map((result) => ({
      kind: result.kind,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    })),
  };
}

export function appendVerificationCheck(
  history: VerificationCheckHistory,
  record: VerificationCheckRecord,
): VerificationCheckHistory {
  const records = [...history.records, record];
  const dropped = Math.max(0, records.length - VERIFICATION_CHECK_HISTORY_MAX);
  return { records: records.slice(dropped), omitted: history.omitted + dropped };
}

// ─── Reading a history back from evidence: any unexpected shape is refused ─────────────────────

function oneOf<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  const allowed: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is T => typeof value === "string" && allowed.has(value);
}

const isKind = oneOf<VerificationKind>(["test", "targeted-test", "typecheck", "lint", "build"]);
const isStatus = oneOf<VerificationStatus>([
  "passed",
  "failed",
  "skipped",
  "denied",
  "timed-out",
  "cancelled",
  "resource-exceeded",
]);
const isInstallState = oneOf<VerificationDependencyState>([
  "none",
  "current",
  "installed",
  "refused",
  "failed",
  "timed-out",
  "cancelled",
]);
const isLockfileState = oneOf<VerificationLockfileState>(["present", "created", "absent"]);
const DIGEST = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isExitCode(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function isOptionalDigest(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && DIGEST.test(value));
}

function parseStep(value: unknown): VerificationCheckStep | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, status, exitCode, durationMs } = value;
  return isKind(kind) && isStatus(status) && isExitCode(exitCode) && isDuration(durationMs)
    ? { kind, status, exitCode, durationMs }
    : undefined;
}

function parseEgress(
  value: Record<string, unknown>,
): Pick<VerificationCheckInstall, "egressAllowed" | "egressRefused"> | undefined {
  const { egressAllowed, egressRefused } = value;
  if (egressAllowed === undefined && egressRefused === undefined) return {};
  return isCount(egressAllowed) && isCount(egressRefused)
    ? { egressAllowed, egressRefused }
    : undefined;
}

function parseInstall(value: unknown): VerificationCheckInstall | undefined {
  if (!isRecord(value)) return undefined;
  const { state, lockfile, exitCode, durationMs } = value;
  const egress = parseEgress(value);
  return isInstallState(state) &&
    isLockfileState(lockfile) &&
    isExitCode(exitCode) &&
    isDuration(durationMs) &&
    egress !== undefined
    ? { state, lockfile, exitCode, durationMs, ...egress }
    : undefined;
}

function parseSteps(value: unknown): readonly VerificationCheckStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value.map(parseStep);
  return steps.every((step): step is VerificationCheckStep => step !== undefined)
    ? steps
    : undefined;
}

function parseRecord(value: unknown): VerificationCheckRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { startedAtMs, stagedTreeDigest } = value;
  const steps = parseSteps(value.steps);
  // `null` is "no install ran"; `undefined` is an install that failed to parse.
  const install = value.install === undefined ? null : parseInstall(value.install);
  if (
    !isDuration(startedAtMs) ||
    !isOptionalDigest(stagedTreeDigest) ||
    steps === undefined ||
    install === undefined
  )
    return undefined;
  return {
    startedAtMs,
    ...(stagedTreeDigest === undefined ? {} : { stagedTreeDigest }),
    ...(install === null ? {} : { install }),
    steps,
  };
}

export function parseVerificationCheckHistory(
  value: unknown,
): VerificationCheckHistory | undefined {
  if (!isRecord(value) || !isCount(value.omitted) || !Array.isArray(value.records))
    return undefined;
  if (value.records.length > VERIFICATION_CHECK_HISTORY_MAX) return undefined;
  const records = value.records.map(parseRecord);
  return records.every((record): record is VerificationCheckRecord => record !== undefined)
    ? { records, omitted: value.omitted }
    : undefined;
}

/** The history a commit proof's evidence record carries, or undefined when absent or malformed. */
export function verificationCheckHistoryFromEvidence(
  json: string,
): VerificationCheckHistory | undefined {
  let evidence: unknown;
  try {
    evidence = JSON.parse(json);
  } catch {
    return undefined;
  }
  return isRecord(evidence) ? parseVerificationCheckHistory(evidence.checks) : undefined;
}
