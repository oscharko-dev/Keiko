import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDebugBrowserSessionRegistry,
  DEBUG_BROWSER_COOKIE_NAME,
  DEBUG_BROWSER_COOKIE_PATH,
  DEBUG_BROWSER_PROFILE_COOKIE_NAME,
  DEBUG_BROWSER_SESSION_CAP,
  DEBUG_BROWSER_SESSION_TTL_MS,
} from "./dapBrowserSession.js";

function tokenBytes(value: number): Buffer {
  return Buffer.alloc(32, value);
}

function cookieFor(setCookies: readonly string[], name: string): string {
  return setCookies.find((value) => value.startsWith(`${name}=`))?.split(";", 1)[0] ?? "";
}

function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((value) => value.split(";", 1)[0] ?? "").join("; ");
}

describe("debug browser-session capability registry", () => {
  it("mints only an HttpOnly same-site API-path cookie and retains only its digest", () => {
    const registry = createDebugBrowserSessionRegistry({
      now: () => 10,
      token: () => tokenBytes(1),
    });

    const issued = registry.issue("workspace_a");

    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("invalid test fixture");
    const capabilityCookie = issued.setCookies.find((value) =>
      value.startsWith(`${DEBUG_BROWSER_COOKIE_NAME}=`),
    );
    expect(capabilityCookie).toContain(
      `Path=${DEBUG_BROWSER_COOKIE_PATH}; Max-Age=${String(DEBUG_BROWSER_SESSION_TTL_MS / 1_000)}; HttpOnly; SameSite=Strict`,
    );
    expect(capabilityCookie).toMatch(
      new RegExp(`^${DEBUG_BROWSER_COOKIE_NAME}=[A-Za-z0-9_-]{43};`, "u"),
    );
    expect(issued.setCookies).toHaveLength(2);
    const token = cookieFor(issued.setCookies, DEBUG_BROWSER_COOKIE_NAME).split("=", 2)[1] ?? "";
    expect(registry.authorize(cookieHeader(issued.setCookies), "workspace_a")).toEqual({
      ok: true,
      browserSessionBinding: createHash("sha256").update(token).digest("hex"),
    });
  });

  it("rejects missing, malformed, duplicate, unknown, and cross-workspace cookies", () => {
    const registry = createDebugBrowserSessionRegistry({
      now: () => 0,
      token: () => tokenBytes(2),
    });
    const issued = registry.issue("workspace_a");
    if (!issued.ok) throw new Error("invalid test fixture");
    const valid = cookieHeader(issued.setCookies);

    expect(registry.authorize(undefined, "workspace_a")).toEqual({ ok: false, reason: "missing" });
    for (const header of [
      `${DEBUG_BROWSER_COOKIE_NAME}=short`,
      `${valid}; ${valid}`,
      `${DEBUG_BROWSER_COOKIE_NAME}=${"A".repeat(43)}`,
    ]) {
      expect(registry.authorize(header, "workspace_a")).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
    expect(registry.authorize(valid, "workspace_b")).toEqual({
      ok: false,
      reason: "workspace_mismatch",
    });
  });

  it("reuses a valid workspace capability without rotating its session binding", () => {
    const registry = createDebugBrowserSessionRegistry({
      now: () => 0,
      token: () => tokenBytes(4),
    });
    const issued = registry.issue("workspace_a");
    if (!issued.ok) throw new Error("invalid test fixture");
    const header = cookieHeader(issued.setCookies);
    const authorized = registry.authorize(header, "workspace_a");
    if (!authorized.ok) throw new Error("invalid test fixture");

    expect(registry.ensure("workspace_a", header)).toEqual({
      ok: true,
      browserSessionBinding: authorized.browserSessionBinding,
      setCookies: [],
    });
  });

  it("expires capabilities at the exact boundary and rejects replay after BFF restart", () => {
    let now = 100;
    const registry = createDebugBrowserSessionRegistry({
      now: () => now,
      token: () => tokenBytes(3),
    });
    const issued = registry.issue("workspace_a");
    if (!issued.ok) throw new Error("invalid test fixture");
    const header = cookieHeader(issued.setCookies);
    now += DEBUG_BROWSER_SESSION_TTL_MS;

    expect(registry.authorize(header, "workspace_a")).toEqual({ ok: false, reason: "expired" });
    const restarted = createDebugBrowserSessionRegistry({ now: () => now });
    expect(restarted.authorize(header, "workspace_a")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("bounds retained browser profiles and reuses capacity only after expiry", () => {
    let now = 0;
    let next = 0;
    const registry = createDebugBrowserSessionRegistry({
      now: () => now,
      token: () => tokenBytes(next++),
    });
    for (let index = 0; index < DEBUG_BROWSER_SESSION_CAP; index += 1) {
      expect(registry.issue(`workspace_${String(index)}`).ok).toBe(true);
    }
    expect(registry.issue("overflow")).toEqual({ ok: false, reason: "capacity" });
    now = DEBUG_BROWSER_SESSION_TTL_MS;
    expect(registry.issue("after_expiry").ok).toBe(true);
  });

  it("rejects a capability replayed under a different browser-profile binding", () => {
    let next = 1;
    const registry = createDebugBrowserSessionRegistry({
      now: () => 0,
      token: () => tokenBytes(next++),
    });
    const first = registry.issue("workspace_a");
    const second = registry.issue("workspace_a");
    if (!first.ok || !second.ok) throw new Error("invalid test fixture");
    const replay = [
      cookieFor(second.setCookies, DEBUG_BROWSER_PROFILE_COOKIE_NAME),
      cookieFor(first.setCookies, DEBUG_BROWSER_COOKIE_NAME),
    ].join("; ");
    expect(registry.authorize(replay, "workspace_a")).toEqual({
      ok: false,
      reason: "profile_mismatch",
    });
  });

  it("fails closed when an injected token source violates the fixed entropy size", () => {
    const registry = createDebugBrowserSessionRegistry({
      now: () => 0,
      token: () => Buffer.alloc(31),
    });
    expect(registry.issue("workspace_a")).toEqual({ ok: false, reason: "capacity" });
  });
});
