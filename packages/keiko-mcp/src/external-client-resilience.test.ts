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
import { ManagedMcpError } from "./definitions.js";

/**
 * Hermetic resilience fixtures. The server is an in-process MCP handler behind an injected `fetch`,
 * so there is no listener, no port and no sleep: a stall is a promise the test settles, and a
 * crash is a rejected request.
 */
const clients: ExternalMcpConnection[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});
const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const;

interface Rpc {
  readonly method?: string;
  readonly id?: string | number;
  readonly params?: {
    readonly name?: string;
    readonly _meta?: { readonly progressToken?: unknown };
  };
}
type Intercept = (
  rpc: Rpc,
  request: Request,
  forward: () => Promise<Response>,
) => Response | Promise<Response | undefined> | undefined;
interface FixtureOptions {
  readonly tools?: readonly { name: string; description?: string }[];
  readonly allowedTools?: readonly string[];
  readonly intercept?: Intercept;
  readonly result?: (name: string) => string;
}
interface Fixture {
  readonly connect: () => Promise<ExternalMcpConnection>;
  readonly frames: string[];
  readonly lines: Parameters<ManagedMcpLogPort["write"]>[0][];
}

function serverFor(options: FixtureOptions): ReturnType<typeof createMcpHandler> {
  return createMcpHandler(
    () => {
      const server = new McpServer({ name: "synthetic-resilience", version: "1" });
      for (const tool of options.tools ?? [{ name: "work" }]) {
        server.registerTool(
          tool.name,
          {
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: fromJsonSchema<Record<string, never>>(emptyInput),
          },
          () => ({ content: [{ type: "text", text: options.result?.(tool.name) ?? "ok" }] }),
        );
      }
      return server;
    },
    { legacy: "reject", keepAliveMs: 0 },
  );
}
function fixture(options: FixtureOptions = {}): Fixture {
  const handler = serverFor(options);
  const frames: string[] = [];
  const lines: Fixture["lines"] = [];
  return {
    frames,
    lines,
    connect: async (): Promise<ExternalMcpConnection> => {
      const connection = await connectExternalMcp({
        signal: new AbortController().signal,
        correlationId: "resilience",
        log: { write: (event): void => void lines.push(event) },
        ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
        transport: {
          kind: "remote",
          url: "https://synthetic.example.test/mcp",
          transport: "streamable-http",
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const rpc: Rpc =
              request.method === "POST" ? ((await request.clone().json()) as Rpc) : {};
            frames.push(rpc.method ?? request.method);
            return (
              (await options.intercept?.(rpc, request.clone(), () =>
                handler.fetch(request.clone()),
              )) ?? handler.fetch(request)
            );
          },
        },
      });
      clients.push(connection);
      return connection;
    },
  };
}
function context(
  overrides: Partial<ManagedMcpInvocationContext> = {},
): ManagedMcpInvocationContext {
  return {
    invocationId: "resilience-invocation",
    correlationId: "resilience",
    signal: new AbortController().signal,
    beforeEffect: () => true,
    ...overrides,
  };
}
function writeFrame(
  controller: ReadableStreamDefaultController<Uint8Array>,
  message: unknown,
): void {
  controller.enqueue(
    new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
  );
}
/** A response that never completes until the request is aborted: a hung server. */
function stalled(request: Request): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (request.signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    request.signal.addEventListener(
      "abort",
      () => {
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
async function rejection(promise: Promise<unknown>): Promise<ManagedMcpError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ManagedMcpError);
  return error as ManagedMcpError;
}

describe("failure before the tools/call frame is effect-free (finding 1)", () => {
  it("reports effect none, dispatched false, when the declaration check fails", async () => {
    let lists = 0;
    const f = fixture({
      intercept: (rpc) => {
        if (rpc.method === "tools/list" && ++lists === 2)
          return Response.json({ error: "synthetic list outage" }, { status: 503 });
        return undefined;
      },
    });
    const connection = await f.connect();
    const error = await rejection(connection.call("work", {}, context()));
    expect(error.effect).toBe("none");
    expect(f.frames).not.toContain("tools/call");
    const failed = f.lines
      .map((line) =>
        expectActivityLogProof("mcp.managed.lifecycle.line", formatActivityLogProofLine(line)),
      )
      .filter((event) => event.phase === "failed" && event.invocationId !== undefined);
    expect(failed).toMatchObject([{ dispatched: false, effect: "none" }]);
  });

  it("reports effect none when the dispatch gate refuses the frame", async () => {
    const f = fixture();
    const connection = await f.connect();
    const error = await rejection(
      connection.call("work", {}, context({ beforeDispatch: () => false })),
    );
    expect(error.reason).toBe("not-admitted");
    expect(error.effect).toBe("none");
    expect(f.frames).not.toContain("tools/call");
  });

  it("reports effect possible once the frame left, even when the answer is lost", async () => {
    const f = fixture({
      intercept: (rpc) => {
        if (rpc.method === "tools/call") throw new TypeError("synthetic lost response");
        return undefined;
      },
    });
    const connection = await f.connect();
    const dispatch = vi.fn(() => true);
    const error = await rejection(
      connection.call("work", {}, context({ beforeDispatch: dispatch })),
    );
    expect(error.effect).toBe("possible");
    expect(dispatch).toHaveBeenCalledOnce();
    const failed = f.lines
      .map((line) =>
        expectActivityLogProof("mcp.managed.lifecycle.line", formatActivityLogProofLine(line)),
      )
      .filter((event) => event.phase === "failed" && event.invocationId !== undefined);
    expect(failed).toMatchObject([{ dispatched: true, effect: "possible" }]);
  });

  it("aborting a call that waits behind another declaration check is prompt and effect-free", async () => {
    let lists = 0;
    const f = fixture({
      intercept: (rpc, request) =>
        rpc.method === "tools/list" && ++lists === 2 ? stalled(request) : undefined,
    });
    const connection = await f.connect();
    const first = new AbortController();
    const blocked = connection.call("work", {}, context({ signal: first.signal }));
    const second = new AbortController();
    const waiting = rejection(connection.call("work", {}, context({ signal: second.signal })));
    second.abort();
    const error = await waiting;
    expect(error.reason).toBe("aborted");
    expect(error.effect).toBe("none");
    first.abort();
    expect((await rejection(blocked)).effect).toBe("none");
  });
});

describe("catalog drift does not cancel dispatched calls (finding 2)", () => {
  it("lets three parallel in-flight calls finish, and refuses a fourth without sending its frame", async () => {
    const releases: (() => void)[] = [];
    const notify: (() => void)[] = [];
    let calls = 0;
    const f = fixture({
      intercept: async (rpc, _request, forward) => {
        if (rpc.method !== "tools/call") return undefined;
        calls++;
        const real: unknown = await (await forward()).json();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              const frame = (message: unknown): void => {
                writeFrame(controller, message);
              };
              notify.push(() => {
                frame({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
              });
              releases.push(() => {
                frame(real);
                controller.close();
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const connection = await f.connect();
    const pending = [1, 2, 3].map((n) =>
      connection.call("work", {}, context({ invocationId: `parallel-${String(n)}` })),
    );
    // The catalog moves only after all three frames left the process.
    await vi.waitFor(() => {
      expect(releases).toHaveLength(3);
    });
    notify[0]?.();
    await vi.waitFor(() => {
      expect(connection.signal.aborted).toBe(true);
    });
    const late = await rejection(connection.call("work", {}, context()));
    expect(late.reason).toBe("descriptor-drift");
    expect(late.effect).toBe("none");
    expect(calls).toBe(3);
    for (const release of releases) release();
    const settled = await Promise.all(pending);
    expect(settled).toHaveLength(3);
    for (const result of settled) expect(result).toMatchObject({ content: [{ type: "text" }] });
  });
});

describe("oversized results are refused whole (finding 3)", () => {
  it("refuses a 1.5 MB result as result-too-large and keeps the connection usable", async () => {
    const f = fixture({
      tools: [{ name: "big" }, { name: "small" }],
      result: (name) => (name === "big" ? "x".repeat(1_500_000) : "tiny"),
    });
    const connection = await f.connect();
    const error = await rejection(connection.call("big", {}, context()));
    expect(error.reason).toBe("result-too-large");
    expect(error.effect).toBe("possible");
    expect(connection.signal.aborted).toBe(false);
    expect(await connection.call("small", {}, context())).toMatchObject({
      content: [{ text: "tiny" }],
    });
  });
});

describe("a large server is narrowed, not refused (finding 5)", () => {
  const many = Array.from({ length: 200 }, (_unused, index) => ({
    name: `tool_${String(index)}`,
    description: "d".repeat(5000),
  }));
  it("keeps only registry-allowed tools of a 200-tool server and bounds their descriptions", async () => {
    const f = fixture({ tools: many, allowedTools: ["tool_3", "tool_150"] });
    const connection = await f.connect();
    expect(connection.tools.map((tool) => tool.name).sort()).toEqual(["tool_150", "tool_3"]);
    for (const tool of connection.tools)
      expect(Buffer.byteLength(tool.description ?? "", "utf8")).toBeLessThanOrEqual(2048);
    const listed = f.lines
      .map((line) =>
        expectActivityLogProof("mcp.managed.lifecycle.line", formatActivityLogProofLine(line)),
      )
      .find((event) => event.phase === "listed");
    expect(listed).toMatchObject({
      toolCount: 2,
      omittedToolCount: 198,
      truncatedDescriptionCount: 2,
    });
    expect(await connection.call("tool_3", {}, context())).toMatchObject({
      content: [{ text: "ok" }],
    });
  });

  it("bounds the total description budget of an unrestricted catalog", async () => {
    const f = fixture({
      tools: many.slice(0, 60).map((tool) => ({ ...tool, description: "e".repeat(4000) })),
    });
    const connection = await f.connect();
    const total = connection.tools.reduce(
      (sum, tool) => sum + Buffer.byteLength(tool.description ?? "", "utf8"),
      0,
    );
    expect(total).toBeLessThanOrEqual(128 * 1024);
    expect(connection.tools).toHaveLength(60);
  });
});

describe("closed failure reasons and the call's own budget (findings 6 and 7)", () => {
  it("reports a caller abort as aborted, never as a protocol error", async () => {
    const f = fixture({
      intercept: (rpc, request) => (rpc.method === "tools/call" ? stalled(request) : undefined),
    });
    const connection = await f.connect();
    const caller = new AbortController();
    const pending = rejection(connection.call("work", {}, context({ signal: caller.signal })));
    await vi.waitFor(() => {
      expect(f.frames).toContain("tools/call");
    });
    caller.abort();
    const error = await pending;
    expect(error.reason).toBe("aborted");
    expect(error.effect).toBe("possible");
  });

  it("reports a silent server as deadline-exceeded after the idle budget", async () => {
    const f = fixture({
      intercept: (rpc, request) => (rpc.method === "tools/call" ? stalled(request) : undefined),
    });
    const connection = await f.connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = rejection(connection.call("work", {}, context()));
    await vi.waitFor(() => {
      expect(f.frames).toContain("tools/call");
    });
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).reason).toBe("deadline-exceeded");
  });

  it("lets progress notifications extend the idle budget up to the hard cap", async () => {
    let progress: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const f = fixture({
      intercept: async (rpc, _request, forward) => {
        if (rpc.method !== "tools/call") return undefined;
        const token = rpc.params?._meta?.progressToken;
        const real: unknown = await (await forward()).json();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              const frame = (message: unknown): void => {
                writeFrame(controller, message);
              };
              progress = (): void => {
                frame({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: { progressToken: token, progress: 1 },
                });
              };
              finish = (): void => {
                frame(real);
                controller.close();
              };
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const connection = await f.connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = connection.call("work", {}, context());
    await vi.waitFor(() => {
      expect(progress).toBeDefined();
    });
    await vi.advanceTimersByTimeAsync(20_000);
    progress?.();
    await vi.advanceTimersByTimeAsync(20_000);
    progress?.();
    await vi.advanceTimersByTimeAsync(20_000);
    finish?.();
    expect(await pending).toMatchObject({ content: [{ text: "ok" }] });
  });
});

describe("an unchanged catalog does not retire the connection", () => {
  it("accepts a re-listing whose key order differs", async () => {
    let lists = 0;
    const f = fixture({
      intercept: async (rpc, request) => {
        if (rpc.method !== "tools/list" || ++lists < 2) return undefined;
        const body = (await (await fixtureHandlerResponse(f, request)).json()) as {
          result: { tools: Record<string, unknown>[] };
        };
        body.result.tools = body.result.tools.map((tool) =>
          Object.fromEntries(Object.entries(tool).reverse()),
        );
        return Response.json(body);
      },
    });
    const connection = await f.connect();
    expect(await connection.call("work", {}, context())).toMatchObject({
      content: [{ text: "ok" }],
    });
    expect(connection.signal.aborted).toBe(false);
  });
});

async function fixtureHandlerResponse(_fixture: Fixture, request: Request): Promise<Response> {
  return serverFor({}).fetch(request);
}

describe("a failed connect names its cause (finding 6)", () => {
  function connectFailures(f: Fixture): string[] {
    return f.lines
      .map((line) =>
        expectActivityLogProof("mcp.managed.lifecycle.line", formatActivityLogProofLine(line)),
      )
      .filter((event) => event.phase === "failed")
      .map((event) => `${String(event.reason)}/${String(event.connectCause)}`);
  }

  it("names a server that never answers the handshake as a timeout", async () => {
    const f = fixture({ intercept: (_rpc, request) => stalled(request) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attempt = f.connect().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await attempt).toMatchObject({ reason: "deadline-exceeded" });
    expect(connectFailures(f)).toContain("deadline-exceeded/timeout");
  });

  it("names an aborted attempt as aborted", async () => {
    const controller = new AbortController();
    const second = fixture({ intercept: (_rpc, request) => stalled(request) });
    const aborted = connectExternalMcp({
      signal: controller.signal,
      correlationId: "resilience-abort",
      log: { write: (event): void => void second.lines.push(event) },
      transport: {
        kind: "remote",
        url: "https://synthetic.example.test/mcp",
        transport: "streamable-http",
        fetch: (input, init) => stalled(new Request(input, init)),
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    controller.abort();
    expect(await aborted).toMatchObject({ reason: "aborted" });
    expect(connectFailures(second)).toContain("aborted/aborted");
  });
});
