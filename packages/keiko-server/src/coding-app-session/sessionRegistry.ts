// Process-memory registry for authenticated app sessions (ADR-0141 D4, D5).
//
// The registry holds no durable bearer material, so a server restart invalidates every prior session
// by construction (restart expiry). It stores only a salted hash of each session secret, never the
// secret; verification is constant-time. Sessions additionally fail closed on rotation, explicit
// revocation, inactivity, and an absolute lifetime bound. The bearer (the cookie value) is
// `<sessionId>.<secret>`; only the browser holds it, and it never appears in any diagnostic here.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { isBrowserApprovalId } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 32;
const SESSION_ID_PATTERN = /^sess_[a-f0-9]{24}$/u;

/** The non-secret descriptor a valid session exposes to callers. Carries no bearer material. */
export interface AppSession {
  readonly sessionId: string;
  readonly principalLabel: string;
  readonly issuedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly rotationCount: number;
}

/** The result of issuing or rotating a session: the descriptor plus the cookie value to set. */
export interface SessionMint {
  readonly session: AppSession;
  readonly cookieToken: string;
  readonly capacityDecision?: {
    readonly expiredSessionCount: number;
    readonly evictedSessionClass: "none" | "inactive" | "active";
  };
}

export interface SessionRegistry {
  readonly mint: (principalLabel: string) => SessionMint;
  readonly mintForApproval: (
    principalLabel: string,
    approval: SessionApprovalBinding,
  ) => SessionMint;
  readonly verify: (cookieToken: string | undefined) => AppSession | undefined;
  /** Non-touching validity check for persistent server streams; never refreshes idle expiry. */
  readonly inspect: (cookieToken: string | undefined) => AppSession | undefined;
  /** Confirm existing authority and return its remaining absolute cookie lifetime. */
  readonly verifyForCookieRepair: (cookieToken: string | undefined) => number | undefined;
  /** Non-touching count for body-free operation lifecycle evidence. */
  readonly inspectOperationCount: (cookieToken: string | undefined) => number | undefined;
  /** Protect a valid session from idle expiry only while an explicit operation remains active. */
  readonly beginOperation: (cookieToken: string | undefined) => (() => void) | undefined;
  readonly rotate: (sessionId: string) => SessionMint | undefined;
  readonly revoke: (sessionId: string) => void;
  readonly revokeApproval: (approvalId: string) => number;
  /** Share an expiry observed by the browser-approval owner with every associated live session. */
  readonly expireApprovalsAt: (observedAtMs: number) => number;
  readonly sessionCount: () => number;
}

/** Browser identity approval caps session validity; it grants no task or autonomy authority. */
export interface SessionApprovalBinding {
  readonly approvalId: string;
  readonly expiresAtMs: number;
}

export interface SessionRegistryDeps {
  readonly activityLog?: ServerLogSink | undefined;
  /** Persist a positively observed grant expiry through the existing private approval owner. */
  readonly observeApprovalExpiry?: ((observedAtMs: number) => void) | undefined;
  readonly now?: () => number;
  readonly idleTtlMs?: number;
  readonly absoluteTtlMs?: number;
  readonly maxSessions?: number;
  /** Test seams: deterministic id/secret generation. Production uses CSPRNG bytes. */
  readonly mintSessionId?: () => string;
  readonly mintSecret?: () => string;
}

interface StoredSession {
  readonly sessionId: string;
  readonly secretHash: Buffer;
  readonly principalLabel: string;
  readonly issuedAtMs: number;
  lastSeenAtMs: number;
  activeOperationCount: number;
  readonly rotationCount: number;
  readonly approval?: SessionApprovalBinding;
}

interface SessionIssue {
  readonly sessionId: string;
  readonly principalLabel: string;
  readonly rotationCount: number;
  readonly issuedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly approval?: SessionApprovalBinding;
}

interface RegistryState {
  readonly activityLog?: ServerLogSink | undefined;
  readonly observeApprovalExpiry?: ((observedAtMs: number) => void) | undefined;
  readonly sessions: Map<string, StoredSession>;
  readonly now: () => number;
  readonly idleTtlMs: number;
  readonly absoluteTtlMs: number;
  readonly maxSessions: number;
  /** Per-registry random salt (HMAC key) so stored digests are salted, never bare `sha256`. */
  readonly salt: string;
  readonly mintSessionId: () => string;
  readonly mintSecret: () => string;
}

const EXPIRY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-app-session.expired",
  category: "http",
  owner: "keiko-server",
  emitter: "coding-app-session.sessionRegistry.recordObservedExpiry",
  fields: {
    expiredSessionCount: { type: "integer", dataClass: "count", required: true },
    sessionCount: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["approval", "lifetime", "inactivity", "invalid-clock"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-app-session-pairing"],
  proofIds: ["coding-app-session.expired.observation"],
  releaseImpact: "patch",
});

type ExpiryReason = "approval" | "lifetime" | "inactivity" | "invalid-clock";

function recordObservedExpiry(
  state: RegistryState,
  expiredSessionCount: number,
  reason: ExpiryReason,
): void {
  if (expiredSessionCount === 0 || state.activityLog === undefined) return;
  state.activityLog.write(
    activityLogEvent(
      EXPIRY_OPERATION,
      { level: "info", correlationId: UNKNOWN_CORRELATION_ID },
      { expiredSessionCount, sessionCount: state.sessions.size, reason },
    ),
  );
}

/** Salted hash of a session secret: HMAC-SHA256 keyed by the per-registry salt (ADR-0141 D4). */
function saltedHash(salt: string, secret: string): Buffer {
  return createHmac("sha256", salt).update(secret, "utf8").digest();
}

function defaultSessionId(): string {
  return `sess_${randomBytes(12).toString("hex")}`;
}

function defaultSecret(): string {
  return randomBytes(32).toString("base64url");
}

function parseCookieToken(
  cookieToken: string,
): { readonly sessionId: string; readonly secret: string } | undefined {
  const separator = cookieToken.indexOf(".");
  if (separator <= 0) return undefined;
  const sessionId = cookieToken.slice(0, separator);
  const secret = cookieToken.slice(separator + 1);
  if (!SESSION_ID_PATTERN.test(sessionId) || secret.length === 0) return undefined;
  return { sessionId, secret };
}

function describe(stored: StoredSession): AppSession {
  return {
    sessionId: stored.sessionId,
    principalLabel: stored.principalLabel,
    issuedAtMs: stored.issuedAtMs,
    lastSeenAtMs: stored.lastSeenAtMs,
    rotationCount: stored.rotationCount,
  };
}

function isExpired(state: RegistryState, stored: StoredSession, nowMs: number): boolean {
  return (
    approvalExpired(stored, nowMs) ||
    nowMs - stored.issuedAtMs >= state.absoluteTtlMs ||
    (stored.activeOperationCount === 0 && nowMs - stored.lastSeenAtMs >= state.idleTtlMs)
  );
}

function approvalExpired(stored: StoredSession, nowMs: number): boolean {
  return (
    stored.approval !== undefined &&
    (!Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      nowMs < stored.lastSeenAtMs ||
      nowMs >= stored.approval.expiresAtMs)
  );
}

function expireStoredSession(state: RegistryState, stored: StoredSession, nowMs: number): number {
  if (
    Number.isSafeInteger(nowMs) &&
    stored.approval !== undefined &&
    nowMs >= stored.approval.expiresAtMs
  )
    return expireApprovalSessions(state, nowMs);
  const expired = state.sessions.delete(stored.sessionId) ? 1 : 0;
  recordObservedExpiry(state, expired, expiryReason(state, stored, nowMs));
  return expired;
}

function expiryReason(state: RegistryState, stored: StoredSession, nowMs: number): ExpiryReason {
  if (approvalExpired(stored, nowMs)) return "invalid-clock";
  return nowMs - stored.issuedAtMs >= state.absoluteTtlMs ? "lifetime" : "inactivity";
}

function sweepExpiredSessions(state: RegistryState): number {
  let expiredSessionCount = 0;
  const nowMs = state.now();
  for (const stored of state.sessions.values()) {
    if (isExpired(state, stored, nowMs)) {
      expiredSessionCount += expireStoredSession(state, stored, nowMs);
    }
  }
  return expiredSessionCount;
}

function evictOldestIfFull(state: RegistryState): NonNullable<SessionMint["capacityDecision"]> {
  if (state.sessions.size < state.maxSessions)
    return { expiredSessionCount: 0, evictedSessionClass: "none" };
  const expiredSessionCount = sweepExpiredSessions(state);
  if (state.sessions.size < state.maxSessions)
    return { expiredSessionCount, evictedSessionClass: "none" };
  const candidates = [...state.sessions.values()];
  const inactive = candidates.filter((stored) => stored.activeOperationCount === 0);
  let oldest: StoredSession | undefined;
  for (const stored of inactive.length > 0 ? inactive : candidates) {
    if (oldest === undefined || stored.lastSeenAtMs < oldest.lastSeenAtMs) oldest = stored;
  }
  if (oldest !== undefined) state.sessions.delete(oldest.sessionId);
  return { expiredSessionCount, evictedSessionClass: inactive.length > 0 ? "inactive" : "active" };
}

function storeSession(state: RegistryState, issue: SessionIssue): SessionMint {
  const secret = state.mintSecret();
  const stored: StoredSession = {
    ...issue,
    secretHash: saltedHash(state.salt, secret),
    activeOperationCount: 0,
    ...(issue.approval === undefined ? {} : { approval: { ...issue.approval } }),
  };
  state.sessions.set(issue.sessionId, stored);
  return { session: describe(stored), cookieToken: `${issue.sessionId}.${secret}` };
}

function mintSession(
  state: RegistryState,
  principalLabel: string,
  approval?: SessionApprovalBinding,
): SessionMint {
  const issuedAtMs = state.now();
  assertApprovalBinding(approval, issuedAtMs);
  const capacityDecision = evictOldestIfFull(state);
  return {
    ...storeSession(state, {
      sessionId: state.mintSessionId(),
      principalLabel,
      rotationCount: 0,
      issuedAtMs,
      lastSeenAtMs: issuedAtMs,
      ...(approval === undefined ? {} : { approval }),
    }),
    capacityDecision,
  };
}

function assertApprovalBinding(approval: SessionApprovalBinding | undefined, nowMs: number): void {
  if (approval === undefined) return;
  if (
    !isBrowserApprovalId(approval.approvalId) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(approval.expiresAtMs) ||
    approval.expiresAtMs <= nowMs
  ) {
    throw new TypeError("Invalid browser approval session binding");
  }
}

function verifySession(
  state: RegistryState,
  cookieToken: string | undefined,
  touch: boolean,
): AppSession | undefined {
  if (cookieToken === undefined) return undefined;
  const parsed = parseCookieToken(cookieToken);
  if (parsed === undefined) return undefined;
  const stored = state.sessions.get(parsed.sessionId);
  if (stored === undefined) return undefined;
  const nowMs = state.now();
  if (isExpired(state, stored, nowMs)) {
    expireStoredSession(state, stored, nowMs);
    return undefined;
  }
  if (!timingSafeEqual(saltedHash(state.salt, parsed.secret), stored.secretHash)) return undefined;
  if (touch) stored.lastSeenAtMs = nowMs;
  return describe(stored);
}

function verifyForCookieRepair(
  state: RegistryState,
  cookieToken: string | undefined,
): number | undefined {
  const verified = verifySession(state, cookieToken, true);
  if (verified === undefined) return undefined;
  const nowMs = state.now();
  const stored = state.sessions.get(verified.sessionId);
  if (stored === undefined) return undefined;
  if (isExpired(state, stored, nowMs)) {
    expireStoredSession(state, stored, nowMs);
    return undefined;
  }
  const remaining = state.absoluteTtlMs - (nowMs - verified.issuedAtMs);
  const approval = stored.approval;
  return Math.max(
    0,
    Math.min(remaining, approval === undefined ? remaining : approval.expiresAtMs - nowMs),
  );
}

function rotateSession(state: RegistryState, sessionId: string): SessionMint | undefined {
  const stored = state.sessions.get(sessionId);
  if (stored === undefined) return undefined;
  const nowMs = state.now();
  if (isExpired(state, stored, nowMs)) {
    expireStoredSession(state, stored, nowMs);
    return undefined;
  }
  state.sessions.delete(sessionId);
  return storeSession(state, {
    sessionId,
    principalLabel: stored.principalLabel,
    rotationCount: stored.rotationCount + 1,
    issuedAtMs: stored.issuedAtMs,
    lastSeenAtMs: nowMs,
    ...(stored.approval === undefined ? {} : { approval: stored.approval }),
  });
}

function beginSessionOperation(
  state: RegistryState,
  cookieToken: string | undefined,
): (() => void) | undefined {
  const session = verifySession(state, cookieToken, true);
  if (session === undefined) return undefined;
  const stored = state.sessions.get(session.sessionId);
  if (stored === undefined) return undefined;
  stored.activeOperationCount += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    stored.activeOperationCount -= 1;
    const nowMs = state.now();
    if (state.sessions.get(stored.sessionId) !== stored) return;
    if (approvalExpired(stored, nowMs) || nowMs - stored.issuedAtMs >= state.absoluteTtlMs) {
      expireStoredSession(state, stored, nowMs);
      return;
    }
    stored.lastSeenAtMs = nowMs;
  };
}

export function createSessionRegistry(deps: SessionRegistryDeps = {}): SessionRegistry {
  const state: RegistryState = {
    sessions: new Map<string, StoredSession>(),
    activityLog: deps.activityLog,
    observeApprovalExpiry: deps.observeApprovalExpiry,
    now: deps.now ?? Date.now,
    idleTtlMs: deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
    absoluteTtlMs: deps.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS,
    maxSessions: deps.maxSessions ?? DEFAULT_MAX_SESSIONS,
    salt: randomBytes(32).toString("hex"),
    mintSessionId: deps.mintSessionId ?? defaultSessionId,
    mintSecret: deps.mintSecret ?? defaultSecret,
  };
  return {
    mint: (principalLabel: string): SessionMint => mintSession(state, principalLabel),
    mintForApproval: (principalLabel, approval): SessionMint =>
      mintSession(state, principalLabel, approval),
    verify: (cookieToken: string | undefined): AppSession | undefined =>
      verifySession(state, cookieToken, true),
    inspect: (cookieToken: string | undefined): AppSession | undefined =>
      verifySession(state, cookieToken, false),
    inspectOperationCount: (cookieToken: string | undefined): number | undefined => {
      const session = verifySession(state, cookieToken, false);
      return session === undefined
        ? undefined
        : state.sessions.get(session.sessionId)?.activeOperationCount;
    },
    verifyForCookieRepair: (cookieToken: string | undefined): number | undefined =>
      verifyForCookieRepair(state, cookieToken),
    beginOperation: (cookieToken: string | undefined): (() => void) | undefined =>
      beginSessionOperation(state, cookieToken),
    rotate: (sessionId: string): SessionMint | undefined => rotateSession(state, sessionId),
    revoke: (sessionId: string): void => {
      state.sessions.delete(sessionId);
    },
    revokeApproval: (approvalId: string): number => revokeApprovalSessions(state, approvalId),
    expireApprovalsAt: (observedAtMs: number): number =>
      expireApprovalSessions(state, observedAtMs),
    sessionCount: (): number => state.sessions.size,
  };
}

function expireApprovalSessions(state: RegistryState, observedAtMs: number): number {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    throw new TypeError("Invalid browser approval expiry observation");
  let expired = 0;
  for (const session of state.sessions.values()) {
    if (session.approval === undefined || observedAtMs < session.approval.expiresAtMs) continue;
    state.sessions.delete(session.sessionId);
    expired += 1;
  }
  recordObservedExpiry(state, expired, "approval");
  if (expired > 0) state.observeApprovalExpiry?.(observedAtMs);
  return expired;
}

function revokeApprovalSessions(state: RegistryState, approvalId: string): number {
  let revoked = 0;
  for (const session of state.sessions.values()) {
    if (session.approval?.approvalId !== approvalId) continue;
    state.sessions.delete(session.sessionId);
    revoked += 1;
  }
  return revoked;
}
