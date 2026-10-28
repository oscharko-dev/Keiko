import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import type {
  ExternalMcpConnection,
  ManagedMcpInvocationContext,
  ManagedMcpLogPort,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { connectExternalMcp } from "./external-client.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const clients: ExternalMcpConnection[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});
const schema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const;
function context(allowed = true): ManagedMcpInvocationContext {
  return {
    invocationId: "external-test-invocation",
    correlationId: "external-test",
    signal: new AbortController().signal,
    beforeEffect: () => allowed,
  };
}
function fixture(
  failAfterEffect: boolean | "header-mismatch" = false,
  signal = new AbortController().signal,
  inputSchema: CatalogJsonObject = schema,
  outputSchema?: CatalogJsonObject,
  metadataOverride?: { readonly name: string; readonly inputSchema: CatalogJsonObject },
): {
  readonly connect: () => Promise<ExternalMcpConnection>;
  readonly calls: string[];
  readonly lines: string[];
  readonly effects: () => number;
  readonly contexts: (string | undefined)[];
  readonly sentHeaders: Headers[];
} {
  let effects = 0;
  const calls: string[] = [];
  const lines: string[] = [];
  const contexts: (string | undefined)[] = [];
  const sentHeaders: Headers[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "synthetic-external", version: "1" });
      server.registerTool(
        "save_note",
        {
          inputSchema: fromJsonSchema<{ text: string }>(inputSchema),
          ...(outputSchema === undefined ? {} : { outputSchema: fromJsonSchema(outputSchema) }),
        },
        ({ text }) => {
          effects++;
          return { content: [{ type: "text", text }] };
        },
      );
      return server;
    },
    { legacy: "reject", keepAliveMs: 0 },
  );
  return {
    calls,
    lines,
    effects: () => effects,
    contexts,
    sentHeaders,
    connect: async (): Promise<ExternalMcpConnection> => {
      const connection = await connectExternalMcp({
        signal,
        correlationId: "external-test",
        log: {
          write: (event): void => {
            lines.push(formatActivityLogProofLine(event));
          },
        },
        transport: {
          kind: "remote",
          url: "https://synthetic.example.test/mcp",
          transport: "streamable-http",
          fetch: async (input, init, context) => {
            const request = new Request(input, init);
            const rpc =
              request.method === "POST"
                ? ((await request.clone().json()) as { method?: string; id?: string | number })
                : {};
            calls.push(rpc.method ?? request.method);
            if (rpc.method === "tools/call") sentHeaders.push(new Headers(request.headers));
            contexts.push(context?.invocationId);
            const result = await handler.fetch(request);
            if (rpc.method === "tools/list" && metadataOverride !== undefined) {
              const body = (await result.json()) as { result: { tools: unknown[] } };
              body.result.tools = [metadataOverride];
              return new Response(JSON.stringify(body), {
                status: result.status,
                headers: result.headers,
              });
            }
            if (rpc.method !== "tools/call") return result;
            if (failAfterEffect === true) throw new TypeError("synthetic lost response");
            if (failAfterEffect === "header-mismatch")
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32020, message: "synthetic mismatch after commit" },
              });
            return result;
          },
        },
      });
      clients.push(connection);
      return connection;
    },
  };
}

describe("external MCP SDK client", () => {
  it("refuses unsafe external schemas during discovery before they reach a tool validator", async () => {
    const f = fixture(false, new AbortController().signal, {
      ...schema,
      properties: { text: { type: "string", pattern: "^(a+)+$" } },
    });
    await expect(f.connect()).rejects.toMatchObject({ reason: "protocol-error" });
    expect(f.effects()).toBe(0);
    expect(f.calls).not.toContain("tools/call");
    const events = f.lines.map((line) =>
      expectActivityLogProof("mcp.managed.lifecycle.line", line),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "failed", reason: "protocol-error", toolCount: 0 }),
    );
    expect(f.lines.join("\n")).not.toContain("^(a+)+$");
    expect(f.lines.join("\n")).not.toContain("synthetic.example.test");
  });
  it("refuses unsafe external output schemas before the SDK lazily compiles them", async () => {
    const f = fixture(false, new AbortController().signal, schema, {
      type: "object",
      properties: { text: { type: "string", pattern: "^(a+)+$" } },
    });
    await expect(f.connect()).rejects.toMatchObject({ reason: "protocol-error" });
    expect(f.effects()).toBe(0);
  });
  it("negotiates the modern protocol and invokes the server through real SDK transport", async () => {
    const f = fixture();
    const client = await f.connect();
    expect(f.calls).toContain("server/discover");
    expect(client.tools.map((tool) => tool.name)).toEqual(["save_note"]);
    const result = await client.call("save_note", { text: "synthetic note" }, context());
    expect(result).toMatchObject({ content: [{ type: "text", text: "synthetic note" }] });
    expect(f.effects()).toBe(1);
    expect(f.contexts.at(-1)).toBe("external-test-invocation");
  });
  it("refuses invalid arguments, unknown tools and revoked authority before handler execution", async () => {
    const f = fixture();
    const client = await f.connect();
    await expect(client.call("save_note", { text: 42 }, context())).rejects.toMatchObject({
      reason: "invalid-arguments",
    });
    await expect(client.call("unknown", {}, context())).rejects.toMatchObject({
      reason: "not-admitted",
    });
    await expect(
      client.call("save_note", { text: "synthetic" }, context(false)),
    ).rejects.toMatchObject({ reason: "not-admitted" });
    expect(f.effects()).toBe(0);
  });
  it("does not retry a tool whose remote effect succeeded before response loss", async () => {
    const f = fixture(true);
    const client = await f.connect();
    await expect(client.call("save_note", { text: "synthetic" }, context())).rejects.toMatchObject({
      reason: "protocol-error",
    });
    expect(f.effects()).toBe(1);
    expect(f.calls.filter((method) => method === "tools/call")).toHaveLength(1);
    expect(client.signal.aborted).toBe(false);
  });
});

it("ends a connection on lifetime cancellation and refuses further effects", async () => {
  const controller = new AbortController();
  const f = fixture(false, controller.signal);
  const client = await f.connect();
  expect(client.signal.aborted).toBe(false);
  controller.abort();
  expect(client.signal.aborted).toBe(true);
  await client.close();
  expect(client.signal.aborted).toBe(true);
  await client.close();
  await expect(client.call("save_note", { text: "synthetic" }, context())).rejects.toMatchObject({
    reason: "not-admitted",
  });
  expect(f.effects()).toBe(0);
});
it("rechecks authority after asynchronous schema validation", async () => {
  const f = fixture();
  const client = await f.connect();
  let allowed = true;
  const pending = client.call(
    "save_note",
    { text: "synthetic" },
    { ...context(), beforeEffect: () => allowed },
  );
  allowed = false;
  await expect(pending).rejects.toMatchObject({ reason: "not-admitted" });
  expect(f.effects()).toBe(0);
});
it.each(["http://example.test/mcp", "https://user:password@example.test/mcp", "invalid-url"])(
  "refuses an unsafe remote target before dispatch: %s",
  async (url) => {
    let requests = 0;
    await expect(
      connectExternalMcp({
        signal: new AbortController().signal,
        correlationId: "invalid-target",
        log: { write: () => undefined },
        transport: {
          kind: "remote",
          url,
          transport: "streamable-http",
          fetch: (): Promise<Response> => {
            requests++;
            return Promise.resolve(new Response());
          },
        },
      }),
    ).rejects.toMatchObject({ reason: "not-admitted" });
    expect(requests).toBe(0);
  },
);

it("records external client lifecycle without arguments or results", async () => {
  const f = fixture();
  const client = await f.connect();
  await client.call("save_note", { text: "synthetic-confidential-body" }, context());
  await client.close();
  const events = f.lines.map((line) => expectActivityLogProof("mcp.managed.lifecycle.line", line));
  expect(events.map((event) => event.phase)).toEqual([
    "listed",
    "started",
    "completed",
    "completed",
  ]);
  expect(events.at(-1)?.reason).toBe("closed");
  expect(f.lines.join("")).not.toContain("synthetic-confidential-body");
  expect(f.lines.join("")).not.toContain("synthetic.example.test");
});
it("does not open a cancelled connection", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await expect(
    connectExternalMcp({
      signal: controller.signal,
      correlationId: "cancelled",
      log: { write: () => undefined },
      transport: {
        kind: "remote",
        url: "https://synthetic.example.test/mcp",
        transport: "streamable-http",
        fetch: (): Promise<Response> => {
          requests++;
          return Promise.resolve(new Response());
        },
      },
    }),
  ).rejects.toMatchObject({ reason: "aborted" });
  expect(requests).toBe(0);
});

const legacyProgram = `
  import { createInterface } from "node:readline";
  const tools = [{ name: "probe", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
  createInterface({ input: process.stdin }).on("line", line => {
    const rpc = JSON.parse(line);
    if (rpc.id === undefined) return;
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "synthetic-legacy", version: "1" } };
    if (rpc.method === "tools/list") result = { tools };
    if (rpc.method === "tools/call") result = { content: [{ type: "text", text: process.env.USER === "" && process.env.SERVICE_SECRET === "synthetic-token" && process.env.HOME === process.cwd() ? "isolated" : "unsafe" }] };
    process.stdout.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id: rpc.id, result }) + "\\n");
  });
`;

describe("external MCP compatibility", () => {
  it("negotiates with a real legacy stdio process and isolates its environment", async () => {
    const connection = await connectExternalMcp({
      signal: new AbortController().signal,
      correlationId: "external-stdio-test",
      log: { write: () => undefined },
      transport: {
        kind: "local",
        command: [process.execPath, "--input-type=module", "--eval", legacyProgram],
        cwd: process.cwd(),
        environment: { SERVICE_SECRET: "synthetic-token" },
      },
    });
    clients.push(connection);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["probe"]);
    expect(await connection.call("probe", {}, context())).toMatchObject({
      content: [{ text: "isolated" }],
    });
  });
  it("bounds legacy discovery pagination without invoking tools", async () => {
    let pages = 0;
    const connected = connectExternalMcp({
      signal: new AbortController().signal,
      correlationId: "external-pagination-test",
      log: { write: () => undefined },
      transport: {
        kind: "remote",
        url: "https://synthetic.example.test/mcp",
        transport: "streamable-http",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.method !== "POST") return new Response(null, { status: 405 });
          const rpc = (await request.json()) as { id?: number; method?: string };
          if (rpc.id === undefined) return new Response(null, { status: 202 });
          let result: unknown;
          if (rpc.method === "initialize")
            result = {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-legacy", version: "1" },
            };
          if (rpc.method === "tools/list") {
            pages++;
            result = { tools: [], nextCursor: String(pages) };
          }
          return Response.json(
            result === undefined
              ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }
              : { jsonrpc: "2.0", id: rpc.id, result },
          );
        },
      },
    });
    await expect(connected).rejects.toMatchObject({ reason: "protocol-error" });
    expect(pages).toBe(4);
  });
});

it.each(["descriptor-drift", "connection-close", "request-rejection"] as const)(
  "preserves the legacy HTTP+SSE lifetime boundary for %s",
  async (termination) => {
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let effects = 0;
    let opened = 0;
    const lines: Parameters<ManagedMcpLogPort["write"]>[0][] = [];
    const connection = await connectExternalMcp({
      signal: new AbortController().signal,
      correlationId: "external-sse-test",
      log: {
        write: (line) => {
          lines.push(line);
        },
      },
      transport: {
        kind: "remote",
        url: "https://synthetic.example.test/sse",
        transport: "sse",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "GET") {
            opened++;
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller): void {
                  stream = controller;
                  controller.enqueue(
                    encoder.encode("retry: 1\nevent: endpoint\ndata: /messages\n\n"),
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          const rpc = (await request.json()) as { method: string; id?: number };
          if (rpc.id === undefined) return new Response(null, { status: 202 });
          let result: unknown;
          if (rpc.method === "initialize")
            result = {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-sse", version: "1" },
            };
          if (rpc.method === "tools/list")
            result = {
              tools: [
                {
                  name: "probe",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            };
          if (rpc.method === "tools/call") {
            if (termination === "request-rejection" && effects === 1)
              return new Response(null, { status: 503 });
            effects++;
            result = { content: [{ type: "text", text: "sse-result" }] };
          }
          const message =
            result === undefined
              ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }
              : { jsonrpc: "2.0", id: rpc.id, result };
          stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
          return new Response(null, { status: 202 });
        },
      },
    });
    clients.push(connection);
    expect(await connection.call("probe", {}, context())).toMatchObject({
      content: [{ text: "sse-result" }],
    });
    expect(effects).toBe(1);
    expect(connection.signal.aborted).toBe(false);
    if (termination === "request-rejection") {
      await expect(connection.call("probe", {}, context())).rejects.toMatchObject({
        reason: "protocol-error",
      });
      expect(connection.signal.aborted).toBe(false);
      expect(effects).toBe(1);
      expect(opened).toBe(1);
      return;
    }
    if (termination === "connection-close") stream?.close();
    else
      stream?.enqueue(
        encoder.encode(
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
        ),
      );
    await vi.waitFor(() => {
      expect(connection.signal.aborted).toBe(true);
    });
    await expect(connection.call("probe", {}, context())).rejects.toMatchObject({
      reason: termination === "descriptor-drift" ? "descriptor-drift" : "not-admitted",
    });
    if (termination === "connection-close") {
      await vi.waitFor(() => {
        expect(lines.slice(-2)).toMatchObject([
          {
            op: "mcp.managed.lifecycle",
            extra: { phase: "failed", reason: "closed", toolCount: 1 },
          },
          {
            op: "mcp.managed.lifecycle",
            extra: { phase: "completed", reason: "closed", toolCount: 1 },
          },
        ]);
      });
      expect(JSON.stringify(lines)).not.toContain("synthetic.example.test");
      for (const line of lines)
        expectActivityLogProof("mcp.managed.lifecycle.line", formatActivityLogProofLine(line));
    }
    expect(effects).toBe(1);
    expect(opened).toBe(1);
  },
);

it.each([
  { text: { type: "string", "x-mcp-header": "synthetic-private-header value" } },
  [{ type: "string", "x-mcp-header": "synthetic-private-header value" }],
])(
  "refuses invalid header metadata before the SDK can print private tool and schema values",
  async (properties) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = fixture(false, new AbortController().signal, schema, undefined, {
      name: "synthetic-private-tool-name",
      inputSchema: {
        type: "object",
        properties,
        additionalProperties: false,
      },
    });
    const connection = await f.connect().then(
      () => "connected",
      (error: unknown) => error,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(connection).toMatchObject({ reason: "protocol-error" });
    expect(f.effects()).toBe(0);
    const evidence = `${String(connection)} ${f.lines.join(" ")}`;
    expect(evidence).not.toContain("synthetic-private-tool-name");
    expect(evidence).not.toContain("synthetic-private-header value");
    for (const line of f.lines) expectActivityLogProof("mcp.managed.lifecycle.line", line);
  },
);

it("preserves supported metadata while namespacing tool headers away from HTTP routing", async () => {
  const inputSchema = {
    ...schema,
    properties: { text: { type: "string", "x-mcp-header": "Host" } },
  };
  const f = fixture(false, new AbortController().signal, inputSchema);
  const client = await f.connect();
  expect(client.tools[0]?.inputSchema).toMatchObject(inputSchema);
  expect(await client.call("save_note", { text: "synthetic-note" }, context())).toMatchObject({
    content: [{ text: "synthetic-note" }],
  });
  expect(f.sentHeaders[0]?.get("host")).toBeNull();
  expect(f.sentHeaders[0]?.get("mcp-param-host")).toBe("synthetic-note");
  expect(f.sentHeaders[0]?.get("mcp-protocol-version")).toBe("2026-07-28");
  expect(f.effects()).toBe(1);
});

it("never replays a mutation after a committed effect followed by HEADER_MISMATCH", async () => {
  const f = fixture("header-mismatch");
  const client = await f.connect();
  await expect(
    client.call("save_note", { text: "synthetic-once" }, context()),
  ).rejects.toMatchObject({ reason: "protocol-error" });
  expect(f.effects()).toBe(1);
  expect(f.calls.filter((method) => method === "tools/call")).toHaveLength(1);
});
