// Body-free Activity Log evidence for one finished verification execution (F14, #3873).
//
// A Workbench run's targeted-test verification took 28.5 s while the same path measured 236 ms when
// called directly, and the log could not say where the time went: between `workspace acquired` and
// `released` it held no line, and the `editor.verification.execute` completion line carried neither a
// duration nor the isolation backend that ran the step. This module is the one place that turns what
// an execution already produced -- the report (keiko-verification's single source of every duration
// and status), the isolation probe (keiko-sandbox) and the egress policy the orchestrator ran under
// -- into the closed, bounded fields of that completion line. It measures nothing and decides
// nothing: it names the vocabularies, projects values onto them, and keeps every value valid, so a
// quirk of one report can never cost the whole line (an invalid field makes the sink drop it).
//
// Never recorded: a command, an argument, a script name, a path, an output or a detail. Only closed
// vocabularies, booleans and whole milliseconds leave this module.
//
// How a reader attributes the wall time of one run (all durations are milliseconds):
//   durationMs        the report's own total: the dependency bootstrap's decision and installation
//                     plus every step. It starts after the isolation probe and the workspace wait.
//   <kind>DurationMs  one step kind's wall time as the orchestrator measured it, with its
//                     `<kind>Status`. A kind the run did not plan has no field.
//   maxStepDurationMs the slowest single step.
//   outsideStepsMs    durationMs minus every step: the bootstrap's decision and installation and the
//                     orchestration between steps. The install's own duration is on
//                     `editor.verification.dependencies`; `dependencyBootstrap` names the outcome.
//   probeDurationMs   the isolation probe, which runs before the report's clock starts.
// The time a run waited for the workspace is the gap between its `editor.verification.workspace`
// `waiting` and `acquired` lines.

import type {
  SandboxBackend,
  VerificationDependencyState,
  VerificationKind,
  VerificationReport,
  VerificationStatus,
} from "@oscharko-dev/keiko-contracts";
import type { ActivityLogFieldContract } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { SANDBOX_BACKENDS } from "@oscharko-dev/keiko-contracts/runtime/tools";
import type { NetworkEnforcementMode } from "@oscharko-dev/keiko-verification";
import type { ExecuteVerificationResult } from "./verificationExecution.js";

// The registry's closed vocabularies. `as const satisfies` rejects a value the production type does
// not have; the call site that hands a production value to `activityLogEvent` rejects a production
// value this list lacks, so a new status, backend or bootstrap state breaks the build instead of
// silently making the completion line unwritable.
export const VERIFICATION_STATUS_VALUES = [
  "passed",
  "failed",
  "skipped",
  "denied",
  "timed-out",
  "cancelled",
  "resource-exceeded",
] as const satisfies readonly VerificationStatus[];

export const VERIFICATION_DEPENDENCY_STATE_VALUES = [
  "none",
  "current",
  "installed",
  "refused",
  "failed",
  "timed-out",
  "cancelled",
] as const satisfies readonly VerificationDependencyState[];

// "unknown" is the label of a probe that named no sandbox backend (a host whose probe answer this
// build does not know); a free-form label is never recorded.
const ISOLATION_BACKEND_VALUES = [
  "bubblewrap",
  "unshare",
  "seatbelt",
  "container-docker",
  "container-podman",
  "none",
  "unknown",
] as const satisfies readonly (SandboxBackend | "unknown")[];

const NETWORK_ENFORCEMENT_VALUES = [
  "inherit",
  "enforce-or-degrade",
  "enforce-or-fail-closed",
] as const satisfies readonly NetworkEnforcementMode[];

const STATUS_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: false,
  values: VERIFICATION_STATUS_VALUES,
} as const satisfies ActivityLogFieldContract;

const DURATION_FIELD = {
  type: "integer",
  dataClass: "duration",
  required: false,
} as const satisfies ActivityLogFieldContract;

// Spread into the `editor.verification.execute` registration. Every field is optional: only the
// completion line carries them, and each is omitted rather than invented when the execution did not
// report it.
export const VERIFICATION_COMPLETION_FIELD_CONTRACTS = {
  durationMs: DURATION_FIELD,
  outsideStepsMs: DURATION_FIELD,
  maxStepDurationMs: DURATION_FIELD,
  probeDurationMs: DURATION_FIELD,
  testStatus: STATUS_FIELD,
  testDurationMs: DURATION_FIELD,
  targetedTestStatus: STATUS_FIELD,
  targetedTestDurationMs: DURATION_FIELD,
  typecheckStatus: STATUS_FIELD,
  typecheckDurationMs: DURATION_FIELD,
  lintStatus: STATUS_FIELD,
  lintDurationMs: DURATION_FIELD,
  buildStatus: STATUS_FIELD,
  buildDurationMs: DURATION_FIELD,
  isolationBackend: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: ISOLATION_BACKEND_VALUES,
  },
  isolationAvailable: { type: "boolean", dataClass: "closed-enum", required: false },
  networkEnforcement: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: NETWORK_ENFORCEMENT_VALUES,
  },
  dependencyBootstrap: {
    type: "string",
    dataClass: "closed-enum",
    required: false,
    values: VERIFICATION_DEPENDENCY_STATE_VALUES,
  },
} as const satisfies Readonly<Record<string, ActivityLogFieldContract>>;

interface VerificationCompletionLogFields {
  readonly durationMs?: number;
  readonly outsideStepsMs?: number;
  readonly maxStepDurationMs?: number;
  readonly probeDurationMs?: number;
  readonly testStatus?: VerificationStatus;
  readonly testDurationMs?: number;
  readonly targetedTestStatus?: VerificationStatus;
  readonly targetedTestDurationMs?: number;
  readonly typecheckStatus?: VerificationStatus;
  readonly typecheckDurationMs?: number;
  readonly lintStatus?: VerificationStatus;
  readonly lintDurationMs?: number;
  readonly buildStatus?: VerificationStatus;
  readonly buildDurationMs?: number;
  readonly isolationBackend?: SandboxBackend | "unknown";
  readonly isolationAvailable?: boolean;
  readonly networkEnforcement?: NetworkEnforcementMode;
  readonly dependencyBootstrap?: VerificationDependencyState;
}

type MutableFields = {
  -readonly [Name in keyof VerificationCompletionLogFields]: VerificationCompletionLogFields[Name];
};

type StatusFieldName =
  "testStatus" | "targetedTestStatus" | "typecheckStatus" | "lintStatus" | "buildStatus";
type DurationFieldName =
  | "testDurationMs"
  | "targetedTestDurationMs"
  | "typecheckDurationMs"
  | "lintDurationMs"
  | "buildDurationMs";

// Exhaustive over the verification kinds: a new kind fails to compile until it has its own pair of
// registered fields.
const STEP_FIELD_NAMES = {
  test: ["testStatus", "testDurationMs"],
  "targeted-test": ["targetedTestStatus", "targetedTestDurationMs"],
  typecheck: ["typecheckStatus", "typecheckDurationMs"],
  lint: ["lintStatus", "lintDurationMs"],
  build: ["buildStatus", "buildDurationMs"],
} as const satisfies Record<VerificationKind, readonly [StatusFieldName, DurationFieldName]>;

const SANDBOX_BACKEND_SET: ReadonlySet<string> = new Set(SANDBOX_BACKENDS);

function isSandboxBackend(label: string): label is SandboxBackend {
  return SANDBOX_BACKEND_SET.has(label);
}

// The probe's label is typed `string`, so it is checked against the contract's own backend list.
function isolationBackendOf(label: string): SandboxBackend | "unknown" {
  return isSandboxBackend(label) ? label : "unknown";
}

// The registry takes a whole, non-negative, safe integer. A report's duration is only a finite,
// non-negative number (a clock injected with sub-millisecond resolution yields a fraction), so it is
// rounded, never rejected; a value no clock can have produced is omitted rather than invented.
function wholeMilliseconds(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

function addMilliseconds(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

interface KindTotal {
  readonly status: VerificationStatus;
  readonly durationMs: number | undefined;
}

// The runner plans at most one step per kind. A report that holds several of one kind (an SDK
// plan) is still recorded without loss: the kind's wall time is their sum, and its status is the
// first one that is not `passed`, so a failure is never hidden behind a later pass.
function totalsByKind(report: VerificationReport): ReadonlyMap<VerificationKind, KindTotal> {
  const totals = new Map<VerificationKind, KindTotal>();
  for (const result of report.results) {
    const durationMs = wholeMilliseconds(result.durationMs);
    const before = totals.get(result.kind);
    totals.set(
      result.kind,
      before === undefined
        ? { status: result.status, durationMs }
        : {
            status: before.status === "passed" ? result.status : before.status,
            durationMs: addMilliseconds(before.durationMs, durationMs),
          },
    );
  }
  return totals;
}

function stepFields(report: VerificationReport): VerificationCompletionLogFields {
  const fields: MutableFields = {};
  for (const [kind, total] of totalsByKind(report)) {
    const [statusField, durationField] = STEP_FIELD_NAMES[kind];
    fields[statusField] = total.status;
    if (total.durationMs !== undefined) fields[durationField] = total.durationMs;
  }
  return fields;
}

// The report's total, the slowest step, and what the steps leave of the total (see the header).
function timingFields(report: VerificationReport): VerificationCompletionLogFields {
  const stepDurations = report.results.flatMap(
    (result) => wholeMilliseconds(result.durationMs) ?? [],
  );
  const totalMs = wholeMilliseconds(report.durationMs);
  const insideSteps = stepDurations.reduce((sum, durationMs) => sum + durationMs, 0);
  return {
    ...(totalMs === undefined
      ? {}
      : { durationMs: totalMs, outsideStepsMs: Math.max(0, totalMs - insideSteps) }),
    ...(stepDurations.length === 0 ? {} : { maxStepDurationMs: Math.max(...stepDurations) }),
  };
}

function isolationFields(execution: ExecuteVerificationResult): VerificationCompletionLogFields {
  const probeMs =
    execution.probeDurationMs === undefined
      ? undefined
      : wholeMilliseconds(execution.probeDurationMs);
  return {
    isolationBackend: isolationBackendOf(execution.probe.backend),
    isolationAvailable: execution.probe.available,
    ...(execution.networkEnforcement === undefined
      ? {}
      : { networkEnforcement: execution.networkEnforcement }),
    ...(probeMs === undefined ? {} : { probeDurationMs: probeMs }),
  };
}

// The fields the `editor.verification.execute` completion line adds to its counts: where the wall
// time of the run went, which isolation applied and how the dependency bootstrap ended. Total over
// every value the types permit, so recording a run can never fail it.
export function verificationCompletionLogFields(
  execution: ExecuteVerificationResult,
): VerificationCompletionLogFields {
  const { report } = execution;
  return {
    ...timingFields(report),
    ...stepFields(report),
    ...isolationFields(execution),
    ...(report.dependencies === undefined
      ? {}
      : { dependencyBootstrap: report.dependencies.state }),
  };
}
