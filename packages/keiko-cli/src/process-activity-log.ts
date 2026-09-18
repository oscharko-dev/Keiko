import {
  activityLogEvent,
  classifyErrorKind,
  defineActivityLogOperation,
  isActivityLogErrorKind,
  type ActivityLogEventEnvelope,
  type ActivityLogErrorKind,
  type ActivityLogFields,
  type RegisteredActivityLogEvent,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

const PROCESS_FATAL_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "process.fatal",
  category: "process",
  owner: "keiko-cli",
  emitter: "process-activity-log.processFatalActivityLogEvent",
  fields: {
    kind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["server-error", "uncaught-exception", "unhandled-rejection"],
    },
    failureKind: {
      type: "string",
      dataClass: "error-kind",
      required: true,
      maxLength: 64,
    },
    recoveryReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["interrupted", "corrupt", "incompatible", "persistence-failed", "unspecified"],
    },
    sessionId: {
      type: "string",
      dataClass: "opaque-id",
      required: false,
      maxLength: 128,
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxItems: 8,
      maxLength: 512,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxItems: 5,
      maxLength: 64,
    },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["process-fatal", "startup-recovery-failed"],
  proofIds: ["process.fatal.body-free", "process.fatal.stack-context"],
  releaseImpact: "patch",
});

type ProcessFatalFields = ActivityLogFields<typeof PROCESS_FATAL_OPERATION>;
type ProcessFatalEvent = RegisteredActivityLogEvent<typeof PROCESS_FATAL_OPERATION> &
  ActivityLogEventEnvelope & { readonly extra: ProcessFatalFields };

export interface ProcessFatalActivityInput {
  readonly kind: ProcessFatalFields["kind"];
  readonly failureKind: string;
  readonly recoveryReason?: ProcessFatalFields["recoveryReason"];
  readonly sessionId?: string | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
}

function boundedSessionId(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : undefined;
}

const RECOVERY_ERROR_KINDS = {
  interrupted: "cancelled",
  corrupt: "validation-failed",
  incompatible: "validation-failed",
  "persistence-failed": "durability-failed",
  unspecified: "internal",
} as const satisfies Readonly<
  Record<NonNullable<ProcessFatalFields["recoveryReason"]>, ActivityLogErrorKind>
>;

const FATAL_ERROR_KIND_PATTERNS: readonly (readonly [RegExp, ActivityLogErrorKind])[] = [
  [/timeout|timedout|etimedout/iu, "timeout"],
  [/cancel|abort|interrupted/iu, "cancelled"],
  [/rate.?limit|quota/iu, "rate-limited"],
  [/permission|forbidden|unauthorized|eacces|eperm|auth/iu, "permission-denied"],
  [/unavailable|connection|transport|network|econn|epipe|dns/iu, "unavailable"],
];

function fatalActivityErrorKind(
  failureKind: string,
  recoveryReason: ProcessFatalFields["recoveryReason"],
): ActivityLogErrorKind {
  if (recoveryReason !== undefined) return RECOVERY_ERROR_KINDS[recoveryReason];
  if (isActivityLogErrorKind(failureKind)) return failureKind;
  return (
    FATAL_ERROR_KIND_PATTERNS.find(([pattern]) => pattern.test(failureKind))?.[1] ?? "internal"
  );
}

export function processFatalActivityLogEvent(input: ProcessFatalActivityInput): ProcessFatalEvent {
  const failureKind = classifyErrorKind(input.failureKind) ?? "unknown";
  const sessionId = boundedSessionId(input.sessionId);
  return activityLogEvent(
    PROCESS_FATAL_OPERATION,
    {
      level: "error",
      errorKind: fatalActivityErrorKind(failureKind, input.recoveryReason),
    },
    {
      kind: input.kind,
      failureKind,
      ...(input.recoveryReason === undefined ? {} : { recoveryReason: input.recoveryReason }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(input.frames === undefined ? {} : { frames: input.frames }),
      ...(input.causeChain === undefined ? {} : { causeChain: input.causeChain }),
    },
  );
}
