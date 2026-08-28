// Production pairing authority for the authenticated local app-session channel (ADR-0141 D2).
//
// The port binds to a trusted launcher/OS authority: the launcher provisions a process-scoped secret
// to the BFF out of band (an inherited environment value, never a disk file, never a URL). A pairing
// attestation is accepted only when it carries a fresh, single-use HMAC claim over that secret — proof
// an arbitrary same-user local process cannot forge, because it does not hold the launcher secret.
//
// `resolveLauncherSessionPairingPort` returns `undefined` when no launcher secret is present, which is
// the intentional fail-closed production posture: without launcher authority no session is issuable.
// The exact launcher-to-browser delivery of the attestation is finalized with the UI plumbing in W1.5;
// the server-side authority verified here is complete and unit-tested directly.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  CODING_APP_SESSION_LAUNCHER_SECRET_ENV,
  CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  SESSION_PAIRING_DENIED,
  isWellFormedSessionPairingAttestation,
  type SessionPairingAttestation,
  type SessionPairingDecision,
  type SessionPairingPort,
} from "./sessionPairingPort.js";

/** Environment variable through which the trusted launcher provisions the process-scoped secret. */
export const SESSION_PAIRING_LAUNCHER_SECRET_ENV = CODING_APP_SESSION_LAUNCHER_SECRET_ENV;

const MIN_LAUNCHER_SECRET_CHARS = CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS;
const DEFAULT_CLAIM_FRESHNESS_MS = 30_000;
const MAX_TRACKED_REQUEST_IDS = 4_096;
const APPROVED_PRINCIPAL_LABEL = "local-app-session";

export interface LauncherSessionPairingPortDeps {
  /** The launcher-provisioned process-scoped secret. */
  readonly secret: string;
  /** Injectable clock (tests); production uses the wall clock. */
  readonly now?: () => number;
  /** Accepted attestation age before it is stale. */
  readonly claimFreshnessMs?: number;
}

/**
 * Compute the canonical claim a launcher (or a test) mints for a pairing request. Exposed so the
 * claim construction has exactly one definition shared by minting and verification.
 */
export function computeLauncherPairingClaim(
  secret: string,
  requestId: string,
  issuedAtMs: number,
): string {
  return createHmac("sha256", secret)
    .update(`${requestId}:${String(issuedAtMs)}`)
    .digest("hex");
}

/** Mint a valid attestation. Used by tests and any trusted-launcher caller; never by the browser. */
export function mintLauncherPairingAttestation(input: {
  readonly secret: string;
  readonly requestId: string;
  readonly issuedAtMs: number;
}): SessionPairingAttestation {
  return {
    requestId: input.requestId,
    issuedAtMs: input.issuedAtMs,
    claim: computeLauncherPairingClaim(input.secret, input.requestId, input.issuedAtMs),
  };
}

/** Constant-time claim comparison over fixed-length digests, independent of input length. */
function claimMatches(secret: string, attestation: SessionPairingAttestation): boolean {
  const expected = computeLauncherPairingClaim(
    secret,
    attestation.requestId,
    attestation.issuedAtMs,
  );
  return timingSafeEqual(sha256(attestation.claim), sha256(expected));
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

function isFresh(issuedAtMs: number, nowMs: number, freshnessMs: number): boolean {
  const age = nowMs - issuedAtMs;
  return age >= -freshnessMs && age <= freshnessMs;
}

/**
 * Build the production pairing port over a launcher secret. Approves only a well-formed, fresh,
 * single-use attestation whose HMAC claim matches; every other outcome is an indistinguishable denial.
 */
export function createLauncherSessionPairingPort(
  deps: LauncherSessionPairingPortDeps,
): SessionPairingPort {
  const now = deps.now ?? Date.now;
  const freshnessMs = deps.claimFreshnessMs ?? DEFAULT_CLAIM_FRESHNESS_MS;
  const secret = deps.secret;
  // KEIKO-0460: the anti-replay set previously grew unbounded and — once past the cap —
  // permanently rejected every future attestation. Since `isFresh` already denies any attestation
  // whose issuedAtMs is more than `freshnessMs` from wall in either direction, an id can only be
  // replayed inside that window. Pair each id with its own expiry (`issuedAtMs + freshnessMs`)
  // and evict entries whose window has elapsed before the cap gate — no anti-replay strength is
  // given up because a would-be replay outside the window was already denied by `isFresh`.
  const consumedRequestIds = new Map<string, number>();
  // Strict `<` matches `isFresh`'s inclusive `age <= freshnessMs` — at the exact boundary the
  // original attestation is still admissible, so we must NOT evict its entry yet. #3099 P2
  // follow-up to KEIKO-0460.
  const prune = (nowMs: number): void => {
    for (const [requestId, expiresAtMs] of consumedRequestIds) {
      if (expiresAtMs < nowMs) consumedRequestIds.delete(requestId);
    }
  };
  return {
    attest: (attestation: SessionPairingAttestation): SessionPairingDecision => {
      if (!isWellFormedSessionPairingAttestation(attestation)) return SESSION_PAIRING_DENIED;
      const nowMs = now();
      // #3099 R3 KfQ Major: prune at the top of every attest so stale entries clear even when
      // subsequent traffic is a stream of stale-only replays that never reaches the admit path
      // — otherwise a burst of stale attestations could hoard the ~4k slots and lock a future
      // fresh attestation out on availability grounds.
      prune(nowMs);
      if (!isFresh(attestation.issuedAtMs, nowMs, freshnessMs)) return SESSION_PAIRING_DENIED;
      if (consumedRequestIds.has(attestation.requestId)) return SESSION_PAIRING_DENIED;
      if (consumedRequestIds.size >= MAX_TRACKED_REQUEST_IDS) return SESSION_PAIRING_DENIED;
      if (!claimMatches(secret, attestation)) return SESSION_PAIRING_DENIED;
      consumedRequestIds.set(attestation.requestId, attestation.issuedAtMs + freshnessMs);
      return { outcome: "approved", principalLabel: APPROVED_PRINCIPAL_LABEL };
    },
  };
}

/**
 * Resolve the production pairing port from the environment. Returns `undefined` — fail closed — unless
 * the trusted launcher has provisioned a sufficiently long process-scoped secret. Production
 * composition never falls back to a fake; a missing secret means no session can be issued.
 */
export function resolveLauncherSessionPairingPort(env: EnvSource): SessionPairingPort | undefined {
  const secret = env[SESSION_PAIRING_LAUNCHER_SECRET_ENV];
  if (typeof secret !== "string" || secret.length < MIN_LAUNCHER_SECRET_CHARS) return undefined;
  return createLauncherSessionPairingPort({ secret });
}
