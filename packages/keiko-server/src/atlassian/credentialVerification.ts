import {
  AtlassianCredentialCustodyError,
  verifyAtlassianConnection,
  verifyJiraDataCenterConnection,
  type AtlassianCredentialCustody,
  type AtlassianCredentialMetadata,
} from "@oscharko-dev/keiko-connectors";
import type { AtlassianConnectionVerificationStatus } from "@oscharko-dev/keiko-contracts";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { recordConnectionCheck } from "./credentialActivity.js";

type VerificationTicket = NonNullable<ReturnType<AtlassianCredentialCustody["beginVerification"]>>;

function probeCredential(
  deps: AtlassianConnectorCredentialDeps,
  metadata: AtlassianCredentialMetadata,
  correlationId: string,
): Promise<AtlassianConnectionVerificationStatus> {
  const port = deps.httpBodyPortFactory(metadata, correlationId);
  return metadata.deployment === "data-center"
    ? verifyJiraDataCenterConnection(port, metadata.baseUrl)
    : verifyAtlassianConnection(port, { provider: metadata.provider, baseUrl: metadata.baseUrl });
}

function completeProbe(
  deps: AtlassianConnectorCredentialDeps,
  ticket: VerificationTicket,
  status: AtlassianConnectionVerificationStatus | "unverified",
  correlationId: string,
): boolean {
  const applied = deps.custody.finishVerification(
    ticket.metadata.authRef,
    ticket.metadata.generation ?? 1,
    ticket.revision,
    status,
  );
  recordConnectionCheck(
    deps,
    correlationId,
    status === "unverified" ? "verification-aborted" : status,
    applied ? "applied" : "stale",
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
    const status = await probeCredential(deps, metadata, correlationId);
    recordConnectionCheck(deps, correlationId, status);
    return status;
  }
  let status: AtlassianConnectionVerificationStatus;
  try {
    status = await probeCredential(deps, ticket.metadata, correlationId);
  } catch (error) {
    completeProbe(deps, ticket, "unverified", correlationId);
    throw error;
  }
  if (!completeProbe(deps, ticket, status, correlationId))
    throw new AtlassianCredentialCustodyError("credential-changed");
  return status;
}
