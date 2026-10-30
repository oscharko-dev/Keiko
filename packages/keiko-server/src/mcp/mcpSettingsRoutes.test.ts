import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodingAppSessionChannel } from "../coding-app-session/sessionChannel.js";
import { createSessionRegistry } from "../coding-app-session/sessionRegistry.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../coding-app-session/_support.js";
import { APP_SESSION_COOKIE_NAME } from "../coding-app-session/sessionCookie.js";
import { API_ROUTES, type RouteContext } from "../routes.js";
import { createMcpSettingsStore } from "./mcpSettingsStore.js";
import { createConfiguredMcpConnections } from "./mcpConfiguredConnections.js";
import {
  handleConnectMcpServer,
  handleGetMcpSettings,
  handlePutMcpSettings,
} from "./mcpSettingsRoutes.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): { deps: Parameters<typeof handleGetMcpSettings>[1]; cookie: string } {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("fixture pairing failed");
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-route-")));
  roots.push(stateDir);
  return {
    cookie: `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`,
    deps: {
      codingAppSessionChannel: channel,
      mcpSettings: createMcpSettingsStore({
        stateDir,
        env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
        keychainAccess: (): undefined => undefined,
      }),
    },
  };
}
function context(cookie: string, body: unknown = {}): RouteContext {
  const req = new IncomingMessage(new Socket());
  req.headers.cookie = cookie;
  req.headers["content-type"] = "application/json";
  req.push(JSON.stringify(body));
  req.push(null);
  return {
    req,
    res: new ServerResponse(req),
    params: {},
    url: new URL("http://localhost/api/mcp/servers"),
    correlationId: "mcp-settings-test",
  };
}

describe("authenticated shared MCP settings routes", () => {
  it("mounts GET and PUT on the production router", () => {
    expect(
      API_ROUTES.filter((route) => route.pattern === "/api/mcp/servers").map(
        (route) => route.method,
      ),
    ).toEqual(["GET", "PUT"]);
  });
  it("refuses unpaired requests without reading or writing private configuration", async () => {
    const { deps } = fixture();
    if (deps.mcpSettings === undefined) throw new Error("missing fixture store");
    const read = vi.spyOn(deps.mcpSettings, "read");
    const update = vi.spyOn(deps.mcpSettings, "update");
    expect(handleGetMcpSettings(context(""), deps).status).toBe(403);
    expect((await handlePutMcpSettings(context(""), deps)).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("saves through the canonical store and returns metadata without the submitted token", async () => {
    const { deps, cookie } = fixture();
    const snapshot = deps.mcpSettings?.read("mcp-settings-test");
    const server = {
      name: "demo",
      discovery: "automatic",
      tools: {},
      transport: {
        kind: "remote",
        url: "https://example.test/mcp",
        headers: { Authorization: { secretEnv: "KEIKO_MCP_SECRET_ROUTE", prefix: "Bearer " } },
      },
    };
    const payload = {
      expectedRevision: snapshot?.revision,
      servers: [server],
      secrets: {
        KEIKO_MCP_SECRET_ROUTE: { server: "demo", value: "synthetic-private-route-token" },
      },
    };
    const result = await handlePutMcpSettings(context(cookie, payload), deps);
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "cache-control": "no-store" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-route-token");
    expect(handleGetMcpSettings(context(cookie), deps).body).toEqual(result.body);
    expect((await handlePutMcpSettings(context(cookie, payload), deps)).status).toBe(409);
  });
  it("rejects malformed mutations before touching the store", async () => {
    const { deps, cookie } = fixture();
    if (deps.mcpSettings === undefined) throw new Error("missing fixture store");
    const update = vi.spyOn(deps.mcpSettings, "update");
    expect(
      (
        await handlePutMcpSettings(
          context(cookie, { expectedRevision: "invalid", servers: [] }),
          deps,
        )
      ).status,
    ).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it("refuses a session revoked while its request body is being read", async () => {
    const { deps, cookie } = fixture();
    if (deps.mcpSettings === undefined) throw new Error("missing fixture store");
    const update = vi.spyOn(deps.mcpSettings, "update");
    const pending = handlePutMcpSettings(
      context(cookie, {
        expectedRevision: deps.mcpSettings.read("mcp-settings-test").revision,
        servers: [],
        secrets: {},
      }),
      deps,
    );
    deps.codingAppSessionChannel?.signOut(cookie.split("=")[1]);
    expect((await pending).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });
});

it("GET observes the existing owner and connect confirms the committed discovery generation", async () => {
  const { deps, cookie } = fixture();
  const settings = deps.mcpSettings;
  const root = roots.at(-1);
  if (settings === undefined || root === undefined) throw new Error("Missing fixture");
  const original = settings.read("test");
  await handlePutMcpSettings(
    context(cookie, {
      expectedRevision: original.revision,
      servers: [
        {
          name: "notes",
          discovery: "automatic",
          tools: {},
          transport: { kind: "remote", url: "https://example.test/mcp" },
        },
      ],
      secrets: {},
    }),
    deps,
  );
  const signals: AbortSignal[] = [];
  const manager = createConfiguredMcpConnections({
    settings,
    stateDir: root,
    log: { write: () => undefined },
    egress: () => undefined,
    connect: (options) => {
      signals.push(options.signal);
      return Promise.resolve({
        signal: options.signal,
        tools: [{ name: "probe", inputSchema: { type: "object" } }],
        call: () => Promise.resolve({ content: [] }),
        close: () => Promise.resolve(),
      });
    },
  });
  const wired = { ...deps, mcpConnections: manager };
  try {
    expect(handleGetMcpSettings(context(cookie), wired).body).toMatchObject({
      connections: [{ name: "notes", state: "idle", toolCount: null }],
    });
    expect(signals).toHaveLength(0);
    const result = await handleConnectMcpServer(
      { ...context(cookie), params: { serverName: "notes" } },
      wired,
    );
    expect(result.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(result.body).toMatchObject({
      snapshot: {
        connections: [{ name: "notes", state: "connected", toolCount: 1 }],
      },
      toolCount: 1,
    });
    expect(handleGetMcpSettings(context(cookie), wired).body).toMatchObject({
      connections: [{ name: "notes", state: "connected", toolCount: 1 }],
    });
    expect(signals).toHaveLength(2);
  } finally {
    await manager.close();
  }
});
