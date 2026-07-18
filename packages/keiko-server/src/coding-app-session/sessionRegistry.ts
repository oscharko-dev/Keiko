// Process-memory registry for authenticated app sessions (ADR-0141 D4, D5).
//
// The registry holds no durable bearer material, so a server restart invalidates every prior session
// by construction (restart expiry). It stores only a salted hash of each session secret, never the
// secret; verification is constant-time. Sessions additionally fail closed on rotation, explicit
// revocation, inactivity, and an absolute lifetime bound. The bearer (the cookie value) is
// `<sessionId>.<secret>`; only the browser holds it, and it never appears in any diagnostic here.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
}

export interface SessionRegistry {
  readonly mint: (principalLabel: string) => SessionMint;
  readonly verify: (cookieToken: string | undefined) => AppSession | undefined;
  /** Non-touching validity check for persistent server streams; never refreshes idle expiry. */
  readonly inspect: (cookieToken: string | undefined) => AppSession | undefined;
  readonly rotate: (sessionId: string) => SessionMint | undefined;
  readonly revoke: (sessionId: string) => void;
  readonly sessionCount: () => number;
}

export interface SessionRegistryDeps {
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
  readonly rotationCount: number;
}

interface RegistryState {
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
    nowMs - stored.issuedAtMs > state.absoluteTtlMs || nowMs - stored.lastSeenAtMs > state.idleTtlMs
  );
}

function evictOldestIfFull(state: RegistryState): void {
  if (state.sessions.size < state.maxSessions) return;
  let oldest: StoredSession | undefined;
  for (const stored of state.sessions.values()) {
    if (oldest === undefined || stored.lastSeenAtMs < oldest.lastSeenAtMs) oldest = stored;
  }
  if (oldest !== undefined) state.sessions.delete(oldest.sessionId);
}

function storeSession(
  state: RegistryState,
  sessionId: string,
  principalLabel: string,
  rotationCount: number,
): SessionMint {
  const secret = state.mintSecret();
  const nowMs = state.now();
  const stored: StoredSession = {
    sessionId,
    secretHash: saltedHash(state.salt, secret),
    principalLabel,
    issuedAtMs: nowMs,
    lastSeenAtMs: nowMs,
    rotationCount,
  };
  state.sessions.set(sessionId, stored);
  return { session: describe(stored), cookieToken: `${sessionId}.${secret}` };
}

function mintSession(state: RegistryState, principalLabel: string): SessionMint {
  evictOldestIfFull(state);
  return storeSession(state, state.mintSessionId(), principalLabel, 0);
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
    state.sessions.delete(stored.sessionId);
    return undefined;
  }
  if (!timingSafeEqual(saltedHash(state.salt, parsed.secret), stored.secretHash)) return undefined;
  if (touch) stored.lastSeenAtMs = nowMs;
  return describe(stored);
}

function rotateSession(state: RegistryState, sessionId: string): SessionMint | undefined {
  const stored = state.sessions.get(sessionId);
  if (stored === undefined) return undefined;
  state.sessions.delete(sessionId);
  return storeSession(state, sessionId, stored.principalLabel, stored.rotationCount + 1);
}

export function createSessionRegistry(deps: SessionRegistryDeps = {}): SessionRegistry {
  const state: RegistryState = {
    sessions: new Map<string, StoredSession>(),
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
    verify: (cookieToken: string | undefined): AppSession | undefined =>
      verifySession(state, cookieToken, true),
    inspect: (cookieToken: string | undefined): AppSession | undefined =>
      verifySession(state, cookieToken, false),
    rotate: (sessionId: string): SessionMint | undefined => rotateSession(state, sessionId),
    revoke: (sessionId: string): void => {
      state.sessions.delete(sessionId);
    },
    sessionCount: (): number => state.sessions.size,
  };
}
