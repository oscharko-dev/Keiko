import { randomUUID } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
  withActivityLogCorrelation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogEvent,
  type SecurityLogSink,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "@oscharko-dev/keiko-security";

/** Builds the existing activity-log sink for the state directory selected by one CLI command. */
export type CliSecurityLogSinkFactory = (stateDir: string) => SecurityLogSink;

export type CliWindowsSystemSurface =
  | "launcher-install"
  | "legacy-start-menu-cleanup"
  | "portable-failure-alert"
  | "start-open-browser";

const WINDOWS_SYSTEM_FAILURE_KIND_FIELD = {
  type: "string",
  dataClass: "error-kind",
  required: true,
  maxLength: 64,
} as const;

const WINDOWS_LAUNCHER_FIELDS = {
  surface: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["launcher-install"],
  },
  failureKind: WINDOWS_SYSTEM_FAILURE_KIND_FIELD,
} as const;

const WINDOWS_LEGACY_LAUNCHER_FIELDS = {
  surface: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["legacy-start-menu-cleanup"],
  },
  failureKind: WINDOWS_SYSTEM_FAILURE_KIND_FIELD,
} as const;

const WINDOWS_PORTABLE_ALERT_FIELDS = {
  surface: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["portable-failure-alert"],
  },
  failureKind: WINDOWS_SYSTEM_FAILURE_KIND_FIELD,
} as const;

const WINDOWS_LIFECYCLE_OPENER_FIELDS = {
  surface: {
    type: "string",
    dataClass: "closed-enum",
    required: true,
    values: ["start-open-browser"],
  },
  failureKind: WINDOWS_SYSTEM_FAILURE_KIND_FIELD,
} as const;

const WINDOWS_SYSTEM_ROOT_REFUSED_REGISTRATION = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "security",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemRootRefusal",
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-root-refused"],
  releaseImpact: "patch",
} as const;

const WINDOWS_SYSTEM_BINARY_MISSING_REGISTRATION = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemBinaryMissing",
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-binary-unavailable"],
  releaseImpact: "patch",
} as const;

const WINDOWS_LAUNCHER_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_ROOT_REFUSED_REGISTRATION,
  op: "security.windows-launcher.system-root-refused",
  fields: WINDOWS_LAUNCHER_FIELDS,
  proofIds: ["security.windows-launcher.system-root-refused.emitted-line"],
});

const WINDOWS_LEGACY_LAUNCHER_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_ROOT_REFUSED_REGISTRATION,
  op: "security.windows-portable-legacy-launcher.system-root-refused",
  fields: WINDOWS_LEGACY_LAUNCHER_FIELDS,
  proofIds: ["security.windows-portable-legacy-launcher.system-root-refused.emitted-line"],
});

const WINDOWS_PORTABLE_ALERT_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_ROOT_REFUSED_REGISTRATION,
  op: "security.windows-portable-alert.system-root-refused",
  fields: WINDOWS_PORTABLE_ALERT_FIELDS,
  proofIds: ["security.windows-portable-alert.system-root-refused.emitted-line"],
});

const WINDOWS_LIFECYCLE_OPENER_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_ROOT_REFUSED_REGISTRATION,
  op: "security.windows-lifecycle-opener.system-root-refused",
  fields: WINDOWS_LIFECYCLE_OPENER_FIELDS,
  proofIds: ["security.windows-lifecycle-opener.system-root-refused.emitted-line"],
});

const WINDOWS_LAUNCHER_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_BINARY_MISSING_REGISTRATION,
  op: "security.windows-launcher.system-binary-missing",
  fields: WINDOWS_LAUNCHER_FIELDS,
  proofIds: ["security.windows-launcher.system-binary-missing.emitted-line"],
});

const WINDOWS_LEGACY_LAUNCHER_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_BINARY_MISSING_REGISTRATION,
  op: "security.windows-portable-legacy-launcher.system-binary-missing",
  fields: WINDOWS_LEGACY_LAUNCHER_FIELDS,
  proofIds: ["security.windows-portable-legacy-launcher.system-binary-missing.emitted-line"],
});

const WINDOWS_PORTABLE_ALERT_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_BINARY_MISSING_REGISTRATION,
  fields: WINDOWS_PORTABLE_ALERT_FIELDS,
  op: "security.windows-portable-alert.system-binary-missing",
  proofIds: ["security.windows-portable-alert.system-binary-missing.emitted-line"],
});

const WINDOWS_LIFECYCLE_OPENER_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  ...WINDOWS_SYSTEM_BINARY_MISSING_REGISTRATION,
  op: "security.windows-lifecycle-opener.system-binary-missing",
  fields: WINDOWS_LIFECYCLE_OPENER_FIELDS,
  proofIds: ["security.windows-lifecycle-opener.system-binary-missing.emitted-line"],
});

function emitWindowsSystemRootRefusal(
  error: WindowsSystemDirectoryError,
  sink: SecurityLogSink | undefined,
  surface: CliWindowsSystemSurface,
): void {
  const failureKind = securityErrorKind(error);
  switch (surface) {
    case "launcher-install":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_LAUNCHER_ROOT_REFUSED_OPERATION,
          { level: "warn", errorKind: "unsafe-target" },
          { surface, failureKind },
        ),
      );
      break;
    case "legacy-start-menu-cleanup":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_LEGACY_LAUNCHER_ROOT_REFUSED_OPERATION,
          { level: "warn", errorKind: "unsafe-target" },
          { surface, failureKind },
        ),
      );
      break;
    case "portable-failure-alert":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_PORTABLE_ALERT_ROOT_REFUSED_OPERATION,
          { level: "warn", errorKind: "unsafe-target" },
          { surface, failureKind },
        ),
      );
      break;
    case "start-open-browser":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_LIFECYCLE_OPENER_ROOT_REFUSED_OPERATION,
          { level: "warn", errorKind: "unsafe-target" },
          { surface, failureKind },
        ),
      );
      break;
  }
}

function emitWindowsSystemBinaryMissing(
  error: WindowsSystemBinaryMissingError,
  sink: SecurityLogSink | undefined,
  surface: CliWindowsSystemSurface,
): void {
  const failureKind = securityErrorKind(error);
  switch (surface) {
    case "launcher-install":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_LAUNCHER_BINARY_MISSING_OPERATION,
          { level: "error", errorKind: "unavailable" },
          { surface, failureKind },
        ),
      );
      break;
    case "legacy-start-menu-cleanup":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_LEGACY_LAUNCHER_BINARY_MISSING_OPERATION,
          { level: "error", errorKind: "unavailable" },
          { surface, failureKind },
        ),
      );
      break;
    case "portable-failure-alert":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_PORTABLE_ALERT_BINARY_MISSING_OPERATION,
          { level: "error", errorKind: "unavailable" },
          { surface, failureKind },
        ),
      );
      break;
    case "start-open-browser":
      emitSecurityLogEvent(
        sink,
        activityLogEvent(
          WINDOWS_LIFECYCLE_OPENER_BINARY_MISSING_OPERATION,
          { level: "error", errorKind: "unavailable" },
          { surface, failureKind },
        ),
      );
      break;
  }
}

/**
 * Emit the CLI's one closed, body-free event shape for trusted Windows helper resolution.
 *
 * The surface is a closed union and selects fixed catalog operations; neither the thrown message
 * nor a path can enter the event. Returning whether the error belongs to this contract lets callers
 * preserve their existing typed-error control flow without reimplementing the dispatch.
 */
export function emitCliWindowsSystemFailure(
  error: unknown,
  sink: SecurityLogSink | undefined,
  surface: CliWindowsSystemSurface,
): boolean {
  if (error instanceof WindowsSystemDirectoryError) {
    emitWindowsSystemRootRefusal(error, sink, surface);
    return true;
  }
  if (error instanceof WindowsSystemBinaryMissingError) {
    emitWindowsSystemBinaryMissing(error, sink, surface);
    return true;
  }
  return false;
}

/**
 * Bind security-package events to one real CLI invocation.
 *
 * The security package deliberately does not invent correlation context. The CLI composition
 * boundary does know when an invocation begins, so it mints one UUID and overwrites any event-level
 * value before forwarding. The adapter adds no argv, path, environment, or error content.
 */
export function createCliSecurityLogSink(
  stateDir: string,
  factory: CliSecurityLogSinkFactory | undefined,
  invocationCorrelationId: string = randomUUID(),
): SecurityLogSink | undefined {
  if (factory === undefined) return undefined;
  let downstream: SecurityLogSink | undefined;
  return {
    write(event: SecurityLogEvent): void {
      // Resolve the file sink only when the security package has an event. Portable/repair/
      // uninstall validate their selected state directory before reaching a shortcut operation;
      // eagerly creating `<stateDir>/logs` here would run before those fail-closed checks and would
      // also mutate an otherwise read-only command that emits nothing.
      downstream ??= factory(stateDir);
      downstream.write(withActivityLogCorrelation(event, invocationCorrelationId));
    },
  };
}
