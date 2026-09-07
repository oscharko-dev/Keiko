import type {
  CatalogDigest,
  ToolRef,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { semanticDigest } from "./identity.js";

/** Immutable identity of one handler slot in projection order; no runtime/readiness state. */
export interface ToolHandlerSetIdentity {
  readonly toolRef: ToolRef;
  readonly descriptorDigest: CatalogDigest;
  readonly handlerId: string | null;
  readonly handlerVersion: number | null;
  readonly catalogAction: string | null;
}

/** The single semantic digest for the exact handlers bound to one compiled projection. */
export function computeHandlerSetDigest(
  projectionDigest: CatalogDigest,
  bindings: readonly ToolHandlerSetIdentity[],
): CatalogDigest {
  return semanticDigest("keiko.tool-handler-set.v1", { projectionDigest, bindings });
}
