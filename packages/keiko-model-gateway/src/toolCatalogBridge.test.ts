import {
  createToolCatalog,
  createToolDescriptor,
  compileToolProjection,
  OPENCODE_NATIVE_EXTENSION_DEFINITIONS,
  opencodeRegistrationSet,
} from "@oscharko-dev/keiko-tool-catalog";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  gatewayCatalogAdvertisement,
  openCodeGatewayCatalogAdvertisement,
} from "./__fixtures__/toolCatalog.js";
import { describe, expect, it, vi } from "vitest";
import { createInitialToolCatalog, gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";
import type { GatewayToolCatalogAdvertisement } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { ModelGatewayLogEvent } from "./observability.js";
import { withCorrelationId } from "./observability.js";
import { createGatewayToolCatalogBridge, GatewayToolCatalogError } from "./toolCatalogBridge.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { GatewayRequest, GatewayStreamChunk, ModelProviderConfig } from "./types.js";

const NOW = Date.parse("2026-09-05T00:00:00.000Z");
const CONFIG: ModelProviderConfig = {
  modelId: "fixture-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-key",
  timeoutMs: 1000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
function advertisement(): GatewayToolCatalogAdvertisement {
  return gatewayCatalogAdvertisement(NOW);
}

function response(args: unknown = { path: "src/example.ts" }): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
function request(): GatewayRequest {
  return { modelId: CONFIG.modelId, messages: [{ role: "user", content: "fixture" }] };
}

function toolCallDeltaLine(id: string, name: string, argumentsText: string): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, type: "function", function: { name, arguments: argumentsText } },
          ],
        },
      },
    ],
  })}\n`;
}
function toolCallFinishLine(): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n`;
}
function toolCallStream(lines: readonly string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const enc = new TextEncoder();
      for (const line of [...lines, "data: [DONE]\n"]) controller.enqueue(enc.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function collectToolCallStream(
  iterable: AsyncIterable<GatewayStreamChunk>,
): Promise<GatewayStreamChunk[]> {
  const out: GatewayStreamChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe("production gateway catalog bridge", () => {
  it("rejects unbound handwritten advertisement before transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "request-1",
      costClass: "low",
      now: (): number => NOW,
    });
    await expect(
      adapter.call(
        {
          ...request(),
          tools: [{ name: "read_file", description: "read", parameters: {} }],
        } as unknown as GatewayRequest,
        CONFIG,
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("advertises the producer projection and binds the returned alias", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = (_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected serialized request");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(response());
    };
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "request-1",
      costClass: "low",
      now: (): number => NOW,
    });
    const result = await adapter.call(
      { ...request(), ...{ toolCatalog: advertisement() } },
      CONFIG,
    );
    const catalog = createInitialToolCatalog();
    expect(body).toMatchObject({
      tools: gatewayToolDefinitions(catalog, { id: "legacy-native", version: 1 }).map(
        (definition) => ({ type: "function", function: definition }),
      ),
    });
    expect(result.toolCalls[0]).toMatchObject({
      invocation: {
        kind: "bound",
        toolRef: { canonicalId: "keiko.file.read", contractVersion: 1 },
        offerId: "offer-1",
      },
    });
  });

  it("rejects extra provider arguments through the advertised descriptor", async () => {
    const adapter = new OpenAiAdapter({
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(response({ path: "src/example.ts", unauthorized: true })),
      requestId: "request-1",
      costClass: "low",
      now: (): number => NOW,
    });
    await expect(
      adapter.call({ ...request(), ...{ toolCatalog: advertisement() } }, CONFIG),
    ).rejects.toThrow();
  });
});

function removedLegacyRequest(): GatewayRequest {
  const source = advertisement();
  const legacySession = {
    consumer: "native-harness",
    profile: { id: "legacy-native", version: 1 },
    catalogRevision: source.catalog.catalogRevision,
    projectionDigest: source.projection.projectionDigest,
    offerId: source.offered.offerId,
    openedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ownerIssue: 3409,
    removalIssue: 3415,
  };
  return {
    ...request(),
    toolCatalog: { ...source, kind: "legacy-native", legacySession },
    tools: gatewayToolDefinitions(source.catalog, source.projection.profile),
  } as unknown as GatewayRequest;
}
function adapter(
  fetchImpl: typeof fetch,
  log: ModelGatewayLogEvent[] = [],
  now = (): number => NOW,
): OpenAiAdapter {
  return new OpenAiAdapter({
    fetchImpl,
    requestId: "request-1",
    costClass: "low",
    now,
    log: {
      write: (event): void => {
        log.push(event);
      },
    },
    logContext: { correlationId: "correlation-1" },
  });
}

describe("gateway bridge trust and compatibility boundaries", () => {
  it("rejects the removed legacy advertisement and handwritten tools before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    const subject = adapter(fetchImpl);
    const definitions = gatewayToolDefinitions(
      advertisement().catalog,
      advertisement().projection.profile,
    );
    for (const input of [
      removedLegacyRequest(),
      { ...request(), toolCatalog: advertisement(), tools: definitions },
      {
        ...request(),
        toolCatalog: advertisement(),
        tools: [{ name: "read_file", description: "read", parameters: {} }],
      },
    ])
      await expect(subject.call(input, CONFIG)).rejects.toBeInstanceOf(GatewayToolCatalogError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("binds a streamed tool call, assembled from SSE deltas, at the done chunk", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        toolCallStream([
          toolCallDeltaLine("call-1", "read_file", JSON.stringify({ path: "src/example.ts" })),
          toolCallFinishLine(),
        ]),
      ),
    );
    const chunks = await collectToolCallStream(
      adapter(fetchImpl).callStream({ ...request(), toolCatalog: advertisement() }, CONFIG),
    );
    const done = chunks.find((chunk) => chunk.type === "done");
    if (done?.type !== "done") throw new Error("expected a done chunk");
    expect(done.response.toolCalls).toHaveLength(1);
    expect(done.response.toolCalls[0]).toMatchObject({
      name: "read_file",
      invocation: { kind: "bound", toolRef: { canonicalId: "keiko.file.read" } },
    });
  });

  it("rejects a streamed call to an alias absent from the offer — no result reaches the caller", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        toolCallStream([
          toolCallDeltaLine("call-1", "not_a_governed_tool", "{}"),
          toolCallFinishLine(),
        ]),
      ),
    );
    await expect(
      collectToolCallStream(
        adapter(fetchImpl).callStream({ ...request(), toolCatalog: advertisement() }, CONFIG),
      ),
    ).rejects.toMatchObject({ status: "invalid", reason: "invalid-arguments" });
  });

  it("rejects a streamed call when no catalog was advertised at all", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        toolCallStream([toolCallDeltaLine("call-1", "read_file", "{}"), toolCallFinishLine()]),
      ),
    );
    await expect(
      collectToolCallStream(adapter(fetchImpl).callStream(request(), CONFIG)),
    ).rejects.toMatchObject({ status: "invalid", reason: "unoffered-tool" });
  });

  it("rejects a streamed call carrying a malformed (non-JSON) argument payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        toolCallStream([
          toolCallDeltaLine("call-1", "read_file", "{not json"),
          toolCallFinishLine(),
        ]),
      ),
    );
    await expect(
      collectToolCallStream(
        adapter(fetchImpl).callStream({ ...request(), toolCatalog: advertisement() }, CONFIG),
      ),
    ).rejects.toThrow();
  });
  it("rejects unsolicited tool calls when no tool was advertised", async () => {
    await expect(
      adapter(() => Promise.resolve(response())).call(request(), CONFIG),
    ).rejects.toMatchObject({ status: "invalid", reason: "unoffered-tool" });
  });
  it("does not let caller mutation during transport change the captured offer", async () => {
    const source = structuredClone(advertisement());
    const result = await adapter(() => {
      Object.assign(source.offered, { offerId: "changed" });
      return Promise.resolve(response());
    }).call({ ...request(), toolCatalog: source }, CONFIG);
    expect(result.toolCalls[0]?.invocation?.offerId).toBe("offer-1");
  });
  it("rechecks expiry after the asynchronous provider response", async () => {
    let now = NOW;
    const subject = adapter(
      () => {
        now += 30_000;
        return Promise.resolve(response());
      },
      [],
      (): number => now,
    );
    await expect(
      subject.call({ ...request(), toolCatalog: advertisement() }, CONFIG),
    ).rejects.toMatchObject({ status: "invalid" });
  });
  it("keeps the bound payload identical to the existing redacted argument view", async () => {
    const result = await adapter(() => Promise.resolve(response({ path: CONFIG.apiKey }))).call(
      { ...request(), toolCatalog: advertisement() },
      CONFIG,
    );
    const call = result.toolCalls[0];
    expect(call?.invocation?.arguments).toEqual(call?.arguments);
    expect(JSON.stringify(result)).not.toContain(CONFIG.apiKey);
  });
  it("emits correlated body-free projection, binding and rejection activity", async () => {
    const log: ModelGatewayLogEvent[] = [];
    await adapter(() => Promise.resolve(response()), log).call(
      { ...request(), toolCatalog: advertisement() },
      CONFIG,
    );
    await expect(
      adapter(() => Promise.resolve(response({ path: "raw-body", extra: "raw-body" })), log).call(
        { ...request(), toolCatalog: advertisement() },
        CONFIG,
      ),
    ).rejects.toThrow();
    const events = log.filter((event) => event.op.startsWith("gateway.tool-catalog."));
    expect(events.map((event) => event.op)).toEqual([
      "gateway.tool-catalog.projected",
      "gateway.tool-catalog.call-bound",
      "gateway.tool-catalog.projected",
      "gateway.tool-catalog.rejected",
    ]);
    expect(events.every((event) => event.correlationId === "correlation-1")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("raw-body");
    expect(JSON.stringify(events)).not.toContain("src/example.ts");
    expect(events.at(-1)).toMatchObject({
      errorKind: "validation",
      extra: { phase: "response", status: "invalid", reason: "invalid-arguments" },
    });
  });
  it("never executes an accessor while inspecting the catalog advertisement", () => {
    const read = vi.fn(() => advertisement());
    const input = Object.defineProperty(request(), "toolCatalog", { enumerable: true, get: read });
    expect(() => createGatewayToolCatalogBridge(input, (): number => NOW)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("representable gateway schemas", () => {
  it("rejects primitive tool inputs before provider transport", async () => {
    const initial = createInitialToolCatalog();
    const original = initial.descriptors[0];
    if (original === undefined) throw new TypeError("Missing fixture descriptor");
    const declaration = Object.fromEntries(
      Object.entries(original).filter(([key]) => key !== "descriptorDigest"),
    );
    const descriptor = createToolDescriptor({ ...declaration, inputSchema: { type: "string" } });
    const catalog = createToolCatalog(
      {
        descriptors: [descriptor],
        profiles: [
          {
            profile: { id: "primitive-fixture", version: 1 },
            toolRefs: [{ toolRef: descriptor.toolRef, alias: "primitive" }],
            nativeExtensions: [],
            adapterDialect: { id: "gateway-json-schema", version: 1 },
            adapterRuntime: { id: "keiko", version: "0.3.17" },
            compatibility: [],
          },
        ],
        compatibility: [],
      },
      { referenceTimeMs: NOW },
    );
    const projection = compileToolProjection(catalog, { id: "primitive-fixture", version: 1 });
    const offered = {
      ...advertisement().offered,
      binding: {
        ...advertisement().offered.binding,
        catalogRevision: catalog.catalogRevision,
        profile: projection.profile,
        projectionDigest: projection.projectionDigest,
      },
      toolRefs: [descriptor.toolRef],
    };
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response()));
    await expect(
      adapter(fetchImpl).call(
        { ...request(), toolCatalog: { kind: "bound", catalog, projection, offered } },
        CONFIG,
      ),
    ).rejects.toMatchObject({ status: "invalid", reason: "unsupported-capability" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("native extensions (question/todowrite, #3414 follow-up)", () => {
  it("merges a bound advertisement's native extensions into the model-visible tool list", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    // Derived from the producer, never a restated count: every catalog entry of the OpenCode
    // registration set plus its declared native extensions is model-visible.
    expect(bridge.tools).toHaveLength(
      opencodeRegistrationSet().entries.length + OPENCODE_NATIVE_EXTENSION_DEFINITIONS.length,
    );
    for (const definition of OPENCODE_NATIVE_EXTENSION_DEFINITIONS) {
      expect(bridge.tools).toContainEqual({
        name: definition.alias,
        description: definition.description,
        parameters: definition.inputSchema,
      });
    }
  });

  it("passes a native extension call through unbound: no catalog invocation, arguments untouched", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    const call = { id: "call-1", name: "question", arguments: { questions: [] } };
    const bound = bridge.bind(call);
    expect(bound).toEqual(call);
    expect(bound).not.toHaveProperty("invocation");
  });

  it("logs a body-free passthrough event instead of a catalog bind for a native extension call", () => {
    const events: ModelGatewayLogEvent[] = [];
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
      {
        write: (event): void => {
          events.push(event);
        },
      },
    );
    bridge.bind({ id: "call-1", name: "todowrite", arguments: { todos: [] } });
    expect(events.map((event) => event.op)).toEqual([
      "gateway.tool-catalog.projected",
      "gateway.tool-catalog.native-passthrough",
    ]);
    expect(JSON.stringify(events)).not.toContain("todos");
  });

  it("still rejects an unoffered, non-extension alias against an opencode advertisement", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    expect(() => bridge.bind({ id: "call-1", name: "not_a_real_tool", arguments: {} })).toThrow();
  });

  // b1-16: native-extension passthrough shares `captureCall`'s structural check with every bound
  // call (composer.ts calls `captureCatalogJson` on the whole `{id, name, arguments}` object
  // before branching on the alias), so the same byte-budget, string-length and unsafe-key guards
  // already apply here -- these two cases prove that instead of asserting only the op name.
  it("rejects an oversized native extension argument payload before it ever passes through", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    const oversized = "x".repeat(TOOL_CATALOG_LIMITS.maxStringBytes + 1);
    expect(() =>
      bridge.bind({ id: "call-1", name: "todowrite", arguments: { todos: [oversized] } }),
    ).toThrow(GatewayToolCatalogError);
  });

  it("rejects a native extension argument payload carrying an unsafe prototype key", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    // JSON.parse (unlike an object literal) creates "__proto__" as a real own enumerable key.
    const hostile = JSON.parse('{"__proto__":{"injected":true},"questions":[]}') as Record<
      string,
      unknown
    >;
    expect(() => bridge.bind({ id: "call-1", name: "question", arguments: hostile })).toThrow(
      GatewayToolCatalogError,
    );
  });

  it("threads the caller's correlation id onto a native extension passthrough event", () => {
    // Production wires every adapter's log sink through `withCorrelationId` before it ever
    // reaches this bridge (see OpenAiAdapter's constructor) -- exercising that same wrapper here
    // is what proves the id is threaded, rather than merely asserting the op name.
    const events: ModelGatewayLogEvent[] = [];
    const sink = withCorrelationId(
      {
        write: (event): void => {
          events.push(event);
        },
      },
      "correlation-1",
    );
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
      sink,
    );
    bridge.bind({ id: "call-1", name: "todowrite", arguments: { todos: [] } });
    const passthrough = events.find(
      (event) => event.op === "gateway.tool-catalog.native-passthrough",
    );
    expect(passthrough?.correlationId).toBe("correlation-1");
  });
});

describe("malformed provider tool calls", () => {
  it.each(["{broken", "[]", "null", "42", '{"__proto__":{"injected":true},"path":"src/a.ts"}'])(
    "rejects malformed JSON or non-object/prototype arguments %s",
    async (argumentsText) => {
      const payload = {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: argumentsText },
                },
              ],
            },
          },
        ],
      };
      const subject = adapter(() =>
        Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
      );
      await expect(
        subject.call({ ...request(), toolCatalog: advertisement() }, CONFIG),
      ).rejects.toThrow();
    },
  );
  it("rejects unexpected provider identities rather than preserving a smuggled bound arm", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: advertisement() },
      (): number => NOW,
    );
    const tool = advertisement().projection.tools[0];
    if (tool === undefined) throw new TypeError("Missing fixture tool");
    expect(() =>
      bridge.bind({
        id: "call-1",
        name: "read_file",
        arguments: {},
        invocation: {
          kind: "bound",
          toolRef: tool.toolRef,
          projectionDigest: advertisement().projection.projectionDigest,
          offerId: "forged",
          arguments: {},
        },
      }),
    ).toThrow();
  });
});

describe("provider invocation batch bounds", () => {
  it.each([2, 1001])(
    "rejects a duplicate or oversized %i-call batch before binding any call",
    async (count) => {
      const calls = Array.from({ length: count }, (_, index) => ({
        id: count === 2 ? "duplicate-id" : `call-${String(index)}`,
        type: "function",
        function: { name: "read_file", arguments: '{"path":"src/example.ts"}' },
      }));
      const log: ModelGatewayLogEvent[] = [];
      const subject = adapter(
        () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: { content: "", tool_calls: calls },
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
        log,
      );
      let error: unknown;
      try {
        await subject.call({ ...request(), toolCatalog: advertisement() }, CONFIG);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(GatewayToolCatalogError);
      expect(log.some((event) => event.op === "gateway.tool-catalog.call-bound")).toBe(false);
    },
  );
});
