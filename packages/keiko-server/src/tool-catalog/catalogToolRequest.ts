import type { CatalogDigest } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import type { BoundToolInvocation, CatalogTrustedContext } from "./catalogToolPorts.js";

export function catalogRequestDigest(
  request: BoundToolInvocation,
  context: CatalogTrustedContext,
  nonce: string,
): CatalogDigest {
  return sha256Hex(
    canonicalise({
      domain: "keiko.tool-request.v1",
      toolRef: request.toolRef,
      projectionDigest: request.projectionDigest,
      workspaceIdentity: context.workspaceIdentity,
      workspaceRevision: context.workspaceRevision,
      canonicalArguments: request.arguments,
      nonce,
    }),
  ) as CatalogDigest;
}
