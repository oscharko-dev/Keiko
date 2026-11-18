import { randomUUID } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  CodingWorkbenchGatewayServiceRepairOutcome,
  CodingWorkbenchRuntimeEvidenceClass,
  CodingWorkbenchRuntimeUnavailableReason,
  CodingWorkbenchRuntimeVersion,
} from "@oscharko-dev/keiko-contracts";
import { reportServerLogFailure, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";

// Tells the Workbench why a released Windows runtime cannot start, and what the human can do about
// it (ADR-0043 D19, #4068). The answer comes from the native helper, refreshed in the background
// while Keiko runs rather than once at startup: the broker starts delayed after boot and can be
// installed while Keiko runs, and neither may require a Keiko restart. The launch itself stays
// fail-closed whatever this probe last said.
//
// The Workbench's Repair runs the same idempotent `--gateway-service-install` command `keiko
// gateway-service repair` and the automatic setup after `keiko start` use. Windows asks the human
// through UAC; only the digest-checked native helper runs elevated, never Node.

const STATE_VALUES = ["ready", "absent", "stopped", "image-mismatch", "state-unknown"] as const;

const WINDOWS_GATEWAY_SERVICE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.windows-gateway-service",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "coding-runtime.windowsGatewayServiceProbe.stateEvent",
  fields: {
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: STATE_VALUES,
    },
    helperSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    evidenceClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["platform-qualified", "functional-not-platform-qualified"],
    },
    origin: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["portable-release", "dev-checkout", "npm-runtime-package"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["windows-gateway-service"],
  proofIds: ["coding-runtime.windows-gateway-service.real-sink-line"],
  releaseImpact: "patch",
});

const WINDOWS_GATEWAY_SERVICE_REPAIR_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.windows-gateway-service.repair",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "coding-runtime.windowsGatewayServiceProbe.repairEvent",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["ready", "declined", "failed", "busy"],
    },
    // The broker state the helper answered after the install: why a failed repair failed.
    state: { type: "string", dataClass: "closed-enum", required: false, values: STATE_VALUES },
    exitClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["state", "native-failure", "no-exit", "unexpected"],
    },
    helperSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    durationMs: { type: "integer", dataClass: "duration", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["failed"] }],
  failureClasses: ["windows-gateway-service"],
  proofIds: ["coding-runtime.windows-gateway-service.repair.real-sink-line"],
  releaseImpact: "minor",
});

export type WindowsGatewayServiceState = ActivityLogFields<
  typeof WINDOWS_GATEWAY_SERVICE_OPERATION
>["state"];

// The status exit codes of `--gateway-service-status` (native gateway_install.h).
const NATIVE_STATES: Readonly<Record<number, WindowsGatewayServiceState>> = {
  0: "ready",
  10: "absent",
  11: "stopped",
  12: "image-mismatch",
  13: "state-unknown",
};

// The native exit code of a declined UAC approval (KEIKO_GATEWAY_SERVICE_ELEVATION_DECLINED).
const NATIVE_ELEVATION_DECLINED = 20;
// The native failure codes of `--gateway-service-install` (gateway_install.h, 20..27).
const NATIVE_FAILURE_MIN = 20;
const NATIVE_FAILURE_MAX = 27;

const UNAVAILABLE_REASONS: Readonly<
  Record<Exclude<WindowsGatewayServiceState, "ready">, CodingWorkbenchRuntimeUnavailableReason>
> = {
  absent: "gateway-service-absent",
  stopped: "gateway-service-stopped",
  "image-mismatch": "gateway-service-stale",
  "state-unknown": "gateway-service-unknown",
};

const PROBE_TTL_MS = 3_000;

export interface WindowsGatewayServiceProbe {
  /** undefined when the broker is ready; otherwise the closed reason the Workbench names. */
  readonly unavailableReason: () => CodingWorkbenchRuntimeUnavailableReason | undefined;
  /**
   * The Workbench's Repair: the native idempotent install behind Windows' UAC approval. Absent for
   * a runtime without a broker pin, which no repair can change.
   */
  readonly repair?: (correlationId: string) => Promise<CodingWorkbenchGatewayServiceRepairOutcome>;
}

/** The probe that asks the helper in the background. */
export interface RefreshingWindowsGatewayServiceProbe extends WindowsGatewayServiceProbe {
  /** Settles once no helper run is pending. */
  readonly idle: () => Promise<void>;
}

type HelperRunner = (helperPath: string, helperSha256: string) => Promise<number | null>;

export interface WindowsGatewayServiceProbeInput {
  readonly helperPath: string;
  readonly helperSha256: string;
  readonly activityLog: ServerLogSink;
  readonly evidenceClass?: CodingWorkbenchRuntimeEvidenceClass | undefined;
  readonly origin?: CodingWorkbenchRuntimeVersion["origin"] | undefined;
  /** Resolves to the helper's exit code, or null when it did not run to an exit. */
  readonly runStatus: HelperRunner;
  /** The native `--gateway-service-install`; the same contract as `runStatus`. */
  readonly runInstall?: HelperRunner | undefined;
  /**
   * The installation is managed outside the app (a standalone folder package or an IT-managed
   * deployment, ADR-0121 D9). Keiko sets up no system service there: a broker that is not ready
   * is named as such, never with an install or repair step.
   */
  readonly managedOutsideApp?: boolean | undefined;
  readonly now?: () => number;
}

interface CachedState {
  readonly state: WindowsGatewayServiceState;
  readonly at: number;
}

// A sink that throws reports the loss on the existing body-free stderr channel instead of failing
// the caller.
function writeEvent(
  activityLog: ServerLogSink,
  op: string,
  correlationId: string,
  event: () => Parameters<ServerLogSink["write"]>[0],
): void {
  try {
    activityLog.write(event());
  } catch (error) {
    reportServerLogFailure(error, { op, correlationId, loss: "event-dropped" });
  }
}

// One line per state change.
function writeStateChange(
  input: WindowsGatewayServiceProbeInput,
  state: WindowsGatewayServiceState,
): void {
  const correlationId = randomUUID();
  writeEvent(input.activityLog, WINDOWS_GATEWAY_SERVICE_OPERATION.op, correlationId, () =>
    activityLogEvent(
      WINDOWS_GATEWAY_SERVICE_OPERATION,
      { level: state === "ready" ? "info" : "warn", correlationId },
      {
        state,
        helperSha256: input.helperSha256,
        ...(input.evidenceClass === undefined ? {} : { evidenceClass: input.evidenceClass }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      },
    ),
  );
}

type RepairEventOutcome = Exclude<CodingWorkbenchGatewayServiceRepairOutcome, "unavailable">;

interface RepairSettlement {
  readonly outcome: RepairEventOutcome;
  readonly state?: WindowsGatewayServiceState;
  readonly exitClass?: "state" | "native-failure" | "no-exit" | "unexpected";
}

/** The closed outcome of one native install, from its exit code alone. */
export function classifyWindowsGatewayInstallExit(exitCode: number | null): RepairSettlement {
  if (exitCode === null) return { outcome: "failed", exitClass: "no-exit" };
  const state = NATIVE_STATES[exitCode];
  if (state !== undefined) {
    return state === "ready"
      ? { outcome: "ready", state, exitClass: "state" }
      : { outcome: "failed", state, exitClass: "state" };
  }
  if (exitCode === NATIVE_ELEVATION_DECLINED) {
    return { outcome: "declined", exitClass: "native-failure" };
  }
  const nativeFailure = exitCode >= NATIVE_FAILURE_MIN && exitCode <= NATIVE_FAILURE_MAX;
  return { outcome: "failed", exitClass: nativeFailure ? "native-failure" : "unexpected" };
}

function writeRepair(
  input: WindowsGatewayServiceProbeInput,
  correlationId: string,
  settlement: RepairSettlement,
  durationMs: number,
): void {
  writeEvent(input.activityLog, WINDOWS_GATEWAY_SERVICE_REPAIR_OPERATION.op, correlationId, () =>
    activityLogEvent(
      WINDOWS_GATEWAY_SERVICE_REPAIR_OPERATION,
      settlement.outcome === "failed"
        ? { level: "warn", correlationId, errorKind: "unavailable" }
        : { level: "info", correlationId },
      {
        outcome: settlement.outcome,
        ...(settlement.state === undefined ? {} : { state: settlement.state }),
        ...(settlement.exitClass === undefined ? {} : { exitClass: settlement.exitClass }),
        helperSha256: input.helperSha256,
        durationMs: Math.max(0, durationMs),
      },
    ),
  );
}

// One UAC prompt at a time: a second press while Windows asks answers busy. The install port never
// rejects by contract; a rejection still counts as an install that did not run to an exit.
function createGatewayRepair(
  input: WindowsGatewayServiceProbeInput,
  runInstall: HelperRunner,
  now: () => number,
  refreshFresh: () => Promise<void>,
): (correlationId: string) => Promise<CodingWorkbenchGatewayServiceRepairOutcome> {
  let repairing = false;
  return async (correlationId) => {
    if (repairing) {
      writeRepair(input, correlationId, { outcome: "busy" }, 0);
      return "busy";
    }
    repairing = true;
    const startedAt = now();
    try {
      const exitCode = await runInstall(input.helperPath, input.helperSha256).catch(
        (): null => null,
      );
      const settlement = classifyWindowsGatewayInstallExit(exitCode);
      writeRepair(input, correlationId, settlement, now() - startedAt);
      await refreshFresh();
      return settlement.outcome;
    } finally {
      repairing = false;
    }
  };
}

// An installation managed outside the app (ADR-0121 D9) sets up no system service, so a broker
// that is not ready there is named as one this Keiko does not set up, whatever its state.
function unavailableReasonFor(
  state: WindowsGatewayServiceState,
  managedOutsideApp: boolean,
): CodingWorkbenchRuntimeUnavailableReason | undefined {
  if (state === "ready") return undefined;
  return managedOutsideApp ? "gateway-service-managed-outside" : UNAVAILABLE_REASONS[state];
}

// #4068: a read never waits for the helper. It answers from the last settled state and starts a
// background refresh once that state is older than the TTL, so a slow service query cannot hold
// the server's event loop. Before the first result the state is unknown, which keeps the Workbench
// unavailable (fail closed). The first refresh starts with the probe, at server startup.
export function createWindowsGatewayServiceProbe(
  input: WindowsGatewayServiceProbeInput,
): RefreshingWindowsGatewayServiceProbe {
  const now = input.now ?? Date.now;
  let cached: CachedState | undefined;
  let pending: Promise<void> | undefined;

  const settle = (state: WindowsGatewayServiceState): void => {
    // A status poll must not write a line per read: only a change is evidence.
    const changed = cached?.state !== state;
    // The state is cached first: a sink that throws must neither crash the process nor make the
    // next read spawn the helper again.
    cached = { state, at: now() };
    if (changed) writeStateChange(input, state);
  };

  const refresh = (): void => {
    if (pending !== undefined) return;
    pending = input
      .runStatus(input.helperPath, input.helperSha256)
      .then(
        (exitCode) => (exitCode === null ? undefined : NATIVE_STATES[exitCode]) ?? "state-unknown",
        (): WindowsGatewayServiceState => "state-unknown",
      )
      .then(settle)
      .finally(() => {
        pending = undefined;
      });
  };

  const read = (): WindowsGatewayServiceState => {
    if (cached === undefined || now() - cached.at >= PROBE_TTL_MS) refresh();
    return cached?.state ?? "state-unknown";
  };

  // The next read after a repair answers from a fresh status, not from the state before it.
  const refreshFresh = async (): Promise<void> => {
    await (pending ?? Promise.resolve());
    cached = undefined;
    refresh();
    await (pending ?? Promise.resolve());
  };
  const repair =
    input.runInstall === undefined || input.managedOutsideApp === true
      ? undefined
      : createGatewayRepair(input, input.runInstall, now, refreshFresh);

  refresh();
  return {
    unavailableReason: (): CodingWorkbenchRuntimeUnavailableReason | undefined =>
      unavailableReasonFor(read(), input.managedOutsideApp === true),
    ...(repair === undefined ? {} : { repair }),
    // At most one refresh runs, and settling one never starts another.
    idle: (): Promise<void> => pending ?? Promise.resolve(),
  };
}
