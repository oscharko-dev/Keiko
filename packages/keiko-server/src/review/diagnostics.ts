// Body-free diagnostics for review failures that resolve to a closed outcome (Issue #4133).
//
// A failure the review layer turns into a closed refusal or availability state (`fetch-failed`,
// `failed`, a quarantined registry) still leaves its error class on the existing diagnostic sink,
// joined to the operation's correlation id, so the closed outcome on the Activity Log can be traced
// back to its cause without recording paths, refs or remote text.

import { correlationIdOrUnknown } from "../correlation.js";
import {
  DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
  defaultServerDiagnosticSink,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";

export type ReviewDiagnosticOperation =
  | "review.target.github-identity"
  | "review.target.provider-read"
  | "review.target.resolve"
  | "review.worktree.registry-read"
  | "review.worktree.remove"
  | "review.run.execute"
  | "review.run.persist"
  | "review.run.diff";

export function reportReviewFailure(
  operation: ReviewDiagnosticOperation,
  correlationId: string | undefined,
  error: unknown,
  sink: ServerDiagnosticSink = defaultServerDiagnosticSink,
): void {
  emitServerDiagnostic(
    sink,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(correlationId),
      operation,
      source: "review",
      error,
      summary: DEFAULT_SERVER_DIAGNOSTIC_SUMMARY,
      redact: (message): string => message,
    }),
  );
}
