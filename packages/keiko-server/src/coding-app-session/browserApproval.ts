import { createHash, createPublicKey, randomBytes, randomInt, verify } from "node:crypto";
import {
  BROWSER_APPROVAL_CHALLENGE_TTL_MS,
  BROWSER_APPROVAL_MAX_CHALLENGES,
  BROWSER_APPROVAL_MAX_RECORDS,
  BROWSER_APPROVAL_REMEMBER_TTL_MS,
  BROWSER_APPROVAL_REQUEST_TTL_MS,
  BROWSER_APPROVAL_VERSION,
  browserApprovalChallengeText,
  isBrowserApprovalOrigin,
  validateBrowserApprovalChallenge,
  validateBrowserApprovalChallengeInput,
  validateBrowserApprovalDecisionInput,
  validateBrowserApprovalProofInput,
  validateBrowserApprovalRequestInput,
  type BrowserApprovalChallenge,
  type BrowserApprovalChallengeResult,
  type BrowserApprovalDescriptor,
  type BrowserApprovalDecisionInput,
  type BrowserApprovalManagementSnapshot,
  type BrowserApprovalPublicKey,
  type BrowserApprovalRequestDescriptor,
  type BrowserApprovalRequestResult,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import type { BrowserApprovalStore, StoredBrowserApproval } from "../store/browserApprovals.js";
import type { SessionMint, SessionRegistry } from "./sessionRegistry.js";
import { APP_SESSION_COOKIE_MAX_AGE_SECONDS } from "./sessionCookie.js";

interface ApprovedDecision {
  readonly approvalId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly remember: boolean;
}

interface PendingRequest {
  readonly descriptor: BrowserApprovalRequestDescriptor;
  readonly publicKey: BrowserApprovalPublicKey;
  readonly origin: string;
  decision?: ApprovedDecision;
  sessionId?: string;
}

interface ApprovalState {
  readonly registry: SessionRegistry;
  readonly store: BrowserApprovalStore;
  readonly installationId: string;
  readonly serverInstanceId: string;
  readonly requests: Map<string, PendingRequest>;
  readonly challenges: Map<string, BrowserApprovalChallenge>;
  readonly now: () => number;
  lastObservedAtMs: number;
}

export type BrowserApprovalCompletion =
  | { readonly state: "unavailable" }
  | {
      readonly state: "active";
      readonly mint: SessionMint;
      readonly maxAgeSeconds: number;
      readonly approval?: BrowserApprovalDescriptor;
    };

/** Extends the existing app-session owner; no task, mode, or tool authority is granted. */
export interface BrowserApprovalService {
  readonly request: (input: unknown, origin: string) => BrowserApprovalRequestResult;
  readonly snapshot: (cookie: string | undefined) => BrowserApprovalManagementSnapshot | undefined;
  readonly approve: (cookie: string | undefined, input: unknown) => boolean;
  readonly challenge: (input: unknown, origin: string) => BrowserApprovalChallengeResult;
  readonly prove: (input: unknown, origin: string) => BrowserApprovalCompletion;
  readonly revoke: (cookie: string | undefined, approvalId: string) => boolean;
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function fingerprint(key: BrowserApprovalPublicKey): string {
  return createHash("sha256")
    .update(JSON.stringify(["P-256", key.x, key.y]))
    .digest("hex");
}

function publicKey(key: BrowserApprovalPublicKey): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: { kty: "EC", crv: "P-256", ...key }, format: "jwk" });
}

function usableKey(key: BrowserApprovalPublicKey): boolean {
  try {
    publicKey(key);
    return true;
  } catch (error) {
    // Only malformed public points are input refusals. Unexpected crypto failures remain diagnostic.
    if (error instanceof Error && "code" in error && error.code === "ERR_CRYPTO_INVALID_JWK")
      return false;
    throw error;
  }
}

function observedTime(state: ApprovalState): number | undefined {
  const now = state.now();
  if (
    !Number.isSafeInteger(now) ||
    now < state.lastObservedAtMs ||
    now > Number.MAX_SAFE_INTEGER - BROWSER_APPROVAL_REMEMBER_TTL_MS
  )
    return undefined;
  state.registry.expireApprovalsAt(now);
  if (!state.store.observeTime(now)) return undefined;
  state.lastObservedAtMs = now;
  for (const [id, request] of state.requests) {
    if (retireRequest(state, request, now)) state.requests.delete(id);
  }
  for (const [id, challenge] of state.challenges) {
    if (now >= challenge.expiresAtMs) state.challenges.delete(id);
  }
  return now;
}

function retireRequest(state: ApprovalState, request: PendingRequest, now: number): boolean {
  const live =
    request.sessionId !== undefined &&
    state.registry.inspectSession(request.sessionId) !== undefined;
  if (request.sessionId !== undefined && !live) return true;
  if (now < request.descriptor.expiresAtMs) return false;
  return !(request.decision?.remember === false && now < request.decision.expiresAtMs && live);
}

function describeApproval(approval: StoredBrowserApproval): BrowserApprovalDescriptor {
  return {
    approvalId: approval.approvalId,
    remembered: true,
    approvedAtMs: approval.approvedAtMs,
    expiresAtMs: approval.expiresAtMs,
    lastUsedAtMs: approval.lastUsedAtMs,
    publicKeyFingerprint: fingerprint(approval.publicKey),
  };
}

function currentApproval(
  state: ApprovalState,
  approvalId: string,
  now: number,
): StoredBrowserApproval | undefined {
  return state.store
    .list()
    .find(
      (approval) =>
        approval.approvalId === approvalId &&
        approval.lastUsedAtMs <= now &&
        now < approval.expiresAtMs,
    );
}

function newChallenge(
  state: ApprovalState,
  purpose: "complete" | "renew",
  subjectId: string,
  origin: string,
  now: number,
): BrowserApprovalChallenge {
  return {
    schemaVersion: BROWSER_APPROVAL_VERSION,
    challengeId: randomId("bch"),
    purpose,
    subjectId,
    installationId: state.installationId,
    serverInstanceId: state.serverInstanceId,
    origin,
    nonce: randomBytes(32).toString("base64url"),
    issuedAtMs: now,
    expiresAtMs: now + BROWSER_APPROVAL_CHALLENGE_TTL_MS,
  };
}

function requestApproval(
  state: ApprovalState,
  input: unknown,
  origin: string,
): BrowserApprovalRequestResult {
  const parsed = validateBrowserApprovalRequestInput(input);
  const now = observedTime(state);
  if (!parsed.ok || now === undefined || state.requests.size >= BROWSER_APPROVAL_MAX_RECORDS)
    return { state: "unavailable" };
  const requestId = randomId("brq");
  if (!isBrowserApprovalOrigin(origin) || !usableKey(parsed.value.publicKey))
    return { state: "unavailable" };
  const descriptor: BrowserApprovalRequestDescriptor = {
    requestId,
    comparisonCode: String(randomInt(100_000_000)).padStart(8, "0"),
    requestedAtMs: now,
    expiresAtMs: now + BROWSER_APPROVAL_REQUEST_TTL_MS,
    rememberRequested: parsed.value.remember,
    publicKeyFingerprint: fingerprint(parsed.value.publicKey),
  };
  state.requests.set(requestId, {
    descriptor,
    publicKey: { ...parsed.value.publicKey },
    origin,
  });
  return { state: "pending", request: descriptor };
}

function requestForDecision(
  state: ApprovalState,
  input: BrowserApprovalDecisionInput,
): PendingRequest | undefined {
  const request = state.requests.get(input.requestId);
  if (
    request === undefined ||
    request.decision !== undefined ||
    request.descriptor.comparisonCode !== input.comparisonCode ||
    (input.remember && !request.descriptor.rememberRequested)
  )
    return undefined;
  return request;
}

function approveRequest(state: ApprovalState, cookie: string | undefined, input: unknown): boolean {
  if (state.registry.verify(cookie) === undefined) return false;
  const parsed = validateBrowserApprovalDecisionInput(input);
  const now = observedTime(state);
  if (!parsed.ok || now === undefined) return false;
  const request = requestForDecision(state, parsed.value);
  if (request === undefined) return false;
  const decision: ApprovedDecision = {
    approvalId: randomId("bra"),
    approvedAtMs: now,
    expiresAtMs:
      now +
      (parsed.value.remember
        ? BROWSER_APPROVAL_REMEMBER_TTL_MS
        : APP_SESSION_COOKIE_MAX_AGE_SECONDS * 1_000),
    remember: parsed.value.remember,
  };
  if (
    decision.remember &&
    !state.store.insert({
      ...decision,
      publicKey: request.publicKey,
      origin: request.origin,
      lastUsedAtMs: now,
    })
  )
    return false;
  request.decision = decision;
  return true;
}

function completionReadiness(
  state: ApprovalState,
  subjectId: string,
  origin: string,
  now: number,
): "ready" | "pending" | "unavailable" {
  const request = state.requests.get(subjectId);
  if (request?.origin !== origin || now >= request.descriptor.expiresAtMs) return "unavailable";
  return request.decision === undefined ? "pending" : "ready";
}

function issueChallenge(
  state: ApprovalState,
  input: unknown,
  origin: string,
): BrowserApprovalChallengeResult {
  const parsed = validateBrowserApprovalChallengeInput(input);
  const now = observedTime(state);
  if (!parsed.ok || now === undefined) return { state: "unavailable" };
  if (parsed.value.purpose === "complete") {
    const readiness = completionReadiness(state, parsed.value.subjectId, origin, now);
    if (readiness !== "ready") return { state: readiness };
  } else if (currentApproval(state, parsed.value.subjectId, now)?.origin !== origin) {
    return { state: "unavailable" };
  }
  const challenge = newChallenge(state, parsed.value.purpose, parsed.value.subjectId, origin, now);
  if (!validateBrowserApprovalChallenge(challenge).ok) return { state: "unavailable" };
  retirePreviousChallenges(state, challenge);
  if (state.challenges.size >= BROWSER_APPROVAL_MAX_CHALLENGES) return { state: "unavailable" };
  state.challenges.set(challenge.challengeId, challenge);
  return { state: "challenge", challenge };
}

function retirePreviousChallenges(state: ApprovalState, challenge: BrowserApprovalChallenge): void {
  for (const [id, previous] of state.challenges) {
    if (previous.subjectId === challenge.subjectId && previous.purpose === challenge.purpose)
      state.challenges.delete(id);
  }
}

function verifyProof(
  key: BrowserApprovalPublicKey,
  challenge: BrowserApprovalChallenge,
  signature: string,
): boolean {
  return verify(
    "sha256",
    Buffer.from(browserApprovalChallengeText(challenge)),
    { key: publicKey(key), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

function finishRequest(
  state: ApprovalState,
  request: PendingRequest,
  decision: ApprovedDecision,
  now: number,
): BrowserApprovalCompletion {
  const approval = decision.remember ? currentApproval(state, decision.approvalId, now) : undefined;
  if (decision.remember && approval === undefined) return { state: "unavailable" };
  if (approval !== undefined && !state.store.touch(approval.approvalId, now))
    return { state: "unavailable" };
  const mint =
    request.sessionId === undefined
      ? state.registry.mintForApproval("Approved browser", decision)
      : state.registry.rotate(request.sessionId);
  if (mint === undefined) return { state: "unavailable" };
  request.sessionId = mint.session.sessionId;
  const touched = approval === undefined ? undefined : { ...approval, lastUsedAtMs: now };
  return completion(state, mint, touched);
}

function completeRequest(
  state: ApprovalState,
  challenge: BrowserApprovalChallenge,
  signature: string,
  now: number,
): BrowserApprovalCompletion {
  const request = state.requests.get(challenge.subjectId);
  const decision = request?.decision;
  if (
    request === undefined ||
    decision === undefined ||
    now >= decision.expiresAtMs ||
    now >= request.descriptor.expiresAtMs
  )
    return { state: "unavailable" };
  if (!verifyProof(request.publicKey, challenge, signature)) return { state: "unavailable" };
  return finishRequest(state, request, decision, now);
}

function completion(
  state: ApprovalState,
  mint: SessionMint,
  approval: StoredBrowserApproval | undefined,
): BrowserApprovalCompletion {
  const remaining = state.registry.verifyForCookieRepair(mint.cookieToken);
  if (remaining === undefined || remaining < 1_000) {
    state.registry.revoke(mint.session.sessionId);
    return { state: "unavailable" };
  }
  return {
    state: "active",
    mint,
    maxAgeSeconds: Math.floor(remaining / 1_000),
    ...(approval === undefined ? {} : { approval: describeApproval(approval) }),
  };
}

function renewApproval(
  state: ApprovalState,
  challenge: BrowserApprovalChallenge,
  signature: string,
  now: number,
): BrowserApprovalCompletion {
  const approval = currentApproval(state, challenge.subjectId, now);
  if (
    approval?.origin !== challenge.origin ||
    !verifyProof(approval.publicKey, challenge, signature)
  )
    return { state: "unavailable" };
  if (!state.store.touch(approval.approvalId, now)) return { state: "unavailable" };
  return completion(state, state.registry.mintForApproval("Remembered browser", approval), {
    ...approval,
    lastUsedAtMs: now,
  });
}

function proveApproval(
  state: ApprovalState,
  input: unknown,
  origin: string,
): BrowserApprovalCompletion {
  const parsed = validateBrowserApprovalProofInput(input);
  const now = observedTime(state);
  if (!parsed.ok || now === undefined) return { state: "unavailable" };
  const challenge = state.challenges.get(parsed.value.challengeId);
  state.challenges.delete(parsed.value.challengeId);
  if (challenge?.origin !== origin || now < challenge.issuedAtMs) return { state: "unavailable" };
  return challenge.purpose === "complete"
    ? completeRequest(state, challenge, parsed.value.signature, now)
    : renewApproval(state, challenge, parsed.value.signature, now);
}

function managementSnapshot(
  state: ApprovalState,
  cookie: string | undefined,
): BrowserApprovalManagementSnapshot | undefined {
  if (state.registry.inspect(cookie) === undefined || observedTime(state) === undefined)
    return undefined;
  return {
    requests: [...state.requests.values()]
      .filter((request) => request.decision === undefined)
      .map((request) => ({ ...request.descriptor })),
    approvals: [...state.store.list().map(describeApproval), ...sessionApprovalDescriptors(state)],
  };
}

function sessionApprovalDescriptors(state: ApprovalState): readonly BrowserApprovalDescriptor[] {
  const approvals: BrowserApprovalDescriptor[] = [];
  for (const request of state.requests.values()) {
    const decision = request.decision;
    if (decision?.remember !== false) continue;
    const session =
      request.sessionId === undefined
        ? undefined
        : state.registry.inspectSession(request.sessionId);
    if (request.sessionId !== undefined && session === undefined) continue;
    approvals.push({
      approvalId: decision.approvalId,
      remembered: false,
      approvedAtMs: decision.approvedAtMs,
      expiresAtMs: decision.expiresAtMs,
      lastUsedAtMs: session?.lastSeenAtMs ?? decision.approvedAtMs,
      publicKeyFingerprint: request.descriptor.publicKeyFingerprint,
    });
  }
  return approvals;
}

function revokeApproval(state: ApprovalState, cookie: string | undefined, id: string): boolean {
  if (state.registry.verify(cookie) === undefined || observedTime(state) === undefined)
    return false;
  const removed = state.store.remove(id);
  const revokedSessions = state.registry.revokeApproval(id);
  const revokedSubjects = new Set([id]);
  for (const [requestId, request] of state.requests) {
    if (request.decision?.approvalId !== id) continue;
    state.requests.delete(requestId);
    revokedSubjects.add(requestId);
  }
  for (const [challengeId, challenge] of state.challenges) {
    if (revokedSubjects.has(challenge.subjectId)) state.challenges.delete(challengeId);
  }
  return removed || revokedSessions > 0 || revokedSubjects.size > 1;
}

export function createBrowserApprovalService(deps: {
  readonly registry: SessionRegistry;
  readonly store: BrowserApprovalStore;
  readonly now?: () => number;
}): BrowserApprovalService {
  const state: ApprovalState = {
    ...deps,
    now: deps.now ?? Date.now,
    lastObservedAtMs: 0,
    installationId: deps.store.installationId(),
    serverInstanceId: randomBytes(16).toString("hex"),
    requests: new Map(),
    challenges: new Map(),
  };
  return {
    request: (input, origin): BrowserApprovalRequestResult => requestApproval(state, input, origin),
    snapshot: (cookie): BrowserApprovalManagementSnapshot | undefined =>
      managementSnapshot(state, cookie),
    approve: (cookie, input): boolean => approveRequest(state, cookie, input),
    challenge: (input, origin): BrowserApprovalChallengeResult =>
      issueChallenge(state, input, origin),
    prove: (input, origin): BrowserApprovalCompletion => proveApproval(state, input, origin),
    revoke: (cookie, id): boolean => revokeApproval(state, cookie, id),
  };
}
