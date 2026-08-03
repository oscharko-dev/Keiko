import { randomUUID } from "node:crypto";

// A PID identifies a running process only until the host or container reuses it. Persisted locks
// bind ownership to this process-instance nonce as well, so a restarted PID 1 cannot inherit an
// abandoned lock while every lock manager in this process still recognizes the same owner.
export const PROCESS_START_IDENTITY = randomUUID();

export function isOptionalProcessIdentity(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

export function processIdentityField(value: string | undefined): {
  readonly processIdentity?: string | undefined;
} {
  return value === undefined ? {} : { processIdentity: value };
}
