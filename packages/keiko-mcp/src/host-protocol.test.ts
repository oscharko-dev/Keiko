import childProcess from "node:child_process";
import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import type {
  CanonicalToolId,
  CatalogDigest,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpHost,
  ManagedMcpInvocationContext,
  ManagedMcpTool,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createManagedMcpHost } from "./index.js";

interface WireMessage {
  jsonrpc: string;
  method: string;
  params: { name?: string; arguments?: unknown; _meta?: Record<string, unknown> };
}
const wire = vi.hoisted(() => ({
  method: "tools/call",
  protocolHeader: undefined as string | undefined,
  rewrite: undefined as ((message: WireMessage) => string) | undefined,
  exchanges: [] as {
    body: string;
    protocolHeader: string | null;
    status: number;
    response: string;
  }[],
}));

// Only the injected request bytes change. The real SDK transport still calls the production
// host's fetch, which binds that exact Request to the server-owned invocation context.
vi.mock("@modelcontextprotocol/client", async (original) => {
  const sdk = await original<typeof import("@modelcontextprotocol/client")>();
  return {
    ...sdk,
    StreamableHTTPClientTransport: class extends sdk.StreamableHTTPClientTransport {
      constructor(...args: ConstructorParameters<typeof sdk.StreamableHTTPClientTransport>) {
        const [url, options] = args;
        const fetch = options?.fetch;
        if (fetch === undefined) throw new TypeError("Expected the production in-process fetch");
        super(url, {
          ...options,
          fetch: async (input, init): Promise<Response> => {
            const request = new Request(input, init);
            const message = (await request.clone().json()) as WireMessage;
            const body = message.method === wire.method ? wire.rewrite?.(message) : undefined;
            if (body === undefined) return fetch(input, init);
            const headers = new Headers(request.headers);
            if (wire.protocolHeader !== undefined)
              headers.set("mcp-protocol-version", wire.protocolHeader);
            return fetch(request.url, { ...init, body, headers, signal: request.signal });
          },
        });
      }
    },
  };
});

// Observe the actual handler's response; no validator, response or result is replaced.
vi.mock("@modelcontextprotocol/server", async (original) => {
  const sdk = await original<typeof import("@modelcontextprotocol/server")>();
  return {
    ...sdk,
    createMcpHandler: (
      ...args: Parameters<typeof sdk.createMcpHandler>
    ): ReturnType<typeof sdk.createMcpHandler> => {
      const handler = sdk.createMcpHandler(...args);
      return {
        ...handler,
        fetch: async (request, options): Promise<Response> => {
          const body = await request.clone().text();
          const response = await handler.fetch(request, options);
          wire.exchanges.push({
            body,
            protocolHeader: request.headers.get("mcp-protocol-version"),
            status: response.status,
            response: await response.clone().text(),
          });
          return response;
        },
      };
    },
  };
});

const PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const CLIENT = "io.modelcontextprotocol/clientInfo";
interface Context extends ManagedMcpInvocationContext {
  readonly marker: string;
}
const hosts: ManagedMcpHost<Context>[] = [];
afterEach(async () => {
  wire.rewrite = undefined;
  wire.method = "tools/call";
  wire.protocolHeader = undefined;
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  wire.exchanges.length = 0;
  vi.restoreAllMocks();
});
const descriptor: ToolDescriptor = {
  toolRef: { canonicalId: "fixture.echo" as CanonicalToolId, contractVersion: 1 },
  descriptorDigest: "a".repeat(64) as CatalogDigest,
  description: "Synthetic protocol boundary control",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  resultSchema: {
    type: "object",
    properties: { marker: { type: "string" }, value: { type: "string" } },
    required: ["marker", "value"],
    additionalProperties: false,
  },
  effects: ["workspace-read"],
  actionMapping: [{ action: "fixture.echo", effects: ["workspace-read"] }],
  policyReferences: ["fixture"],
  handlerRequirement: { id: "fixture", contractVersion: 1 },
  bounds: { maxArgumentBytes: 1024, maxResultBytes: 1024, maxResultCount: 1, maxDurationMs: 1000 },
  idempotency: "read-only",
  cancellation: "before-effect",
};
function fixture(): {
  host: ManagedMcpHost<Context>;
  execute: ReturnType<typeof vi.fn<ManagedMcpTool<Context>["execute"]>>;
  context: Context;
} {
  const execute = vi.fn<ManagedMcpTool<Context>["execute"]>((args, context) =>
    Promise.resolve({ data: { marker: context.marker, value: args.value ?? "" } }),
  );
  const host = createManagedMcpHost<Context>({
    providers: [
      {
        id: "fixture",
        tools: (): readonly ManagedMcpTool<Context>[] => [
          { name: "fixture.echo", risk: "read", descriptor, execute },
        ],
      },
    ],
    log: { write: () => undefined },
  });
  hosts.push(host);
  return {
    host,
    execute,
    context: {
      marker: "server-bound",
      invocationId: "synthetic-invocation",
      correlationId: "synthetic-correlation",
      signal: new AbortController().signal,
      beforeEffect: () => true,
    },
  };
}

it("records the real 2026-07-28 request envelope while preventing network and process creation", async () => {
  const refused = (): never => {
    throw new Error("Unexpected external transport");
  };
  const guards = [
    vi.spyOn(globalThis, "fetch").mockImplementation(refused),
    vi.spyOn(net, "connect").mockImplementation(refused),
    vi.spyOn(net, "createConnection").mockImplementation(refused),
    vi.spyOn(net, "createServer").mockImplementation(refused),
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(refused),
    vi.spyOn(childProcess, "spawn").mockImplementation(refused),
    vi.spyOn(childProcess, "fork").mockImplementation(refused),
    vi.spyOn(childProcess, "exec").mockImplementation(refused),
    vi.spyOn(childProcess, "execFile").mockImplementation(refused),
  ];
  const f = fixture();
  await f.host.admit("synthetic-admission");
  await expect(f.host.call("fixture.echo", { value: "control" }, f.context)).resolves.toEqual({
    marker: "server-bound",
    value: "control",
  });
  const messages = wire.exchanges.map(({ body }) => JSON.parse(body) as WireMessage);
  expect(messages.map(({ method }) => method)).toEqual([
    "server/discover",
    "tools/list",
    "tools/list",
    "tools/call",
  ]);
  for (const message of messages)
    expect(message.params._meta).toMatchObject({
      [PROTOCOL]: "2026-07-28",
      [CAPABILITIES]: {},
      [CLIENT]: { name: "keiko-managed", version: "1" },
    });
  for (const exchange of wire.exchanges) expect(exchange.protocolHeader).toBe("2026-07-28");
  expect(f.host.protocolEra()).toBe("modern");
  expect(f.execute).toHaveBeenCalledOnce();
  for (const guard of guards) expect(guard).not.toHaveBeenCalled();
});

const refusals: {
  name: string;
  protocolHeader?: string;
  rewrite: (message: WireMessage) => string;
}[] = [
  {
    name: "unsupported protocol revision",
    protocolHeader: "2099-01-01",
    rewrite: (message): string =>
      JSON.stringify({
        ...message,
        params: { ...message.params, _meta: { ...message.params._meta, [PROTOCOL]: "2099-01-01" } },
      }),
  },
  {
    name: "mismatched body and HTTP protocol revisions",
    rewrite: (message): string =>
      JSON.stringify({
        ...message,
        params: { ...message.params, _meta: { ...message.params._meta, [PROTOCOL]: "2099-01-01" } },
      }),
  },
  {
    name: "missing required protocol metadata",
    rewrite: (message): string => {
      delete message.params._meta?.[PROTOCOL];
      return JSON.stringify(message);
    },
  },
  {
    name: "missing required capabilities metadata",
    rewrite: (message): string => {
      delete message.params._meta?.[CAPABILITIES];
      return JSON.stringify(message);
    },
  },
  {
    name: "malformed required capabilities metadata",
    rewrite: (message): string =>
      JSON.stringify({
        ...message,
        params: {
          ...message.params,
          _meta: { ...message.params._meta, [CAPABILITIES]: "invalid" },
        },
      }),
  },
  { name: "malformed JSON", rewrite: () => "{" },
  {
    name: "invalid JSON-RPC version",
    rewrite: (message): string => JSON.stringify({ ...message, jsonrpc: "1.0" }),
  },
  {
    name: "invalid RPC method shape",
    rewrite: (message): string => JSON.stringify({ ...message, method: 42 }),
  },
  {
    name: "unknown tool",
    rewrite: (message): string =>
      JSON.stringify({ ...message, params: { ...message.params, name: "fixture.unknown" } }),
  },
  {
    name: "schema-invalid tool arguments",
    rewrite: (message): string =>
      JSON.stringify({ ...message, params: { ...message.params, arguments: { value: 42 } } }),
  },
];
it.each(refusals)(
  "the production SDK handler refuses $name before the provider runs",
  async ({ rewrite, protocolHeader }) => {
    const f = fixture();
    await f.host.admit("synthetic-admission");
    await expect(f.host.call("fixture.echo", { value: "before" }, f.context)).resolves.toEqual({
      marker: "server-bound",
      value: "before",
    });
    wire.exchanges.length = 0;
    wire.rewrite = rewrite;
    wire.protocolHeader = protocolHeader;
    await expect(f.host.call("fixture.echo", { value: "rejected" }, f.context)).rejects.toThrow();
    expect(f.execute).toHaveBeenCalledTimes(1);
    const rejected = wire.exchanges.filter(({ body }) => !body.includes('"method":"tools/list"'));
    expect(rejected.length).toBeGreaterThan(0);
    for (const exchange of rejected) expect(exchange.response).toMatch(/"error"|"isError":true/u);
    wire.rewrite = undefined;
    wire.protocolHeader = undefined;
    await expect(f.host.call("fixture.echo", { value: "after" }, f.context)).resolves.toEqual({
      marker: "server-bound",
      value: "after",
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
  },
);

it("keeps optional clientInfo optional while enforcing the modern required envelope", async () => {
  const f = fixture();
  await f.host.admit("synthetic-admission");
  wire.rewrite = (message): string => {
    delete message.params._meta?.[CLIENT];
    return JSON.stringify(message);
  };
  await expect(
    f.host.call("fixture.echo", { value: "optional-client-info" }, f.context),
  ).resolves.toEqual({ marker: "server-bound", value: "optional-client-info" });
  expect(f.execute).toHaveBeenCalledOnce();
});

it("refuses an unsupported revision during real SDK discovery and records the supported revision", async () => {
  const control = fixture();
  await control.host.admit("synthetic-control");
  await expect(
    control.host.call("fixture.echo", { value: "control" }, control.context),
  ).resolves.toEqual({ marker: "server-bound", value: "control" });
  const unsupported = fixture();
  wire.exchanges.length = 0;
  wire.method = "server/discover";
  wire.protocolHeader = "2099-01-01";
  wire.rewrite = (message): string =>
    JSON.stringify({
      ...message,
      params: {
        ...message.params,
        _meta: { ...message.params._meta, [PROTOCOL]: "2099-01-01" },
      },
    });
  await expect(unsupported.host.admit("synthetic-unsupported")).rejects.toMatchObject({
    reason: "protocol-error",
  });
  expect(unsupported.host.protocolEra()).toBeUndefined();
  expect(() => unsupported.host.catalog()).toThrow();
  expect(unsupported.execute).not.toHaveBeenCalled();
  expect(control.execute).toHaveBeenCalledOnce();
  expect(wire.exchanges.map(({ body }) => (JSON.parse(body) as WireMessage).method)).toEqual([
    "server/discover",
    "server/discover",
  ]);
  for (const response of wire.exchanges) {
    expect(response.status).toBe(400);
    expect(response.protocolHeader).toBe("2099-01-01");
    expect(JSON.parse(response.response)).toMatchObject({
      error: {
        data: {
          requested: "2099-01-01",
          supported: ["2026-07-28"],
        },
      },
    });
  }
});
