import { createHash, randomBytes } from "node:crypto";

export const DEBUG_BROWSER_COOKIE_NAME = "keiko_debug_capability";
export const DEBUG_BROWSER_PROFILE_COOKIE_NAME = "keiko_debug_profile";
export const DEBUG_BROWSER_COOKIE_PATH = "/api/editor/debug";
export const DEBUG_BROWSER_SESSION_TTL_MS = 60 * 60 * 1_000;
export const DEBUG_BROWSER_SESSION_CAP = 64;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type DebugBrowserAuthorizationFailure =
  "missing" | "malformed" | "expired" | "workspace_mismatch" | "profile_mismatch";

export type DebugBrowserAuthorization =
  | { readonly ok: true; readonly browserSessionBinding: string }
  | { readonly ok: false; readonly reason: DebugBrowserAuthorizationFailure };

type DebugBrowserSessionIssueResult =
  | { readonly ok: true; readonly setCookies: readonly string[] }
  | { readonly ok: false; readonly reason: "capacity" };

type DebugBrowserSessionEnsureResult =
  | {
      readonly ok: true;
      readonly browserSessionBinding: string;
      readonly setCookies: readonly string[];
    }
  | { readonly ok: false; readonly reason: "capacity" };

type DebugBrowserCookieHeader = string | readonly string[] | undefined;

export interface DebugBrowserSessionRegistry {
  issue(
    workspacePartitionKey: string,
    cookieHeader?: DebugBrowserCookieHeader,
  ): DebugBrowserSessionIssueResult;
  ensure(
    workspacePartitionKey: string,
    cookieHeader?: DebugBrowserCookieHeader,
  ): DebugBrowserSessionEnsureResult;
  authorize(
    cookieHeader: DebugBrowserCookieHeader,
    workspacePartitionKey: string,
  ): DebugBrowserAuthorization;
}

export interface DebugBrowserSessionRegistryOptions {
  readonly now: () => number;
  readonly token?: (() => Buffer) | undefined;
  readonly ttlMs?: number | undefined;
  readonly capacity?: number | undefined;
}

interface BrowserSessionRecord {
  readonly workspacePartitionKey: string;
  readonly profileBinding: string;
  readonly expiresAtMs: number;
}

interface BrowserProfileRecord {
  readonly expiresAtMs: number;
}

type BrowserSessionIssueInternalResult =
  | {
      readonly ok: true;
      readonly browserSessionBinding: string;
      readonly setCookies: readonly string[];
    }
  | { readonly ok: false; readonly reason: "capacity" };

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cookieValue(header: DebugBrowserCookieHeader, name: string): string | undefined {
  const joined = typeof header === "string" ? header : header?.join(";");
  if (joined === undefined) return undefined;
  const matches = joined
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.slice(name.length + 1);
  return value !== undefined && TOKEN_PATTERN.test(value) ? value : undefined;
}

function setCookie(name: string, token: string, ttlMs: number): string {
  const maxAgeSeconds = Math.floor(ttlMs / 1_000);
  return `${name}=${token}; Path=${DEBUG_BROWSER_COOKIE_PATH}; Max-Age=${String(
    maxAgeSeconds,
  )}; HttpOnly; SameSite=Strict`;
}

function removeExpired<T extends { readonly expiresAtMs: number }>(
  records: Map<string, T>,
  now: number,
): void {
  for (const [binding, record] of records) {
    if (record.expiresAtMs <= now) records.delete(binding);
  }
}

function issueToken(factory: () => Buffer): string | undefined {
  const bytes = factory();
  if (bytes.length !== TOKEN_BYTES) return undefined;
  const token = bytes.toString("base64url");
  return TOKEN_PATTERN.test(token) ? token : undefined;
}

interface BrowserRegistryRuntime {
  readonly records: Map<string, BrowserSessionRecord>;
  readonly profiles: Map<string, BrowserProfileRecord>;
  readonly now: () => number;
  readonly tokenFactory: () => Buffer;
  readonly ttlMs: number;
  readonly capacity: number;
}

function issueProfile(
  runtime: BrowserRegistryRuntime,
  now: number,
): { readonly binding: string; readonly cookie: string } | undefined {
  if (runtime.profiles.size >= runtime.capacity) return undefined;
  const token = issueToken(runtime.tokenFactory);
  if (token === undefined) return undefined;
  const binding = digest(token);
  runtime.profiles.set(binding, { expiresAtMs: now + runtime.ttlMs });
  return {
    binding,
    cookie: setCookie(DEBUG_BROWSER_PROFILE_COOKIE_NAME, token, runtime.ttlMs),
  };
}

function existingProfile(
  runtime: BrowserRegistryRuntime,
  header: DebugBrowserCookieHeader,
  now: number,
): string | undefined {
  const token = cookieValue(header, DEBUG_BROWSER_PROFILE_COOKIE_NAME);
  if (token === undefined) return undefined;
  const binding = digest(token);
  const profile = runtime.profiles.get(binding);
  return profile !== undefined && profile.expiresAtMs > now ? binding : undefined;
}

function issueBrowserSession(
  runtime: BrowserRegistryRuntime,
  workspacePartitionKey: string,
  header: DebugBrowserCookieHeader,
): BrowserSessionIssueInternalResult {
  const now = runtime.now();
  removeExpired(runtime.records, now);
  removeExpired(runtime.profiles, now);
  if (runtime.records.size >= runtime.capacity) return { ok: false, reason: "capacity" };
  const currentProfile = existingProfile(runtime, header, now);
  const issuedProfile = currentProfile === undefined ? issueProfile(runtime, now) : undefined;
  const profileBinding = currentProfile ?? issuedProfile?.binding;
  if (profileBinding === undefined) return { ok: false, reason: "capacity" };
  const token = issueToken(runtime.tokenFactory);
  if (token === undefined) return { ok: false, reason: "capacity" };
  const browserSessionBinding = digest(token);
  runtime.records.set(browserSessionBinding, {
    workspacePartitionKey,
    profileBinding,
    expiresAtMs: now + runtime.ttlMs,
  });
  return {
    ok: true,
    browserSessionBinding,
    setCookies: [
      ...(issuedProfile?.cookie === undefined ? [] : [issuedProfile.cookie]),
      setCookie(DEBUG_BROWSER_COOKIE_NAME, token, runtime.ttlMs),
    ],
  };
}

function ensureBrowserSession(
  runtime: BrowserRegistryRuntime,
  workspacePartitionKey: string,
  header: DebugBrowserCookieHeader,
): DebugBrowserSessionEnsureResult {
  const authorized = authorizeBrowserSession(runtime, header, workspacePartitionKey);
  if (authorized.ok) return { ...authorized, setCookies: [] };
  return issueBrowserSession(runtime, workspacePartitionKey, header);
}

function authorizationExpired(
  record: BrowserSessionRecord,
  profile: BrowserProfileRecord | undefined,
  now: number,
): boolean {
  return record.expiresAtMs <= now || profile === undefined || profile.expiresAtMs <= now;
}

function authorizeBrowserSession(
  runtime: BrowserRegistryRuntime,
  header: DebugBrowserCookieHeader,
  workspacePartitionKey: string,
): DebugBrowserAuthorization {
  const token = cookieValue(header, DEBUG_BROWSER_COOKIE_NAME);
  const profileToken = cookieValue(header, DEBUG_BROWSER_PROFILE_COOKIE_NAME);
  if (token === undefined || profileToken === undefined)
    return { ok: false, reason: header === undefined ? "missing" : "malformed" };
  const binding = digest(token);
  const profileBinding = digest(profileToken);
  const record = runtime.records.get(binding);
  if (record === undefined) return { ok: false, reason: "malformed" };
  const profile = runtime.profiles.get(profileBinding);
  if (authorizationExpired(record, profile, runtime.now())) {
    runtime.records.delete(binding);
    runtime.profiles.delete(profileBinding);
    return { ok: false, reason: "expired" };
  }
  if (record.profileBinding !== profileBinding) return { ok: false, reason: "profile_mismatch" };
  return record.workspacePartitionKey === workspacePartitionKey
    ? { ok: true, browserSessionBinding: binding }
    : { ok: false, reason: "workspace_mismatch" };
}

export function createDebugBrowserSessionRegistry(
  options: DebugBrowserSessionRegistryOptions,
): DebugBrowserSessionRegistry {
  const runtime: BrowserRegistryRuntime = {
    records: new Map(),
    profiles: new Map(),
    now: options.now,
    ttlMs: options.ttlMs ?? DEBUG_BROWSER_SESSION_TTL_MS,
    capacity: options.capacity ?? DEBUG_BROWSER_SESSION_CAP,
    tokenFactory: options.token ?? ((): Buffer => randomBytes(TOKEN_BYTES)),
  };
  return {
    issue: (workspacePartitionKey, header): DebugBrowserSessionIssueResult => {
      const issued = issueBrowserSession(runtime, workspacePartitionKey, header);
      return issued.ok
        ? { ok: true, setCookies: issued.setCookies }
        : { ok: false, reason: issued.reason };
    },
    ensure: (workspacePartitionKey, header) =>
      ensureBrowserSession(runtime, workspacePartitionKey, header),
    authorize: (header, workspacePartitionKey) =>
      authorizeBrowserSession(runtime, header, workspacePartitionKey),
  };
}
