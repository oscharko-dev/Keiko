import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  resolveCodingSafeSidecarGatewayProfile,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type ModelCapability,
  type ModelProviderConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  createOpenCodeGatewayReadinessRegistry,
  handleCodingSidecarGatewayChatCompletions,
  handleCodingSidecarGatewayProfile,
} from "./coding-sidecar-gateway.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { STREAMING, type RouteContext, type RouteResult } from "./routes.js";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    modelId: "azure-coding-model",
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-secret",
    apiKeyHeaderName: "api-key",
    endpointStyle: "azure-openai-deployment",
    apiVersion: "2024-06-01",
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
    ...overrides,
  };
}

function capability(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "azure-coding-model",
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "coding-sidecar",
    preferredUseCases: ["Coding"],
    knownLimitations: [],
    ...overrides,
  };
}

function configValue(
  providerValue: ModelProviderConfig,
  capabilityValue: ModelCapability,
): GatewayConfig {
  return {
    providers: [providerValue],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [capabilityValue],
  };
}

function depsValue(
  config: GatewayConfig,
  chatFactory?: UiHandlerDeps["codingSidecarGatewayChatFactory"],
  env: UiHandlerDeps["env"] = {},
  evidenceStore: UiHandlerDeps["evidenceStore"] = {
    put: () => "",
    list: () => [],
    get: () => undefined,
    delete: () => undefined,
  },
  options: {
    readonly diagnostics?: UiHandlerDeps["diagnostics"];
    readonly modelSource?: UiHandlerDeps["codingSidecarGatewayModelSource"];
    readonly codingWorkbenchEvidenceStore?: UiHandlerDeps["codingWorkbenchEvidenceStore"];
    readonly evidenceAggregator?: UiHandlerDeps["codingSidecarGatewayEvidenceAggregator"];
  } = {},
): UiHandlerDeps {
  return {
    config,
    configPresent: true,
    evidenceStore,
    env,
    redactor: buildRedactor({}),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    ...(chatFactory === undefined ? {} : { codingSidecarGatewayChatFactory: chatFactory }),
    ...(options.modelSource === undefined
      ? {}
      : { codingSidecarGatewayModelSource: options.modelSource }),
    ...(options.codingWorkbenchEvidenceStore === undefined
      ? {}
      : { codingWorkbenchEvidenceStore: options.codingWorkbenchEvidenceStore }),
    ...(options.evidenceAggregator === undefined
      ? {}
      : { codingSidecarGatewayEvidenceAggregator: options.evidenceAggregator }),
    // Every sidecar request is capability-authenticated. The readiness registry
    // remains absent here so generic gateway tests do not claim the OpenCode lane.
    runtimeCapabilityAuthenticator: {
      authenticate: (capability: string, audience: "model-gateway" | "tool-facade") =>
        capability === "gateway-capability-material-0000000001" && audience === "model-gateway"
          ? { ok: true, binding: { runId: "run-gateway-test" } }
          : { ok: false },
    },
  };
}

function routeContext(body: unknown): RouteContext {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const request = mockRequest({
    method: "POST",
    url: "/api/coding-sidecar/gateway/chat/completions",
    body: rawBody,
    headers: { authorization: "Bearer gateway-capability-material-0000000001" },
  });
  const response = mockResponse();
  return {
    req: request,
    res: response.res,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/chat/completions"),
  };
}

function runtimeGatewayDeps(
  authenticate: (capability: string, audience: "model-gateway" | "tool-facade") => unknown,
  chatFactory?: UiHandlerDeps["codingSidecarGatewayChatFactory"],
  readiness = createOpenCodeGatewayReadinessRegistry(),
  streamFactory?: unknown,
): UiHandlerDeps {
  return {
    ...depsValue(configValue(provider(), capability()), chatFactory),
    runtimeCapabilityAuthenticator: { authenticate },
    openCodeGatewayReadinessRegistry: readiness,
    ...(streamFactory === undefined
      ? {}
      : { codingSidecarGatewayChatStreamFactory: streamFactory }),
  } as unknown as UiHandlerDeps;
}

function authenticatedContext(body: unknown, origin?: string): RouteContext {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const response = mockResponse({ captureBody: true });
  return {
    req: mockRequest({
      method: "POST",
      url: "/api/coding-sidecar/gateway/chat/completions",
      body: rawBody,
      headers: {
        authorization: "Bearer gateway-capability-material-0000000001",
        ...(origin === undefined ? {} : { origin }),
      },
    }),
    res: response.res,
    params: {},
    url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/chat/completions"),
  };
}

const QUESTION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  properties: {
    questions: {
      description: "Questions to ask",
      items: {
        properties: {
          header: { description: "Very short label (max 30 chars)", type: "string" },
          multiple: { description: "Allow selecting multiple choices", type: "boolean" },
          options: {
            description: "Available choices",
            items: {
              properties: {
                description: { description: "Explanation of choice", type: "string" },
                label: { description: "Display text (1-5 words, concise)", type: "string" },
              },
              required: ["label", "description"],
              type: "object",
            },
            type: "array",
          },
          question: { description: "Complete question", type: "string" },
        },
        required: ["question", "header", "options"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["questions"],
  type: "object",
} as const;

const WORKSPACE_READ_SCHEMA = {
  type: "object",
  properties: {
    relativePath: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^(?![\\\\/])(?!.*(?:^|/)\\.\\.?(/|$))(?!.*\\\\).+$",
    },
    startLine: {
      type: "integer",
      minimum: 1,
      maximum: 1_000_000,
      description: "1-based first line of the returned window; pass 1 to start at the file head.",
    },
    maxLines: {
      type: "integer",
      minimum: 1,
      maximum: 5_000,
      description:
        "Window height in lines; startLine 1 with maxLines 5000 reads a small file whole. The result reports totalLines and, when truncated, nextStartLine; the digest always covers the whole file.",
    },
  },
  // OpenCode v1.17.17 declares every custom-tool argument as required in its provider projection.
  required: ["relativePath", "startLine", "maxLines"],
} as const;

const CHANGESET_EDIT_SCHEMA = {
  type: "object",
  properties: {
    changeset: {
      type: "object",
      additionalProperties: false,
      properties: {
        patch: {
          type: "string",
          minLength: 1,
          maxLength: 65_536,
          pattern:
            "^(?:(?:(?:diff --git [^\\r\\n]+ [^\\r\\n]+\\r?\\n)(?:index [^\\r\\n]+\\r?\\n)?)?--- (?:a/|/dev/null)|:[0-7]{6} [0-7]{6} [a-f0-9]{7,64} [a-f0-9]{7,64} M [^\\r\\n]+\\r?\\n@@ )",
          description:
            "Strict unified diff for every listed file. Start each file with `--- a/<path>` and `+++ b/<path>` (or `/dev/null`), followed by one or more `@@ -old +new @@` hunks. A single-file `:100644 ... M <path>` raw-index header is accepted only as a compatibility fallback and is normalized before validation.",
        },
        files: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              file: {
                type: "string",
                minLength: 1,
                maxLength: 512,
                pattern: "^(?![\\\\/])(?!.*(?:^|/)\\.\\.?(/|$))(?!.*\\\\).+$",
              },
              expectedContentHash: {
                type: "string",
                pattern: "^[a-f0-9]{64}$",
                description: "SHA-256 digest returned by keiko_workspace_read.",
              },
            },
            required: ["file", "expectedContentHash"],
          },
          description: "Every file changed by patch, bound to its last governed read digest.",
        },
        selectedFiles: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            pattern: "^(?![\\\\/])(?!.*(?:^|/)\\.\\.?(/|$))(?!.*\\\\).+$",
          },
          description: "Optional subset of files to apply; each entry must occur in files.",
        },
      },
      required: ["patch", "files"],
    },
  },
  required: ["changeset"],
} as const;

// OpenCode v1.17.17 strips `additionalProperties` before forwarding this schema.
const VERIFICATION_PROJECTED_SCHEMA = {
  type: "object",
  properties: {
    verifierId: {
      type: "string",
      enum: ["test", "targeted-test", "typecheck", "lint", "build"],
    },
  },
  required: ["verifierId"],
} as const;

// The built-in todowrite projection is byte-identical to its source schema (#2480).
const TODO_WRITE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "Brief description of the task" },
          status: {
            type: "string",
            description: "Current status of the task: pending, in_progress, completed, cancelled",
          },
          priority: {
            type: "string",
            description: "Priority level of the task: high, medium, low",
          },
        },
        required: ["content", "status", "priority"],
      },
      description: "The updated todo list",
    },
  },
  required: ["todos"],
} as const;

const RESEARCH_FETCH_SCHEMA = {
  type: "object",
  properties: {
    target: {
      type: "string",
      minLength: 9,
      maxLength: 512,
      pattern: "^https://",
    },
  },
  required: ["target"],
} as const;

const SKILL_SCHEMA = {
  type: "object",
  properties: {
    skillId: {
      type: "string",
      pattern: "^skl_[a-z0-9][a-z0-9-]{0,62}@[0-9]{1,4}(?:\\.[0-9]{1,4}){0,2}$",
      maxLength: 80,
    },
  },
  required: ["skillId"],
} as const;

const CHILD_AGENT_SCHEMA = {
  type: "object",
  properties: {
    objective: { type: "string", minLength: 1, maxLength: 512 },
    maxToolCalls: { type: "integer", minimum: 1, maximum: 32 },
  },
  required: ["objective", "maxToolCalls"],
} as const;

const PINNED_MODEL_VISIBLE_TOOLS = [
  { name: "question", parameters: QUESTION_SCHEMA },
  { name: "keiko_workspace_read", parameters: WORKSPACE_READ_SCHEMA },
  { name: "keiko_changeset_edit", parameters: CHANGESET_EDIT_SCHEMA },
  { name: "keiko_verification", parameters: VERIFICATION_PROJECTED_SCHEMA },
  { name: "keiko_research_fetch", parameters: RESEARCH_FETCH_SCHEMA },
  { name: "keiko_skill", parameters: SKILL_SCHEMA },
  { name: "keiko_child_agent", parameters: CHILD_AGENT_SCHEMA },
  { name: "todowrite", parameters: TODO_WRITE_SCHEMA },
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function schemaDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

interface ModelVisibleRequestTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly parameters: unknown;
  };
}

function modelVisibleTools(
  tools: readonly {
    readonly name: string;
    readonly parameters: unknown;
  }[] = PINNED_MODEL_VISIBLE_TOOLS,
): ModelVisibleRequestTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, parameters: tool.parameters },
  }));
}

/**
 * Replayed child history for the adoption-gap fingerprint: two system messages, the private task
 * prompt, then `rounds` assistant/user pairs. With `toolCallName` the final round carries one
 * settled tool call so adoption (keiko_*) and planning-only loops (todowrite) stay distinguishable.
 */
function adoptionGapMessages(rounds: number, toolCallName?: string): readonly unknown[] {
  const messages: unknown[] = [
    { role: "system", content: "governed prompt" },
    { role: "system", content: "environment" },
    { role: "user", content: "private task content" },
  ];
  for (let round = 0; round < rounds; round += 1) {
    const withToolCall = toolCallName !== undefined && round === rounds - 1;
    messages.push(
      withToolCall
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: `call-${String(round)}`,
                type: "function",
                function: { name: toolCallName, arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: `private analysis ${String(round)}` },
    );
    messages.push(
      withToolCall
        ? { role: "tool", content: "private tool result", tool_call_id: `call-${String(round)}` }
        : { role: "user", content: "continue" },
    );
  }
  return messages;
}

function assertRouteResult(result: RouteResult | typeof STREAMING): asserts result is RouteResult {
  expect(result).not.toBe(STREAMING);
  if (result === STREAMING) throw new Error("Expected a buffered route result.");
}

function assistantResponse(modelId: string): NormalizedResponse {
  return {
    modelId,
    content: "assistant-content",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "req-1",
      promptTokens: 12,
      completionTokens: 8,
      latencyMs: 1,
      costClass: "medium",
    },
  };
}

async function* streamedResponse(response: NormalizedResponse): AsyncGenerator<GatewayStreamChunk> {
  await Promise.resolve();
  if (response.content.length > 0) yield { type: "delta" as const, token: response.content };
  yield { type: "done" as const, response };
}

describe("coding-sidecar gateway", () => {
  it("fails closed when a runtime gateway route has no capability authenticator", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = { ...depsValue(configValue(provider(), capability()), () => chat) } as Record<
      string,
      unknown
    >;
    delete deps.runtimeCapabilityAuthenticator;
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [],
      }),
      deps as unknown as UiHandlerDeps,
    );

    expect(result).toMatchObject({ status: 401 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("authenticates the model-gateway audience before parsing a body and rejects Origin", async () => {
    const authenticate = vi.fn(() => ({ ok: false, reason: "invalid" }));
    const malformed = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext("{"),
      runtimeGatewayDeps(authenticate),
    );
    expect(authenticate).toHaveBeenCalledWith(
      "gateway-capability-material-0000000001",
      "model-gateway",
    );
    expect(malformed).toMatchObject({ status: 401 });

    const browser = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({ messages: [{ role: "user", content: "hello" }] }, "http://evil.test"),
      runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-1" } })),
    );
    expect(browser).toMatchObject({ status: 403 });
  });

  it("accepts exactly the pinned OpenCode v1.17.17 visible schemas by canonical digest", async () => {
    expect(
      PINNED_MODEL_VISIBLE_TOOLS.map((tool) => [tool.name, schemaDigest(tool.parameters)]),
    ).toEqual([
      ["question", "4f618d23c27d7147ab8564c3ec1050c508762a19b9a4858951a9cd3089b52df3"],
      ["keiko_workspace_read", "56d2649a7a308efdc47db2899922c9889822a17b9d9bd081ee0c099a066411ac"],
      ["keiko_changeset_edit", "59902a2dd9af28ed8b97d1108215c6e88bbe0fba017a4756a99e833b9af48952"],
      ["keiko_verification", "4cd58eaead9fef3c41ef7faaacd2feb5440755e052ed67efa6b9c4860e18e988"],
      ["keiko_research_fetch", "8510b5132cc06c627c2b46c20df92c3fcca392f0d16a621b7006eb41d2bf02b5"],
      ["keiko_skill", "c3a50e828f78a32481ce662f8cd92e04dd6375af8df916f3c588b0628ff2de2d"],
      ["keiko_child_agent", "aa977e5c893cef8e1c7f6e5185836e039bb0a874e35c476d6a896a14441cb0ab"],
      ["todowrite", "0adc662a3338db20587ec0eb8dc2c057847f940e2cd2e4e6b160abd6a68173d6"],
    ]);
    const chat = vi.fn((_request: GatewayRequest) =>
      Promise.resolve(assistantResponse("azure-coding-model")),
    );
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "ask and read" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
    );

    expect(result).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0]).toMatchObject({ modelId: "azure-coding-model" });
  });

  it("fails closed when OpenCode sends the unprojected verification source schema", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const tools = modelVisibleTools(
      PINNED_MODEL_VISIBLE_TOOLS.map((tool) =>
        tool.name === "keiko_verification"
          ? { ...tool, parameters: { ...tool.parameters, additionalProperties: false } }
          : tool,
      ),
    );
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "verify" }],
        tools,
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
    );

    expect(result).toMatchObject({ status: 403 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("denies selected-upstream and arbitrary model ids on the authenticated runtime lane", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    for (const model of [undefined, "azure-coding-model", "other-profile-model"]) {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model,
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-1" } }),
          () => chat,
        ),
      );
      expect(result).toMatchObject({
        status: 400,
        body: { error: { code: "INVALID_MODEL" } },
      });
    }
    expect(chat).not.toHaveBeenCalled();
  });

  it("observes readiness only after authenticated exact tool-contract validation", async () => {
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const signal = new AbortController().signal;
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const observed = readiness.waitForObservedRequest("run-1", signal);
    const exact = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "readiness" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
        readiness,
      ),
    );
    expect(exact).toMatchObject({ status: 200 });
    await expect(observed).resolves.toBe(true);
    expect(chat).not.toHaveBeenCalled();

    const duplicate = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "normal turn" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
        readiness,
      ),
    );
    expect(duplicate).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();

    const driftAbort = new AbortController();
    let driftSettled = false;
    const driftPending = readiness
      .waitForObservedRequest("run-2", driftAbort.signal)
      .finally(() => {
        driftSettled = true;
      });
    const drifted = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "readiness" }],
        tools: modelVisibleTools().slice(0, 2),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-2" } }),
        () => chat,
        readiness,
      ),
    );
    expect(drifted).toMatchObject({ status: 403 });
    await Promise.resolve();
    expect(driftSettled).toBe(false);
    driftAbort.abort();
    await expect(driftPending).resolves.toBe(false);
    const afterAbortedReadiness = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "normal after aborted readiness" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-2" } }),
        () => chat,
        readiness,
      ),
    );
    expect(afterAbortedReadiness).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledTimes(2);

    const crossAbort = new AbortController();
    let crossSettled = false;
    const crossPending = readiness
      .waitForObservedRequest("run-a", crossAbort.signal)
      .finally(() => {
        crossSettled = true;
      });
    const crossRun = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "normal cross-run turn" }],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-b" } }),
        () => chat,
        readiness,
      ),
    );
    expect(crossRun).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    expect(crossSettled).toBe(false);
    crossAbort.abort();
    await expect(crossPending).resolves.toBe(false);
  });

  it("emits only a closed reason when the authenticated runtime tool contract is rejected", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = {
      ...runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-1" } })),
      diagnostics,
    };

    for (const [tools, code] of [
      [undefined, "CODING_GATEWAY_TOOL_CONTRACT_MISSING"],
      [[], "CODING_GATEWAY_TOOL_CONTRACT_EMPTY"],
      [modelVisibleTools().slice(0, 2), "CODING_GATEWAY_TOOL_CONTRACT_DRIFT"],
    ] as const) {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "private runtime content" }],
          ...(tools === undefined ? {} : { tools }),
        }),
        deps,
      );
      expect(result).toMatchObject({ status: 403 });
      expect(diagnostics.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "coding-sidecar-gateway.tool-contract",
          errorClass: "CodingSidecarGatewayToolContractRejection",
          message: "coding-sidecar-gateway-tool-contract-rejected",
          code,
        }),
      );
    }
    expect(diagnostics.record).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("private runtime content");
  });

  it("emits the tool-adoption-gap diagnostic once per run for keiko_*-free governed histories", async () => {
    // #2680 live-probe fingerprint: many model requests, zero keiko_* facade calls. The
    // diagnostic is observability only — the request must keep flowing to the model — and a
    // persisting gap must not flood the operator log with one record per request.
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
        readiness,
      ),
      diagnostics,
    };
    const send = async (): Promise<void> => {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: adoptionGapMessages(3),
          tools: modelVisibleTools(),
        }),
        deps,
      );
      expect(result).toMatchObject({ status: 200 });
    };
    const adoptionRecords = (): readonly ServerDiagnosticRecord[] =>
      diagnostics.record.mock.calls
        .map(([record]) => record)
        .filter((record) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP");

    await send();
    await send();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(adoptionRecords()).toHaveLength(1);
    expect(adoptionRecords()[0]).toMatchObject({
      source: "coding-sidecar-gateway.tool-adoption",
      errorClass: "CodingSidecarGatewayToolAdoptionGap",
      message: "coding-sidecar-gateway-tool-adoption-gap",
    });
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("private");

    // A disposed run releases the mark; the next run's gap is diagnosable again.
    readiness.clear("run-1");
    await send();
    expect(adoptionRecords()).toHaveLength(2);
  });

  it("keeps planning-only todowrite loops inside the tool-adoption-gap fingerprint", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      diagnostics,
    };
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: adoptionGapMessages(3, "todowrite"),
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(
      diagnostics.record.mock.calls.some(
        ([record]) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP",
      ),
    ).toBe(true);
  });

  it("stays silent below the adoption threshold and once one keiko_* call is in the history", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      diagnostics,
    };
    for (const messages of [
      adoptionGapMessages(1),
      adoptionGapMessages(3, "keiko_workspace_read"),
    ]) {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({ model: "coding", messages, tools: modelVisibleTools() }),
        deps,
      );
      expect(result).toMatchObject({ status: 200 });
    }
    expect(
      diagnostics.record.mock.calls.some(
        ([record]) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP",
      ),
    ).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("never fingerprints an empty or threshold-minus-one history", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      diagnostics,
    };
    // The gap fires at TOOL_ADOPTION_GAP_MESSAGE_THRESHOLD (9) messages; the builder only yields
    // odd counts, so the exact 8-message boundary is constructed inline alongside the empty case.
    const thresholdMinusOne: readonly unknown[] = [
      { role: "system", content: "governed prompt" },
      { role: "system", content: "environment" },
      { role: "user", content: "private task content" },
      { role: "assistant", content: "private analysis 0" },
      { role: "user", content: "next" },
      { role: "assistant", content: "private analysis 1" },
      { role: "user", content: "next" },
      { role: "assistant", content: "private analysis 2" },
    ];
    expect(thresholdMinusOne).toHaveLength(8);
    for (const messages of [[] as readonly unknown[], thresholdMinusOne]) {
      await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({ model: "coding", messages, tools: modelVisibleTools() }),
        deps,
      );
    }
    expect(
      diagnostics.record.mock.calls.some(
        ([record]) => record.code === "CODING_GATEWAY_TOOL_ADOPTION_GAP",
      ),
    ).toBe(false);
  });

  it("admits tool-free compaction only after the exact runtime handshake and before disposal", async () => {
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const controller = new AbortController();
    const observed = readiness.waitForObservedRequest("run-1", controller.signal);
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-1" } }),
      () => chat,
      readiness,
    );
    const request = (tools?: readonly ModelVisibleRequestTool[]): RouteContext =>
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "bounded private runtime content" }],
        ...(tools === undefined ? {} : { tools }),
      });

    expect(await handleCodingSidecarGatewayChatCompletions(request(), deps)).toMatchObject({
      status: 403,
    });
    expect(readiness.isVerified("run-1")).toBe(false);
    expect(
      await handleCodingSidecarGatewayChatCompletions(request(modelVisibleTools()), deps),
    ).toMatchObject({ status: 200 });
    await expect(observed).resolves.toBe(true);
    expect(readiness.isVerified("run-1")).toBe(true);
    readiness.clear("run-1", true);

    expect(await handleCodingSidecarGatewayChatCompletions(request(), deps)).toMatchObject({
      status: 200,
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(await handleCodingSidecarGatewayChatCompletions(request([]), deps)).toMatchObject({
      status: 403,
    });

    readiness.clear("run-1");
    expect(readiness.isVerified("run-1")).toBe(false);
    expect(await handleCodingSidecarGatewayChatCompletions(request(), deps)).toMatchObject({
      status: 403,
    });
    expect(chat).toHaveBeenCalledOnce();
  });

  it("canonicalizes key order but denies empty, drifted, unknown, and productive built-in tools", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const acceptedWithReorderedKeys = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "continue" }],
        tools: modelVisibleTools([
          { name: "question", parameters: { ...QUESTION_SCHEMA, required: ["questions"] } },
          {
            name: "keiko_workspace_read",
            parameters: {
              required: ["relativePath", "startLine", "maxLines"],
              properties: { ...WORKSPACE_READ_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_changeset_edit",
            parameters: {
              required: ["changeset"],
              properties: { ...CHANGESET_EDIT_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_verification",
            parameters: {
              required: ["verifierId"],
              properties: { ...VERIFICATION_PROJECTED_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_research_fetch",
            parameters: {
              required: ["target"],
              properties: { ...RESEARCH_FETCH_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_skill",
            parameters: {
              required: ["skillId"],
              properties: { ...SKILL_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_child_agent",
            parameters: {
              required: ["objective", "maxToolCalls"],
              properties: { ...CHILD_AGENT_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "todowrite",
            parameters: {
              required: ["todos"],
              properties: { ...TODO_WRITE_SCHEMA.properties },
              type: "object",
              $schema: "https://json-schema.org/draft/2020-12/schema",
            },
          },
        ]),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
    );
    expect(acceptedWithReorderedKeys).toMatchObject({ status: 200 });

    for (const tools of [
      modelVisibleTools().map((tool) => ({
        ...tool,
        function: { ...tool.function, parameters: {} },
      })),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS.slice(0, 1),
        {
          name: "keiko_workspace_read",
          parameters: {
            ...WORKSPACE_READ_SCHEMA,
            properties: { relativePath: { type: "string", minLength: 1 } },
          },
        },
        PINNED_MODEL_VISIBLE_TOOLS[2],
      ]),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS,
        { name: "unknown_tool", parameters: QUESTION_SCHEMA },
      ]),
      modelVisibleTools([
        ...PINNED_MODEL_VISIBLE_TOOLS,
        { name: "bash", parameters: QUESTION_SCHEMA },
      ]),
    ]) {
      const denied = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools,
        }),
        runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-1" } }),
          () => chat,
        ),
      );
      expect(denied).toMatchObject({ status: 403 });
    }
    expect(chat).toHaveBeenCalledOnce();
  });

  it("preserves assistant tool_calls and tool_call_id on continuation turns", async () => {
    const seen: GatewayRequest[] = [];
    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "keiko_workspace_read",
                  arguments: '{"relativePath":"src/a.ts"}',
                },
              },
            ],
          },
          { role: "tool", content: "result", tool_call_id: "call-1" },
        ],
        tools: modelVisibleTools(),
      }),
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        (): ((request: GatewayRequest) => Promise<NormalizedResponse>) =>
          (request: GatewayRequest): Promise<NormalizedResponse> => {
            seen.push(request);
            return Promise.resolve(assistantResponse("azure-coding-model"));
          },
      ),
    );

    expect(result).toMatchObject({ status: 200 });
    expect(seen[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [expect.objectContaining({ id: "call-1" })],
        }),
        expect.objectContaining({ role: "tool", toolCallId: "call-1" }),
      ]),
    );
  });

  it("emits the pinned role, text, terminal, and done frame order for final text", async () => {
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [
          { role: "user", content: "finish" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-edit",
                type: "function",
                function: {
                  name: "keiko_changeset_edit",
                  arguments: '{"changeset":{"patch":"bounded"}}',
                },
              },
            ],
          },
          { role: "tool", content: "completed", tool_call_id: "call-edit" },
        ],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> =>
          Promise.resolve({ ...assistantResponse("azure-coding-model"), content: "Completed." }),
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          streamedResponse({ ...assistantResponse("azure-coding-model"), content: "Completed." }),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(response.res.writableEnded).toBe(true);
    const frames = response
      .body()
      .trim()
      .split("\n\n")
      .map((frame) => frame.slice("data: ".length));
    expect(frames).toHaveLength(5);
    expect(JSON.parse(frames[0] ?? "null")).toMatchObject({
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(JSON.parse(frames[1] ?? "null")).toMatchObject({
      choices: [{ delta: { content: "Completed." }, finish_reason: null }],
    });
    expect(JSON.parse(frames[2] ?? "null")).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    expect(JSON.parse(frames[3] ?? "null")).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
    expect(frames[4]).toBe("[DONE]");
  });

  it("synthesizes OpenAI SSE from a buffered tool-call response", async () => {
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "read" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const normalized: NormalizedResponse = {
      ...assistantResponse("azure-coding-model"),
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call-1", name: "keiko_workspace_read", arguments: { relativePath: "src/a.ts" } },
      ],
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> =>
          Promise.resolve(normalized),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body()).toContain('"tool_calls"');
    expect(response.body()).toContain('"finish_reason":"tool_calls"');
    expect(response.body()).toContain("data: [DONE]");
  });

  it("commits the buffered SSE handshake before waiting for the provider", async () => {
    vi.useFakeTimers();
    let resolveProvider: ((response: NormalizedResponse) => void) | undefined;
    const provider = new Promise<NormalizedResponse>((resolve) => {
      resolveProvider = resolve;
    });
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "wait for a tool" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const pending = handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-buffered-handshake" } }),
        (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> => provider,
      ),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.body()).toContain('"role":"assistant"');
      expect(response.body()).not.toContain(": keep-alive");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(response.body()).toContain(": keep-alive\n\n");

      resolveProvider?.(assistantResponse("azure-coding-model"));
      await expect(pending).resolves.toBe(STREAMING);
      const settledBody = response.body();
      expect(settledBody).toContain("data: [DONE]");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(response.body()).toBe(settledBody);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a buffered provider call on response close and run stop", async () => {
    for (const cancellation of ["response-close", "run-stop"] as const) {
      const run = new AbortController();
      let seenSignal: AbortSignal | undefined;
      let observeAbort: (() => void) | undefined;
      const providerAborted = new Promise<void>((resolve) => {
        observeAbort = resolve;
      });
      const chat = vi.fn(
        (request: GatewayRequest): Promise<NormalizedResponse> =>
          new Promise((_resolve, reject) => {
            seenSignal = request.cancellationSignal;
            request.cancellationSignal?.addEventListener(
              "abort",
              () => {
                observeAbort?.();
                reject(new Error("provider cancellation details must not escape"));
              },
              { once: true },
            );
          }),
      );
      const deps = {
        ...runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-cancel" } }),
          () => chat,
        ),
        codingSidecarGatewayCancellationRegistry: { signalFor: () => run.signal },
      } as unknown as UiHandlerDeps;
      const context = authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "cancel" }],
        tools: modelVisibleTools(),
      });

      const pending = handleCodingSidecarGatewayChatCompletions(context, deps);
      await vi.waitFor((): void => {
        expect(chat).toHaveBeenCalledOnce();
      });
      if (cancellation === "response-close") context.res.emit("close");
      else run.abort();
      await expect(providerAborted).resolves.toBeUndefined();
      await expect(pending).resolves.toMatchObject({ status: 503 });
      expect(seenSignal?.aborted).toBe(true);
    }
  });

  it("passes the sidecar deadline through to an in-flight provider call", async () => {
    let seenSignal: AbortSignal | undefined;
    let observeAbort: (() => void) | undefined;
    const providerAborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    const chat = vi.fn(
      (request: GatewayRequest): Promise<NormalizedResponse> =>
        new Promise((_resolve, reject) => {
          seenSignal = request.cancellationSignal;
          request.cancellationSignal?.addEventListener(
            "abort",
            () => {
              observeAbort?.();
              reject(new Error("deadline cancellation details must not escape"));
            },
            { once: true },
          );
        }),
    );
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-deadline" } }),
        () => chat,
      ),
      config: configValue(provider({ timeoutMs: 10 }), capability()),
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "deadline" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    await expect(providerAborted).resolves.toBeUndefined();
    expect(result).toMatchObject({ status: 503 });
    expect(seenSignal?.aborted).toBe(true);
  });

  it("rejects buffered responses that exceed completion-token or UTF-8 output bounds", async () => {
    const oversizedArguments = { secretLikePayload: "x".repeat(800) };
    const responses: readonly NormalizedResponse[] = [
      {
        ...assistantResponse("azure-coding-model"),
        content: "too many",
        usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 3 },
      },
      {
        ...assistantResponse("azure-coding-model"),
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call-oversized", name: "keiko_workspace_read", arguments: oversizedArguments },
        ],
        usage: { ...assistantResponse("azure-coding-model").usage, completionTokens: 1 },
      },
    ];
    for (const response of responses) {
      const deps = {
        ...runtimeGatewayDeps(
          () => ({ ok: true, binding: { runId: "run-output" } }),
          (): (() => Promise<NormalizedResponse>) => (): Promise<NormalizedResponse> =>
            Promise.resolve(response),
        ),
        config: configValue(provider(), capability({ maxOutputTokens: 2 })),
      } as UiHandlerDeps;
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "bounded" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      expect(result).toEqual({
        status: 503,
        body: {
          error: {
            code: "CODING_SIDECAR_UNAVAILABLE",
            message: "Coding sidecar gateway is unavailable.",
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("secretLikePayload");
    }
  });

  it("uses the injected gateway stream, bounds cumulative output, and returns it on overflow", async () => {
    let returned = false;
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      try {
        await Promise.resolve();
        yield { type: "delta", token: "x".repeat(20) };
        yield { type: "done", response: assistantResponse("azure-coding-model") };
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "bounded stream" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      config: configValue(provider(), capability({ maxOutputTokens: 2 })),
    } as UiHandlerDeps;
    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    expect(returned).toBe(true);
    expect(response.body()).not.toContain("x".repeat(20));
    expect(response.body()).toContain('"finish_reason":"length"');
    expect(response.body()).toContain("data: [DONE]");
  });

  it("counts only each new UTF-8 stream delta instead of re-encoding accumulated output", async () => {
    const firstToken = "gateway-delta-one-α";
    const secondToken = "gateway-delta-two-β";
    const byteLength = vi.spyOn(Buffer, "byteLength");
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: firstToken };
      yield { type: "delta", token: secondToken };
      yield { type: "done", response: assistantResponse("azure-coding-model") };
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "stream incrementally" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-stream" } }),
      undefined,
      createOpenCodeGatewayReadinessRegistry(),
      (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
        stream(),
    );

    try {
      const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

      expect(result).toBe(STREAMING);
      expect(response.body()).toContain(firstToken);
      expect(response.body()).toContain(secondToken);
      expect(byteLength.mock.calls.some(([value]) => value === firstToken + secondToken)).toBe(
        false,
      );
    } finally {
      byteLength.mockRestore();
    }
  });

  it("counts a UTF-8 surrogate pair split across stream deltas as one scalar", async () => {
    const record = vi.fn();
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: "\ud83d" };
      yield { type: "delta", token: "\ude00" };
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "stream one emoji" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      config: configValue(provider(), capability({ maxOutputTokens: 1 })),
      codingSidecarGatewayEvidenceAggregator: { record },
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    expect(response.body()).not.toContain('"finish_reason":"length"');
    expect(response.body()).toContain('"finish_reason":"error"');
    expect(record).toHaveBeenCalledWith({
      runId: "run-stream",
      outcome: "failed",
      completionTokens: 1,
      outputBytes: 4,
    });
  });

  it("returns the injected stream and aborts its provider signal when the client disconnects", async () => {
    let returned = false;
    let seenSignal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = async function* (request: GatewayRequest): AsyncGenerator<GatewayStreamChunk> {
      seenSignal = request.cancellationSignal;
      started?.();
      try {
        await new Promise<void>((resolve) => {
          request.cancellationSignal?.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
        });
        yield* [] as GatewayStreamChunk[];
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "disconnect" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-stream-cancel" } }),
      undefined,
      createOpenCodeGatewayReadinessRegistry(),
      (): ((request: GatewayRequest) => AsyncIterable<GatewayStreamChunk>) =>
        (request: GatewayRequest): AsyncIterable<GatewayStreamChunk> =>
          stream(request),
    );

    const pending = handleCodingSidecarGatewayChatCompletions(context, deps);
    await streamStarted;
    context.res.emit("close");
    await expect(pending).resolves.toBe(STREAMING);
    expect(seenSignal?.aborted).toBe(true);
    expect(returned).toBe(true);
  });

  it("cancels the provider iterator when the streaming response applies backpressure", async () => {
    let pulls = 0;
    let returned = false;
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      try {
        await Promise.resolve();
        pulls += 1;
        yield { type: "delta", token: "first" };
        pulls += 1;
        yield { type: "delta", token: "must-not-be-pulled" };
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    let writes = 0;
    response.res.write = vi.fn(() => {
      writes += 1;
      return writes === 1;
    });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "stream slowly" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-backpressure" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(returned).toBe(true);
    expect(pulls).toBe(1);
    expect(response.res.destroyed).toBe(true);
  });

  it("reports a stream that ends without a terminal response chunk as an error", async () => {
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: "partial" };
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "truncate" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-truncated" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(response.body()).toContain('"finish_reason":"error"');
    expect(response.body()).not.toContain('"finish_reason":"stop"');
  });

  it("destroys the response when the terminal tool-call frame hits backpressure", async () => {
    let returned = false;
    const toolResponse: NormalizedResponse = {
      ...assistantResponse("azure-coding-model"),
      content: "",
      toolCalls: [{ id: "call-1", name: "workspace_read", arguments: { path: "README.md" } }],
    };
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      try {
        await Promise.resolve();
        yield { type: "done", response: toolResponse };
      } finally {
        returned = true;
      }
    };
    const response = mockResponse({ captureBody: true });
    let writes = 0;
    response.res.write = vi.fn(() => {
      writes += 1;
      return writes === 1;
    });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "tool call backpressure" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-tool-backpressure" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
    );

    expect(result).toBe(STREAMING);
    expect(returned).toBe(true);
    expect(response.res.destroyed).toBe(true);
  });

  it("returns an opaque 503 when stream construction fails before committing SSE headers", async () => {
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "construct stream" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      context,
      runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-setup" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> => {
          throw new Error("private stream setup failure");
        },
      ),
    );

    assertRouteResult(result);
    expect(result).toMatchObject({ status: 503 });
    expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
  });
  it("projects an available coding-capable model without provider endpoint or credential details", () => {
    const result = resolveCodingSafeSidecarGatewayProfile(configValue(provider(), capability()));

    expect(result).toMatchObject({
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "azure-coding-model",
      localEndpointPath: "/api/coding-sidecar/gateway",
      supportsStreaming: false,
      supportsToolCalling: true,
    });
    expect(JSON.stringify(result)).not.toContain("baseUrl");
    expect(JSON.stringify(result)).not.toContain("apiKey");
    expect(JSON.stringify(result)).not.toContain("api-key");
  });

  it("surfaces the same content-free projection through the profile route", () => {
    const put = vi.fn((_runId: string, _json: string): string => "");
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
    } satisfies RouteContext;
    const deps = depsValue(configValue(provider(), capability()), undefined, {}, undefined, {
      codingWorkbenchEvidenceStore: {
        put,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
    });
    const result = handleCodingSidecarGatewayProfile(context, deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "available",
      profileId: "coding-safe-openai-compatible",
      modelAlias: "azure-coding-model",
    });
    expect(JSON.stringify(result.body)).not.toContain("baseUrl");
    expect(JSON.stringify(result.body)).not.toContain("apiKey");
    expect(put).not.toHaveBeenCalled();
  });

  it("fails closed through the profile route when the injected model source is subscription-backed", () => {
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
    } satisfies RouteContext;
    const result = handleCodingSidecarGatewayProfile(
      context,
      depsValue(
        configValue(provider(), capability()),
        undefined,
        {},
        {
          put: () => "",
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        { modelSource: "chatgpt-codex-subscription-profile" },
      ),
    );

    expect(result).toEqual({
      status: 200,
      body: {
        status: "unavailable",
        reason: "subscription-source",
      },
    });
  });

  it.each([
    {
      label: "Azure",
      config: configValue(
        provider({ endpointStyle: "azure-openai-deployment", apiKeyHeaderName: "api-key" }),
        capability(),
      ),
    },
    {
      label: "LiteLLM",
      config: configValue(
        provider({
          modelId: "litellm-coding-model",
          baseUrl: "https://litellm.example/v1",
          apiKey: "litellm-secret",
          apiKeyHeaderName: "x-litellm-key",
          endpointStyle: "openai-compatible",
        }),
        capability({ id: "litellm-coding-model" }),
      ),
    },
    {
      label: "CodeCoda",
      config: configValue(
        provider({
          modelId: "codecoda-coding-model",
          baseUrl: "https://codecoda.example/v1",
          apiKey: "codecoda-secret",
          apiKeyHeaderName: "x-api-key",
        }),
        capability({ id: "codecoda-coding-model" }),
      ),
    },
  ])("selects $label-style provider config and keeps the projection content-free", ({ config }) => {
    const result = resolveCodingSafeSidecarGatewayProfile(config);

    expect(result.status).toBe("available");
    expect(JSON.stringify(result)).not.toContain("https://");
    expect(JSON.stringify(result)).not.toContain("api-key");
    expect(JSON.stringify(result)).not.toContain("x-litellm-key");
    expect(JSON.stringify(result)).not.toContain("x-api-key");
  });

  it.each([
    {
      label: "non-chat",
      config: configValue(
        provider({ modelId: "text-model" }),
        capability({ id: "text-model", kind: "embedding" }),
      ),
      reason: "non-chat",
    },
    {
      label: "no tool calling",
      config: configValue(
        provider({ modelId: "no-tools" }),
        capability({ id: "no-tools", toolCalling: false }),
      ),
      reason: "no-tool-calling",
    },
    {
      label: "workflow disabled",
      config: configValue(
        provider({ modelId: "no-workflow" }),
        capability({ id: "no-workflow", workflowEligible: false }),
      ),
      reason: "non-workflow-eligible",
    },
    {
      label: "missing credential",
      config: configValue(
        provider({ modelId: "missing-credential", baseUrl: " ", apiKey: "" }),
        capability({ id: "missing-credential" }),
      ),
      reason: "missing-credentials",
    },
  ])("fails closed for $label", ({ config, reason }) => {
    expect(resolveCodingSafeSidecarGatewayProfile(config)).toEqual({
      status: "unavailable",
      reason,
    });
  });

  it("returns non-coding-capable when the selected model is chat, tool-calling, and workflow-eligible but lacks a coding use case", () => {
    const config = configValue(
      provider({ modelId: "chat-only-sidecar" }),
      capability({ id: "chat-only-sidecar", preferredUseCases: ["Chat"] }),
    );

    expect(resolveCodingSafeSidecarGatewayProfile(config)).toEqual({
      status: "unavailable",
      reason: "non-coding-capable",
    });
  });

  it("fails closed for deployment policy and subscription source", () => {
    expect(
      resolveCodingSafeSidecarGatewayProfile(configValue(provider(), capability()), {
        deploymentPolicyDisabled: true,
      }),
    ).toEqual({ status: "unavailable", reason: "deployment-policy-disabled" });
    expect(
      resolveCodingSafeSidecarGatewayProfile(configValue(provider(), capability()), {
        modelSource: "chatgpt-codex-subscription-profile",
      }),
    ).toEqual({ status: "unavailable", reason: "subscription-source" });
  });

  it("routes chat completions through the fake seam without provider endpoint or credential data in the request", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );
    const context = routeContext({
      model: "azure-coding-model",
      messages: [{ role: "user", content: "continue" }],
      tools: [],
      temperature: 0.2,
      top_p: 0.9,
    });

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      model: "azure-coding-model",
      choices: [{ message: { role: "assistant", content: "assistant-content" } }],
    });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.maxOutputTokens).toBe(4_096);
    expect(JSON.stringify(seenRequests[0])).not.toContain("baseUrl");
    expect(JSON.stringify(seenRequests[0])).not.toContain("apiKey");
    expect(JSON.stringify(seenRequests[0])).not.toContain("api-key");
    expect(JSON.stringify(result.body)).not.toContain("provider-secret");
  });

  it("returns BAD_REQUEST for malformed OpenAI-compatible tools", async () => {
    const deps = depsValue(configValue(provider(), capability()));
    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [{ type: "function", function: { name: "search", parameters: [] } }],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body tools must be OpenAI-compatible function tools.",
        },
      },
    });
  });

  it("projects a valid OpenAI-compatible tool into the gateway request shape", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "Look up files",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          },
        ],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.tools).toEqual([
      {
        name: "search",
        description: "Look up files",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
    ]);
  });

  it("returns BAD_REQUEST for invalid JSON bodies via readJsonObject", async () => {
    const deps = depsValue(configValue(provider(), capability()));
    const result = await handleCodingSidecarGatewayChatCompletions(routeContext("{"), deps);

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body is not valid JSON.",
        },
      },
    });
  });

  it("returns BAD_REQUEST for invalid temperature before calling the gateway", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
        temperature: 2.1,
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body temperature must be a finite number between 0 and 2.",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("returns BAD_REQUEST for invalid top_p before calling the gateway", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
        top_p: 1.1,
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body top_p must be a finite number between 0 and 1.",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("returns BAD_REQUEST when messages exceed the advertised maxInputMessages", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: Array.from({ length: 65 }, (_, index) => ({
          role: "user",
          content: `message-${String(index)}`,
        })),
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body messages exceed profile maxInputMessages (64).",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("returns BAD_REQUEST when estimated prompt tokens exceed the advertised maxPromptTokens", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability({ contextWindow: 16 })),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "x".repeat(400) }],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Request body estimated prompt tokens exceed profile maxPromptTokens (16).",
        },
      },
    });
    expect(seenRequests).toHaveLength(0);
  });

  it("aggregates accepted counts without a durable per-request evidence write", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
    const record =
      vi.fn<
        (event: {
          readonly runId: string;
          readonly outcome: "accepted" | "cancelled" | "failed" | "output-limit";
          readonly completionTokens: number;
          readonly outputBytes: number;
        }) => void
      >();
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          void request;
          return Promise.resolve(assistantResponse(modelId));
        };
      },
      {},
      {
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      {
        codingWorkbenchEvidenceStore: {
          put: codingPut,
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        evidenceAggregator: { record },
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(rootPut).not.toHaveBeenCalled();
    expect(codingPut).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({
      runId: "run-gateway-test",
      outcome: "accepted",
      completionTokens: 8,
      outputBytes: expect.any(Number) as number,
    });
  });

  it.each([
    [
      "synchronous",
      (): void => {
        throw new Error("customer/path/secret-sync");
      },
    ],
    ["asynchronous", (): Promise<void> => Promise.reject(new Error("customer/path/secret-async"))],
  ])(
    "emits a content-free diagnostic for %s evidence aggregation failure",
    async (_kind, record) => {
      const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
      const deps = depsValue(
        configValue(provider(), capability()),
        (
          _config: GatewayConfig,
          modelId: string,
        ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
          return (request: GatewayRequest): Promise<NormalizedResponse> => {
            void request;
            return Promise.resolve(assistantResponse(modelId));
          };
        },
        {},
        {
          put: () => "",
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        { diagnostics, evidenceAggregator: { record } },
      );

      const result = await handleCodingSidecarGatewayChatCompletions(
        routeContext({
          model: "azure-coding-model",
          messages: [{ role: "user", content: "continue" }],
        }),
        deps,
      );

      assertRouteResult(result);
      expect(result.status).toBe(200);
      await vi.waitFor(() => {
        expect(diagnostics.record).toHaveBeenCalledTimes(1);
      });
      expect(diagnostics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: "run-gateway-test",
          operation: "POST /api/coding-sidecar/gateway/chat/completions",
          source: "coding-sidecar-gateway.evidence-aggregation",
          errorClass: "CodingSidecarGatewayEvidenceAggregationFailure",
          message: "sidecar-gateway-evidence-aggregation-failed",
        }),
      );
      expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("customer/path/secret");
    },
  );

  it("does not substitute diagnostics or root evidence for the optional aggregator", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          void request;
          return Promise.resolve(assistantResponse(modelId));
        };
      },
      {},
      {
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      { diagnostics },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(rootPut).not.toHaveBeenCalled();
    expect(diagnostics.record).not.toHaveBeenCalled();
  });

  it("returns a content-free unavailable error when deployment policy disables the gateway", async () => {
    const deps = depsValue(configValue(provider(), capability()), undefined, {
      KEIKO_CODING_SIDECAR_DISABLED: "1",
    });
    const context = routeContext({
      messages: [{ role: "user", content: "continue" }],
    });

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toEqual({
      status: 503,
      body: {
        error: {
          code: "CODING_SIDECAR_UNAVAILABLE",
          message: "Coding sidecar gateway is unavailable.",
        },
      },
    });
  });

  it("returns a content-free unavailable error for the injected subscription-backed model source", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
    const deps = depsValue(
      configValue(provider(), capability()),
      undefined,
      {},
      {
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      {
        modelSource: "chatgpt-codex-subscription-profile",
        codingWorkbenchEvidenceStore: {
          put: codingPut,
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 503,
      body: {
        error: {
          code: "CODING_SIDECAR_UNAVAILABLE",
          message: "Coding sidecar gateway is unavailable.",
        },
      },
    });
    expect(rootPut).not.toHaveBeenCalled();
    expect(codingPut).not.toHaveBeenCalled();
  });

  it("aggregates a content-free failure without a durable per-request evidence write", async () => {
    const rootPut = vi.fn((_runId: string, _json: string): string => "");
    const codingPut = vi.fn((_runId: string, _json: string): string => "");
    let capturedDiagnostic: ServerDiagnosticRecord | undefined;
    const diagnostics = {
      record: vi.fn((record: ServerDiagnosticRecord): void => {
        capturedDiagnostic = record;
      }),
    };
    const record = vi.fn();
    const hostileMessage =
      "tool call '/Users/customer/private-repo/secret-tool' has non-JSON arguments";
    const gatewayError = new ProviderError(hostileMessage, 400);
    gatewayError.requestId = "gateway-request-1";
    const deps = depsValue(
      configValue(provider(), capability()),
      (): ((request: GatewayRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayRequest): Promise<NormalizedResponse> => {
          void request;
          return Promise.reject(gatewayError);
        };
      },
      {},
      {
        put: rootPut,
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      {
        diagnostics,
        codingWorkbenchEvidenceStore: {
          put: codingPut,
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        evidenceAggregator: { record },
      },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "continue" }],
      }),
      deps,
    );

    expect(result).toEqual({
      status: 503,
      body: {
        error: {
          code: "CODING_SIDECAR_UNAVAILABLE",
          message: "Coding sidecar gateway is unavailable.",
        },
      },
    });
    expect(rootPut).not.toHaveBeenCalled();
    expect(codingPut).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({
      runId: "run-gateway-test",
      outcome: "failed",
      completionTokens: 0,
      outputBytes: 0,
    });
    expect(diagnostics.record).toHaveBeenCalledTimes(1);
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "coding-sidecar-gateway.chat",
        errorClass: "ProviderError",
        code: "GATEWAY_PROVIDER_ERROR",
        gatewayRequestId: "gateway-request-1",
        message: "server-operation-failed",
      }),
    );
    expect(JSON.stringify(capturedDiagnostic)).not.toContain(hostileMessage);
    expect(JSON.stringify(capturedDiagnostic)).not.toContain(
      "/Users/customer/private-repo/secret-tool",
    );
  });
});
