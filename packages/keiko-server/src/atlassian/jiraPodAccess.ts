import { createHash } from "node:crypto";
import type {
  AtlassianCredentialMetadata,
  AtlassianCredentialCustody,
} from "@oscharko-dev/keiko-connectors";
import type {
  AtlassianCredentialPublicMetadata,
  JiraLivePodMetadata,
  JiraLivePodView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { UiHandlerDeps } from "../deps.js";

export type JiraLivePodCredential = Extract<
  AtlassianCredentialMetadata,
  { deployment: "data-center" }
> & {
  readonly livePod: JiraLivePodMetadata;
};

export type JiraPodAccessDeps = Pick<UiHandlerDeps, "serverPrincipal"> & {
  readonly atlassianConnectorCredentials?:
    | {
        readonly custody: Pick<AtlassianCredentialCustody, "list">;
      }
    | undefined;
};

export function findOwnedJiraPod(
  deps: JiraPodAccessDeps,
  podId: string,
): JiraLivePodCredential | undefined {
  const actorDigest = jiraChatActorDigest(deps);
  if (actorDigest === undefined) return undefined;
  return deps.atlassianConnectorCredentials?.custody
    .list()
    .find(
      (metadata): metadata is JiraLivePodCredential =>
        metadata.deployment === "data-center" &&
        metadata.livePod?.podId === podId &&
        metadata.livePod.ownerDigest === actorDigest,
    );
}

export function isReadyJiraPod(credential: JiraLivePodCredential): boolean {
  return (
    credential.livePod.verificationStatus === "ok" &&
    !credential.livePod.verificationInProgress &&
    credential.livePod.credentialOperation === undefined
  );
}

export function jiraChatActorDigest(
  deps: Pick<UiHandlerDeps, "serverPrincipal">,
): string | undefined {
  const principal = deps.serverPrincipal?.();
  if (typeof principal !== "string" || principal.length === 0 || principal.length > 256)
    return undefined;
  return createHash("sha256").update(principal).digest("hex");
}

export function ownsAtlassianCredential(
  deps: Pick<UiHandlerDeps, "serverPrincipal">,
  metadata: AtlassianCredentialMetadata,
): boolean {
  return (
    metadata.deployment !== "data-center" ||
    metadata.livePod === undefined ||
    metadata.livePod.ownerDigest === jiraChatActorDigest(deps)
  );
}

/** Explicit legacy wire projection: private ownership, creation and verification facts stay in custody. */
export function publicAtlassianCredential(
  metadata: AtlassianCredentialMetadata,
): AtlassianCredentialPublicMetadata {
  const common = {
    schemaVersion: metadata.schemaVersion,
    authRef: metadata.authRef,
    displayName: metadata.displayName,
    baseUrl: metadata.baseUrl,
    createdAt: metadata.createdAt,
    ...(metadata.generation === undefined ? {} : { generation: metadata.generation }),
  };
  return metadata.deployment === "data-center"
    ? {
        ...common,
        provider: "jira",
        deployment: "data-center",
        authScheme: "bearer-pat",
        generation: metadata.generation,
        ...(metadata.livePod === undefined
          ? {}
          : { livePod: publicJiraPod(metadata.generation, metadata.livePod) }),
      }
    : {
        ...common,
        provider: metadata.provider,
        authScheme: "basic-api-token",
        ...(metadata.deployment === undefined ? {} : { deployment: metadata.deployment }),
      };
}

function publicJiraPod(generation: number, pod: JiraLivePodMetadata): JiraLivePodView {
  return {
    kind: "jira-live",
    podId: pod.podId,
    authenticationGeneration: generation,
    verificationRevision: pod.verificationRevision,
    verificationInProgress: pod.verificationInProgress,
    verificationStatus:
      pod.credentialOperation === undefined ? pod.verificationStatus : "unverified",
    capabilities: ["live-read", "live-write"],
  };
}
