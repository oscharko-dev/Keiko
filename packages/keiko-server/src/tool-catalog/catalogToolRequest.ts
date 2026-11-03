import type { ToolConsumerContext } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import { captureCatalogJson } from "@oscharko-dev/keiko-tool-catalog";
import type {
  CatalogDigest,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { BoundToolInvocation } from "./catalogToolPorts.js";

export function catalogRequestDigest(
  request: BoundToolInvocation,
  scopeDigest: CatalogDigest,
  nonce: string,
): CatalogDigest {
  return sha256Hex(
    canonicalise({
      domain: "keiko.tool-request.v2",
      toolRef: request.toolRef,
      projectionDigest: request.projectionDigest,
      scopeDigest,
      canonicalArguments: request.arguments,
      nonce,
    }),
  ) as CatalogDigest;
}

export function sameRef(
  left: BoundToolInvocation["toolRef"],
  right: BoundToolInvocation["toolRef"],
): boolean {
  return left.canonicalId === right.canonicalId && left.contractVersion === right.contractVersion;
}

export function catalogScopeDigest(scope: CatalogJsonObject): CatalogDigest {
  return sha256Hex(
    canonicalise({
      domain: "keiko.tool-consumer-scope.v1",
      scope: captureCatalogJson(scope, 4096),
    }),
  ) as CatalogDigest;
}

export function captureCatalogConsumerContext<Context extends ToolConsumerContext>(
  context: Context,
): Context {
  const snapshot = { ...context };
  Object.freeze(snapshot);
  return snapshot;
}
