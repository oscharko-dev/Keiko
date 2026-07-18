// Server-private pairing authority seam for the authenticated local app-session channel
// (ADR-0141 D2). Given a launcher-attested pairing request, the port decides whether the request
// proves the trusted local app session. The production implementation (launcherSessionPairingPort.ts)
// binds to a trusted launcher/OS authority; a deterministic fake (sessionPairingPort.testsupport.ts)
// exists only for CI. Absence of a port is an intentional fail-closed production posture: no session
// is issued and every content read stays content-free.
//
// This seam mints read authority, so — exactly like the runtime start-confirmation consumer
// (codingRuntimeStartConfirmation.ts) — production composition must never construct or fall back to
// the fake. The bounds here are the outer envelope the launcher attestation must satisfy before the
// port even evaluates it.

/** Maximum characters for the single-use pairing request identifier. */
export const SESSION_PAIRING_REQUEST_ID_MAX_CHARS = 128;
/** Maximum characters for the attestation claim (an HMAC-SHA256 hex digest is 64 chars). */
export const SESSION_PAIRING_CLAIM_MAX_CHARS = 256;
/** Maximum characters for a principal label an approved decision may carry. */
export const SESSION_PAIRING_PRINCIPAL_LABEL_MAX_CHARS = 64;

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** A launcher-minted, single-use, process-bound pairing attestation presented at the pair endpoint. */
export interface SessionPairingAttestation {
  readonly requestId: string;
  readonly issuedAtMs: number;
  readonly claim: string;
}

/** The port's decision. `denied` never distinguishes why, so a probe learns nothing from it. */
export type SessionPairingDecision =
  | { readonly outcome: "approved"; readonly principalLabel: string }
  | { readonly outcome: "denied" };

/** The pairing authority seam. Synchronous, in-memory, and fail-closed by default. */
export interface SessionPairingPort {
  readonly attest: (attestation: SessionPairingAttestation) => SessionPairingDecision;
}

/** A single denied decision reused everywhere so no call site invents a divergent shape. */
export const SESSION_PAIRING_DENIED: SessionPairingDecision = { outcome: "denied" };

const ALLOWED_KEYS: readonly string[] = ["requestId", "issuedAtMs", "claim"];

function hasOnlyAllowedKeys(candidate: Record<string, unknown>): boolean {
  return Object.keys(candidate).every((key) => ALLOWED_KEYS.includes(key));
}

function isValidRequestId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= SESSION_PAIRING_REQUEST_ID_MAX_CHARS &&
    SAFE_REQUEST_ID.test(value)
  );
}

function isValidIssuedAt(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isValidClaim(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= SESSION_PAIRING_CLAIM_MAX_CHARS
  );
}

/**
 * Structural gate every attestation must pass before any authority check. Rejects malformed request
 * ids, non-integer timestamps, and oversized claims. It is not authority — it only bounds the input.
 */
export function isWellFormedSessionPairingAttestation(
  value: unknown,
): value is SessionPairingAttestation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasOnlyAllowedKeys(candidate) &&
    isValidRequestId(candidate.requestId) &&
    isValidIssuedAt(candidate.issuedAtMs) &&
    isValidClaim(candidate.claim)
  );
}
