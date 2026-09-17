import { randomUUID } from "node:crypto";
import {
  ACTIVITY_LOG_EVENT_REGISTRATION,
  activityLogEvent,
  activityLogEventRegistration,
  defineActivityLogOperation,
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

const WINDOWS_LAUNCHER_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-launcher.system-root-refused",
  category: "security",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemRootRefusal",
  fields: {
    surface: { type: "string", dataClass: "closed-enum", required: true, values: ["launcher-install"] },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-root-refused"],
  proofIds: ["windows.launcher.system-root-refused"],
  releaseImpact: "patch",
});

const WINDOWS_LEGACY_LAUNCHER_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-portable-legacy-launcher.system-root-refused",
  category: "security",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemRootRefusal",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["legacy-start-menu-cleanup"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-root-refused"],
  proofIds: ["windows.legacy-launcher.system-root-refused"],
  releaseImpact: "patch",
});

const WINDOWS_PORTABLE_ALERT_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-portable-alert.system-root-refused",
  category: "security",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemRootRefusal",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["portable-failure-alert"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-root-refused"],
  proofIds: ["windows.portable-alert.system-root-refused"],
  releaseImpact: "patch",
});

const WINDOWS_LIFECYCLE_OPENER_ROOT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-lifecycle-opener.system-root-refused",
  category: "security",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemRootRefusal",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["start-open-browser"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-root-refused"],
  proofIds: ["windows.lifecycle-opener.system-root-refused"],
  releaseImpact: "patch",
});

const WINDOWS_LAUNCHER_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-launcher.system-binary-missing",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemBinaryMissing",
  fields: {
    surface: { type: "string", dataClass: "closed-enum", required: true, values: ["launcher-install"] },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-binary-unavailable"],
  proofIds: ["windows.launcher.system-binary-missing"],
  releaseImpact: "patch",
});

const WINDOWS_LEGACY_LAUNCHER_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-portable-legacy-launcher.system-binary-missing",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemBinaryMissing",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["legacy-start-menu-cleanup"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-binary-unavailable"],
  proofIds: ["windows.legacy-launcher.system-binary-missing"],
  releaseImpact: "patch",
});

const WINDOWS_PORTABLE_ALERT_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-portable-alert.system-binary-missing",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemBinaryMissing",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["portable-failure-alert"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-binary-unavailable"],
  proofIds: ["windows.portable-alert.system-binary-missing"],
  releaseImpact: "patch",
});

const WINDOWS_LIFECYCLE_OPENER_BINARY_MISSING_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.windows-lifecycle-opener.system-binary-missing",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "security-log.emitWindowsSystemBinaryMissing",
  fields: {
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["start-open-browser"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: true, maxLength: 64 },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["windows-system-binary-unavailable"],
  proofIds: ["windows.lifecycle-opener.system-binary-missing"],
  releaseImpact: "patch",
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
): SecurityLogSink | undefined {
  if (factory === undefined) return undefined;
  const correlationId = randomUUID();
  let downstream: SecurityLogSink | undefined;
  return {
    write(event: SecurityLogEvent): void {
      // Resolve the file sink only when the security package has an event. Portable/repair/
      // uninstall validate their selected state directory before reaching a shortcut operation;
      // eagerly creating `<stateDir>/logs` here would run before those fail-closed checks and would
      // also mutate an otherwise read-only command that emits nothing.
      downstream ??= factory(stateDir);
      const forwarded = { ...event, correlationId };
      const registration = activityLogEventRegistration(
        event as unknown as Readonly<Record<PropertyKey, unknown>>,
      );
      if (registration !== undefined) {
        Object.defineProperty(forwarded, ACTIVITY_LOG_EVENT_REGISTRATION, {
          value: registration,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }
      downstream.write(forwarded);
    },
  };
}
