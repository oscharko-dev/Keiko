// Shared error formatting for Local Knowledge surfaces (uiux-fix F033, C064).
// Previously five components each duplicated a local formatError that rendered
// `${err.code}: ${err.message}` into role="alert" regions, so users saw raw
// machine strings like "LK_VALIDATION: …" or "INTERNAL: HTTP 500". The message
// now comes first; the technical code is appended in parentheses so support and
// audit can still identify the failure (same pattern as memoriaviva/format-error).

import { ApiError } from "@/lib/api";

const LOCAL_KNOWLEDGE_UNAVAILABLE_CODE = "LOCAL_KNOWLEDGE_UNAVAILABLE";
const LOCAL_KNOWLEDGE_UNAVAILABLE_HINT =
  "Restart Keiko, reopen Local Knowledge, then try again. If it still fails, run the local-state repair or Knowledge Pod reindex remediation.";
const RUNTIME_UNREACHABLE_HINT =
  "Keiko runtime could not be reached. Restart Keiko, reopen Local Knowledge, then try again.";

export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message.trim();
    const prefix =
      error.code === LOCAL_KNOWLEDGE_UNAVAILABLE_CODE && message.length > 0
        ? `${message} ${LOCAL_KNOWLEDGE_UNAVAILABLE_HINT}`
        : message;
    return `${prefix.length > 0 ? prefix : "Something went wrong. Try again."} (${formatApiErrorDetails(error)})`;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = error.message.trim();
    return isRuntimeUnreachableMessage(message)
      ? `${message}. ${RUNTIME_UNREACHABLE_HINT}`
      : message;
  }
  return "An unexpected error occurred.";
}

function formatApiErrorDetails(error: ApiError): string {
  return error.correlationId === undefined
    ? error.code
    : `${error.code}; support ID ${error.correlationId}`;
}

function isRuntimeUnreachableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized === "failed to fetch" ||
    normalized.includes("networkerror") ||
    normalized.includes("load failed")
  );
}
