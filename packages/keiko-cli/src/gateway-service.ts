import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  activityLogEvent,
  classifyErrorKind,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogEvent,
} from "@oscharko-dev/keiko-security";

import { loadServer } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import { createCliSecurityLogSink, type CliSecurityLogSinkFactory } from "./security-log.js";

// `keiko gateway-service` — the customer's way to install, repair and remove the LocalSystem broker
// that confines a Windows coding runtime to its attested gateway (ADR-0043 D19, #4068).
//
// This command holds no authority of its own. Windows asks the human through UAC, and only the
// digest-checked native helper runs elevated; Node never does. An ordinary Workbench launch never
// comes through here, so it never prompts.

const USAGE = `Usage:
  keiko gateway-service status      Report whether the Windows runtime gateway is ready.
  keiko gateway-service install     Install the gateway service (asks Windows for approval).
  keiko gateway-service repair      Bring the service back to this Keiko version's helper.
  keiko gateway-service uninstall   Remove the service and its files.

Windows only. Coding runs on Windows stay refused until the gateway is ready.
Exit code: 0 ready or removed, 1 not ready or failed, 2 usage error.`;

const ACTIONS = ["status", "install", "repair", "uninstall"] as const;
type GatewayServiceAction = (typeof ACTIONS)[number];

const ACTION_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: ACTIONS,
} as const;

// A UAC approval can wait on the human for minutes, so the duration separates that from a fault.
const DURATION_FIELD = { type: "integer", dataClass: "duration", required: true } as const;

const CLI_GATEWAY_SERVICE_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.gateway-service.started",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "gateway-service.startedEvent",
  fields: { action: ACTION_FIELD },
  causal: "correlation",
  lifecycle: "start",
  analyzerProjection: "timeline",
  failureClasses: ["cli-gateway-service"],
  proofIds: ["cli.gateway-service.started.real-sink-line"],
  releaseImpact: "patch",
});

const CLI_GATEWAY_SERVICE_COMPLETED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.gateway-service.completed",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "gateway-service.completedEvent",
  fields: {
    action: ACTION_FIELD,
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["ready", "absent", "stopped", "image-mismatch", "state-unknown"],
    },
    durationMs: DURATION_FIELD,
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["cli-gateway-service"],
  proofIds: ["cli.gateway-service.completed.real-sink-line"],
  releaseImpact: "patch",
});

const CLI_GATEWAY_SERVICE_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.gateway-service.failed",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "gateway-service.failedEvent",
  fields: {
    action: ACTION_FIELD,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "unsupported-platform",
        "helper-not-qualified",
        "helper-unavailable",
        "elevation-declined",
        "source-mismatch",
        "target-unsafe",
        "copy-failed",
        "scm-failed",
        "start-failed",
        "guards-remain",
        "invalid-request",
        "not-ready",
        "unexpected-result",
      ],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
    durationMs: DURATION_FIELD,
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["cli-gateway-service"],
  proofIds: ["cli.gateway-service.failed.real-sink-line"],
  releaseImpact: "patch",
});

type GatewayServiceState = ActivityLogFields<
  typeof CLI_GATEWAY_SERVICE_COMPLETED_OPERATION
>["state"];
type GatewayServiceFailure = ActivityLogFields<
  typeof CLI_GATEWAY_SERVICE_FAILED_OPERATION
>["reason"];

// The exit codes of the native --gateway-service-* commands (gateway_install.h).
const NATIVE_STATES: Readonly<Record<number, GatewayServiceState>> = {
  0: "ready",
  10: "absent",
  11: "stopped",
  12: "image-mismatch",
  13: "state-unknown",
};

const NATIVE_FAILURES: Readonly<Record<number, GatewayServiceFailure>> = {
  20: "elevation-declined",
  21: "source-mismatch",
  22: "target-unsafe",
  23: "copy-failed",
  24: "scm-failed",
  25: "start-failed",
  26: "guards-remain",
  27: "invalid-request",
};

const STATE_MESSAGES: Readonly<Record<GatewayServiceState, string>> = {
  ready: "The Windows runtime gateway is ready.",
  absent: "The Windows runtime gateway is not installed. Run: keiko gateway-service install",
  stopped: "The Windows runtime gateway is stopped. Run: keiko gateway-service repair",
  "image-mismatch":
    "The Windows runtime gateway does not match this Keiko version. Run: keiko gateway-service repair",
  "state-unknown": "The state of the Windows runtime gateway could not be determined.",
};

const REMOVED_MESSAGE = "The Windows runtime gateway is removed.";

const FAILURES: Readonly<
  Record<GatewayServiceFailure, { readonly kind: ActivityLogErrorKind; readonly message: string }>
> = {
  "unsupported-platform": {
    kind: "validation-failed",
    message: "keiko gateway-service runs only on Windows.",
  },
  "helper-not-qualified": {
    kind: "validation-failed",
    message: "This installation has no release-qualified Windows runtime helper to install.",
  },
  "helper-unavailable": {
    kind: "unavailable",
    message: "The runtime helper could not be started.",
  },
  "elevation-declined": {
    kind: "cancelled",
    message: "Windows approval was declined; nothing was changed.",
  },
  "source-mismatch": {
    kind: "validation-failed",
    message: "The runtime helper does not match its approved digest; nothing was installed.",
  },
  "target-unsafe": {
    kind: "permission-denied",
    message: "The installation folder is not safe to use; nothing was installed.",
  },
  "copy-failed": {
    kind: "unavailable",
    message: "The gateway files could not be copied or removed.",
  },
  "scm-failed": {
    kind: "unavailable",
    message: "The Windows Service Control Manager refused the change.",
  },
  "start-failed": { kind: "unavailable", message: "The gateway service did not start." },
  "guards-remain": {
    kind: "conflict",
    message:
      "A coding run is still protected by the gateway's network policy. Stop it, restart Windows if none is running, and try again.",
  },
  "invalid-request": {
    kind: "validation-failed",
    message: "The runtime helper rejected the request.",
  },
  "not-ready": {
    kind: "unavailable",
    message: "The gateway service is not ready after the change.",
  },
  "unexpected-result": {
    kind: "internal",
    message: "The runtime helper returned an unexpected result.",
  },
};

export interface WindowsGatewayHelper {
  readonly helperPath: string;
  readonly helperSha256: string;
}

export interface GatewayServiceCliDeps {
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly securityLogSinkFactory?: CliSecurityLogSinkFactory;
  readonly resolveHelper?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<WindowsGatewayHelper | undefined>;
  readonly runHelper?: (helperPath: string, args: readonly string[]) => Promise<number>;
}

function startedEvent(action: GatewayServiceAction): SecurityLogEvent {
  return activityLogEvent(CLI_GATEWAY_SERVICE_STARTED_OPERATION, { level: "info" }, { action });
}

function completedEvent(
  action: GatewayServiceAction,
  state: GatewayServiceState,
  durationMs: number,
): SecurityLogEvent {
  return activityLogEvent(
    CLI_GATEWAY_SERVICE_COMPLETED_OPERATION,
    { level: state === "ready" || action === "uninstall" ? "info" : "warn" },
    { action, state, durationMs },
  );
}

function failedEvent(
  action: GatewayServiceAction,
  reason: GatewayServiceFailure,
  failureKind: string,
  durationMs: number,
): SecurityLogEvent {
  return activityLogEvent(
    CLI_GATEWAY_SERVICE_FAILED_OPERATION,
    { level: "error", errorKind: FAILURES[reason].kind },
    { action, reason, failureKind: classifyErrorKind(failureKind) ?? "unknown", durationMs },
  );
}

async function defaultResolveHelper(
  env: Readonly<Record<string, string | undefined>>,
): Promise<WindowsGatewayHelper | undefined> {
  return (await loadServer()).discoverReleasedWindowsGatewayHelper({ env });
}

function defaultRunHelper(helperPath: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [...args], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? -1);
    });
  });
}

function helperArguments(action: GatewayServiceAction, pin: string): readonly string[] {
  if (action === "status") return ["--gateway-service-status", pin];
  if (action === "uninstall") return ["--gateway-service-uninstall"];
  return ["--gateway-service-install", pin];
}

function isAction(value: string | undefined): value is GatewayServiceAction {
  return (ACTIONS as readonly (string | undefined)[]).includes(value);
}

function succeeded(action: GatewayServiceAction, state: GatewayServiceState): boolean {
  return action === "uninstall" ? state === "absent" : state === "ready";
}

function nativeFailure(action: GatewayServiceAction, exitCode: number): GatewayServiceFailure {
  if (NATIVE_FAILURES[exitCode] !== undefined) return NATIVE_FAILURES[exitCode];
  return NATIVE_STATES[exitCode] !== undefined && action !== "status"
    ? "not-ready"
    : "unexpected-result";
}

interface GatewayServiceRun {
  readonly action: GatewayServiceAction;
  readonly io: CliIo;
  readonly sink: ReturnType<typeof createCliSecurityLogSink>;
  readonly startedAt: number;
}

function reportFailure(
  run: GatewayServiceRun,
  reason: GatewayServiceFailure,
  failureKind: string,
): number {
  emitSecurityLogEvent(
    run.sink,
    failedEvent(run.action, reason, failureKind, Date.now() - run.startedAt),
  );
  run.io.err(`keiko gateway-service: ${FAILURES[reason].message}
`);
  return 1;
}

function settle(run: GatewayServiceRun, exitCode: number): number {
  const { action } = run;
  const state = NATIVE_STATES[exitCode];
  if (state === undefined || (action !== "status" && !succeeded(action, state))) {
    return reportFailure(run, nativeFailure(action, exitCode), "NativeResult");
  }
  emitSecurityLogEvent(run.sink, completedEvent(action, state, Date.now() - run.startedAt));
  run.io.out(`${action === "uninstall" ? REMOVED_MESSAGE : STATE_MESSAGES[state]}
`);
  return succeeded(action, state) ? 0 : 1;
}

async function runAction(
  run: GatewayServiceRun,
  env: Readonly<Record<string, string | undefined>>,
  deps: GatewayServiceCliDeps,
): Promise<number> {
  try {
    const helper = await (deps.resolveHelper ?? defaultResolveHelper)(env);
    if (helper === undefined) return reportFailure(run, "helper-not-qualified", "NotQualified");
    const exitCode = await (deps.runHelper ?? defaultRunHelper)(
      helper.helperPath,
      helperArguments(run.action, helper.helperSha256),
    );
    return settle(run, exitCode);
  } catch (error) {
    // The class of failure only: a spawn error message can quote the helper's path.
    emitSecurityLogEvent(
      run.sink,
      failedEvent(
        run.action,
        "helper-unavailable",
        securityErrorKind(error),
        Date.now() - run.startedAt,
      ),
    );
    run.io.err(`keiko gateway-service: ${FAILURES["helper-unavailable"].message}
`);
    return 1;
  }
}

export async function runGatewayServiceCli(
  rest: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
  deps: GatewayServiceCliDeps = {},
): Promise<number> {
  const [action] = rest;
  if (action === "--help" || action === "-h") {
    io.out(`${USAGE}
`);
    return 0;
  }
  if (rest.length !== 1 || !isAction(action)) {
    io.err(`${USAGE}
`);
    return 2;
  }
  const stateDir = env.KEIKO_STATE_DIR ?? join(deps.cwd ?? process.cwd(), ".keiko");
  const sink = createCliSecurityLogSink(stateDir, deps.securityLogSinkFactory, randomUUID());
  const run: GatewayServiceRun = { action, io, sink, startedAt: Date.now() };
  emitSecurityLogEvent(sink, startedEvent(action));
  return (deps.platform ?? process.platform) === "win32"
    ? runAction(run, env, deps)
    : reportFailure(run, "unsupported-platform", "Platform");
}
