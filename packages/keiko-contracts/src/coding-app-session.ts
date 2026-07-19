// Wire contracts for the authenticated local app-session channel (ADR-0141, promoted from
// keiko-server in W1.5 per the ADR's D12 batching guidance).
//
// These are the shapes that cross the loopback wire between the Keiko UI, the trusted launcher,
// and the BFF: the bounded channel content and fail-closed snapshot, the content-free
// acknowledgement, the launcher-minted pairing attestation, and the URL-fragment codec the
// launcher-automatic pairing flow uses to hand the attestation to the browser. The session bearer
// is an HttpOnly cookie and is never represented here.

import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import { exactKeys, invalid, isRecord, result } from "./coding-workbench-runtime-api-validation.js";

/** Contract version for the authenticated app-session channel wire shapes (ADR-0141). */
export const CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION = "1" as const;

/** Maximum characters for a bounded content item's `kind` label. */
export const CODING_APP_SESSION_CHANNEL_KIND_MAX_CHARS = 64;
/** Maximum characters for a bounded content item's untrusted `body`. Mirrors the question budget. */
export const CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS = 4_096;
/** Aggregate UTF-8 byte ceiling for a serialized channel snapshot. Mirrors the question budget. */
export const CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES = 64 * 1_024;

/**
 * Environment variable through which the trusted launcher provisions the BFF's process-scoped
 * pairing secret (ADR-0141 D2): an inherited environment value only — never a disk file, never a
 * URL. Part of the launcher↔server contract, so the keiko-cli launcher and the server-side pairing
 * port resolve one name.
 */
export const CODING_APP_SESSION_LAUNCHER_SECRET_ENV = "KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET";
/** Minimum launcher-secret length before the server-side pairing port resolves (fail-closed). */
export const CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS = 32;

/** Maximum characters for the single-use pairing request identifier. */
export const CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS = 128;
/** Maximum characters for the attestation claim (an HMAC-SHA256 hex digest is 64 chars). */
export const CODING_APP_SESSION_PAIRING_CLAIM_MAX_CHARS = 256;
/** Maximum characters for a principal label an approved pairing decision may carry. */
export const CODING_APP_SESSION_PAIRING_PRINCIPAL_LABEL_MAX_CHARS = 64;

const SAFE_PAIRING_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * One bounded content item served over the authenticated channel to a paired session. `body` is
 * untrusted runtime text for transient browser rendering only; it reuses the runtime-question
 * bounding discipline (bounded, non-empty, aggregate-capped).
 */
export interface CodingAppSessionChannelContent {
  readonly kind: string;
  /** Untrusted runtime text for transient browser rendering only. */
  readonly body: string;
}

/**
 * The authenticated channel snapshot. Fail-closed (ADR-0141 D6): an unpaired caller receives the
 * same `content: null` shape a paired caller with no available content receives, so the response
 * never reveals whether a session or protected content exists.
 */
export interface CodingAppSessionChannelSnapshot {
  readonly schemaVersion: typeof CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION;
  readonly content: CodingAppSessionChannelContent | null;
}

/**
 * The content-free acknowledgement returned by pairing and session-lifecycle endpoints. It never
 * carries bearer material; the session, when issued, is delivered only as an `HttpOnly` cookie.
 */
export interface CodingAppSessionAcknowledgement {
  readonly schemaVersion: typeof CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION;
}

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

/** The single source of the fail-closed content-free snapshot shape (ADR-0141 D6). */
export function contentFreeCodingAppSessionChannelSnapshot(): CodingAppSessionChannelSnapshot {
  return { schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION, content: null };
}

/** The content-free acknowledgement shape returned by pairing and lifecycle endpoints. */
export function codingAppSessionAcknowledgement(): CodingAppSessionAcknowledgement {
  return { schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION };
}

function checkBoundedText(value: unknown, path: string, max: number, errors: string[]): void {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    errors.push(`${path} must be a bounded non-empty string`);
  }
}

function serializedUtf8Bytes(value: object): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function checkChannelContent(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object or null`);
    return;
  }
  errors.push(...exactKeys(value, ["kind", "body"], path));
  checkBoundedText(value.kind, `${path}.kind`, CODING_APP_SESSION_CHANNEL_KIND_MAX_CHARS, errors);
  checkBoundedText(value.body, `${path}.body`, CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS, errors);
}

/** Validate a single bounded content item in isolation (used before projecting it into a snapshot). */
export function validateCodingAppSessionChannelContent(
  value: unknown,
): CodingWorkbenchValidationResult<CodingAppSessionChannelContent> {
  if (!isRecord(value)) return invalid("channel content must be an object");
  const errors: string[] = [];
  checkChannelContent(value, "channelContent", errors);
  return result(value, errors);
}

/**
 * Validate a channel snapshot: exact keys, correct version, a bounded content item or `null`, and an
 * aggregate UTF-8 budget. The server validates every projected snapshot before it crosses the wire.
 */
export function validateCodingAppSessionChannelSnapshot(
  value: unknown,
): CodingWorkbenchValidationResult<CodingAppSessionChannelSnapshot> {
  if (!isRecord(value)) return invalid("channel snapshot must be an object");
  const errors = exactKeys(value, ["schemaVersion", "content"], "channelSnapshot");
  if (value.schemaVersion !== CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION) {
    errors.push("channelSnapshot.schemaVersion is invalid");
  }
  if (value.content !== null) checkChannelContent(value.content, "channelSnapshot.content", errors);
  if (
    errors.length === 0 &&
    serializedUtf8Bytes(value) > CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES
  ) {
    errors.push("channel snapshot exceeds the aggregate UTF-8 byte budget");
  }
  return result(value, errors);
}

function isValidPairingRequestId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= CODING_APP_SESSION_PAIRING_REQUEST_ID_MAX_CHARS &&
    SAFE_PAIRING_REQUEST_ID.test(value)
  );
}

function isValidPairingClaim(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CODING_APP_SESSION_PAIRING_CLAIM_MAX_CHARS
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
 * malformed encoding, or structurally invalid attestation yields `undefined` — never a throw.
 */
export function decodeCodingAppSessionPairingFragment(
  fragment: string,
): CodingAppSessionPairingAttestation | undefined {
  if (!fragment.startsWith(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX)) return undefined;
  const encoded = fragment.slice(CODING_APP_SESSION_PAIRING_FRAGMENT_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    return isWellFormedCodingAppSessionPairingAttestation(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
