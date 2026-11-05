import type { AtlassianCredentialMetadata } from "@oscharko-dev/keiko-connectors";
import { canonicalAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  boundedDnsLookup,
  classifyOutboundHost,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { AtlassianCredentialMetadataStore } from "./credentialMetadataStore.js";

/** Private, server-owned binding for one explicitly saved Data Center connection. */
export interface AtlassianTargetAdmission {
  readonly baseUrl: string;
  readonly addressClass: "public" | "private" | "loopback";
}

function sameLivePodIdentity(
  stored: AtlassianCredentialMetadata,
  metadata: AtlassianCredentialMetadata,
): boolean {
  if (stored.deployment !== "data-center" || metadata.deployment !== "data-center") return false;
  const savedPod = stored.livePod;
  const observedPod = metadata.livePod;
  return (
    savedPod?.podId === observedPod?.podId &&
    savedPod?.ownerDigest === observedPod?.ownerDigest &&
    savedPod?.credentialOperation === undefined
  );
}

export function isCurrentAtlassianDataCenterMetadata(
  stored: AtlassianCredentialMetadata | undefined,
  metadata: AtlassianCredentialMetadata,
): boolean {
  return (
    stored?.deployment === "data-center" &&
    metadata.deployment === "data-center" &&
    stored.generation === metadata.generation &&
    stored.baseUrl === metadata.baseUrl &&
    sameLivePodIdentity(stored, metadata)
  );
}

function isTargetAddressClass(value: unknown): value is AtlassianTargetAdmission["addressClass"] {
  return value === "public" || value === "private" || value === "loopback";
}

export function isAtlassianTargetAdmission(value: unknown): value is AtlassianTargetAdmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "baseUrl" && key !== "addressClass")) return false;
  const baseUrl = canonicalAtlassianConnectorBaseUrl(record.baseUrl);
  if (baseUrl === undefined || baseUrl !== record.baseUrl) return false;
  const addressClass = record.addressClass;
  if (!isTargetAddressClass(addressClass)) return false;
  const literalClass = classifyOutboundHost(new URL(baseUrl).hostname);
  // A DNS name can never acquire loopback authority, even on its first verification.
  return literalClass === undefined ? addressClass !== "loopback" : addressClass === literalClass;
}

async function targetAddressClass(
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<AtlassianTargetAdmission["addressClass"] | undefined> {
  const hostname = new URL(baseUrl).hostname;
  const literalClass = classifyOutboundHost(hostname);
  if (literalClass !== undefined)
    return literalClass === "public" || literalClass === "private" || literalClass === "loopback"
      ? literalClass
      : undefined;
  const addresses = await boundedDnsLookup(hostname, signal);
  const first = addresses[0];
  if (first === undefined) return undefined;
  const addressClass = classifyOutboundHost(first.address);
  if (addressClass !== "public" && addressClass !== "private") return undefined;
  return addresses.every((address) => classifyOutboundHost(address.address) === addressClass)
    ? addressClass
    : undefined;
}

/**
 * Only an explicit verification may establish a binding. Transport still rechecks every DNS
 * answer against this stable class and pins its connect; this lookup grants no credential access.
 */
export async function resolveAtlassianTargetAdmission(
  store: AtlassianCredentialMetadataStore,
  metadata: AtlassianCredentialMetadata,
  signal: AbortSignal | undefined,
  permitCreation: boolean,
): Promise<AtlassianTargetAdmission | undefined> {
  if (metadata.deployment !== "data-center") return undefined;
  signal?.throwIfAborted();
  if (!isCurrentAtlassianDataCenterMetadata(store.get(metadata.authRef), metadata))
    return undefined;
  const existing = store.getTargetAdmission(metadata);
  if (existing !== undefined || !permitCreation) return existing;
  const baseUrl = canonicalAtlassianConnectorBaseUrl(metadata.baseUrl);
  if (baseUrl === undefined) return undefined;
  const addressClass = await targetAddressClass(baseUrl, signal);
  signal?.throwIfAborted();
  if (addressClass === undefined) return undefined;
  // The store rereads current metadata here: rotation, deletion and competing verifications
  // during DNS resolution cannot revive an old identity or change an established address class.
  return store.bindTargetAdmission(metadata, { baseUrl, addressClass });
}
