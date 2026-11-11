import type { UiHandlerDeps } from "./deps.js";
import { CHAT_TURN_JIRA_AUTHENTICATION_FAILED } from "./chat-turn-serializer.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { errorBody, type RouteResult } from "./routes.js";

type ChatOperation =
  "POST /api/chats/messages/grounded" | "POST /api/desktop/chat" | "POST /api/desktop/chat/stream";

/** Preserve the observed cause even if another verification completes before the turn settles. */
export function chatAuthenticationInterruption(
  signal: AbortSignal,
  deps: Pick<UiHandlerDeps, "diagnostics">,
  correlationId: string | undefined,
  operation: ChatOperation,
): RouteResult | undefined {
  if (!signal.aborted || signal.reason !== CHAT_TURN_JIRA_AUTHENTICATION_FAILED) return undefined;
  const code = "JIRA_AUTHENTICATION_FAILED";
  const message =
    "Jira authentication failed. Open the Knowledge Pods hub and verify the connection again.";
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(correlationId),
      operation,
      source: "chat.turn.authentication",
      error: Object.assign(new Error(message), { code }),
      redact: () => message,
    }),
  );
  // The local session remains authenticated; its captured Jira credential binding was revoked.
  return { status: 409, body: errorBody(code, message, correlationId) };
}
