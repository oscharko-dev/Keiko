// Shared error formatting for Local Knowledge surfaces (uiux-fix F033, C064).
// Previously five components each duplicated a local formatError that rendered
// `${err.code}: ${err.message}` into role="alert" regions, so users saw raw
// machine strings like "LK_VALIDATION: …" or "INTERNAL: HTTP 500". The message
// now comes first; the technical code is appended in parentheses so support and
// audit can still identify the failure (same pattern as memoriaviva/format-error).

import { ApiError } from "@/lib/api";

export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.message.trim().length > 0) return `${error.message} (${error.code})`;
    return `Something went wrong. Try again. (${error.code})`;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "An unexpected error occurred.";
}
