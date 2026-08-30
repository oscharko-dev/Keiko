import { randomUUID } from "node:crypto";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";

/** Builds the existing activity-log sink for the state directory selected by one CLI command. */
export type CliSecurityLogSinkFactory = (stateDir: string) => SecurityLogSink;

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
