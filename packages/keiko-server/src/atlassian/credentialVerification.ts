import {
  AtlassianCredentialCustodyError,
  verifyAtlassianConnection,
  verifyJiraDataCenterCompatibility,
  type AtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
} from "@oscharko-dev/keiko-connectors";
import type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import type { JiraDataCenterCompatibilityFacts } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { recordConnectionCheck } from "./credentialActivity.js";

type VerificationTicket = NonNullable<ReturnType<AtlassianCredentialCustody["beginVerification"]>>;

interface CredentialProbeResult {
  readonly status: AtlassianConnectionVerificationStatus;
  readonly compatibility?: JiraDataCenterCompatibilityFacts;
}

async function probeCredential(
  deps: AtlassianConnectorCredentialDeps,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
): Promise<CredentialProbeResult> {
  const port = deps.httpBodyPortFactory(metadata, correlationId, { purpose: "verification" });
  if (metadata.deployment === "data-center")
    return verifyJiraDataCenterCompatibility(port, metadata.baseUrl);
  return {
    status: await verifyAtlassianConnection(port, {
      provider: metadata.provider,
      baseUrl: metadata.baseUrl,
    }),
  };
}

function completeProbe(
  deps: AtlassianConnectorCredentialDeps,
  ticket: VerificationTicket,
  status: AtlassianConnectionVerificationStatus | "unverified",
  correlationId: string,
  compatibility?: JiraDataCenterCompatibilityFacts,
): boolean {
  const applied = deps.custody.finishVerification(
    ticket.metadata.authRef,
    ticket.metadata.generation ?? 1,
    ticket.revision,
    status,
    correlationId,
    compatibility,
  );
  recordConnectionCheck(
    deps,
    correlationId,
    status === "unverified" ? "verification-aborted" : status,
    applied ? "applied" : "stale",
    "verify",
    compatibility === undefined ? "unverified" : "verified",
  );
  return applied;
}

export async function verifyStoredCredential(
  deps: AtlassianConnectorCredentialDeps,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
): Promise<AtlassianConnectionVerificationStatus> {
  const ticket = deps.custody.beginVerification(metadata.authRef, metadata.generation ?? 1);
  if (ticket === undefined) {
    if (metadata.deployment === "data-center" && metadata.livePod !== undefined)
      throw new AtlassianCredentialCustodyError("credential-changed");
    const result = await probeCredential(deps, metadata, correlationId);
    recordConnectionCheck(
      deps,
      correlationId,
      result.status,
      undefined,
      "verify",
      metadata.deployment === "data-center"
        ? result.compatibility === undefined
          ? "unverified"
          : "verified"
        : undefined,
    );
    return result.status;
  }
  let result: CredentialProbeResult;
  try {
    result = await probeCredential(deps, ticket.metadata, correlationId);
  } catch (error) {
    completeProbe(deps, ticket, "unverified", correlationId);
    throw error;
  }
  if (!completeProbe(deps, ticket, result.status, correlationId, result.compatibility))
    throw new AtlassianCredentialCustodyError("credential-changed");
  return result.status;
}
