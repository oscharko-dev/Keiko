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
//
// `--dev-lane` installs the same broker from a Windows dev checkout, pinned to the runtime
// supervisor that checkout built (ADR-0043 D19). It is the human's explicit choice; without it the
// command accepts only a release-qualified package's helper.

const USAGE = `Usage:
  keiko gateway-service status      Report whether the Windows runtime gateway is ready.
  keiko gateway-service install     Install the gateway service (asks Windows for approval).
  keiko gateway-service repair      Bring the service back to this Keiko version's helper.
  keiko gateway-service uninstall   Remove the service and its files.

Add --dev-lane in a Windows repository checkout to use the runtime supervisor it built.

Windows only. Coding runs on Windows stay refused until the gateway is ready.
Exit code: 0 ready or removed, 1 not ready or failed, 2 usage error.`;

const ACTIONS = ["status", "install", "repair", "uninstall"] as const;
type GatewayServiceAction = (typeof ACTIONS)[number];

const DEV_LANE_FLAG = "--dev-lane";

const LANES = ["release-qualified", "dev-checkout"] as const;
type GatewayServiceLane = (typeof LANES)[number];

const ACTION_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: ACTIONS,
} as const;

// Which helper the command used, so a log tells a checkout's broker from a release's.
const LANE_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: LANES,
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
  fields: { action: ACTION_FIELD, lane: LANE_FIELD },
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
    lane: LANE_FIELD,
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
    lane: LANE_FIELD,
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "unsupported-platform",
        "helper-not-qualified",
        "dev-checkout-unverified",
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

function stateMessage(state: GatewayServiceState, lane: GatewayServiceLane): string {
  const flag = lane === "dev-checkout" ? ` ${DEV_LANE_FLAG}` : "";
  switch (state) {
    case "ready":
      return "The Windows runtime gateway is ready.";
    case "absent":
      return `The Windows runtime gateway is not installed. Run: keiko gateway-service install${flag}`;
    case "stopped":
      return `The Windows runtime gateway is stopped. Run: keiko gateway-service repair${flag}`;
    case "image-mismatch":
      return `The Windows runtime gateway does not match this Keiko version. Run: keiko gateway-service repair${flag}`;
    case "state-unknown":
      return "The state of the Windows runtime gateway could not be determined.";
  }
}

const REMOVED_MESSAGE = "The Windows runtime gateway is removed.";

interface GatewayServiceFailureText {
  readonly kind: ActivityLogErrorKind;
  readonly message: string;
}

// The `--dev-lane` refusal: a checkout that does not verify has no supervisor to install (#4068).
const DEV_CHECKOUT_FAILURE: GatewayServiceFailureText = {
  kind: "validation-failed",
  message:
    "This is not a verified Windows dev checkout. Stage its runtime with: npm run dev:coding-runtime:stage",
};

const FAILURES: Readonly<Record<GatewayServiceFailure, GatewayServiceFailureText>> = {
  "dev-checkout-unverified": DEV_CHECKOUT_FAILURE,
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
      "A coding run may still be protected by the gateway's network policy, so nothing was removed.",
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
    lane: GatewayServiceLane,
  ) => Promise<WindowsGatewayHelper | undefined>;
  readonly runHelper?: (helperPath: string, args: readonly string[]) => Promise<number>;
}

interface GatewayServiceRequest {
  readonly action: GatewayServiceAction;
  readonly lane: GatewayServiceLane;
}

function startedEvent({ action, lane }: GatewayServiceRequest): SecurityLogEvent {
  return activityLogEvent(
    CLI_GATEWAY_SERVICE_STARTED_OPERATION,
    { level: "info" },
    { action, lane },
  );
}

function completedEvent(
  { action, lane }: GatewayServiceRequest,
  state: GatewayServiceState,
  durationMs: number,
): SecurityLogEvent {
  return activityLogEvent(
    CLI_GATEWAY_SERVICE_COMPLETED_OPERATION,
    { level: state === "ready" || action === "uninstall" ? "info" : "warn" },
    { action, lane, state, durationMs },
  );
}

function failedEvent(
  { action, lane }: GatewayServiceRequest,
  reason: GatewayServiceFailure,
  failureKind: string,
  durationMs: number,
): SecurityLogEvent {
  return activityLogEvent(
    CLI_GATEWAY_SERVICE_FAILED_OPERATION,
    { level: "error", errorKind: FAILURES[reason].kind },
    {
      action,
      lane,
      reason,
      failureKind: classifyErrorKind(failureKind) ?? "unknown",
      durationMs,
    },
  );
}

async function defaultResolveHelper(
  env: Readonly<Record<string, string | undefined>>,
  lane: GatewayServiceLane,
): Promise<WindowsGatewayHelper | undefined> {
  const server = await loadServer();
  return lane === "dev-checkout"
    ? server.discoverDevCheckoutWindowsGatewayHelper({ env })
    : server.discoverReleasedWindowsGatewayHelper({ env });
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

interface GatewayServiceRun extends GatewayServiceRequest {
  readonly io: CliIo;
  readonly sink: ReturnType<typeof createCliSecurityLogSink>;
  readonly startedAt: number;
}

function reportFailure(
  run: GatewayServiceRun,
  reason: GatewayServiceFailure,
  failureKind: string,
): number {
  emitSecurityLogEvent(run.sink, failedEvent(run, reason, failureKind, Date.now() - run.startedAt));
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
  emitSecurityLogEvent(run.sink, completedEvent(run, state, Date.now() - run.startedAt));
  run.io.out(`${action === "uninstall" ? REMOVED_MESSAGE : stateMessage(state, run.lane)}
`);
  return succeeded(action, state) ? 0 : 1;
}

function missingHelperReason(lane: GatewayServiceLane): GatewayServiceFailure {
  return lane === "dev-checkout" ? "dev-checkout-unverified" : "helper-not-qualified";
}

async function runAction(
  run: GatewayServiceRun,
  env: Readonly<Record<string, string | undefined>>,
  deps: GatewayServiceCliDeps,
): Promise<number> {
  try {
    const helper = await (deps.resolveHelper ?? defaultResolveHelper)(env, run.lane);
    if (helper === undefined) {
      return reportFailure(run, missingHelperReason(run.lane), "NotQualified");
    }
    const exitCode = await (deps.runHelper ?? defaultRunHelper)(
      helper.helperPath,
      helperArguments(run.action, helper.helperSha256),
    );
    return settle(run, exitCode);
  } catch (error) {
    // The class of failure only: a spawn error message can quote the helper's path.
    emitSecurityLogEvent(
      run.sink,
      failedEvent(run, "helper-unavailable", securityErrorKind(error), Date.now() - run.startedAt),
    );
    run.io.err(`keiko gateway-service: ${FAILURES["helper-unavailable"].message}
`);
    return 1;
  }
}

/** The action and lane, or `undefined` for anything else; `--dev-lane` may stand on either side. */
function parseRequest(rest: readonly string[]): GatewayServiceRequest | undefined {
  const devLane = rest.filter((arg) => arg === DEV_LANE_FLAG).length;
  const operands = rest.filter((arg) => arg !== DEV_LANE_FLAG);
  const [action] = operands;
  if (operands.length !== 1 || devLane > 1 || !isAction(action)) return undefined;
  return { action, lane: devLane === 1 ? "dev-checkout" : "release-qualified" };
}

export async function runGatewayServiceCli(
  rest: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
  deps: GatewayServiceCliDeps = {},
): Promise<number> {
  const [first] = rest;
  if (first === "--help" || first === "-h") {
    io.out(`${USAGE}
`);
    return 0;
  }
  const request = parseRequest(rest);
  if (request === undefined) {
    io.err(`${USAGE}
`);
    return 2;
  }
  const stateDir = env.KEIKO_STATE_DIR ?? join(deps.cwd ?? process.cwd(), ".keiko");
  const sink = createCliSecurityLogSink(stateDir, deps.securityLogSinkFactory, randomUUID());
  const run: GatewayServiceRun = { ...request, io, sink, startedAt: Date.now() };
  emitSecurityLogEvent(sink, startedEvent(run));
  return (deps.platform ?? process.platform) === "win32"
    ? runAction(run, env, deps)
    : reportFailure(run, "unsupported-platform", "Platform");
}
