import { isValidCorrelationId } from "../correlation.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSink,
} from "../diagnostics-log.js";

// The correlation id a tool call's diagnostics ride on.
// `actionId` is request content (parseCodingToolRequest bounds it to a non-empty string ≤512
// bytes only), so it rides on the redaction-safe diagnostic solely as a bounded machine token that
// satisfies the one canonical correlation-id shape (`isValidCorrelationId`, the shape
// `defaultServerDiagnosticSink` sanitizes against — a wider local shape would be replaced by the
// sink's content-free marker and lose the correlation). The `tool:<callId>` production shape is not
// valid as-is (the canonical shape admits no `:`), so it is mapped onto `tool-<callId>` — a fixed,
// documented prefix swap an analyzer joins back to the evidence's `actionId`. Prose, whitespace,
// overlength and too-short values degrade to the marker.
const TOOL_ACTION_ID_PREFIX = "tool:";
const TOOL_ACTION_CORRELATION_PREFIX = "tool-";
const UNPARSED_ACTION_CORRELATION_ID = "tool-bridge-unparsed-action";

export function actionCorrelationId(actionId: string | undefined): string {
  if (actionId === undefined) return UNPARSED_ACTION_CORRELATION_ID;
  const candidate = actionId.startsWith(TOOL_ACTION_ID_PREFIX)
    ? `${TOOL_ACTION_CORRELATION_PREFIX}${actionId.slice(TOOL_ACTION_ID_PREFIX.length)}`
    : actionId;
  return isValidCorrelationId(candidate) ? candidate : UNPARSED_ACTION_CORRELATION_ID;
}

/**
 * A governed handler that threw inside the tool facade. The model still receives the closed
 * `failed` answer; this records why, under the call's correlation, with the error class, the
 * dist-anchored Keiko frames and the cause chain, and never the message (audit 2026-11-06,
 * finding 12: the two `catch` blocks used to drop the defect without a trace).
 */
export function emitToolHandlerFailure(
  diagnostics: ServerDiagnosticSink | undefined,
  actionId: string | undefined,
  error: unknown,
): void {
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId: actionCorrelationId(actionId),
      operation: "coding-runtime.tool-bridge",
      source: "coding-tool-facade.handler",
      error,
      summary: "tool-facade-failed",
      redact: () => "tool-facade-failed",
    }),
  );
}
