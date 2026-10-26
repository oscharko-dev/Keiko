import type { AtlassianNetworkConfig, AtlassianPrivateTarget } from "@oscharko-dev/keiko-contracts";
import { canonicalAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { classifyOutboundHost } from "./egress-policy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ConfigInvalidError(
    "atlassian.privateTargets must contain bounded exact HTTPS targets with matching private or loopback address classes",
  );
}

function parseTarget(value: unknown): AtlassianPrivateTarget {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "baseUrl" && key !== "addressClass")
  )
    return invalid();
  const baseUrl = canonicalAtlassianConnectorBaseUrl(value.baseUrl);
  if (
    baseUrl === undefined ||
    (value.addressClass !== "private" && value.addressClass !== "loopback")
  )
    return invalid();
  const literalClass = classifyOutboundHost(new URL(baseUrl).hostname);
  if (literalClass !== undefined && literalClass !== value.addressClass) return invalid();
  return { baseUrl, addressClass: value.addressClass };
}

/** Config-file only. No environment mapping or global private-network fallback. */
export function parseAtlassianNetworkConfig(value: unknown): AtlassianNetworkConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "privateTargets"))
    return invalid();
  if (!Array.isArray(value.privateTargets) || value.privateTargets.length > 64) return invalid();
  const privateTargets = value.privateTargets.map(parseTarget);
  if (new Set(privateTargets.map((target) => target.baseUrl)).size !== privateTargets.length)
    return invalid();
  return { privateTargets };
}
