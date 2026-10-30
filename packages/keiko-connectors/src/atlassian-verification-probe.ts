import type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import type { AtlassianHttpBodyResult } from "./atlassian-http-port.js";

export const ATLASSIAN_VERIFY_MAX_BYTES = 65_536;
type JsonProbe =
  | { readonly value: Record<string, unknown> }
  | { readonly failure: AtlassianConnectionVerificationStatus };

function probeFailure(
  result: AtlassianHttpBodyResult,
): AtlassianConnectionVerificationStatus | undefined {
  if (result.kind === "timeout") return "timeout";
  if (result.kind === "network-error")
    return result.reason === "tls" ? "tls-failed" : "unreachable";
  if (result.status === 401) return "auth-failed";
  if (result.status === 403) return "forbidden";
  if (result.status >= 300 && result.status < 400) return "redirect-refused";
  if (result.status < 200 || result.status >= 300) return "unreachable";
  return undefined;
}

export function parseAtlassianVerificationProbe(result: AtlassianHttpBodyResult): JsonProbe {
  const failure = probeFailure(result);
  if (failure !== undefined) return { failure };
  if (
    result.kind !== "response" ||
    result.truncated ||
    result.bodyBytes > ATLASSIAN_VERIFY_MAX_BYTES
  )
    return { failure: "invalid-response" };
  try {
    const value: unknown = JSON.parse(result.bodyText);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return { value: value as Record<string, unknown> };
  } catch {
    // Untrusted response contents must not reach diagnostics or the caller.
  }
  return { failure: "invalid-response" };
}
