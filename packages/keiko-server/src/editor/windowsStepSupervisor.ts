// #4496 (ADR-0043 D21): the Windows execution-root backend of a governed verification run. The
// supervisor is the runtime's own, verified against the same pin that admits a Windows Coding run;
// each step gets a private copy written from those verified bytes. Without that supervisor the
// backend is absent and a step is refused as isolation unavailable, exactly as before.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  WindowsStepSupervisor,
  WindowsStepSupervisorCopy,
} from "@oscharko-dev/keiko-contracts";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { discoverDevLaneOpenCode } from "../coding-runtime/devLanePortableCodingRuntime.js";
import {
  discardVerifiedHelperCopy,
  verifiedHelperExecutionCopy,
} from "../coding-runtime/nativeRuntimeProcessBackend.js";
import {
  windowsGatewayHelperPin,
  type ResolvedPortableOpenCodeRuntime,
} from "../coding-runtime/productionOpenCodeBackend.js";
import { discoverQualifiedPortableOpenCode } from "../coding-runtime/productionPortableCodingRuntime.js";
import { CommandDeniedError } from "@oscharko-dev/keiko-security";
import { ISOLATION_UNAVAILABLE_DENIAL_PREFIX } from "@oscharko-dev/keiko-verification";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

const WINDOWS_STEP_SUPERVISOR_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "editor.verification.windows-step-supervisor",
  category: "process",
  owner: "keiko-server",
  emitter: "editor.windowsStepSupervisor.resolve",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["available", "no-runtime", "no-pin", "pin-mismatch"],
    },
    readRootCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "capability",
  // A missing supervisor is the backend's absence: the step is refused as isolation unavailable.
  failureClasses: ["runtime-confinement-unavailable"],
  proofIds: ["editor.verification.windows-step-supervisor.emitted-line"],
  releaseImpact: "patch",
});

/** The toolchain homes a step reads besides its executable's own folder: Java's and Maven's. */
const READ_ROOT_VARIABLES = ["JAVA_HOME", "MAVEN_HOME", "M2_HOME"] as const;

// A drive path, as the supervisor accepts a grant: `X:\...`, never a relative or rooted one.
const DRIVE_PATH = /^[A-Za-z]:\\/u;

function directoryOf(value: string | undefined): string | undefined {
  if (value === undefined || !DRIVE_PATH.test(value) || !existsSync(value)) return undefined;
  return statSync(value).isDirectory() ? win32.normalize(value) : undefined;
}

export function windowsStepReadRoots(env: NodeJS.ProcessEnv): readonly string[] {
  const roots = READ_ROOT_VARIABLES.map((name) => directoryOf(env[name])).filter(
    (root): root is string => root !== undefined,
  );
  return Object.freeze([...new Set(roots)]);
}

function discoveredRuntime(env: NodeJS.ProcessEnv): ResolvedPortableOpenCodeRuntime | undefined {
  const portable = discoverQualifiedPortableOpenCode({ env });
  if (portable !== undefined) return portable;
  const development = discoverDevLaneOpenCode({ env });
  return development.outcome === "activated" ? development.runtime : undefined;
}

export interface WindowsStepSupervisorInput {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly activityLog: ServerLogSink;
  readonly correlationId?: string | undefined;
  /** Injectable for tests; defaults to the installed or development runtime. */
  readonly runtime?: (() => ResolvedPortableOpenCodeRuntime | undefined) | undefined;
}

type SupervisorBinary =
  | { readonly outcome: "available"; readonly helperPath: string; readonly pin: string }
  | { readonly outcome: "no-runtime" | "no-pin" | "pin-mismatch" };

// Whether the installed bytes carry the pin now; each step's copy is verified again when written.
function matchesPin(helperPath: string, pin: string): boolean {
  if (!existsSync(helperPath)) return false;
  return createHash("sha256").update(readFileSync(helperPath)).digest("hex") === pin;
}

function supervisorBinary(runtime: ResolvedPortableOpenCodeRuntime | undefined): SupervisorBinary {
  const helperPath = runtime?.nativeHelperPath;
  if (runtime === undefined || helperPath === undefined) return { outcome: "no-runtime" };
  const pin = windowsGatewayHelperPin(runtime);
  if (pin === undefined) return { outcome: "no-pin" };
  return matchesPin(helperPath, pin)
    ? { outcome: "available", helperPath, pin }
    : { outcome: "pin-mismatch" };
}

// A copy that cannot be verified (its bytes miss the pin, or it cannot be written) is a supervisor
// that cannot be governed: the step is refused as isolation unavailable, the same closed reason as
// a host without a backend, and never run.
function verifiedCopy(
  helperPath: string,
  pin: string,
  correlationId: string | undefined,
): ReturnType<typeof verifiedHelperExecutionCopy> {
  try {
    return verifiedHelperExecutionCopy(helperPath, pin);
  } catch (error) {
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
        operation: "editor.verification.windows-step-supervisor.copy-refused",
        source: "editor.verification.windows-step-supervisor",
        error,
        redact: () => "The Windows step supervisor could not be verified against its pin.",
      }),
    );
    throw new CommandDeniedError(
      `${ISOLATION_UNAVAILABLE_DENIAL_PREFIX}the Windows step supervisor could not be verified against its pin`,
      "keiko-runtime-supervisor.exe",
    );
  }
}

/** Each step's private copy, written from the verified bytes and removed when the step ends. */
function verifiedCopies(
  helperPath: string,
  pin: string,
  correlationId: string | undefined,
): WindowsStepSupervisor["acquire"] {
  return (): WindowsStepSupervisorCopy => {
    const copy = verifiedCopy(helperPath, pin, correlationId);
    return {
      path: copy.path,
      release: (): void => {
        void discardVerifiedHelperCopy(copy, {
          operation: "editor.verification.windows-step-supervisor.cleanup",
          source: "editor.verification.windows-step-supervisor",
          correlationId,
        });
      },
    };
  };
}

/**
 * The supervisor a verification run's steps are framed to on Windows, or undefined on every other
 * platform and when no verified supervisor exists. Resolving it records the outcome.
 */
export function resolveWindowsStepSupervisor(
  input: WindowsStepSupervisorInput,
): WindowsStepSupervisor | undefined {
  if ((input.platform ?? process.platform) !== "win32") return undefined;
  const env = input.env ?? process.env;
  const binary = supervisorBinary(
    input.runtime === undefined ? discoveredRuntime(env) : input.runtime(),
  );
  const readRoots = windowsStepReadRoots(env);
  input.activityLog.write(
    activityLogEvent(
      WINDOWS_STEP_SUPERVISOR_OPERATION,
      { correlationId: input.correlationId ?? UNKNOWN_CORRELATION_ID },
      { outcome: binary.outcome, readRootCount: readRoots.length },
    ),
  );
  if (binary.outcome !== "available") return undefined;
  return { acquire: verifiedCopies(binary.helperPath, binary.pin, input.correlationId), readRoots };
}
