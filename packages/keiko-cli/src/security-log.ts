import { randomUUID } from "node:crypto";
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

function emitWindowsSystemRootRefusal(
  error: WindowsSystemDirectoryError,
  sink: SecurityLogSink | undefined,
  surface: CliWindowsSystemSurface,
): void {
  const details = {
    errorKind: securityErrorKind(error),
    extra: { surface },
  } as const;
  switch (surface) {
    case "launcher-install":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "warn",
        category: "security",
        op: "security.windows-launcher.system-root-refused",
      });
      break;
    case "legacy-start-menu-cleanup":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "warn",
        category: "security",
        op: "security.windows-portable-legacy-launcher.system-root-refused",
      });
      break;
    case "portable-failure-alert":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "warn",
        category: "security",
        op: "security.windows-portable-alert.system-root-refused",
      });
      break;
    case "start-open-browser":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "warn",
        category: "security",
        op: "security.windows-lifecycle-opener.system-root-refused",
      });
      break;
  }
}

function emitWindowsSystemBinaryMissing(
  error: WindowsSystemBinaryMissingError,
  sink: SecurityLogSink | undefined,
  surface: CliWindowsSystemSurface,
): void {
  const details = {
    errorKind: securityErrorKind(error),
    extra: { surface },
  } as const;
  switch (surface) {
    case "launcher-install":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "error",
        category: "diagnostic",
        op: "security.windows-launcher.system-binary-missing",
      });
      break;
    case "legacy-start-menu-cleanup":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "error",
        category: "diagnostic",
        op: "security.windows-portable-legacy-launcher.system-binary-missing",
      });
      break;
    case "portable-failure-alert":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "error",
        category: "diagnostic",
        op: "security.windows-portable-alert.system-binary-missing",
      });
      break;
    case "start-open-browser":
      emitSecurityLogEvent(sink, {
        ...details,
        level: "error",
        category: "diagnostic",
        op: "security.windows-lifecycle-opener.system-binary-missing",
      });
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
      downstream.write({ ...event, correlationId });
    },
  };
}
