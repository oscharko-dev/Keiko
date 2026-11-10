import { randomUUID } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { CodingWorkbenchRuntimeUnavailableReason } from "@oscharko-dev/keiko-contracts";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";

// Tells the Workbench why a released Windows runtime cannot start, and what the human can do about
// it (ADR-0043 D19, #4068). The answer comes from the native helper, refreshed in the background
// while Keiko runs rather than once at startup: the broker starts delayed after boot and can be
// installed while Keiko runs, and neither may require a Keiko restart. The launch itself stays
// fail-closed whatever this probe last said.

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
      values: ["ready", "absent", "stopped", "image-mismatch", "state-unknown"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["windows-gateway-service"],
  proofIds: ["coding-runtime.windows-gateway-service.real-sink-line"],
  releaseImpact: "patch",
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
}

/** The probe that asks the helper in the background. */
export interface RefreshingWindowsGatewayServiceProbe extends WindowsGatewayServiceProbe {
  /** Settles once no helper run is pending. */
  readonly idle: () => Promise<void>;
}

export interface WindowsGatewayServiceProbeInput {
  readonly helperPath: string;
  readonly helperSha256: string;
  readonly activityLog: ServerLogSink;
  /** Resolves to the helper's exit code, or null when it did not run to an exit. */
  readonly runStatus: (helperPath: string, helperSha256: string) => Promise<number | null>;
  readonly now?: () => number;
}

interface CachedState {
  readonly state: WindowsGatewayServiceState;
  readonly at: number;
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
    if (cached?.state !== state) {
      input.activityLog.write(
        activityLogEvent(
          WINDOWS_GATEWAY_SERVICE_OPERATION,
          { level: state === "ready" ? "info" : "warn", correlationId: randomUUID() },
          { state },
        ),
      );
    }
    cached = { state, at: now() };
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

  refresh();
  return {
    unavailableReason: (): CodingWorkbenchRuntimeUnavailableReason | undefined => {
      const state = read();
      return state === "ready" ? undefined : UNAVAILABLE_REASONS[state];
    },
    // At most one refresh runs, and settling one never starts another.
    idle: (): Promise<void> => pending ?? Promise.resolve(),
  };
}
