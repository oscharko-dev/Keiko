import type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import { isSafeAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import { ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS } from "./atlassian-connection-verification.js";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";

const VERIFY_MAX_BYTES = 65_536;
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

function parseProbe(result: AtlassianHttpBodyResult): JsonProbe {
  const failure = probeFailure(result);
  if (failure !== undefined) return { failure };
  if (result.kind !== "response" || result.truncated || result.bodyBytes > VERIFY_MAX_BYTES)
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

function serverInfoStatus(value: Record<string, unknown>): AtlassianConnectionVerificationStatus {
  if (
    typeof value.version !== "string" ||
    !Array.isArray(value.versionNumbers) ||
    typeof value.deploymentType !== "string"
  )
    return "invalid-response";
  return value.version === "10.3.26" &&
    JSON.stringify(value.versionNumbers) === "[10,3,26]" &&
    (value.deploymentType === "Server" || value.deploymentType === "Data Center")
    ? "ok"
    : "unsupported-version";
}

function identityStatus(value: Record<string, unknown>): AtlassianConnectionVerificationStatus {
  return typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 255 &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    value.key.length <= 255 &&
    value.active === true
    ? "ok"
    : "invalid-response";
}

/** Two bounded, read-only probes share one deadline. No remote response content is retained. */
export async function verifyJiraDataCenterConnection(
  port: AtlassianHttpBodyPort,
  baseUrl: string,
  now: () => number = Date.now,
): Promise<AtlassianConnectionVerificationStatus> {
  if (!isSafeAtlassianConnectorBaseUrl(baseUrl))
    throw new AtlassianCredentialCustodyError("invalid-input");
  const base = new URL(baseUrl);
  const prefix = `${base.origin}${base.pathname.replace(/\/$/, "")}/rest/api/2/`;
  const deadline = now() + ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS;
  const steps = [
    { path: "serverInfo", check: serverInfoStatus },
    { path: "myself", check: identityStatus },
  ] as const;
  for (const step of steps) {
    const remaining = deadline - now();
    if (remaining <= 0) return "timeout";
    const result = parseProbe(
      await port({
        method: "GET",
        url: `${prefix}${step.path}`,
        timeoutMs: remaining,
        maxBodyBytes: VERIFY_MAX_BYTES,
      }),
    );
    if ("failure" in result) return result.failure;
    const status = step.check(result.value);
    if (status !== "ok") return status;
  }
  return "ok";
}
