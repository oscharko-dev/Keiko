// Deadline + abort cancellation for the deterministic language service (Issue #1198). This bounds
// "expensive analysis" two ways: a wall-clock deadline (so a pathological program can never block
// the loopback BFF) and an AbortSignal (so a disconnected client request is honoured at the next
// cooperative cancellation check). The TypeScript language service polls a HostCancellationToken at
// function/class/module declaration boundaries during traversal and throws
// `ts.OperationCanceledException`; the orchestrator additionally pre-checks the token before each
// operation so an already-expired deadline or pre-aborted signal short-circuits flat files that
// contain no such boundary. This module supplies that token and a provider-facing variant that
// throws a transport-neutral `LanguageCancelledError`.

import ts from "typescript";

export class LanguageCancelledError extends Error {
  public constructor() {
    super("language operation cancelled");
    this.name = "LanguageCancelledError";
  }
}

export type CancellationReason = "aborted" | "timeout";

export interface LanguageCancellation {
  isCancellationRequested(): boolean;
  // Throws LanguageCancelledError when cancellation has been requested.
  throwIfCancellationRequested(): void;
  // The reason cancellation fired, or undefined when it has not. Read after a cancellation to
  // distinguish a client abort from a deadline timeout.
  reason(): CancellationReason | undefined;
  // The HostCancellationToken handed to the TypeScript language-service host.
  hostToken(): ts.HostCancellationToken;
}

export interface DeadlineCancellationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly deadlineMs: number;
  // Injectable clock so the deadline is deterministically testable. Defaults to Date.now.
  readonly now?: (() => number) | undefined;
}

export function createDeadlineCancellation(
  options: DeadlineCancellationOptions,
): LanguageCancellation {
  const now = options.now ?? Date.now;
  const deadline = now() + options.deadlineMs;
  let reason: CancellationReason | undefined;

  const check = (): boolean => {
    if (reason !== undefined) return true;
    if (options.signal?.aborted === true) {
      reason = "aborted";
      return true;
    }
    if (now() >= deadline) {
      reason = "timeout";
      return true;
    }
    return false;
  };

  return {
    isCancellationRequested: check,
    throwIfCancellationRequested: (): void => {
      if (check()) throw new LanguageCancelledError();
    },
    reason: (): CancellationReason | undefined => reason,
    hostToken: (): ts.HostCancellationToken => ({ isCancellationRequested: check }),
  };
}

// True when an error represents a cancellation — either the language service's own
// `OperationCanceledException` or the provider-facing `LanguageCancelledError`.
export function isCancellation(error: unknown): boolean {
  return error instanceof ts.OperationCanceledException || error instanceof LanguageCancelledError;
}
