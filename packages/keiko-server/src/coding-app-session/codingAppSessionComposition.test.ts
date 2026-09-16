import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import type { RouteContext } from "../routes.js";
import { createInMemoryUiStore } from "../store/index.js";
import { fakePairingRequestBody } from "./_support.js";
import { handleCodingAppSessionLocalSession } from "./codingAppSessionRoutes.js";
import {
  SESSION_PAIRING_LAUNCHER_SECRET_ENV,
  mintLauncherPairingAttestation,
} from "./launcherSessionPairingPort.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";

const LAUNCHER_SECRET = "launcher-secret-that-is-long-enough-32+chars";

function productionDeps(env: EnvSource): UiHandlerDeps {
  return buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: realpathSync(mkdtempSync(join(tmpdir(), "app-session-composition-"))),
    env,
    store: createInMemoryUiStore(),
  });
}

describe("production composition of the app-session channel (ADR-0141 D7)", () => {
  it("composes the channel but cannot issue a session without launcher authority (fail closed)", () => {
    const channel = productionDeps({}).codingAppSessionChannel;
    expect(channel).toBeDefined();
    expect(channel?.pair(fakePairingRequestBody())).toEqual({ paired: false });
    expect(channel?.ensureLocalSession(undefined)).toEqual({ status: "unavailable" });
    expect(channel?.snapshot(undefined).content).toBeNull();
    expect(channel?.sessionCount()).toBe(0);
  });

  it("issues a session only when the environment carries a launcher secret", () => {
    const channel = productionDeps({
      [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: LAUNCHER_SECRET,
    }).codingAppSessionChannel;
    const attestation = mintLauncherPairingAttestation({
      secret: LAUNCHER_SECRET,
      requestId: "req_production",
      issuedAtMs: Date.now(),
    });
    const result = channel?.pair(attestation);
    expect(result?.paired).toBe(true);
    // No content source is wired in production this wave, so even a paired session reads content-free.
    if (result?.paired) expect(channel?.snapshot(result.cookieToken).content).toBeNull();
    expect(channel?.ensureLocalSession(undefined).status).toBe("issued");
  });

  // Reviewer thread (PR #3506): the production composition of `handleCodingAppSessionLocalSession`
  // relies on the launcher-backed pairing authority to gate a fresh cookie, and must never treat
  // a caller-supplied cookie value as authoritative. These two tests pin both sides through the real
  // handler (not just the channel API): a forged cookie plus paired authority yields an issued
  // session with a fresh cookie; a valid token yields `active` with no fresh `Set-Cookie`.
  it("handleCodingAppSessionLocalSession issues a fresh cookie for a forged value under launcher authority", () => {
    const deps = productionDeps({ [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: LAUNCHER_SECRET });
    const channel = deps.codingAppSessionChannel;
    if (channel === undefined) throw new Error("channel missing");
    const before = channel.sessionCount();
    const result = handleCodingAppSessionLocalSession(
      routeCtx(`${APP_SESSION_COOKIE_NAME}=sess_000000000000000000000000.forged`),
      deps,
    );
    expect(result.headers?.["Set-Cookie"]).toBeDefined();
    expect(String(result.headers?.["Set-Cookie"])).toContain(APP_SESSION_COOKIE_NAME);
    expect(channel.sessionCount()).toBe(before + 1);
  });

  it("handleCodingAppSessionLocalSession honors a valid app-session cookie without issuing a fresh one", () => {
    const deps = productionDeps({ [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: LAUNCHER_SECRET });
    const channel = deps.codingAppSessionChannel;
    if (channel === undefined) throw new Error("channel missing");
    const pair = channel.pair(
      mintLauncherPairingAttestation({
        secret: LAUNCHER_SECRET,
        requestId: "req_active_cookie",
        issuedAtMs: Date.now(),
      }),
    );
    if (!pair.paired) throw new Error("pair failed");
    const before = channel.sessionCount();
    const result = handleCodingAppSessionLocalSession(
      routeCtx(`${APP_SESSION_COOKIE_NAME}=${pair.cookieToken}`),
      deps,
    );
    expect(result.headers).toBeUndefined();
    expect(channel.sessionCount()).toBe(before);
  });

  it("no production source imports the CI pairing fake (_support), so it is unreachable", () => {
    const srcRoot = join(import.meta.dirname, "..");
    const offenders = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .filter(
        (rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.endsWith("_support.ts"),
      )
      .filter((rel) =>
        importsCodingAppSessionSupport(rel, readFileSync(join(srcRoot, rel), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});

function routeCtx(cookie?: string): RouteContext {
  const req = {
    headers: cookie === undefined ? {} : { cookie },
    socket: {},
    once: vi.fn(),
  } as unknown as IncomingMessage;
  return {
    correlationId: undefined,
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/"),
  };
}

function importsCodingAppSessionSupport(relPath: string, content: string): boolean {
  const dir = dirname(relPath);
  const specifiers = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
  return specifiers.some((specifier) => {
    if (specifier.includes("coding-app-session/_support")) return true;
    return (
      dir.endsWith("coding-app-session") &&
      (specifier === "./_support.js" || specifier === "./_support")
    );
  });
}
