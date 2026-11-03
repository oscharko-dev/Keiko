import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { decodeHtmlEntities } from "@oscharko-dev/keiko-workspace";
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
  MCP_SECRET_MIN_CHARS,
  resolveMcpSecretHeaders,
  serveMcpRelayRequest,
  type McpCredentialRelay,
  type McpRelayMethod,
  type McpRelayUpstream,
} from "./mcpCredentialRelay.js";

const SECRET = "static-secret-canary";
// A generated credential of exactly the admitted minimum length. Assembled at run time, so no
// credential-shaped literal lands in the repository (PR #4064 secret scan; .gitleaks.toml).
const SHORTEST_SECRET = ["k3Y9", "qL2_wX7.pB4"].join("-");
// A generated credential holding every printable ASCII character that has a named HTML reference.
const PUNCTUATED_SECRET = "Kx9:/._@!#$%&'()*+,;=?[\\]^`{|}\"<>~-Q7z";
// Named references of the WHATWG table, each checked against an independent decoder below.
const NAMED: Readonly<Record<string, string>> = {
  ":": "&colon;",
  "/": "&sol;",
  ".": "&period;",
  _: "&lowbar;",
  "@": "&commat;",
  "!": "&excl;",
  "#": "&num;",
  $: "&dollar;",
  "%": "&percnt;",
  "&": "&amp;",
  "'": "&apos;",
  "(": "&lpar;",
  ")": "&rpar;",
  "*": "&ast;",
  "+": "&plus;",
  ",": "&comma;",
  ";": "&semi;",
  "=": "&equals;",
  "?": "&quest;",
  "[": "&lsqb;",
  "\\": "&bsol;",
  "]": "&rsqb;",
  "^": "&Hat;",
  "`": "&grave;",
  "{": "&lcub;",
  "|": "&verbar;",
  "}": "&rcub;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

// The credential as an HTML page may spell it: named references, and decimal and hexadecimal
// references padded with zeros, with and without their semicolons.
function htmlSpellings(secret: string): readonly string[] {
  const each = (spell: (character: string, code: number) => string): string =>
    Array.from(secret, (character) => spell(character, character.charCodeAt(0))).join("");
  const hex = (code: number): string => code.toString(16);
  return [
    each((character) => NAMED[character] ?? character),
    each((_, code) => `&#000${String(code)};`),
    each((_, code) => `&#x00${hex(code)};`),
    each((_, code) => `&#X0${hex(code).toUpperCase()}`),
    each((_, code) => `&#0${String(code)}`),
  ];
}
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
    const binding = relay.bind({
      runId: RUN_ID,
      url: "https://mcp.test/",
      headers: {},
      secrets: [],
    });
    if (binding === undefined) throw new Error("fixture-bind-failed");
    const other = relay.bind({
      runId: "run-other",
      url: "https://mcp.test/",
      headers: {},
      secrets: [],
    });
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
      expect(
        relay.bind({ runId: RUN_ID, url: "https://mcp.test/", headers: {}, secrets: [] }),
      ).toBeDefined();
    expect(
      relay.bind({ runId: RUN_ID, url: "https://mcp.test/", headers: {}, secrets: [] }),
    ).toBeUndefined();
  });

  it("resolves a credential header from Keiko's environment and refuses an unset or unsafe one", () => {
    const headers = { Authorization: { secretEnv: "KEIKO_MCP_SECRET_A", prefix: "Bearer " } };
    expect(resolveMcpSecretHeaders(headers, { KEIKO_MCP_SECRET_A: SECRET })).toEqual({
      ok: true,
      headers: { Authorization: `Bearer ${SECRET}` },
      secrets: [SECRET],
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

  // PR #4064 review (4371888093): a credential too short for the relay to tell apart from ordinary
  // text, or to find inside base64, is refused instead of being admitted without that protection.
  it("refuses a credential shorter than the relay can replace", () => {
    const headers = { Authorization: { secretEnv: "KEIKO_MCP_SECRET_A", prefix: "Bearer " } };
    const shortest = SHORTEST_SECRET.slice(0, MCP_SECRET_MIN_CHARS);
    expect(resolveMcpSecretHeaders(headers, { KEIKO_MCP_SECRET_A: shortest })).toMatchObject({
      ok: true,
      secrets: [shortest],
    });
    for (const short of ["k", "k3Y9-qL2", shortest.slice(0, -1)]) {
      expect(resolveMcpSecretHeaders(headers, { KEIKO_MCP_SECRET_A: short }), short).toEqual({
        ok: false,
        reason: "secret-too-short",
      });
    }
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
      secrets: [SECRET],
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

// PR #4064 review (#3903 AC3): a server can answer with the credential it received, whole, split
// across streamed chunks, or escaped inside its JSON. The runtime must never receive it in any of
// these forms, while an ordinary result and an event stream still pass through as they are.
describe("a credential the server reflects (#3903 AC3)", () => {
  async function reflecting(
    secret: string,
    respond: (authorization: string) => Response,
  ): Promise<{
    readonly url: string;
    readonly capability: string;
    readonly records: ServerLogEvent[];
  }> {
    const relay = createMcpCredentialRelay();
    const binding = relay.bind({
      runId: RUN_ID,
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: `Bearer ${secret}` },
      secrets: [secret],
    });
    if (binding === undefined) throw new Error("fixture-bind-failed");
    const { sink: activityLog, records } = sink();
    const origin = await startRelay(relay, activityLog, (_url, request) =>
      Promise.resolve(respond(request.headers.Authorization ?? "")),
    );
    return {
      url: `${origin}${MCP_RELAY_PATH_PREFIX}${binding.relayId}`,
      capability: binding.capability,
      records,
    };
  }

  function json(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // The body in byte slices, each delivered as its own chunk, as a slow server streams it.
  function sliced(text: string, cuts: readonly number[]): Response {
    const bytes = new TextEncoder().encode(text);
    const bounds = [0, ...cuts, bytes.length];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const start = bounds[index];
        const end = bounds[index + 1];
        index += 1;
        if (start === undefined || end === undefined) controller.close();
        else controller.enqueue(bytes.slice(start, end));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  function post(url: string, capability: string): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [MCP_RELAY_CAPABILITY_HEADER]: capability },
      body: INITIALIZE,
    });
  }

  it("replaces the credential a server echoes in its result and records how often", async () => {
    const { url, capability, records } = await reflecting(SECRET, (authorization) =>
      json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: `got ${authorization}; token ${SECRET}` }] },
      }),
    );
    const body = await (await post(url, capability)).text();
    expect(body).not.toContain(SECRET);
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "got [REDACTED]; token [REDACTED]" }] },
    });
    expect(lines(records)).toEqual([
      expect.objectContaining({ outcome: "relayed", redactedCount: 2 }),
    ]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it("holds back a credential split across streamed chunks until it is whole", async () => {
    const event = `event: message\ndata: {"text":"café, Bearer ${SECRET} and more"}\n\n`;
    const start = new TextEncoder().encode(event.slice(0, event.indexOf("Bearer"))).length;
    // Cuts inside "é", inside "Bearer" and twice inside the secret itself.
    const cuts = [event.indexOf("é") + 1, start + 3, start + 10, start + 16];
    const { url, capability } = await reflecting(SECRET, () => sliced(event, cuts));
    const body = await (await post(url, capability)).text();
    expect(body).toBe(`event: message\ndata: {"text":"café, [REDACTED] and more"}\n\n`);
  });

  it("replaces the escaped forms a JSON result or a URL carries", async () => {
    const secret = 'ab/cd"ef\\gh-1234';
    const escaped = JSON.stringify(secret).slice(1, -1);
    const forms = [
      secret,
      escaped,
      escaped.replaceAll("/", "\\/"),
      JSON.stringify(escaped).slice(1, -1),
      encodeURIComponent(secret),
    ];
    const { url, capability } = await reflecting(
      secret,
      () => new Response(forms.map((form) => `<${form}>`).join(" "), { status: 200 }),
    );
    const body = await (await post(url, capability)).text();
    expect(body).toBe(forms.map(() => "<[REDACTED]>").join(" "));
  });

  // PR #4064 review (4371600693): a result that writes the credential with JSON `\uXXXX` escapes is
  // valid JSON, and the run's ordinary JSON.parse restores the exact credential; so do base64 and
  // HTML character references. Split into three-byte chunks, as the review's counter did.
  it("replaces the credential however a result escapes or encodes it, in any chunking", async () => {
    const escaped = Array.from(
      SECRET,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ).join("");
    const html = Array.from(SECRET, (character) => `&#${String(character.charCodeAt(0))};`).join(
      "",
    );
    const base64 = Buffer.from(`token ${SECRET} end`).toString("base64");
    const text = `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"${escaped} ${html} ${base64}"}]}}`;
    const cuts = Array.from({ length: Math.floor(text.length / 3) }, (_, index) => (index + 1) * 3);
    const { url, capability, records } = await reflecting(SECRET, () => sliced(text, cuts));
    const body = await (await post(url, capability)).text();

    const parsed = JSON.parse(body) as {
      readonly result: { readonly content: readonly { readonly text: string }[] };
    };
    const delivered = parsed.result.content[0]?.text ?? "";
    expect(delivered).not.toContain(SECRET);
    expect(delivered.startsWith("[REDACTED] [REDACTED] ")).toBe(true);
    expect(Buffer.from(delivered.split(" ").at(-1) ?? "", "base64").toString()).not.toContain(
      SECRET,
    );
    expect(lines(records)).toEqual([
      expect.objectContaining({ outcome: "relayed", redactedCount: 3 }),
    ]);
  });

  // PR #4064 review (4371888087): the WHATWG reference grammar a browser applies, and Python's
  // html.unescape too, reflected through the relay in three-byte chunks.
  it("replaces every HTML reference spelling of the credential, in three-byte chunks", async () => {
    const spellings = htmlSpellings(PUNCTUATED_SECRET);
    for (const spelling of spellings) expect(decodeHtmlEntities(spelling)).toBe(PUNCTUATED_SECRET);
    const text = spellings.map((spelling) => `data: ${spelling}\n`).join("");
    const cuts = Array.from({ length: Math.floor(text.length / 3) }, (_, index) => (index + 1) * 3);
    const { url, capability, records } = await reflecting(PUNCTUATED_SECRET, () =>
      sliced(text, cuts),
    );
    const body = await (await post(url, capability)).text();

    expect(body).toBe(spellings.map(() => "data: [REDACTED]\n").join(""));
    expect(lines(records)).toEqual([
      expect.objectContaining({ outcome: "relayed", redactedCount: spellings.length }),
    ]);
  });

  // PR #4064 review (4371888093): the shortest admitted credential, as base64 and base64url at each
  // of the three byte alignments.
  it("replaces the shortest admitted credential's base64 at every alignment", async () => {
    const encoded = [0, 1, 2].flatMap((offset) => {
      const bytes = Buffer.from(`${"x".repeat(offset)}${SHORTEST_SECRET}!`);
      return [bytes.toString("base64"), bytes.toString("base64url")];
    });
    const { url, capability, records } = await reflecting(
      SHORTEST_SECRET,
      () => new Response(encoded.map((form) => `${form}\n`).join(""), { status: 200 }),
    );
    const body = await (await post(url, capability)).text();
    const delivered = body.split("\n").filter((line) => line !== "");

    expect(delivered).toHaveLength(6);
    for (const line of delivered) {
      expect(line).toContain("[REDACTED]");
      expect(Buffer.from(line, "base64").toString("latin1")).not.toContain(SHORTEST_SECRET);
    }
    expect(lines(records)).toEqual([
      expect.objectContaining({ outcome: "relayed", redactedCount: 6 }),
    ]);
  });

  // A reference still incomplete beyond any credential's longest spelling ends the response where it
  // is: nothing held back is published.
  it("ends a response that holds back a possible spelling beyond any credential's", async () => {
    const held = `data: ok\n\ndata: &#${"0".repeat(300 * 1024)}65;`;
    const cuts = Array.from({ length: 20 }, (_, index) => 6 + (index + 1) * 16 * 1024);
    const { url, capability, records } = await reflecting(SECRET, () => sliced(held, cuts));
    const reader = (await post(url, capability)).body?.getReader();
    let delivered = "";
    await expect(
      (async (): Promise<void> => {
        for (;;) {
          const next = await reader?.read();
          if (next === undefined || next.done) return;
          delivered += new TextDecoder().decode(next.value);
        }
      })(),
    ).rejects.toThrow();

    expect(delivered).not.toContain("&#0");
    await expect
      .poll(() => lines(records).map((line) => [line.outcome, line.reason]))
      .toEqual([["failed", "credential-spelling-unbounded"]]);
  });

  // PR #4064 review (4371600693): the session id is echoed by the run on every request, so a server
  // that puts the credential into it cannot be answered with a rewritten id: the response is refused.
  it("refuses a response whose forwarded header carries the credential", async () => {
    const { url, capability, records } = await reflecting(
      SECRET,
      (authorization) =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": authorization },
        }),
    );
    const response = await post(url, capability);
    expect(response.status).toBe(502);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(await response.text()).not.toContain(SECRET);
    expect(lines(records)).toEqual([
      expect.objectContaining({ outcome: "refused", reason: "credential-in-response-header" }),
    ]);
  });

  // PR #4064 review (4371888087): named references in each forwarded header refuse the response.
  it.each(["mcp-session-id", "content-type", "mcp-protocol-version"])(
    "refuses a response whose %s spells the credential with named references",
    async (header) => {
      const [named] = htmlSpellings(PUNCTUATED_SECRET);
      if (named === undefined) throw new TypeError("spelling-missing");
      expect(decodeHtmlEntities(named)).toBe(PUNCTUATED_SECRET);
      const { url, capability, records } = await reflecting(
        PUNCTUATED_SECRET,
        () => new Response("{}", { status: 200, headers: { [header]: named } }),
      );
      const response = await post(url, capability);

      expect(response.status).toBe(502);
      expect(response.headers.get(header)).not.toBe(named);
      expect(lines(records)).toEqual([
        expect.objectContaining({ outcome: "refused", reason: "credential-in-response-header" }),
      ]);
    },
  );

  it("passes an ordinary result through byte for byte", async () => {
    const result = { jsonrpc: "2.0", id: 1, result: { text: "Bearer of good news: café ☕" } };
    const { url, capability, records } = await reflecting(SECRET, () => json(result));
    expect(await (await post(url, capability)).text()).toBe(JSON.stringify(result));
    expect(lines(records)).toEqual([
      expect.objectContaining({ outcome: "relayed", redactedCount: 0 }),
    ]);
  });
});

it("serves the server-owned managed upstream on the existing HTTP relay and revokes its capability", async () => {
  const relay = createMcpCredentialRelay();
  const generation = new AbortController();
  const binding = relay.bind({
    runId: "managed-run",
    url: "https://managed.example.test/mcp",
    headers: {},
    secrets: [],
    signal: generation.signal,
    upstream: () =>
      Promise.resolve(
        new Response('{"managed":true}', { headers: { "content-type": "application/json" } }),
      ),
  });
  if (binding === undefined) throw new Error("Missing binding");
  const origin = await startRelay(relay, { write: () => undefined }, () =>
    Promise.reject(new Error("Fallback transport must not be used")),
  );
  const url = `${origin}${MCP_RELAY_PATH_PREFIX}${binding.relayId}`;
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-keiko-csrf": "1",
      [MCP_RELAY_CAPABILITY_HEADER]: binding.capability,
    },
    body: INITIALIZE,
  };
  const response = await fetch(url, init);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ managed: true });
  generation.abort();
  expect((await fetch(url, init)).status).toBe(401);
});
