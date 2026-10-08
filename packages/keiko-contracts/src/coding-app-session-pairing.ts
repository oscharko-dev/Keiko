// Pairing codecs without transient channel/history validation dependencies.

import { exactKeys, isRecord } from "./contract-validation-primitives.js";

/** Maximum characters for the single-use pairing request identifier. */
export const CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS = 128;
/** Maximum characters for the attestation claim (an HMAC-SHA256 hex digest is 64 chars). */
export const CODING_APP_SESSION_PAIRING_CLAIM_MAX_CHARS = 256;
/** Maximum characters for a principal label an approved pairing decision may carry. */
export const CODING_APP_SESSION_PAIRING_PRINCIPAL_LABEL_MAX_CHARS = 64;

const SAFE_PAIRING_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * A launcher-minted, single-use, freshness-bounded pairing attestation presented at the pair
 * endpoint. The claim is an HMAC over the launcher's process-scoped secret; an arbitrary local
 * process cannot forge it because it does not hold that secret (ADR-0141 D2).
 */
export interface CodingAppSessionPairingAttestation {
  readonly requestId: string;
  readonly issuedAtMs: number;
  readonly claim: string;
}

function isValidPairingRequestId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS &&
    SAFE_PAIRING_REQUEST_ID.test(value)
  );
}

// KEIKO-0742: the claim is documented as a fixed-length HMAC-SHA256 hex digest — a length range of
// 1..CODING_APP_SESSION_PAIRING_CLAIM_MAX_CHARS is an outer defence-in-depth backstop, not the
// admission gate. Match the shape the launcher actually emits (64 lowercase hex characters). The
// outer cap stays as the defence-in-depth bound the field's max-chars constant still documents.
const HMAC_SHA256_HEX_CLAIM = /^[a-f0-9]{64}$/u;

function isValidPairingClaim(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= CODING_APP_SESSION_PAIRING_CLAIM_MAX_CHARS &&
    HMAC_SHA256_HEX_CLAIM.test(value)
  );
}

/**
 * Structural gate every pairing attestation must pass before any authority check. Rejects malformed
 * request ids, non-integer timestamps, and oversized claims. It is not authority — it only bounds
 * the input; the server-private pairing port decides approval.
 */
export function isWellFormedCodingAppSessionPairingAttestation(
  value: unknown,
): value is CodingAppSessionPairingAttestation {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, ["requestId", "issuedAtMs", "claim"], "attestation").length === 0 &&
    isValidPairingRequestId(value.requestId) &&
    Number.isSafeInteger(value.issuedAtMs) &&
    Number(value.issuedAtMs) >= 0 &&
    isValidPairingClaim(value.claim)
  );
}

/**
 * URL-fragment prefix for the launcher-automatic pairing hand-off (ADR-0141 W1.5 finalization).
 * The fragment never reaches the server over HTTP; the UI redeems it against the pair endpoint on
 * boot and immediately strips it from the address bar and history.
 */
export const CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX = "#keiko-app-session=";

/** Encode a launcher-minted attestation as the boot URL fragment the browser redeems on load. */
export function encodeCodingAppSessionPairingFragment(
  attestation: CodingAppSessionPairingAttestation,
): string {
  return `${CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX}${encodeURIComponent(
    JSON.stringify(attestation),
  )}`;
}

/**
 * Decode a boot URL fragment back into a pairing attestation. Fail-closed: any prefix mismatch,
 * malformed encoding, or structurally invalid attestation yields `undefined`. Unexpected runtime
 * faults propagate to the caller's diagnostic boundary.
 */
export function decodeCodingAppSessionPairingFragment(
  fragment: string,
): CodingAppSessionPairingAttestation | undefined {
  if (!fragment.startsWith(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX)) return undefined;
  const encoded = fragment.slice(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    return isWellFormedCodingAppSessionPairingAttestation(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof URIError) return undefined;
    throw error;
  }
}
