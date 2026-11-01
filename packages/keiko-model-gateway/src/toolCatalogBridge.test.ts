import { readFileSync } from "node:fs";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  createToolCatalog,
  createKeikoToolCatalog,
  createToolDescriptor,
  compileToolProjection,
  OPENCODE_NATIVE_EXTENSION_DEFINITIONS,
  opencodeRegistrationSet,
} from "@oscharko-dev/keiko-tool-catalog";
import {
  CHANGESET_EDIT_ARGUMENT_LIMITS,
  TOOL_CATALOG_LIMITS,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  gatewayCatalogAdvertisement,
  openCodeGatewayCatalogAdvertisement,
} from "./__fixtures__/toolCatalog.js";
import { describe, expect, it, vi } from "vitest";
import { createInitialToolCatalog, gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";
import { GATEWAY_NATIVE_EXACT_CONTENT_TOOLS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  GatewayNativeToolAdvertisement,
  GatewayToolCatalogAdvertisement,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { ModelGatewayLogTransport } from "./observability.js";
import { withCorrelationId } from "./observability.js";
import {
  createGatewayToolCatalogBridge,
  GatewayToolCatalogError,
  type GatewayToolCatalogBridge,
} from "./toolCatalogBridge.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import type {
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  NormalizedToolCall,
} from "./types.js";
import { NATIVE_TOOL_CATALOG_RUNTIME } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS,
  gatewayNativeToolDefinitionBytes,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";

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

function response(
  args: unknown = { path: "src/example.ts" },
  usage?: { readonly promptTokens: number; readonly completionTokens: number },
): Response {
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
      ...(usage === undefined
        ? {}
        : {
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
            },
          }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
function request(): GatewayRequest {
  return { modelId: CONFIG.modelId, messages: [{ role: "user", content: "fixture" }] };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} record`);
  }
  return value as Record<string, unknown>;
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
  it.each([
    ["keiko_workspace_read", "whole-file SHA-256"],
    ["keiko_workspace_read", "nextStartLine"],
    ["keiko_changeset_edit", "expectedContentHash"],
    ["keiko_changeset_edit", "selectedFiles"],
    ["keiko_changeset_edit", sha256Hex("")],
  ])("preserves actionable read/edit guidance for %s: %s", async (name, guidance) => {
    let body: unknown;
    const fetchImpl: typeof fetch = (_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected serialized request");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    await adapter(fetchImpl).call(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      CONFIG,
    );
    expect(body).toMatchObject({
      tools: expect.arrayContaining([
        {
          type: "function",
          function: expect.objectContaining({
            name,
            description: expect.stringContaining(guidance) as unknown,
          }) as unknown,
        },
      ]) as unknown,
    });
  });

  it.each([
    "keiko_git_stage",
    "keiko_git_commit",
    "keiko_git_push",
    "keiko_pull_request",
    "keiko_git_execute",
  ])("sends current approval continuation instructions to the provider for %s", async (name) => {
    let body: unknown;
    const fetchImpl: typeof fetch = (_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected serialized request");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    await adapter(fetchImpl).call(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      CONFIG,
    );
    expect(body).toMatchObject({
      tools: expect.arrayContaining([
        {
          type: "function",
          function: expect.objectContaining({
            name,
            description: expect.stringContaining('approvalDisposition: "ready"') as unknown,
          }) as unknown,
        },
      ]) as unknown,
    });
  });

  it("advertises the required bounded verification target sentinel to the actual provider", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = (_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected serialized request");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    };
    await adapter(fetchImpl).call(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      CONFIG,
    );
    const tools = requiredRecord(body, "provider request").tools;
    if (!Array.isArray(tools)) throw new TypeError("Expected provider tools array");
    const verification = tools
      .map((tool) => requiredRecord(tool, "provider tool"))
      .find(
        (tool) => requiredRecord(tool.function, "provider function").name === "keiko_verification",
      );
    if (verification === undefined) throw new Error("Expected verification tool advertisement");
    const advertisedFunction = requiredRecord(verification.function, "verification function");
    const parameters = requiredRecord(advertisedFunction.parameters, "verification parameters");
    const properties = requiredRecord(parameters.properties, "verification properties");
    expect(typeof advertisedFunction.description).toBe("string");
    expect(parameters.type).toBe("object");
    expect(parameters.required).toEqual(["targetPath", "verifierId"]);
    expect(requiredRecord(properties.targetPath, "targetPath schema")).toMatchObject({
      type: "string",
      minLength: 0,
      maxLength: 4096,
    });
  });

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
  log: ModelGatewayLogTransport[] = [],
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
    ).rejects.toMatchObject({ status: "invalid", retryable: false });
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
    const log: ModelGatewayLogTransport[] = [];
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
    // The projection line names how long the offer stays bindable (the fixture mints NOW + 30 s), so
    // an `expired-compatibility` rejection is reconstructable next to the fetch duration.
    expect(events[0]).toMatchObject({ extra: { offerRemainingMs: 30_000 } });
    expect(events.at(-1)).toMatchObject({
      errorKind: "validation-failed",
      extra: {
        phase: "response",
        status: "invalid",
        reason: "invalid-arguments",
        catalogReason: "invalid-shape",
        canonicalToolId: "keiko.file.read",
        contractVersion: 1,
        // The schema's account of the mismatch (run 7, 2026-09-10): the undeclared property is
        // counted, never named -- its name is model text.
        missingRequired: [],
        missingRequiredCount: 0,
        invalidPaths: [],
        invalidPathCount: 0,
        unexpectedPropertyCount: 1,
        droppedPathCount: 0,
      },
    });
    const projectedPersisted = expectActivityLogProof(
      "gateway.tool-catalog.projected.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(projectedPersisted).toMatchObject({ compatibility: "bound", offerRemainingMs: 30_000 });
    const callBoundPersisted = expectActivityLogProof(
      "gateway.tool-catalog.call-bound.emitted-line",
      formatActivityLogProofLine(events[1] ?? {}),
    );
    expect(callBoundPersisted).toMatchObject({ toolCount: 1 });
    const rejectedPersisted = expectActivityLogProof(
      "gateway.tool-catalog.rejected.emitted-line",
      formatActivityLogProofLine(events.at(-1) ?? {}),
    );
    expect(rejectedPersisted).toMatchObject({
      phase: "response",
      status: "invalid",
      reason: "invalid-arguments",
    });
  });

  it("retains reported usage when invalid tool arguments reject an HTTP 200 response", async () => {
    const subject = adapter(() =>
      Promise.resolve(
        response(
          { path: "raw-body", extra: "raw-body" },
          {
            promptTokens: 41,
            completionTokens: 7,
          },
        ),
      ),
    );

    await expect(
      subject.call({ ...request(), toolCatalog: advertisement() }, CONFIG),
    ).rejects.toMatchObject({
      retryable: true,
      partialUsage: { promptTokens: 41, completionTokens: 7, streamedChars: 0 },
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
            adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
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

describe("exact-content tool resolution (#4009)", () => {
  it("names only the offered changeset edit, resolved by catalog identity", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    const exact = bridge.tools.map((tool) => tool.name).filter(bridge.isExactContentTool);
    expect(exact).toEqual(["keiko_changeset_edit"]);
    expect(bridge.isExactContentTool("question")).toBe(false);
    expect(bridge.isExactContentTool("keiko_research_fetch")).toBe(false);
    expect(bridge.isExactContentTool("unoffered_changeset_edit")).toBe(false);
  });

  it("names no exact-content tool without a catalog advertisement", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: undefined },
      (): number => NOW,
    );
    expect(bridge.isExactContentTool("keiko_changeset_edit")).toBe(false);
  });
});

describe("native extensions (OpenCode V2 question, #3414 follow-up)", () => {
  it("merges a bound advertisement's native extensions into the model-visible tool list", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    // Derived from the producer, never a restated count: every catalog entry of the OpenCode
    // registration set plus its declared native extensions is model-visible.
    expect(bridge.tools).toHaveLength(
      opencodeRegistrationSet().entries.length +
        (opencodeRegistrationSet().nativeExtensions?.length ?? 0),
    );
    expect(bridge.tools.some((tool) => tool.name === "execute")).toBe(false);
    for (const definition of OPENCODE_NATIVE_EXTENSION_DEFINITIONS.filter(
      (entry) => entry.alias === "question",
    )) {
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
    const events: ModelGatewayLogTransport[] = [];
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
      {
        write: (event): void => {
          events.push(event);
        },
      },
    );
    bridge.bind({ id: "call-1", name: "question", arguments: { questions: [] } });
    expect(events.map((event) => event.op)).toEqual([
      "gateway.tool-catalog.projected",
      "gateway.tool-catalog.native-passthrough",
    ]);
    expect(JSON.stringify(events)).not.toContain("questions");
    const passthroughPersisted = expectActivityLogProof(
      "gateway.tool-catalog.native-passthrough.emitted-line",
      formatActivityLogProofLine(events[1] ?? {}),
    );
    expect(passthroughPersisted).toMatchObject({ toolCount: 1 });
  });

  it("still rejects an unoffered, non-extension alias against an opencode advertisement", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    expect(() => bridge.bind({ id: "call-1", name: "not_a_real_tool", arguments: {} })).toThrow(
      expect.objectContaining({ retryable: true }),
    );
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
      bridge.bind({ id: "call-1", name: "question", arguments: { questions: [oversized] } }),
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
    const events: ModelGatewayLogTransport[] = [];
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
    bridge.bind({ id: "call-1", name: "question", arguments: { questions: [] } });
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
      const log: ModelGatewayLogTransport[] = [];
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

  // The array-level check used to reuse `TOOL_CATALOG_LIMITS.maxArgumentBytes` -- sized for ONE
  // call's arguments -- as a budget shared across the WHOLE batch, so several individually-legal
  // calls could combine past that ceiling and be rejected wholesale.
  it("binds a batch whose combined size exceeds one call's byte budget, when every call is individually within it", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    const bigQuestion = "x".repeat(65_000); // under maxStringBytes (65_536) on its own
    const calls = Array.from({ length: 5 }, (_unused, index) => ({
      id: `call-${String(index)}`,
      name: "question",
      arguments: { questions: [bigQuestion] },
    }));
    expect(bigQuestion.length * calls.length).toBeGreaterThan(TOOL_CATALOG_LIMITS.maxArgumentBytes);
    const bound = bridge.bindCalls(calls);
    expect(bound.map((call) => call.id)).toEqual(calls.map((call) => call.id));
  });

  it("still rejects a single call whose own arguments exceed the per-call byte budget", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    const tooBig = "x".repeat(65_000);
    const calls = Array.from({ length: 5 }, (_unused, index) => ({
      id: `call-${String(index)}`,
      name: "question",
      // Five strings well past maxArgumentBytes on their own -- this ONE call must still fail.
      arguments: { questions: [tooBig, tooBig, tooBig, tooBig, tooBig] },
    }));
    expect(() => bridge.bindCalls(calls)).toThrow(GatewayToolCatalogError);
  });

  it("rejects a sparse calls array smuggled past a plain length check", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    const calls = [{ id: "call-0", name: "question", arguments: { questions: [] } }];
    calls.length = 2; // a hole at index 1: no own property, but `.length` reports 2
    expect(() => bridge.bindCalls(calls)).toThrow(
      expect.objectContaining({ reason: "invalid-arguments" }),
    );
  });

  // #3394 review: a hole ALONE already trips the own-keys-count check above (it changes
  // `Reflect.ownKeys(calls).length` relative to `calls.length + 1`). Pairing the hole with one
  // smuggled extra own key restores that coincidental match, so only a per-index denseness walk
  // -- not `Array.prototype.every`, which skips holes instead of visiting them -- still catches
  // it. Unpatched, this array sailed through unbound with a hole at index 1: `bindCalls` returned
  // a frozen 2-length array containing only one real bound call, silently, with no thrown error.
  it("rejects a sparse calls array whose hole is masked by a matching smuggled own key", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
    const calls = [{ id: "call-0", name: "question", arguments: { questions: [] } }];
    calls.length = 2; // a hole at index 1
    (calls as unknown as Record<string, unknown>).extra = "x"; // keeps ownKeys.length === length+1
    expect(() => bridge.bindCalls(calls)).toThrow(
      expect.objectContaining({ reason: "invalid-arguments" }),
    );
  });
});

function codeModeAdvertisement(): GatewayToolCatalogAdvertisement {
  const set = opencodeRegistrationSet("code-mode");
  const catalog = createKeikoToolCatalog([set]);
  const projection = compileToolProjection(catalog, set.profile);
  const legacy = openCodeGatewayCatalogAdvertisement(NOW);
  const offered = {
    ...legacy.offered,
    binding: {
      ...legacy.offered.binding,
      catalogRevision: catalog.catalogRevision,
      profile: projection.profile,
      projectionDigest: projection.projectionDigest,
      handlerSetDigest: projection.projectionDigest,
    },
    toolRefs: projection.tools.map((tool) => tool.toolRef),
  };
  return { kind: "bound", catalog, projection, offered };
}

describe("inactive native Code Mode provider advertisement", () => {
  it("offers only original outer extensions while retaining all governed inner bindings", () => {
    const advertisement = codeModeAdvertisement();
    const bridge = createGatewayToolCatalogBridge(
      { modelId: "fixture", messages: [], toolCatalog: advertisement },
      () => NOW,
    );
    expect(bridge.tools.map((tool) => tool.name).sort()).toEqual(["execute", "question"]);
    // Every governed inner binding stays, including keiko_git_branch (#3907).
    expect(advertisement.projection.tools).toHaveLength(19);
    expect(advertisement.projection.tools.map((tool) => tool.toolRef.canonicalId)).toContain(
      "keiko.git.branch",
    );
    const native = JSON.parse(
      readFileSync(
        new URL(
          "../../keiko-server/src/coding-runtime/opencodeToolSchemas.opencode-2.0.10-codemode.fixture.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly tools: readonly {
        readonly name: string;
        readonly parameters: unknown;
        readonly description: string;
      }[];
    };
    for (const tool of native.tools) {
      const projected = bridge.tools.find((entry) => entry.name === tool.name);
      expect(projected?.parameters).toEqual(tool.parameters);
      if (tool.name === "execute") expect(projected?.description).toBe(tool.description);
    }
  });

  it("uses alias/version lookup when sorted extensions put execute first", () => {
    const advertisement = codeModeAdvertisement();
    expect(advertisement.projection.nativeExtensions[0]?.alias).toBe("execute");
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: advertisement },
      () => NOW,
    );
    expect(bridge.tools.map((tool) => tool.name)).toEqual(["execute", "question"]);
    expect(bridge.tools.find((tool) => tool.name === "execute")?.parameters).not.toEqual(
      bridge.tools.find((tool) => tool.name === "question")?.parameters,
    );
  });

  it("keeps execute unbound and logs no JavaScript body", () => {
    const events: ModelGatewayLogTransport[] = [];
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: codeModeAdvertisement() },
      () => NOW,
      {
        write: (event): void => {
          events.push(event);
        },
      },
    );
    const call = {
      id: "call-native",
      name: "execute",
      arguments: { code: "return 'private-body';" },
    };
    expect(bridge.bind(call)).toEqual(call);
    expect(bridge.bind(call)).not.toHaveProperty("invocation");
    expect(JSON.stringify(events)).not.toContain("private-body");
    const event = events.find((entry) => entry.op === "gateway.tool-catalog.native-passthrough");
    expectActivityLogProof(
      "gateway.tool-catalog.native-passthrough.emitted-line",
      formatActivityLogProofLine(event ?? {}),
    );
  });

  it("refuses a provider direct call to a hidden governed capability", () => {
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: codeModeAdvertisement() },
      () => NOW,
    );
    expect(() =>
      bridge.bind({
        id: "call-direct",
        name: "keiko_workspace_discover",
        arguments: { query: "*", maxResults: 1 },
      }),
    ).toThrow(expect.objectContaining({ reason: "unoffered-tool" }));
  });

  it("enforces original offer expiry and argument budgets on execute passthrough", () => {
    let time = NOW;
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: codeModeAdvertisement() },
      () => time,
    );
    expect(() =>
      bridge.bind({
        id: "call-big",
        name: "execute",
        arguments: { code: "x".repeat(TOOL_CATALOG_LIMITS.maxStringBytes + 1) },
      }),
    ).toThrow();
    time += 30_000;
    expect(() =>
      bridge.bind({ id: "call-expired", name: "execute", arguments: { code: "return 1;" } }),
    ).toThrow();
  });
});

describe("inactive Code Mode profile substitution", () => {
  it("rejects a direct offer or projection substituted into Code Mode", () => {
    const grouped = codeModeAdvertisement();
    const direct = openCodeGatewayCatalogAdvertisement(NOW);
    for (const value of [
      { ...grouped, offered: direct.offered },
      { ...grouped, projection: direct.projection },
    ]) {
      expect(() =>
        createGatewayToolCatalogBridge({ ...request(), toolCatalog: value }, () => NOW),
      ).toThrow(GatewayToolCatalogError);
    }
  });
});

// ─── Native OpenCode tool advertisement (#3897) ──────────────────────────────────────────────
// The pinned runtime's own definitions are forwarded to the provider as data and every returned call
// is handed back by name only: no Keiko handler is bound, OpenCode executes under its policy.

const NATIVE_OFFER_MS = 30_000;
const NATIVE_DIGEST = sha256Hex("native-tool-set-fixture");
const NATIVE_CANARY = "private-native-argument-canary";
const NATIVE_TOOL_NAMES = ["read", "edit", "write", "patch", "shell"] as const;

function nativeAdvertisement(now = NOW): GatewayNativeToolAdvertisement {
  return {
    kind: "native",
    runtime: { id: "opencode", version: "2.1.4" },
    tools: NATIVE_TOOL_NAMES.map((name) => ({
      name,
      description: `The ${name} tool of the fixture runtime.`,
      parameters: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
    })),
    toolSetDigest: NATIVE_DIGEST,
    offered: {
      offerId: "opencode-native-1",
      expiresAt: new Date(now + NATIVE_OFFER_MS).toISOString(),
    },
  };
}

function looseNativeAdvertisement(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...nativeAdvertisement(), ...overrides };
}

function nativeBridge(
  toolCatalog: unknown = nativeAdvertisement(),
  now: () => number = (): number => NOW,
  recordProjection = true,
): { readonly bridge: GatewayToolCatalogBridge; readonly events: ModelGatewayLogTransport[] } {
  const events: ModelGatewayLogTransport[] = [];
  const bridge = createGatewayToolCatalogBridge(
    { ...request(), toolCatalog } as GatewayRequest,
    now,
    {
      write: (event): void => {
        events.push(event);
      },
    },
    recordProjection,
  );
  return { bridge, events };
}

function nativeCall(
  name = "read",
  id = "call-1",
  args: Record<string, unknown> = { target: "src/a.ts" },
): NormalizedToolCall {
  return { id, name, arguments: args };
}

function textResponse(
  content: string,
  toolCalls: readonly NormalizedToolCall[] = [],
): NormalizedResponse {
  return {
    modelId: CONFIG.modelId,
    content,
    finishReason: "stop",
    toolCalls,
    structuredOutput: null,
    usage: {
      requestId: "request-1",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function opsOf(events: readonly ModelGatewayLogTransport[]): string[] {
  return events.map((event) => event.op);
}

describe("native tool advertisement bridge: projection", () => {
  it("offers the advertised definitions verbatim and in order, as frozen data", () => {
    const advertisement = nativeAdvertisement();
    const { bridge } = nativeBridge(advertisement);
    expect(bridge.tools).toEqual(advertisement.tools);
    expect(Object.isFrozen(bridge.tools)).toBe(true);
    expect(bridge.tools.every((tool) => Object.isFrozen(tool))).toBe(true);
  });

  it("logs one body-free projection line naming the native compatibility and the digest", () => {
    const advertisement = nativeAdvertisement();
    const { events } = nativeBridge(advertisement);
    expect(opsOf(events)).toEqual(["gateway.tool-catalog.projected"]);
    expect(events[0]).toMatchObject({
      extra: {
        projectionDigest: NATIVE_DIGEST,
        toolCount: advertisement.tools.length,
        compatibility: "native",
        offerRemainingMs: NATIVE_OFFER_MS,
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("fixture runtime");
    expect(serialized).not.toContain("properties");
    const persisted = expectActivityLogProof(
      "gateway.tool-catalog.projected.emitted-line",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({ compatibility: "native", offerRemainingMs: NATIVE_OFFER_MS });
  });

  it("records the projection once only when the caller asks for it", () => {
    const { bridge, events } = nativeBridge(nativeAdvertisement(), () => NOW, false);
    expect(events).toEqual([]);
    expect(bridge.tools).toHaveLength(NATIVE_TOOL_NAMES.length);
  });

  it("reports no remaining offer time once the offer has run out, and still projects it", () => {
    const { bridge, events } = nativeBridge(nativeAdvertisement(), () => NOW + NATIVE_OFFER_MS + 1);
    expect(bridge.tools).toHaveLength(NATIVE_TOOL_NAMES.length);
    expect(events[0]).toMatchObject({ extra: { offerRemainingMs: 0 } });
  });

  it("treats exactly the workspace-content tools as exact-content tools", () => {
    const { bridge } = nativeBridge();
    for (const name of GATEWAY_NATIVE_EXACT_CONTENT_TOOLS)
      expect(bridge.isExactContentTool(name)).toBe(true);
    const exact = new Set<string>(GATEWAY_NATIVE_EXACT_CONTENT_TOOLS);
    for (const tool of bridge.tools.filter((entry) => !exact.has(entry.name)))
      expect(bridge.isExactContentTool(tool.name)).toBe(false);
  });

  it("carries the advertisement to the provider and returns a native call unbound", async () => {
    let body: unknown;
    const fetchImpl: typeof fetch = (_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected serialized request");
      body = JSON.parse(init.body) as unknown;
      return Promise.resolve(
        new Response(
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
                      function: { name: "read", arguments: JSON.stringify({ target: "src/a.ts" }) },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };
    const advertisement = nativeAdvertisement();
    const result = await adapter(fetchImpl).call(
      { ...request(), toolCatalog: advertisement },
      CONFIG,
    );
    expect(requiredRecord(body, "provider request").tools).toEqual(
      advertisement.tools.map(({ name, description, parameters }) => ({
        type: "function",
        function: { name, description, parameters },
      })),
    );
    expect(result.toolCalls).toEqual([nativeCall()]);
    expect(result.toolCalls[0]).not.toHaveProperty("invocation");
  });
});

describe("native tool advertisement bridge: admission", () => {
  it.each([
    ["no tools", looseNativeAdvertisement({ tools: [] })],
    ["a malformed tool-set digest", looseNativeAdvertisement({ toolSetDigest: "not-a-digest" })],
    ["an unknown extra key", looseNativeAdvertisement({ extra: true })],
    [
      "an unsupported runtime",
      looseNativeAdvertisement({ runtime: { id: "other", version: "1.0.0" } }),
    ],
    [
      "a malformed runtime version",
      looseNativeAdvertisement({ runtime: { id: "opencode", version: "latest" } }),
    ],
    [
      "a repeated tool name",
      looseNativeAdvertisement({
        tools: nativeAdvertisement().tools.concat(nativeAdvertisement().tools.slice(0, 1)),
      }),
    ],
    [
      "an unparsable expiry",
      looseNativeAdvertisement({ offered: { offerId: "o", expiresAt: "soon" } }),
    ],
    [
      "an empty offer id",
      looseNativeAdvertisement({ offered: { offerId: "", expiresAt: "2030-01-01T00:00:00Z" } }),
    ],
  ])("refuses a native advertisement with %s before any transport", (_label, toolCatalog) => {
    const events: ModelGatewayLogTransport[] = [];
    expect(() =>
      createGatewayToolCatalogBridge(
        { ...request(), toolCatalog } as unknown as GatewayRequest,
        () => NOW,
        {
          write: (event): void => {
            events.push(event);
          },
        },
      ),
    ).toThrow(expect.objectContaining({ reason: "projection-mismatch" }));
    expect(opsOf(events)).toEqual(["gateway.tool-catalog.rejected"]);
    expect(events[0]).toMatchObject({
      errorKind: "validation-failed",
      extra: { phase: "projection", status: "invalid", reason: "projection-mismatch" },
    });
  });

  it("refuses a native advertisement beside handwritten provider tools", () => {
    const toolCatalog = nativeAdvertisement();
    const tools = [{ name: "read", description: "read", parameters: {} }];
    expect(() =>
      createGatewayToolCatalogBridge(
        { ...request(), toolCatalog, tools } as GatewayRequest,
        () => NOW,
      ),
    ).toThrow(expect.objectContaining({ reason: "projection-mismatch" }));
  });

  it("never executes an accessor while inspecting a native advertisement", () => {
    let reads = 0;
    const hostile = looseNativeAdvertisement({});
    Object.defineProperty(hostile, "tools", {
      enumerable: true,
      get: () => {
        reads += 1;
        return nativeAdvertisement().tools;
      },
    });
    expect(() => nativeBridge(hostile)).toThrow(GatewayToolCatalogError);
    expect(reads).toBe(0);
  });

  it("refuses a native advertisement carrying an unsafe prototype key", () => {
    const hostile = JSON.parse(
      JSON.stringify(nativeAdvertisement()).replace('"required"', '"__proto__"'),
    ) as unknown;
    expect(() => nativeBridge(hostile)).toThrow(
      expect.objectContaining({ reason: "projection-mismatch" }),
    );
  });

  // #3897 review: a whole native advertisement is captured under its own byte contract, not one
  // call's 256 KiB budget, so every advertisement the server admits reaches the provider.
  it("captures an admitted native advertisement above one call's budget and refuses one byte over", () => {
    const { maxSchemaBytes, maxTotalBytes } = GATEWAY_NATIVE_TOOL_ADVERTISEMENT_LIMITS;
    const toolOf = (name: string, bytes: number): Record<string, unknown> => {
      const empty = gatewayNativeToolDefinitionBytes({
        name,
        description: "",
        parameters: { p: "" },
      });
      return { name, description: "", parameters: { p: "x".repeat(bytes - empty) } };
    };
    const count = maxTotalBytes / maxSchemaBytes;
    const atBudget = Array.from({ length: count }, (_unused, index) =>
      toolOf(`full_${String(index)}`, maxSchemaBytes),
    );
    expect(maxTotalBytes).toBeGreaterThan(TOOL_CATALOG_LIMITS.maxArgumentBytes);
    expect(nativeBridge(looseNativeAdvertisement({ tools: atBudget })).bridge.tools).toHaveLength(
      count,
    );
    const overByOne = [
      ...atBudget.slice(0, -1),
      toolOf(`full_${String(count - 1)}`, maxSchemaBytes + 1),
    ];
    expect(() => nativeBridge(looseNativeAdvertisement({ tools: overByOne }))).toThrow(
      expect.objectContaining({ reason: "projection-mismatch" }),
    );
  });
});

describe("native tool advertisement bridge: call binding", () => {
  it("hands an offered call back by name, untouched and without a Keiko invocation", () => {
    const { bridge } = nativeBridge();
    // The runtime validates arguments against its own schema; the bridge does not.
    const call = nativeCall("shell", "call-shell", { anything: [1, { nested: true }], target: 7 });
    const bound = bridge.bind(call);
    expect(bound).toEqual(call);
    expect(bound).not.toHaveProperty("invocation");
  });

  it("logs a body-free passthrough line under the tool-set digest and the caller's correlation", () => {
    const events: ModelGatewayLogTransport[] = [];
    const bridge = createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: nativeAdvertisement() },
      () => NOW,
      withCorrelationId(
        {
          write: (event): void => {
            events.push(event);
          },
        },
        "correlation-native",
      ),
    );
    bridge.bind(nativeCall("read", "call-1", { target: NATIVE_CANARY }));
    expect(opsOf(events)).toEqual([
      "gateway.tool-catalog.projected",
      "gateway.tool-catalog.native-passthrough",
    ]);
    expect(events[1]).toMatchObject({
      correlationId: "correlation-native",
      extra: { projectionDigest: NATIVE_DIGEST, toolCount: 1 },
    });
    expect(JSON.stringify(events)).not.toContain(NATIVE_CANARY);
    const persisted = expectActivityLogProof(
      "gateway.tool-catalog.native-passthrough.emitted-line",
      formatActivityLogProofLine(events[1] ?? {}),
    );
    expect(persisted).toMatchObject({ projectionDigest: NATIVE_DIGEST, toolCount: 1 });
  });

  // #3897 (resilience, parity): the native producer owns its tools and binding grants nothing, so a
  // name the request did not offer reaches OpenCode, which answers the model with its own
  // unavailable-tool result and continues the turn (pinned against the real 2.1.4 binary in
  // opencodeNativeProjectBoundary.real.test.ts). Refusing it here ended the whole turn.
  it.each(["not_advertised", "Read", "read ", "execute", "keiko_workspace_read"])(
    "passes the unadvertised tool name %j to the producer and counts it unoffered",
    (name) => {
      const { bridge, events } = nativeBridge();
      const bound = bridge.bind(nativeCall(name, "call-1", { target: NATIVE_CANARY }));
      expect(bound).toMatchObject({ id: "call-1", name });
      expect(bound).not.toHaveProperty("invocation");
      expect(opsOf(events)).toEqual([
        "gateway.tool-catalog.projected",
        "gateway.tool-catalog.native-passthrough",
      ]);
      expect(events[1]).toMatchObject({
        extra: { projectionDigest: NATIVE_DIGEST, toolCount: 1, unofferedCount: 1 },
      });
      expect(JSON.stringify(events)).not.toContain(NATIVE_CANARY);
      expectActivityLogProof(
        "gateway.tool-catalog.native-passthrough.emitted-line",
        formatActivityLogProofLine(events[1] ?? {}),
      );
    },
  );

  it("binds until the offer expires: one millisecond before expiry binds, the expiry itself does not", () => {
    let time = NOW + NATIVE_OFFER_MS - 1;
    const { bridge, events } = nativeBridge(nativeAdvertisement(), () => time);
    expect(bridge.bind(nativeCall())).toEqual(nativeCall());
    time = NOW + NATIVE_OFFER_MS;
    expect(() => bridge.bind(nativeCall())).toThrow(
      expect.objectContaining({ reason: "invalid-arguments", retryable: false }),
    );
    time = NOW + NATIVE_OFFER_MS + 60_000;
    expect(() => bridge.bind(nativeCall())).toThrow(GatewayToolCatalogError);
    expect(events.filter((event) => event.op === "gateway.tool-catalog.rejected")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      extra: {
        phase: "response",
        reason: "invalid-arguments",
        catalogReason: "expired-compatibility",
      },
    });
    expect(
      events.filter((event) => event.op === "gateway.tool-catalog.native-passthrough"),
    ).toHaveLength(1);
  });

  it.each([
    ["an extra key", { id: "call-1", name: "read", arguments: {}, extra: true }],
    ["no arguments", { id: "call-1", name: "read" }],
    ["an empty call id", { id: "", name: "read", arguments: {} }],
    ["a call id with a space", { id: "call 1", name: "read", arguments: {} }],
    ["an over-long call id", { id: "c".repeat(129), name: "read", arguments: {} }],
    ["a non-string tool name", { id: "call-1", name: 7, arguments: {} }],
    [
      "an oversized string argument",
      {
        id: "call-1",
        name: "read",
        arguments: { target: "x".repeat(TOOL_CATALOG_LIMITS.maxStringBytes + 1) },
      },
    ],
    [
      "an unsafe prototype key",
      {
        id: "call-1",
        name: "read",
        arguments: JSON.parse('{"__proto__":{"injected":true}}') as unknown,
      },
    ],
  ])("rejects a call with %s as an invalid argument payload", (_label, call) => {
    const { bridge, events } = nativeBridge();
    expect(() => bridge.bind(call as unknown as NormalizedToolCall)).toThrow(
      expect.objectContaining({ reason: "invalid-arguments" }),
    );
    expect(opsOf(events)).not.toContain("gateway.tool-catalog.native-passthrough");
  });
});

describe("native tool advertisement bridge: call batches", () => {
  it("binds every offered call of a batch in order and logs each passthrough", () => {
    const { bridge, events } = nativeBridge();
    const calls = [nativeCall("read", "call-1"), nativeCall("shell", "call-2", { target: "ls" })];
    const bound = bridge.bindCalls(calls);
    expect(bound).toEqual(calls);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(bound.every((call) => !("invocation" in call))).toBe(true);
    expect(
      events.filter((event) => event.op === "gateway.tool-catalog.native-passthrough"),
    ).toHaveLength(2);
  });

  it("binds an empty batch to an empty frozen list", () => {
    const { bridge, events } = nativeBridge();
    const bound = bridge.bindCalls([]);
    expect(bound).toEqual([]);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(opsOf(events)).toEqual(["gateway.tool-catalog.projected"]);
  });

  it("passes a batch through when one call names an unadvertised tool", () => {
    const { bridge, events } = nativeBridge();
    const bound = bridge.bindCalls([
      nativeCall("read", "call-1"),
      nativeCall("not_advertised", "call-2"),
    ]);
    expect(bound.map((call) => call.name)).toEqual(["read", "not_advertised"]);
    const unoffered = events
      .filter((event) => event.op === "gateway.tool-catalog.native-passthrough")
      .map((event) => (event.extra as { unofferedCount?: number } | undefined)?.unofferedCount);
    expect(unoffered).toEqual([undefined, 1]);
  });

  it("refuses repeated call ids, a non-array batch and an over-long batch", () => {
    const { bridge, events } = nativeBridge();
    expect(() =>
      bridge.bindCalls([nativeCall("read", "same"), nativeCall("edit", "same")]),
    ).toThrow(expect.objectContaining({ reason: "invalid-arguments" }));
    expect(() => bridge.bindCalls("read" as unknown as readonly NormalizedToolCall[])).toThrow(
      expect.objectContaining({ reason: "invalid-arguments" }),
    );
    const tooMany = Array.from(
      { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
      (_unused, index) => nativeCall("read", `call-${String(index)}`),
    );
    expect(() => bridge.bindCalls(tooMany)).toThrow(
      expect.objectContaining({ reason: "invalid-arguments" }),
    );
    expect(opsOf(events)).not.toContain("gateway.tool-catalog.native-passthrough");
  });
});

describe("native tool advertisement bridge: assistant-text tool calls", () => {
  const MARKER = (alias: string): string =>
    `<|tool_call>call:${alias}{target:<|"|>${NATIVE_CANARY}<|"|>}<tool_call|>`;

  it("refuses prose that spells a call to an advertised tool and names it for one repair", () => {
    const { bridge, events } = nativeBridge();
    let thrown: unknown;
    try {
      bridge.assertNativeTransport(textResponse(MARKER("read")));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayToolCatalogError);
    expect(thrown).toMatchObject({
      reason: "invalid-arguments",
      retryable: true,
      repair: {
        toolCallId: "assistant-text-call",
        offeredAlias: "read",
        transport: "assistant-text",
      },
    });
    expect(events.at(-1)).toMatchObject({
      extra: { phase: "response", reason: "invalid-arguments", transport: "assistant-text" },
    });
    expect(JSON.stringify(events)).not.toContain(NATIVE_CANARY);
  });

  it.each([
    ["a spelled call to an unadvertised tool", textResponse(MARKER("not_advertised"))],
    ["a spelled call inside a code fence", textResponse(`\`\`\`\n${MARKER("read")}\n\`\`\``)],
    ["ordinary prose", textResponse("I will read the file next.")],
    ["a structured call beside the spelled one", textResponse(MARKER("read"), [nativeCall()])],
  ])("lets %s through", (_label, response) => {
    const { bridge, events } = nativeBridge();
    expect(() => {
      bridge.assertNativeTransport(response);
    }).not.toThrow();
    expect(opsOf(events)).toEqual(["gateway.tool-catalog.projected"]);
  });
});

// Owner decision 2026-10-28: a model's file content is never refused at 64 KiB. The mapped
// changeset edit carries up to the changeset cap in one string; the native file-content tools
// (edit, write, patch) are held to the same ceilings; every other call keeps the generic bound.
describe("file content in a model tool call", () => {
  function changesetCall(newString: string, oldString = ""): NormalizedToolCall {
    return {
      id: "call-edit",
      name: "keiko_changeset_edit",
      arguments: {
        changeset: {
          edits: [{ file: "src/data.json", oldString, newString, replaceAll: false }],
          deletions: [],
          renames: [],
          files: [{ file: "src/data.json", expectedContentHash: "a".repeat(64) }],
          selectedFiles: ["src/data.json"],
        },
      },
    };
  }
  function mappedBridge(): GatewayToolCatalogBridge {
    return createGatewayToolCatalogBridge(
      { ...request(), toolCatalog: openCodeGatewayCatalogAdvertisement(NOW) },
      (): number => NOW,
    );
  }

  it("binds a mapped changeset edit above the generic 256 KiB and 64 KiB ceilings", () => {
    const big = "y".repeat(TOOL_CATALOG_LIMITS.maxArgumentBytes + 1);
    const [bound] = mappedBridge().bindCalls([changesetCall(big)]);
    expect(bound?.id).toBe("call-edit");
  });

  it("binds a mapped changeset edit string of exactly the cap and refuses one byte more", () => {
    const cap = "z".repeat(CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes);
    expect(mappedBridge().bindCalls([changesetCall(cap)])).toHaveLength(1);
    expect(() => mappedBridge().bindCalls([changesetCall(`${cap}z`)])).toThrow(
      GatewayToolCatalogError,
    );
  });

  // #4110: the legacy patch tools carry a unified diff and follow the shared patch cap.
  it.each(["propose_patch", "apply_patch"])(
    "binds a %s diff above the generic ceilings, up to exactly the cap",
    (name) => {
      const bridge = createGatewayToolCatalogBridge(
        { ...request(), toolCatalog: advertisement() },
        (): number => NOW,
      );
      const call = (diff: string): NormalizedToolCall => ({
        id: "call-patch",
        name,
        arguments: { diff },
      });
      const cap = "z".repeat(CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes);
      expect(
        bridge.bindCalls([call("y".repeat(TOOL_CATALOG_LIMITS.maxArgumentBytes + 1))]),
      ).toHaveLength(1);
      expect(bridge.bindCalls([call(cap)])).toHaveLength(1);
      expect(() => bridge.bindCalls([call(`${cap}z`)])).toThrow(GatewayToolCatalogError);
    },
  );

  it("does not widen any other mapped tool", () => {
    const call = {
      id: "call-question",
      name: "question",
      arguments: { questions: ["x".repeat(TOOL_CATALOG_LIMITS.maxStringBytes + 1)] },
    };
    expect(() => mappedBridge().bindCalls([call])).toThrow(GatewayToolCatalogError);
  });

  it("hands a native file-content call above 64 KiB back unbound, and a native read still bounded", () => {
    const { bridge } = nativeBridge();
    const big = "w".repeat(TOOL_CATALOG_LIMITS.maxStringBytes + 1);
    for (const name of ["edit", "write", "patch"])
      expect(bridge.bindCalls([nativeCall(name, "call-big", { target: big })])).toHaveLength(1);
    expect(() => bridge.bindCalls([nativeCall("read", "call-read", { target: big })])).toThrow(
      GatewayToolCatalogError,
    );
    expect(() =>
      bridge.bindCalls([
        nativeCall("write", "call-over", {
          target: "x".repeat(CHANGESET_EDIT_ARGUMENT_LIMITS.maxStringBytes + 1),
        }),
      ]),
    ).toThrow(GatewayToolCatalogError);
  });
});
