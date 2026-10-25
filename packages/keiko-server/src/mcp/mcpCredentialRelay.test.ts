import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createMcpCredentialRelay,
  egressMcpRelayUpstream,
  MCP_RELAY_CAPABILITY_HEADER,
  MCP_RELAY_PATH_PREFIX,
  MCP_RELAY_REQUEST_MAX_BYTES,
  resolveMcpSecretHeaders,
  serveMcpRelayRequest,
  type McpCredentialRelay,
  type McpRelayMethod,
  type McpRelayUpstream,
} from "./mcpCredentialRelay.js";

const SECRET = "static-secret-canary";
const RUN_ID = "run-relay";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function sink(): { readonly sink: ServerLogSink; readonly records: ServerLogEvent[] } {
  const records: ServerLogEvent[] = [];
  return { sink: { write: (event) => void records.push(event) }, records };
}

function lines(records: readonly ServerLogEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return records.map((record) =>
    expectActivityLogProof(
      "coding-runtime.mcp-relay.emitted-line",
      formatActivityLogProofLine(record),
    ),
  );
}

interface Upstream {
  readonly base: string;
  readonly seen: { method: string; headers: IncomingMessage["headers"]; body: string }[];
}

// An MCP server that answers only with the static credential, as a credentialed remote does.
async function startUpstream(
  answer: (request: IncomingMessage, response: ServerResponse, body: string) => void = (
    _request,
    response,
  ) => {
    response
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" })
      .end('{"jsonrpc":"2.0","id":1,"result":{}}');
  },
): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: request.method ?? "", headers: request.headers, body });
      if (request.headers.authorization !== `Bearer ${SECRET}`) {
        response.writeHead(401).end();
        return;
      }
      answer(request, response, body);
    });
  });
  return { base: await listen(server), seen };
}

// Keiko's relay route as a bare listener; the loopback fixture is reached with a plain fetch.
async function startRelay(
  relay: McpCredentialRelay,
  activityLog: ServerLogSink,
  upstream: McpRelayUpstream = (url, request) =>
    fetch(url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "manual",
      signal: request.signal,
    }),
): Promise<string> {
  const server = createServer((request, response) => {
    const relayId = (request.url ?? "").slice(MCP_RELAY_PATH_PREFIX.length);
    void serveMcpRelayRequest(
      request,
      response,
      { relayId, method: request.method as McpRelayMethod },
      { relay, upstream, activityLog, correlationId: "request-correlation" },
    );
  });
  return listen(server);
}

const INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';

describe("the MCP credential relay's bindings (#3903 AC3)", () => {
  it("authenticates exactly the run's capability for its relay, until the run is released", () => {
    const relay = createMcpCredentialRelay();
    const binding = relay.bind({ runId: RUN_ID, url: "https://mcp.test/", headers: {} });
    if (binding === undefined) throw new Error("fixture-bind-failed");
    const other = relay.bind({ runId: "run-other", url: "https://mcp.test/", headers: {} });
    expect(relay.authenticate(binding.relayId, binding.capability)?.target.runId).toBe(RUN_ID);
    expect(relay.authenticate(binding.relayId, other?.capability)).toBeUndefined();
    expect(relay.authenticate(binding.relayId, undefined)).toBeUndefined();
    expect(relay.authenticate("../../etc", binding.capability)).toBeUndefined();
    const signal = relay.authenticate(binding.relayId, binding.capability)?.signal;
    relay.releaseRun(RUN_ID);
    expect(signal?.aborted).toBe(true);
    expect(relay.authenticate(binding.relayId, binding.capability)).toBeUndefined();
    expect(relay.authenticate(other?.relayId ?? "", other?.capability)).toBeDefined();
  });

  it("refuses a further binding once it holds its maximum", () => {
    const relay = createMcpCredentialRelay();
    for (let index = 0; index < 256; index += 1)
      expect(relay.bind({ runId: RUN_ID, url: "https://mcp.test/", headers: {} })).toBeDefined();
    expect(relay.bind({ runId: RUN_ID, url: "https://mcp.test/", headers: {} })).toBeUndefined();
  });

  it("resolves a credential header from Keiko's environment and refuses an unset or unsafe one", () => {
    const headers = { Authorization: { secretEnv: "KEIKO_MCP_SECRET_A", prefix: "Bearer " } };
    expect(resolveMcpSecretHeaders(headers, { KEIKO_MCP_SECRET_A: SECRET })).toEqual({
      ok: true,
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(resolveMcpSecretHeaders(headers, {})).toEqual({
      ok: false,
      reason: "secret-unavailable",
    });
    expect(resolveMcpSecretHeaders(headers, { KEIKO_MCP_SECRET_A: "" })).toEqual({
      ok: false,
      reason: "secret-unavailable",
    });
    expect(resolveMcpSecretHeaders(headers, { KEIKO_MCP_SECRET_A: "a\r\nX-Evil: 1" })).toEqual({
      ok: false,
      reason: "secret-invalid",
    });
  });
});

describe("a relayed MCP exchange (#3903 AC3)", () => {
  async function relayed(answer?: Parameters<typeof startUpstream>[0]): Promise<{
    readonly upstream: Upstream;
    readonly url: string;
    readonly capability: string;
    readonly relay: McpCredentialRelay;
    readonly records: ServerLogEvent[];
  }> {
    const upstream = await startUpstream(answer);
    const relay = createMcpCredentialRelay();
    const binding = relay.bind({
      runId: RUN_ID,
      url: `${upstream.base}/mcp`,
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    if (binding === undefined) throw new Error("fixture-bind-failed");
    const { sink: activityLog, records } = sink();
    const origin = await startRelay(relay, activityLog);
    return {
      upstream,
      url: `${origin}${MCP_RELAY_PATH_PREFIX}${binding.relayId}`,
      capability: binding.capability,
      relay,
      records,
    };
  }

  it("adds the credential, forwards only the transport's headers and answers with the server's", async () => {
    const { upstream, url, capability, records } = await relayed();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "x-keiko-csrf": "1",
        [MCP_RELAY_CAPABILITY_HEADER]: capability,
        cookie: "keiko_app_session=never-forwarded",
      },
      body: INITIALIZE,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    expect(await response.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    const [seen] = upstream.seen;
    expect(seen?.body).toBe(INITIALIZE);
    expect(seen?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(seen?.headers[MCP_RELAY_CAPABILITY_HEADER]).toBeUndefined();
    expect(seen?.headers["x-keiko-csrf"]).toBeUndefined();
    expect(seen?.headers.cookie).toBeUndefined();
    expect(lines(records)).toEqual([
      expect.objectContaining({
        action: "request",
        outcome: "relayed",
        method: "POST",
        status: 200,
        requestBytes: INITIALIZE.length,
        correlationId: RUN_ID,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).not.toContain(capability);
  });

  it("refuses a request without the run's capability or from a browser before reaching the server", async () => {
    const { upstream, url, capability, records } = await relayed();
    const missing = await fetch(url, { method: "POST", body: INITIALIZE });
    const wrong = await fetch(url, {
      method: "POST",
      headers: { [MCP_RELAY_CAPABILITY_HEADER]: "x".repeat(43) },
      body: INITIALIZE,
    });
    const browser = await fetch(url, {
      method: "POST",
      headers: { [MCP_RELAY_CAPABILITY_HEADER]: capability, origin: "https://evil.example.test" },
      body: INITIALIZE,
    });
    expect([missing.status, wrong.status, browser.status]).toEqual([401, 401, 403]);
    expect(upstream.seen).toEqual([]);
    expect(lines(records).map((line) => [line.outcome, line.reason, line.correlationId])).toEqual([
      ["refused", "capability-invalid", "request-correlation"],
      ["refused", "capability-invalid", "request-correlation"],
      ["refused", "origin-not-allowed", "request-correlation"],
    ]);
  });

  it("refuses an oversized request body and never follows a redirect", async () => {
    const { upstream, url, capability, records } = await relayed((_request, response) => {
      response.writeHead(307, { location: "https://elsewhere.example.test/mcp" }).end();
    });
    const oversized = await fetch(url, {
      method: "POST",
      headers: { [MCP_RELAY_CAPABILITY_HEADER]: capability },
      body: "x".repeat(MCP_RELAY_REQUEST_MAX_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(upstream.seen).toEqual([]);
    const redirected = await fetch(url, {
      method: "POST",
      headers: { [MCP_RELAY_CAPABILITY_HEADER]: capability },
      body: INITIALIZE,
      redirect: "manual",
    });
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get("location")).toBeNull();
    expect(lines(records).map((line) => [line.outcome, line.reason])).toEqual([
      ["refused", "body-too-large"],
      ["refused", "redirect-refused"],
    ]);
  });

  it("ends a held event stream when the run is released", async () => {
    const { url, capability, relay, records } = await relayed((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: message\ndata: {}\n\n");
    });
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream", [MCP_RELAY_CAPABILITY_HEADER]: capability },
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("event: message");
    relay.releaseRun(RUN_ID);
    await expect(reader?.read()).rejects.toThrow();
    await expect
      .poll(() => lines(records).map((line) => [line.outcome, line.method]))
      .toEqual([["cancelled", "GET"]]);
  });

  it("reaches the server only through Keiko's egress, which refuses a loopback target", async () => {
    const upstream = await startUpstream();
    const send = egressMcpRelayUpstream(() => undefined);
    await expect(
      send(`${upstream.base}/mcp`, {
        method: "POST",
        headers: {},
        body: new TextEncoder().encode(INITIALIZE),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(upstream.seen).toEqual([]);
  });
});
