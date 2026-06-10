// Shared error formatting for MemoriaViva surfaces (uiux-fix F005).
// Previously every component rendered `${err.code}: ${err.message}` into
// role="alert" regions, so users saw raw machine strings like
// "INTERNAL: HTTP 500" with no explanation. Known codes now map to plain,
// actionable sentences; the technical code is appended in parentheses so
// support/audit can still identify the failure.

import { ApiError } from "@/lib/api";

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  NOT_FOUND: "The memory could not be found. It may have been deleted.",
  BAD_REQUEST: "The request was rejected as invalid. Adjust the input and try again.",
  CONFLICT: "The memory changed in the meantime. Reload the page and try again.",
  GOVERNANCE_ERROR: "Governance rules blocked this action.",
  MEMORY_ERROR: "The memory store reported an error. Retry, or check the server log.",
  MEMORY_UNAVAILABLE: "The memory store is currently unavailable. Retry in a moment.",
  PAYLOAD_TOO_LARGE: "The submitted content is too large. Shorten it and try again.",
  INTERNAL: "Something went wrong on the server. Retry, or check the server log.",
};

export function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const friendly = CODE_MESSAGES[err.code];
    if (friendly !== undefined) return `${friendly} (${err.code})`;
    if (err.message.trim().length > 0) return `${err.message} (${err.code})`;
    return `Something went wrong. Retry, or check the server log. (${err.code})`;
  }
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "An unexpected error occurred.";
}
