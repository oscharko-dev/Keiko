import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activityLogEvent,
  classifyErrorKind,
  defineActivityLogOperation,
  type ActivityLogFields,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogEvent,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";

import {
  NATIVE_FAILURES,
  NATIVE_STATES,
  defaultResolveHelper,
  defaultRunHelper,
  helperArguments,
  type GatewayServiceCliDeps,
  type GatewayServiceFailure,
  type GatewayServiceLane,
  type GatewayServiceState,
  type WindowsGatewayHelper,
} from "./gateway-service.js";
import type { CliIo } from "./runner.js";

// One-step Windows setup (ADR-0043 D19, ADR-0121 D3/D5): every `keiko start` on Windows — the
// first launch of a new install, the relaunch that completes an update, and an npm start — brings
// the `KeikoRuntimeGateway` service to the helper of the Keiko version that just started. It runs
// after the UI answered healthy, so a pending Windows approval never delays the start or the
// update's restart proof.
//
// The authority is unchanged: Windows asks the human through UAC and only the digest-checked native
// helper runs elevated, through the same `--gateway-service-install` command `keiko gateway-service
// repair` uses. Keiko asks at most once per helper pin: the pin of the last automatic attempt is
// recorded in the state directory, so a declined approval is not repeated on every launch; the
// Coding Workbench then offers Repair, and a new Keiko version (a new pin) asks once again.

/** The operator's opt-out for fleets that install the service themselves (MDM, images). */
export const GATEWAY_SERVICE_SETUP_ENV = "KEIKO_GATEWAY_SERVICE_SETUP";
const GATEWAY_SERVICE_SETUP_MANUAL = "manual";

/** The record of the last automatic attempt, inside the state directory. */
export const GATEWAY_SERVICE_SETUP_RECORD = "gateway-service-setup.json";
const RECORD_SCHEMA_VERSION = 1;

const SETUP_OUTCOMES = [
  "ready",
  "installed",
  "declined",
  "failed",
  "deferred",
  "no-helper",
  "disabled",
  "record-unavailable",
] as const;

const STATE_VALUES = ["ready", "absent", "stopped", "image-mismatch", "state-unknown"] as const;

// The native install's failures (gateway_install.h) plus the two this module adds itself; a
// declined approval is its own outcome, so it is also named here as the reason that outcome carries.
const SETUP_FAILURE_REASONS = [
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
] as const;

const CLI_GATEWAY_SERVICE_SETUP_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.gateway-service.setup",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "gateway-service-setup.setupEvent",
  fields: {
    outcome: { type: "string", dataClass: "closed-enum", required: true, values: SETUP_OUTCOMES },
    lane: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["release-qualified", "portable-evaluation", "dev-checkout", "npm-runtime-package"],
    },
    priorState: { type: "string", dataClass: "closed-enum", required: false, values: STATE_VALUES },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: SETUP_FAILURE_REASONS,
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    durationMs: { type: "integer", dataClass: "duration", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["failed", "record-unavailable"] }],
  failureClasses: ["cli-gateway-service"],
  proofIds: ["cli.gateway-service.setup.real-sink-line"],
  releaseImpact: "minor",
});

export type GatewayServiceSetupOutcome = ActivityLogFields<
  typeof CLI_GATEWAY_SERVICE_SETUP_OPERATION
>["outcome"];
type SetupFailureReason = NonNullable<
  ActivityLogFields<typeof CLI_GATEWAY_SERVICE_SETUP_OPERATION>["reason"]
>;

export interface GatewayServiceSetupInput {
  readonly stateDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: CliIo;
  readonly sink: SecurityLogSink | undefined;
}

export type GatewayServiceSetupDeps = Pick<
  GatewayServiceCliDeps,
  "platform" | "resolveHelper" | "runHelper"
> & {
  readonly now?: () => number;
};

export type GatewayServiceSetupFn = (
  input: GatewayServiceSetupInput,
) => Promise<GatewayServiceSetupOutcome | undefined>;

interface SetupFacts {
  readonly lane?: GatewayServiceLane;
  readonly priorState?: GatewayServiceState;
  readonly reason?: SetupFailureReason;
  readonly failureKind?: string;
}

interface SetupRun {
  readonly input: GatewayServiceSetupInput;
  readonly startedAt: number;
  readonly now: () => number;
}

function setupEventLevel(outcome: GatewayServiceSetupOutcome): "info" | "warn" {
  return outcome === "failed" || outcome === "record-unavailable" ? "warn" : "info";
}

function setupEvent(
  run: SetupRun,
  outcome: GatewayServiceSetupOutcome,
  facts: SetupFacts,
): SecurityLogEvent {
  const level = setupEventLevel(outcome);
  return activityLogEvent(
    CLI_GATEWAY_SERVICE_SETUP_OPERATION,
    level === "warn" ? { level, errorKind: "unavailable" } : { level },
    {
      outcome,
      ...(facts.lane === undefined ? {} : { lane: facts.lane }),
      ...(facts.priorState === undefined ? {} : { priorState: facts.priorState }),
      ...(facts.reason === undefined ? {} : { reason: facts.reason }),
      ...(facts.failureKind === undefined ? {} : { failureKind: facts.failureKind }),
      durationMs: Math.max(0, run.now() - run.startedAt),
    },
  );
}

function recordSetup(
  run: SetupRun,
  outcome: GatewayServiceSetupOutcome,
  facts: SetupFacts = {},
): GatewayServiceSetupOutcome {
  emitSecurityLogEvent(run.input.sink, setupEvent(run, outcome, facts));
  return outcome;
}

/**
 * The pin of the last automatic attempt; undefined when there is none or the record names no valid
 * pin. A record that exists but cannot be read or parsed throws: the caller records it and does not
 * ask, because it could not tell whether it already asked.
 */
export function readGatewayServiceSetupPin(stateDir: string): string | undefined {
  const path = join(stateDir, GATEWAY_SERVICE_SETUP_RECORD);
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as { readonly schemaVersion?: unknown; readonly helperSha256?: unknown };
  return record.schemaVersion === RECORD_SCHEMA_VERSION &&
    typeof record.helperSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(record.helperSha256)
    ? record.helperSha256
    : undefined;
}

function writeSetupRecord(stateDir: string, helperSha256: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, GATEWAY_SERVICE_SETUP_RECORD),
    `${JSON.stringify({ schemaVersion: RECORD_SCHEMA_VERSION, helperSha256 })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

// The closed error kind of a caught error; never its message, which can quote a path.
function errorKindOf(error: unknown): string {
  return classifyErrorKind(securityErrorKind(error)) ?? "unknown";
}

const SETUP_FAILURE_REASON_SET: ReadonlySet<string> = new Set(SETUP_FAILURE_REASONS);

function isSetupFailureReason(value: GatewayServiceFailure): value is SetupFailureReason {
  return SETUP_FAILURE_REASON_SET.has(value);
}

function installFailureReason(exitCode: number): SetupFailureReason {
  const failure: GatewayServiceFailure | undefined = NATIVE_FAILURES[exitCode];
  if (failure !== undefined && isSetupFailureReason(failure)) return failure;
  return NATIVE_STATES[exitCode] === undefined ? "unexpected-result" : "not-ready";
}

async function installOnce(
  run: SetupRun,
  helper: WindowsGatewayHelper,
  priorState: GatewayServiceState,
  runHelper: (helperPath: string, args: readonly string[]) => Promise<number>,
): Promise<GatewayServiceSetupOutcome> {
  const lane = helper.lane;
  try {
    writeSetupRecord(run.input.stateDir, helper.helperSha256);
  } catch (error) {
    // Without a record Keiko could not tell the next launch that it already asked, so it does not
    // ask at all; the Workbench still offers Repair.
    return recordSetup(run, "record-unavailable", {
      ...(lane === undefined ? {} : { lane }),
      priorState,
      failureKind: errorKindOf(error),
    });
  }
  run.input.io.out(
    "Keiko is setting up its Windows runtime gateway for coding runs. Windows asks for approval once.\n",
  );
  const exitCode = await runHelper(
    helper.helperPath,
    helperArguments("install", helper.helperSha256),
  );
  const facts = { ...(lane === undefined ? {} : { lane }), priorState };
  if (NATIVE_STATES[exitCode] === "ready") {
    run.input.io.out("The Windows runtime gateway is ready.\n");
    return recordSetup(run, "installed", facts);
  }
  if (NATIVE_FAILURES[exitCode] === "elevation-declined") {
    run.input.io.out(
      "Windows approval was declined. You can set up the gateway later with Repair in the Coding Workbench.\n",
    );
    return recordSetup(run, "declined", { ...facts, reason: "elevation-declined" });
  }
  run.input.io.err(
    "keiko start: the Windows runtime gateway could not be set up. The Coding Workbench offers Repair.\n",
  );
  return recordSetup(run, "failed", { ...facts, reason: installFailureReason(exitCode) });
}

async function setUpWithHelper(
  run: SetupRun,
  helper: WindowsGatewayHelper,
  runHelper: (helperPath: string, args: readonly string[]) => Promise<number>,
): Promise<GatewayServiceSetupOutcome> {
  const lane = helper.lane;
  const laneFacts = lane === undefined ? {} : { lane };
  const status = await runHelper(helper.helperPath, helperArguments("status", helper.helperSha256));
  const priorState = NATIVE_STATES[status] ?? "state-unknown";
  if (priorState === "ready") return recordSetup(run, "ready", laneFacts);
  let recordedPin: string | undefined;
  try {
    recordedPin = readGatewayServiceSetupPin(run.input.stateDir);
  } catch (error) {
    return recordSetup(run, "record-unavailable", {
      ...laneFacts,
      priorState,
      failureKind: errorKindOf(error),
    });
  }
  if (recordedPin === helper.helperSha256) {
    return recordSetup(run, "deferred", { ...laneFacts, priorState });
  }
  return installOnce(run, helper, priorState, runHelper);
}

/**
 * Bring the Windows gateway service to this Keiko version's helper, at most one UAC prompt per
 * helper pin. Never throws and never changes the start's exit code; `undefined` off Windows.
 */
export async function setUpWindowsGatewayServiceForStart(
  input: GatewayServiceSetupInput,
  deps: GatewayServiceSetupDeps = {},
): Promise<GatewayServiceSetupOutcome | undefined> {
  if ((deps.platform ?? process.platform) !== "win32") return undefined;
  const now = deps.now ?? Date.now;
  const run: SetupRun = { input, startedAt: now(), now };
  if (input.env[GATEWAY_SERVICE_SETUP_ENV] === GATEWAY_SERVICE_SETUP_MANUAL) {
    return recordSetup(run, "disabled");
  }
  try {
    // Release and npm helpers only: a dev checkout keeps its explicit `--dev-lane` command.
    const helper = await (deps.resolveHelper ?? defaultResolveHelper)(
      input.env,
      "release-qualified",
    );
    if (helper === undefined) return recordSetup(run, "no-helper");
    return await setUpWithHelper(run, helper, deps.runHelper ?? defaultRunHelper);
  } catch (error) {
    // The class of failure only: a spawn error message can quote the helper's path.
    return recordSetup(run, "failed", {
      reason: "helper-unavailable",
      failureKind: errorKindOf(error),
    });
  }
}
