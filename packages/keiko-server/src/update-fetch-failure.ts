/** Why an update metadata or asset fetch failed; a closed, body-free classification. */
export type PortableFetchFailureReason =
  "deadline-exceeded" | "request-aborted" | "network-unavailable" | "unexpected-failure";

export function portableFetchFailureReason(error: unknown): PortableFetchFailureReason {
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") return "deadline-exceeded";
    if (error.name === "AbortError") return "request-aborted";
  }
  if (error instanceof TypeError) return "network-unavailable";
  if (typeof error !== "object" || error === null) return "unexpected-failure";
  const code = (error as { readonly code?: unknown }).code;
  return code === "EAI_AGAIN" || code === "ENOTFOUND" || code === "ETIMEDOUT"
    ? "network-unavailable"
    : "unexpected-failure";
}
