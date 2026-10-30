import {
  ATLASSIAN_VERIFY_MAX_BYTES,
  parseAtlassianVerificationProbe,
} from "./atlassian-verification-probe.js";
// Bounded Atlassian connection-verification probe (Issue #2241, ADR-0128 D3/D5).
//
// One cheap, read-only current-user request against the connector's configured base URL through
// the injected transport port, mapped onto a closed status union. The bounded JSON identity is validated in memory; remote content is never logged,
// persisted or returned. HTML login pages and anonymous/invalid identities fail closed.
//
// Endpoint choice per provider (recorded per the issue's engineering note; both are the cheapest
// authenticated read-only "who am I" endpoints of their product):
//   - Jira Cloud:       GET /rest/api/3/myself
//   - Confluence Cloud: GET /wiki/rest/api/user/current

import type {
  AtlassianConnectionVerificationStatus,
  AtlassianConnectorProvider,
} from "@oscharko-dev/keiko-contracts";
import {
  isAtlassianConnectorProvider,
  isSafeAtlassianConnectorBaseUrl,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

// Re-exported from the contracts leaf so the server package and the UI share one source of truth
// for the verify-status wire union (ADR-0128 D3); this package keeps the probe behaviour.
export {
  ATLASSIAN_CONNECTION_VERIFICATION_STATUSES,
  isAtlassianConnectionVerificationStatus,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import type { AtlassianHttpBodyPort, AtlassianHttpRequest } from "./atlassian-http-port.js";

// 30 000 ms: the ADR-0128 D3 interactive-request budget.
export const ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS = 30_000;

export const ATLASSIAN_VERIFY_CONNECTION_PATHS: Readonly<
  Record<AtlassianConnectorProvider, string>
> = Object.freeze({
  jira: "/rest/api/3/myself",
  confluence: "/wiki/rest/api/user/current",
} as const satisfies Readonly<Record<AtlassianConnectorProvider, string>>);

export interface VerifyAtlassianConnectionInput {
  readonly provider: AtlassianConnectorProvider;
  readonly baseUrl: string;
}

// Builds the probe request from a validated connector base URL. The base URL was already
// validated at credential creation; re-validating here is the ADR-0128 D3 request-construction
// re-check (fail closed on internal corruption, never construct a URL from unsafe input). A base
// path (Data Center context path) is preserved; the probe path is appended beneath it.
export function buildAtlassianVerificationRequest(
  input: VerifyAtlassianConnectionInput,
): AtlassianHttpRequest {
  if (!isAtlassianConnectorProvider(input.provider)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "provider must be confluence or jira",
    ]);
  }
  if (!isSafeAtlassianConnectorBaseUrl(input.baseUrl)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "baseUrl must be an https URL without credentials, query, or fragment",
    ]);
  }
  const base = new URL(input.baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const target = new URL(
    `${base.origin}${basePath}${ATLASSIAN_VERIFY_CONNECTION_PATHS[input.provider]}`,
  );
  // Invariant by construction; asserted so a URL-parsing surprise can never re-point the probe.
  if (target.host !== base.host || target.protocol !== "https:") {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "verification target must stay on the configured base URL host",
    ]);
  }
  return {
    method: "GET",
    url: target.toString(),
    timeoutMs: ATLASSIAN_VERIFY_CONNECTION_TIMEOUT_MS,
  };
}

function cloudIdentityStatus(
  provider: AtlassianConnectorProvider,
  value: Record<string, unknown>,
): AtlassianConnectionVerificationStatus {
  if (
    typeof value.accountId !== "string" ||
    value.accountId.trim().length === 0 ||
    value.accountId.length > 255
  )
    return "invalid-response";
  const authenticated = provider === "jira" ? value.active === true : value.type === "known";
  return authenticated ? "ok" : "invalid-response";
}

// Exactly ONE outbound request, to the configured base URL only, inside the D3 timeout budget.
export async function verifyAtlassianConnection(
  port: AtlassianHttpBodyPort,
  input: VerifyAtlassianConnectionInput,
): Promise<AtlassianConnectionVerificationStatus> {
  const request = buildAtlassianVerificationRequest(input);
  const result = parseAtlassianVerificationProbe(
    await port({ ...request, maxBodyBytes: ATLASSIAN_VERIFY_MAX_BYTES }),
  );
  return "failure" in result ? result.failure : cloudIdentityStatus(input.provider, result.value);
}
