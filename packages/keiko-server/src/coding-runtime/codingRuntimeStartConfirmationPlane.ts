import { createHash, randomBytes } from "node:crypto";

import type {
  CodingRuntimeConsumedStartConfirmation,
  CodingRuntimeStartConfirmationClaim,
  CodingRuntimeStartConfirmationConsumer,
} from "./codingRuntimeStartConfirmation.js";

const BINDING_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_TRACKED_REQUEST_IDS = 4_096;
const DEFAULT_CLAIM_FRESHNESS_MS = 30_000;

export interface AuthenticatedSessionStartConfirmationDeps {
  readonly now?: (() => number) | undefined;
  readonly claimFreshnessMs?: number | undefined;
}

/**
 * Tracer-scope production consumer for the central start-confirmation seam (#2377).
 *
 * The #2385 default posture treats the operator's authenticated, CSRF-guarded start request as
 * the confirming human action: the server resolves the trusted workspace context, builds the
 * server-private claim, and this plane converts it into a one-use consumed confirmation. It never
 * accepts a browser-authored digest, replays a request id, or honours a stale claim. Later
 * children replace this plane with the interactive action-confirmation authority without moving
 * the seam.
 */
export function createAuthenticatedSessionStartConfirmationPlane(
  deps: AuthenticatedSessionStartConfirmationDeps = {},
): CodingRuntimeStartConfirmationConsumer {
  const now = deps.now ?? Date.now;
  const freshnessMs = deps.claimFreshnessMs ?? DEFAULT_CLAIM_FRESHNESS_MS;
  const instanceNonce = randomBytes(16).toString("hex");
  const consumedRequestIds = new Set<string>();
  return {
    consume: (
      claim: CodingRuntimeStartConfirmationClaim,
    ): CodingRuntimeConsumedStartConfirmation | undefined => {
      if (!claimIsFresh(claim, now(), freshnessMs)) return undefined;
      if (consumedRequestIds.has(claim.requestId)) return undefined;
      if (consumedRequestIds.size >= MAX_TRACKED_REQUEST_IDS) return undefined;
      consumedRequestIds.add(claim.requestId);
      return { approvalDigest: approvalDigest(claim, instanceNonce) };
    },
  };
}

function claimIsFresh(
  claim: CodingRuntimeStartConfirmationClaim,
  nowMs: number,
  freshnessMs: number,
): boolean {
  return (
    typeof claim.requestId === "string" &&
    claim.requestId.length > 0 &&
    BINDING_DIGEST.test(claim.bindingDigest) &&
    Number.isSafeInteger(claim.nowMs) &&
    Math.abs(nowMs - claim.nowMs) <= freshnessMs
  );
}

function approvalDigest(claim: CodingRuntimeStartConfirmationClaim, nonce: string): string {
  return createHash("sha256")
    .update(`coding-runtime-start-confirmation:${nonce}:${claim.requestId}:${claim.bindingDigest}`)
    .digest("hex");
}
