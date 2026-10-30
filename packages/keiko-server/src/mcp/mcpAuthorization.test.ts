import { getEventListeners } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { createMcpSettingsStore } from "./mcpSettingsStore.js";
import { createMcpAuthorization, type McpAuthorization } from "./mcpAuthorization.js";
import * as oauthPersistence from "./mcpOAuthCredentialStore.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

const issuer = "https://synthetic-identity.example.test";
const endpoint = "https://synthetic-tools.example.test/mcp";
const roots: string[] = [];
const owners: McpAuthorization[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): {
  owner: McpAuthorization;
  settings: ReturnType<typeof createMcpSettingsStore>;
  events: ServerLogEvent[];
  requests: string[];
  server: McpServerDefinition;
  reopen: () => McpAuthorization;
} {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-central-oauth-")));
  roots.push(stateDir);
  const events: ServerLogEvent[] = [];
  const requests: string[] = [];
  const input = {
    stateDir,
    env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    keychainAccess: (): undefined => undefined,
  };
  const settings = createMcpSettingsStore(input);
  const server: McpServerDefinition = {
    name: "synthetic",
    enabled: true,
    description: undefined,
    transport: {
      kind: "remote",
      url: endpoint,
      oauth: { issuer, clientId: "public-fixture", scope: "tools.read" },
    },
    tools: { read: "read" },
    discovery: "automatic",
  };
  settings.update(
    { expectedRevision: settings.read("fixture").revision, servers: [server], secrets: {} },
    "fixture",
  );
  const make = (): McpAuthorization => {
    const owner = createMcpAuthorization({
      ...input,
      settings,
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      egress: () => undefined,
      fetch: (url): Promise<Response> => {
        requests.push(url);
        if (url.includes("oauth-protected-resource"))
          return Promise.resolve(
            Response.json({ resource: endpoint, authorization_servers: [issuer] }),
          );
        if (url.includes("well-known"))
          return Promise.resolve(
            Response.json({
              issuer,
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none"],
              authorization_response_iss_parameter_supported: true,
            }),
          );
        return Promise.resolve(
          Response.json({
            access_token: "synthetic-oauth-private-access",
            token_type: "Bearer",
            refresh_token: "synthetic-oauth-private-refresh",
            expires_in: 3600,
          }),
        );
      },
    });
    owners.push(owner);
    return owner;
  };
  return { owner: make(), settings, events, requests, server, reopen: make };
}
async function started(f: ReturnType<typeof fixture>): Promise<{ id: string; callback: URL }> {
  const result = await f.owner.start("synthetic", "session", () => true, "synthetic-correlation");
  if (result.outcome !== "started") throw new Error("Synthetic authorization did not start");
  const authorization = new URL(result.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
  callback.searchParams.set("code", "synthetic-code");
  callback.searchParams.set("iss", issuer);
  return { id: result.attemptId, callback };
}
describe("server-owned shared MCP OAuth", () => {
  it.each([true, false])(
    "contains vault restoration failure in authorization views (enabled=%s)",
    (enabled) => {
      const f = fixture();
      const write = vi.fn();
      const clear = vi.fn();
      vi.spyOn(oauthPersistence, "createCentralMcpOAuthPersistence").mockReturnValue({
        read: () => {
          throw new SyntaxError("synthetic-private-vault-payload");
        },
        write,
        clear,
      });
      const server = { ...f.server, enabled };
      expect(f.owner.authorized(server, "vault-read-view")).toBe(false);
      expect(() => f.owner.credentials(server)).toThrow(SyntaxError);
      expect(f.requests).toEqual([]);
      expect(write).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(f.events.find((event) => event.op === "mcp.authorization.state")).toMatchObject({
        op: "mcp.authorization.state",
        extra: { state: "credential-unavailable" },
        correlationId: "vault-read-view",
      });
      expect(JSON.stringify(f.events)).not.toContain("synthetic-private-vault-payload");
    },
  );
  it("allows signing out a disabled centrally configured OAuth server", () => {
    const f = fixture();
    const current = f.settings.read("fixture");
    const disabled = { ...f.server, enabled: false };
    f.settings.update(
      { expectedRevision: current.revision, servers: [disabled], secrets: {} },
      "fixture",
    );
    expect(() => {
      f.owner.revoke("synthetic", "fixture");
    }).not.toThrow();
    expect(f.owner.authorized(disabled)).toBe(false);
    expect(f.requests).toHaveLength(0);
  });
  it("cancels an unfinished authorization even if sign-out cannot persist its generation", async () => {
    const f = fixture();
    const attempt = await started(f);
    vi.spyOn(f.settings, "revoke").mockImplementation(() => {
      throw new Error("synthetic registry refusal");
    });
    expect(() => {
      f.owner.revoke("synthetic", "fixture");
    }).toThrow();
    expect(f.owner.status("synthetic", "session", attempt.id)).toBe("cancelled");
    expect(f.requests.some((url) => url.endsWith("/token"))).toBe(false);
  });

  it.each([false, true])(
    "reads disabled OAuth custody without starting an execution generation (signed in: %s)",
    async (signedIn) => {
      const f = fixture();
      if (signedIn) {
        const attempt = await started(f);
        expect((await fetch(attempt.callback)).status).toBe(200);
      }
      const current = f.settings.read("fixture");
      const server = current.servers[0];
      if (server === undefined) throw new TypeError("Missing fixture server");
      const disabled = { ...server, enabled: false };
      f.settings.update(
        { expectedRevision: current.revision, servers: [disabled], secrets: {} },
        "fixture",
      );
      const calls = f.requests.length;
      expect(f.owner.authorized(disabled)).toBe(signedIn);
      expect(f.owner.credentials(disabled).length > 0).toBe(signedIn);
      expect(f.reopen().authorized(disabled)).toBe(signedIn);
      expect(f.requests).toHaveLength(calls);
    },
  );
  it("cannot reuse cached tokens after custody was cleared and generation persistence failed", async () => {
    const f = fixture();
    const attempt = await started(f);
    expect((await fetch(attempt.callback)).status).toBe(200);
    const server = f.settings.read("fixture").servers[0];
    if (server === undefined) throw new TypeError("Missing fixture server");
    await f.owner.token(server, "fixture");
    vi.spyOn(f.settings, "revoke").mockImplementation(() => {
      throw new Error("synthetic registry refusal");
    });
    expect(() => {
      f.owner.revoke("synthetic", "fixture");
    }).toThrow();
    await expect(f.owner.token(server, "fixture")).rejects.toThrow();
    expect(f.reopen().authorized(server)).toBe(false);
  });

  it("reports an elapsed authorization deadline as expired when status observes it first", async () => {
    const f = fixture();
    const attempt = await started(f);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
    expect(f.owner.status("synthetic", "session", attempt.id)).toBe("expired");
  });

  it("detaches the generation listener when an authorization attempt is cancelled", async () => {
    const f = fixture();
    const generation = f.settings.generation(f.server, "fixture");
    const previous = getEventListeners(generation, "abort").length;
    const attempt = await started(f);
    f.owner.cancel("synthetic", "session", attempt.id);
    expect(getEventListeners(generation, "abort")).toHaveLength(previous);
  });

  it("does not persist exchanged tokens when the authority epoch cannot be committed", async () => {
    const f = fixture();
    const attempt = await started(f);
    vi.spyOn(f.settings, "revoke").mockImplementation(() => {
      throw new Error("synthetic registry refusal");
    });
    expect((await fetch(attempt.callback)).status).toBe(400);
    expect(f.owner.status("synthetic", "session", attempt.id)).toBe("failed");
    expect(f.reopen().authorized(f.server)).toBe(false);
  });

  it("mcp.authorization.state.line proves private custody, restart reuse and durable revocation", async () => {
    const f = fixture();
    const generation = f.settings.generation(f.server, "fixture");
    const a = await started(f);
    expect((await fetch(a.callback)).status).toBe(200);
    expect(f.owner.status("synthetic", "session", a.id)).toBe("complete");
    expect(generation.aborted).toBe(true);
    const current = f.settings.read("fixture").servers[0];
    if (current === undefined) throw new Error("Missing fixture server");
    expect(await f.reopen().token(current, "fixture")).toBe("synthetic-oauth-private-access");
    expect(f.events.some((entry) => entry.extra?.state === "credential-ready")).toBe(true);
    const event = f.events.find(
      (entry) => entry.op === "mcp.authorization.state" && entry.extra?.state === "complete",
    );
    if (event === undefined) throw new Error("Missing authorization event");
    const line = expectActivityLogProof(
      "mcp.authorization.state.line",
      formatActivityLogProofLine(event),
    );
    expect(line).toMatchObject({ state: "complete", attemptId: a.id });
    expect(JSON.stringify(f.events)).not.toContain("synthetic-oauth-private");
    expect(JSON.stringify(f.events)).not.toContain(a.callback.searchParams.get("state"));
    f.owner.revoke("synthetic", "fixture");
    const revoked = f.settings.read("fixture").servers[0];
    if (revoked === undefined) throw new Error("Missing fixture server");
    await expect(f.reopen().token(revoked, "fixture")).rejects.toThrow();
    expect(f.events.some((entry) => entry.extra?.state === "credential-required")).toBe(true);
  });
  it("rejects forged state and foreign sessions without dispatching a token exchange", async () => {
    const f = fixture();
    const a = await started(f);
    expect(f.owner.status("synthetic", "foreign-session", a.id)).toBe("unavailable");
    const forged = new URL(a.callback);
    forged.searchParams.set("state", a.id);
    expect((await fetch(forged)).status).toBe(400);
    expect(f.requests.some((url) => url.endsWith("/token"))).toBe(false);
    expect(f.owner.status("synthetic", "session", a.id)).toBe("pending");
    expect((await fetch(a.callback)).status).toBe(200);
    expect(f.requests.filter((url) => url.endsWith("/token"))).toHaveLength(1);
  });
  it("closes a cancelled listener and never exchanges its code", async () => {
    const f = fixture();
    const a = await started(f);
    f.owner.cancel("synthetic", "session", a.id);
    expect(f.owner.status("synthetic", "session", a.id)).toBe("cancelled");
    await expect(fetch(a.callback)).rejects.toThrow();
    expect(f.requests.some((url) => url.endsWith("/token"))).toBe(false);
  });
  it("rejects a mismatched issuer without persisting credentials", async () => {
    const f = fixture();
    const a = await started(f);
    a.callback.searchParams.set("iss", "https://attacker.example.test");
    expect((await fetch(a.callback)).status).toBe(400);
    expect(f.owner.status("synthetic", "session", a.id)).toBe("failed");
    expect(f.owner.authorized(f.server)).toBe(false);
    expect(f.requests.some((url) => url.endsWith("/token"))).toBe(false);
  });
});
