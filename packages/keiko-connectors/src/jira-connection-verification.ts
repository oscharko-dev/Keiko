import {
  ATLASSIAN_VERIFY_MAX_BYTES,
  parseAtlassianVerificationProbe,
} from "./atlassian-verification-probe.js";
import type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import {
  isJiraDataCenterCompatibilityFacts,
  isSafeAtlassianConnectorBaseUrl,
  type JiraDataCenterCompatibilityFacts,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import { ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS } from "./atlassian-connection-verification.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";

export type JiraDataCenterCompatibilityResult =
  | { readonly status: "ok"; readonly compatibility: JiraDataCenterCompatibilityFacts }
  | { readonly status: Exclude<AtlassianConnectionVerificationStatus, "ok"> };

function serverCompatibility(value: Record<string, unknown>): JiraDataCenterCompatibilityResult {
  if (
    typeof value.version !== "string" ||
    !Array.isArray(value.versionNumbers) ||
    typeof value.deploymentType !== "string"
  )
    return { status: "invalid-response" };
  const compatibility = {
    schemaVersion: 1,
    deploymentType: value.deploymentType,
    versionNumbers: value.versionNumbers,
    restApi: "v2",
    agileApi: "unverified",
  };
  // The shared facts validator enforces the 10.3.0 floor; coherent newer releases are observations.
  // Three safe integers bound the release string; suffixes and inconsistent metadata refuse.
  if (
    !isJiraDataCenterCompatibilityFacts(compatibility) ||
    value.version !== compatibility.versionNumbers.join(".")
  )
    return { status: "unsupported-version" };
  return { status: "ok", compatibility };
}

function validIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 255 &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    value.key.length <= 255 &&
    value.active === true
  );
}

async function probe(
  port: AtlassianHttpBodyPort,
  url: string,
  deadline: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<ReturnType<typeof parseAtlassianVerificationProbe>> {
  const remaining = deadline - now();
  if (remaining <= 0 || signal?.aborted) return { failure: "timeout" };
  return parseAtlassianVerificationProbe(
    await port({
      method: "GET",
      url,
      timeoutMs: remaining,
      maxBodyBytes: ATLASSIAN_VERIFY_MAX_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

function jiraRestRoot(baseUrl: string): string {
  if (!isSafeAtlassianConnectorBaseUrl(baseUrl))
    throw new AtlassianCredentialCustodyError("invalid-input");
  const base = new URL(baseUrl);
  return `${base.origin}${base.pathname.replace(/\/$/, "")}/rest/api/2/`;
}

/** Observe identity only, without beginning verification or changing stored compatibility facts. */
export async function verifyJiraDataCenterIdentity(
  port: AtlassianHttpBodyPort,
  baseUrl: string,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
  now: () => number = Date.now,
): Promise<AtlassianConnectionVerificationStatus> {
  const prefix = jiraRestRoot(baseUrl);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return "timeout";
  const timeoutMs = Math.min(options.timeoutMs, ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS);
  const identity = await probe(port, `${prefix}myself`, now() + timeoutMs, now, options.signal);
  if ("failure" in identity) return identity.failure;
  return validIdentity(identity.value) ? "ok" : "invalid-response";
}

function failedProbe(
  status: AtlassianConnectionVerificationStatus,
): JiraDataCenterCompatibilityResult {
  return { status: status === "ok" ? "invalid-response" : status };
}

/** Two bounded reads verify REST v2 identity only; other operations need their own metadata. */
export async function verifyJiraDataCenterCompatibility(
  port: AtlassianHttpBodyPort,
  baseUrl: string,
  now: () => number = Date.now,
): Promise<JiraDataCenterCompatibilityResult> {
  const prefix = jiraRestRoot(baseUrl);
  const deadline = now() + ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS;
  const server = await probe(port, `${prefix}serverInfo`, deadline, now);
  if ("failure" in server) return failedProbe(server.failure);
  const result = serverCompatibility(server.value);
  if (result.status !== "ok") return result;
  const identity = await verifyJiraDataCenterIdentity(
    port,
    baseUrl,
    { timeoutMs: deadline - now() },
    now,
  );
  return identity === "ok" ? result : failedProbe(identity);
}

/** Preserve the status-only API for callers that do not retain capability facts. */
export async function verifyJiraDataCenterConnection(
  port: AtlassianHttpBodyPort,
  baseUrl: string,
  now: () => number = Date.now,
): Promise<AtlassianConnectionVerificationStatus> {
  return (await verifyJiraDataCenterCompatibility(port, baseUrl, now)).status;
}
