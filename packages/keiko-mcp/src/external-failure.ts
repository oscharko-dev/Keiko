import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import type { ManagedMcpFailure } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { ManagedMcpError } from "./definitions.js";

/** What an abort signal's reason means: our own closed error, a deadline, or a caller abort. */
function abortReason(reason: unknown): ManagedMcpFailure {
  if (reason instanceof ManagedMcpError) return reason.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") return "deadline-exceeded";
  return "aborted";
}

/**
 * The SDK reports an abort of the request signal as a RequestTimeout too, with only the abort
 * reason as its message. A genuine deadline of its own carries the budget it exceeded as data.
 */
function sdkDeadline(error: unknown): boolean {
  if (!(error instanceof SdkError) || error.code !== SdkErrorCode.RequestTimeout) return false;
  const data = error.data as
    { readonly timeout?: unknown; readonly maxTotalTimeout?: unknown } | undefined;
  return data?.timeout !== undefined || data?.maxTotalTimeout !== undefined;
}

/**
 * The closed reason a failed call or listing is reported under. A timeout, a caller abort and a
 * lost transport used to share one opaque protocol error, so a model and an operator could not tell
 * a slow server from a dead one.
 */
export function failureReason(error: unknown, signal?: AbortSignal): ManagedMcpFailure {
  if (error instanceof ManagedMcpError) return error.reason;
  // Our own closed reason on the signal is the cause; the SDK only reports its symptom.
  if (signal?.aborted === true && signal.reason instanceof ManagedMcpError)
    return signal.reason.reason;
  if (sdkDeadline(error)) return "deadline-exceeded";
  if (signal?.aborted === true) return abortReason(signal.reason);
  if (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed) return "closed";
  return "protocol-error";
}

const SPAWN_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "EMFILE",
]);

export type ConnectCause = "timeout" | "spawn" | "aborted" | "closed" | "protocol" | "unknown";

/** Why a connection attempt failed, in closed words; never a path, a message or a server name. */
export function connectCause(error: unknown, signal: AbortSignal): ConnectCause {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && SPAWN_CODES.has(code)) return "spawn";
  const reason = failureReason(error, signal);
  if (reason === "deadline-exceeded") return "timeout";
  if (reason === "closed") return "closed";
  if (reason === "aborted") return "aborted";
  return error instanceof ManagedMcpError || error instanceof SdkError || signal.aborted
    ? "protocol"
    : "unknown";
}
