// Shared error formatting for desktop chat surfaces (uiux-fix F041, C171).
// Previously five sites (useChatSession, ChatWindow grounding select,
// ConnectedScopePill, ConnectorScopePill, ScopeConnectButton) each rendered
// `${error.code}: ${error.message}` into role="alert" regions, so users saw raw
// machine strings like "GATEWAY_UPSTREAM_FAILURE: connect ECONNREFUSED …" with
// the code as the leading content. The human message now comes first; the
// technical code is appended in parentheses so support and audit can still
// identify the failure (same pattern as local-knowledge/format-error and
// memoriaviva/components/format-error).

import { ApiError } from "@/lib/api";

export function formatUserError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.message.trim().length > 0) return `${error.message} (${error.code})`;
    return `${fallback} (${error.code})`;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}
