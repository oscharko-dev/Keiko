import type { CodingWorkbenchValidationResult } from "./coding-workbench.js";
import {
  exactKeys,
  isRecord,
  validateWithAdmission,
} from "./coding-workbench-runtime-api-validation.js";
import { isOneOf, isPhysicalArrayOf } from "./contract-validation-primitives.js";

export const BROWSER_APPROVAL_VERSION = 1 as const;
export const BROWSER_APPROVAL_REQUEST_TTL_MS = 5 * 60 * 1_000;
export const BROWSER_APPROVAL_CHALLENGE_TTL_MS = 60 * 1_000;
export const BROWSER_APPROVAL_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const BROWSER_APPROVAL_MAX_RECORDS = 32;
export const BROWSER_APPROVAL_MAX_CHALLENGES = 64;

const REQUEST_ID = /^brq_[a-f0-9]{32}$/u;
const APPROVAL_ID = /^bra_[a-f0-9]{32}$/u;
const CHALLENGE_ID = /^bch_[a-f0-9]{32}$/u;
const POINT_COORDINATE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/u;

/** Only public P-256 coordinates cross the wire; a private JWK is never an input. */
export interface BrowserApprovalPublicKey {
  readonly x: string;
  readonly y: string;
}

export interface BrowserApprovalRequestInput {
  readonly publicKey: BrowserApprovalPublicKey;
  readonly remember: boolean;
}

export interface BrowserApprovalDecisionInput {
  readonly requestId: string;
  readonly comparisonCode: string;
  readonly remember: boolean;
}

export interface BrowserApprovalChallengeInput {
  readonly purpose: "complete" | "renew";
  readonly subjectId: string;
}

export interface BrowserApprovalProofInput {
  readonly challengeId: string;
  /** IEEE-P1363 r || s, encoded as canonical unpadded base64url. */
  readonly signature: string;
}

export interface BrowserApprovalChallenge extends BrowserApprovalChallengeInput {
  readonly schemaVersion: typeof BROWSER_APPROVAL_VERSION;
  readonly challengeId: string;
  readonly installationId: string;
  readonly serverInstanceId: string;
  readonly origin: string;
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface BrowserApprovalRequestDescriptor {
  readonly requestId: string;
  readonly comparisonCode: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly rememberRequested: boolean;
  readonly publicKeyFingerprint: string;
}

export interface BrowserApprovalDescriptor {
  readonly approvalId: string;
  readonly remembered: boolean;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly lastUsedAtMs: number;
  readonly publicKeyFingerprint: string;
}

export interface BrowserApprovalManagementSnapshot {
  readonly requests: readonly BrowserApprovalRequestDescriptor[];
  readonly approvals: readonly BrowserApprovalDescriptor[];
}

export type BrowserApprovalManagementResult =
  | ({ readonly state: "active" } & BrowserApprovalManagementSnapshot)
  | { readonly state: "unavailable" };

export interface BrowserApprovalDecisionResult {
  readonly state: "accepted" | "unavailable";
}

export type BrowserApprovalRequestResult =
  | { readonly state: "pending"; readonly request: BrowserApprovalRequestDescriptor }
  | { readonly state: "unavailable" };

export type BrowserApprovalChallengeResult =
  | { readonly state: "challenge"; readonly challenge: BrowserApprovalChallenge }
  | { readonly state: "pending" | "unavailable" };

export type BrowserApprovalProofResult =
  | { readonly state: "active"; readonly approval?: BrowserApprovalDescriptor | undefined }
  | { readonly state: "unavailable" };

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasBoundedLifetime(
  value: Record<string, unknown>,
  issuedField: string,
  maximumMs: number,
): boolean {
  const issued = value[issuedField];
  const expires = value.expiresAtMs;
  return isTime(issued) && isTime(expires) && expires > issued && expires - issued <= maximumMs;
}

function hasValidLastUse(value: Record<string, unknown>): boolean {
  const used = value.lastUsedAtMs;
  const approved = value.approvedAtMs;
  const expires = value.expiresAtMs;
  return isTime(used) && isTime(approved) && isTime(expires) && used >= approved && used < expires;
}

export function isBrowserApprovalRequestDescriptor(
  value: unknown,
): value is BrowserApprovalRequestDescriptor {
  if (!isRecord(value)) return false;
  const fields = [
    "requestId",
    "comparisonCode",
    "requestedAtMs",
    "expiresAtMs",
    "rememberRequested",
    "publicKeyFingerprint",
  ];
  return (
    exactKeys(value, fields, "browserRequestDescriptor").length === 0 &&
    isBrowserApprovalRequestId(value.requestId) &&
    matches(value.comparisonCode, /^\d{8}$/u) &&
    hasBoundedLifetime(value, "requestedAtMs", BROWSER_APPROVAL_REQUEST_TTL_MS) &&
    typeof value.rememberRequested === "boolean" &&
    matches(value.publicKeyFingerprint, /^[a-f0-9]{64}$/u)
  );
}

export function isBrowserApprovalDescriptor(value: unknown): value is BrowserApprovalDescriptor {
  if (!isRecord(value)) return false;
  const fields = [
    "approvalId",
    "remembered",
    "approvedAtMs",
    "expiresAtMs",
    "lastUsedAtMs",
    "publicKeyFingerprint",
  ];
  return (
    exactKeys(value, fields, "browserApprovalDescriptor").length === 0 &&
    isBrowserApprovalId(value.approvalId) &&
    typeof value.remembered === "boolean" &&
    hasBoundedLifetime(value, "approvedAtMs", BROWSER_APPROVAL_REMEMBER_TTL_MS) &&
    hasValidLastUse(value) &&
    matches(value.publicKeyFingerprint, /^[a-f0-9]{64}$/u)
  );
}

function isStateOnly<State extends "accepted" | "pending" | "unavailable">(
  value: unknown,
  states: readonly State[],
): value is { readonly state: State } {
  return (
    isRecord(value) &&
    exactKeys(value, ["state"], "browserApprovalResult").length === 0 &&
    typeof value.state === "string" &&
    isOneOf(value.state, states)
  );
}

export function validateBrowserApprovalRequestResult(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalRequestResult> {
  return validateWithAdmission(value, checkBrowserApprovalRequestResult);
}

function checkBrowserApprovalRequestResult(
  value: unknown,
  errors: string[],
): value is BrowserApprovalRequestResult {
  if (isStateOnly(value, ["unavailable"])) return true;
  if (!isRecord(value)) {
    errors.push("browser request result must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["state", "request"], "browserRequestResult"));
  if (value.state !== "pending" || !isBrowserApprovalRequestDescriptor(value.request))
    errors.push("browser request result is invalid");
  return errors.length === 0;
}

export function validateBrowserApprovalChallengeResult(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalChallengeResult> {
  return validateWithAdmission(value, checkBrowserApprovalChallengeResult);
}

function checkBrowserApprovalChallengeResult(
  value: unknown,
  errors: string[],
): value is BrowserApprovalChallengeResult {
  if (isStateOnly(value, ["pending", "unavailable"])) return true;
  if (!isRecord(value)) {
    errors.push("browser challenge result must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["state", "challenge"], "browserChallengeResult"));
  if (value.state !== "challenge" || !validateBrowserApprovalChallenge(value.challenge).ok)
    errors.push("browser challenge result is invalid");
  return errors.length === 0;
}

export function validateBrowserApprovalProofResult(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalProofResult> {
  return validateWithAdmission(value, checkBrowserApprovalProofResult);
}

function checkBrowserApprovalProofResult(
  value: unknown,
  errors: string[],
): value is BrowserApprovalProofResult {
  if (isStateOnly(value, ["unavailable"])) return true;
  if (!isRecord(value)) {
    errors.push("browser proof result must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["state", "approval"], "browserProofResult"));
  if (value.state !== "active") errors.push("browser proof result is invalid");
  if (value.approval !== undefined && !isBrowserApprovalDescriptor(value.approval))
    errors.push("browser proof approval is invalid");
  return errors.length === 0;
}

export function validateBrowserApprovalDecisionResult(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalDecisionResult> {
  return validateWithAdmission(value, checkBrowserApprovalDecisionResult);
}

function checkBrowserApprovalDecisionResult(
  value: unknown,
  errors: string[],
): value is BrowserApprovalDecisionResult {
  const admitted = isStateOnly(value, ["accepted", "unavailable"]);
  if (!admitted) errors.push("browser decision result is invalid");
  return admitted;
}

// A bounded physical collection of records, each with a valid identity and no identity repeated.
function hasUniqueRecords<T>(
  value: unknown,
  limit: number,
  isRecord: (entry: unknown) => entry is T,
  key: keyof T,
  isIdentity: (identity: unknown) => identity is string,
): value is T[] {
  if (!Array.isArray(value) || value.length > limit) return false;
  if (!isPhysicalArrayOf(value, isRecord)) return false;
  const entries: readonly T[] = value;
  const count = entries.length;
  const identities = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) return false;
    const identity: unknown = entry[key];
    if (!isIdentity(identity)) return false;
    identities.add(identity);
  }
  return identities.size === value.length;
}

function hasValidRequests(value: unknown): value is BrowserApprovalRequestDescriptor[] {
  return hasUniqueRecords(
    value,
    BROWSER_APPROVAL_MAX_RECORDS,
    isBrowserApprovalRequestDescriptor,
    "requestId",
    isBrowserApprovalRequestId,
  );
}

function hasValidApprovals(value: unknown): value is BrowserApprovalDescriptor[] {
  return hasUniqueRecords(
    value,
    BROWSER_APPROVAL_MAX_RECORDS * 2,
    isBrowserApprovalDescriptor,
    "approvalId",
    isBrowserApprovalId,
  );
}

export function validateBrowserApprovalManagementResult(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalManagementResult> {
  return validateWithAdmission(value, checkBrowserApprovalManagementResult);
}

function checkBrowserApprovalManagementResult(
  value: unknown,
  errors: string[],
): value is BrowserApprovalManagementResult {
  if (isStateOnly(value, ["unavailable"])) return true;
  if (!isRecord(value)) {
    errors.push("browser management result must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["state", "requests", "approvals"], "browserManagementResult"));
  if (value.state !== "active") errors.push("browser management state is invalid");
  if (!hasValidRequests(value.requests)) errors.push("browser management requests are invalid");
  if (!hasValidApprovals(value.approvals)) errors.push("browser management approvals are invalid");
  return errors.length === 0;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

export function isBrowserApprovalPublicKey(value: unknown): value is BrowserApprovalPublicKey {
  return (
    isRecord(value) &&
    exactKeys(value, ["x", "y"], "publicKey").length === 0 &&
    matches(value.x, POINT_COORDINATE) &&
    matches(value.y, POINT_COORDINATE)
  );
}

export function isBrowserApprovalId(value: unknown): value is string {
  return matches(value, APPROVAL_ID);
}

export function isBrowserApprovalRequestId(value: unknown): value is string {
  return matches(value, REQUEST_ID);
}

export function validateBrowserApprovalRequestInput(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalRequestInput> {
  return validateWithAdmission(value, checkBrowserApprovalRequestInput);
}

function checkBrowserApprovalRequestInput(
  value: unknown,
  errors: string[],
): value is BrowserApprovalRequestInput {
  if (!isRecord(value)) {
    errors.push("browser approval request must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["publicKey", "remember"], "browserApprovalRequest"));
  if (!isBrowserApprovalPublicKey(value.publicKey)) errors.push("publicKey is invalid");
  if (typeof value.remember !== "boolean") errors.push("remember is invalid");
  return errors.length === 0;
}

export function validateBrowserApprovalDecisionInput(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalDecisionInput> {
  return validateWithAdmission(value, checkBrowserApprovalDecisionInput);
}

function checkBrowserApprovalDecisionInput(
  value: unknown,
  errors: string[],
): value is BrowserApprovalDecisionInput {
  if (!isRecord(value)) {
    errors.push("browser approval decision must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["requestId", "comparisonCode", "remember"], "browserDecision"));
  if (!isBrowserApprovalRequestId(value.requestId)) errors.push("requestId is invalid");
  if (!matches(value.comparisonCode, /^\d{8}$/u)) errors.push("comparisonCode is invalid");
  if (typeof value.remember !== "boolean") errors.push("remember is invalid");
  return errors.length === 0;
}

export function validateBrowserApprovalChallengeInput(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalChallengeInput> {
  return validateWithAdmission(value, checkBrowserApprovalChallengeInput);
}

function checkBrowserApprovalChallengeInput(
  value: unknown,
  errors: string[],
): value is BrowserApprovalChallengeInput {
  if (!isRecord(value)) {
    errors.push("browser challenge request must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["purpose", "subjectId"], "browserChallengeRequest"));
  const validSubject =
    value.purpose === "complete"
      ? isBrowserApprovalRequestId(value.subjectId)
      : value.purpose === "renew" && isBrowserApprovalId(value.subjectId);
  if (!validSubject) errors.push("challenge purpose or subject is invalid");
  return errors.length === 0;
}

export function validateBrowserApprovalProofInput(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalProofInput> {
  return validateWithAdmission(value, checkBrowserApprovalProofInput);
}

function checkBrowserApprovalProofInput(
  value: unknown,
  errors: string[],
): value is BrowserApprovalProofInput {
  if (!isRecord(value)) {
    errors.push("browser proof must be an object");
    return false;
  }
  errors.push(...exactKeys(value, ["challengeId", "signature"], "browserProof"));
  if (!matches(value.challengeId, CHALLENGE_ID)) errors.push("challengeId is invalid");
  if (!matches(value.signature, SIGNATURE)) errors.push("signature is invalid");
  return errors.length === 0;
}

export function isBrowserApprovalOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128 || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname) &&
    url.origin === value
  );
}

function validChallengeTime(value: Record<string, unknown>): boolean {
  return (
    typeof value.issuedAtMs === "number" &&
    Number.isSafeInteger(value.issuedAtMs) &&
    value.issuedAtMs >= 0 &&
    typeof value.expiresAtMs === "number" &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > value.issuedAtMs &&
    value.expiresAtMs - value.issuedAtMs <= BROWSER_APPROVAL_CHALLENGE_TTL_MS
  );
}

export function validateBrowserApprovalChallenge(
  value: unknown,
): CodingWorkbenchValidationResult<BrowserApprovalChallenge> {
  return validateWithAdmission(value, checkBrowserApprovalChallenge);
}

function checkBrowserApprovalChallenge(
  value: unknown,
  errors: string[],
): value is BrowserApprovalChallenge {
  if (!isRecord(value)) {
    errors.push("browser challenge must be an object");
    return false;
  }
  const keys = [
    "schemaVersion",
    "challengeId",
    "purpose",
    "subjectId",
    "installationId",
    "serverInstanceId",
    "origin",
    "nonce",
    "issuedAtMs",
    "expiresAtMs",
  ];
  errors.push(...exactKeys(value, keys, "browserChallenge"));
  if (value.schemaVersion !== BROWSER_APPROVAL_VERSION) errors.push("schemaVersion is invalid");
  if (!matches(value.challengeId, CHALLENGE_ID)) errors.push("challengeId is invalid");
  if (!matches(value.installationId, /^[a-f0-9]{32}$/u)) errors.push("installationId is invalid");
  if (!matches(value.serverInstanceId, /^[a-f0-9]{32}$/u))
    errors.push("serverInstanceId is invalid");
  if (!matches(value.nonce, POINT_COORDINATE)) errors.push("nonce is invalid");
  if (!isBrowserApprovalOrigin(value.origin)) errors.push("origin is invalid");
  if (!validChallengeTime(value)) errors.push("challenge validity is invalid");
  if (
    !validateBrowserApprovalChallengeInput({ purpose: value.purpose, subjectId: value.subjectId })
      .ok
  )
    errors.push("challenge purpose or subject is invalid");
  return errors.length === 0;
}

/** The browser and server sign exactly these domain-separated UTF-8 bytes. */
export function browserApprovalChallengeText(value: BrowserApprovalChallenge): string {
  return [
    "keiko-browser-approval-v1",
    value.purpose,
    value.installationId,
    value.serverInstanceId,
    value.subjectId,
    value.challengeId,
    value.origin,
    value.nonce,
    String(value.issuedAtMs),
    String(value.expiresAtMs),
    "",
  ].join("\n");
}
