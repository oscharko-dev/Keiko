import { createHash } from "node:crypto";
import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import type { UiHandlerDeps } from "../deps.js";

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
): AtlassianCredentialMetadata {
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
      }
    : {
        ...common,
        provider: metadata.provider,
        authScheme: "basic-api-token",
        ...(metadata.deployment === undefined ? {} : { deployment: metadata.deployment }),
      };
}
