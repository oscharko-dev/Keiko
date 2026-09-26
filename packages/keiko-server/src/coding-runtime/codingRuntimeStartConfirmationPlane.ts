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
  // KEIKO-0396: pair each consumed request id with the wall time past which its own claim can
  // never be re-admitted (claimIsFresh already rejects a claim whose nowMs is more than
  // `freshnessMs` from wall). Once that instant has passed the entry cannot cause a replay any
  // more, so pruning it does not weaken the anti-replay guarantee — it just prevents the cap
  // from turning into a permanent fail-closed once the process has seen its first ~4k requests.
  const consumedRequestIds = new Map<string, number>();
  // Strict `<` matches claimIsFresh's inclusive `Math.abs(nowMs - claim.nowMs) <= freshnessMs`
  // ceiling — at the exact boundary the original claim is still admissible, so we must NOT evict
  // its entry yet. #3099 P2 follow-up to KEIKO-0396.
  const prune = (nowMs: number): void => {
    for (const [requestId, expiresAtMs] of consumedRequestIds) {
      if (expiresAtMs < nowMs) consumedRequestIds.delete(requestId);
    }
  };
  return {
    consume: (
      claim: CodingRuntimeStartConfirmationClaim,
    ): CodingRuntimeConsumedStartConfirmation | undefined => {
      const nowMs = now();
      // #3099 R3 KfQ Major: prune at the top so stale entries clear even when the current claim
      // is itself stale — otherwise a burst of stale-only replays could hoard the ~4k slots and
      // deny a subsequent legitimate fresh claim on availability grounds.
      prune(nowMs);
      if (!claimIsFresh(claim, nowMs, freshnessMs)) return undefined;
      if (consumedRequestIds.has(claim.requestId)) return undefined;
      if (consumedRequestIds.size >= MAX_TRACKED_REQUEST_IDS) return undefined;
      consumedRequestIds.set(claim.requestId, claim.nowMs + freshnessMs);
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
