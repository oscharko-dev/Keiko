import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  resolveCodingSafeSidecarGatewayProfile,
  type GatewayCallRequest,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayStreamChunk,
  type ModelCapability,
  type ModelProviderConfig,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  createOpenCodeGatewayReadinessRegistry,
  handleCodingSidecarGatewayChatCompletions,
  handleCodingSidecarGatewayProfile,
} from "./coding-sidecar-gateway.js";
import { mockRequest, mockResponse, probeVerifiedGatewayConfig } from "./_support.js";
import {
  createOpenCodeGatewayToolCatalogAdvertisement,
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
} from "./coding-runtime/opencodeToolSchemas.js";
import { proposalIdPattern } from "./gitDelivery/proposalId.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { STREAMING, type RouteContext, type RouteResult } from "./routes.js";
import { resetGatewayInstanceCacheForTests } from "./gateway-instance-cache.js";
import { OPENCODE_RUNTIME_READINESS_PROMPT } from "./coding-runtime/opencodeLaunchProfile.js";

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
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date().toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "test-fingerprint",
    },
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
      reservePromptTokens: () => ({ ok: true, runId: "run-gateway-test" }),
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
    correlationId: undefined,
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
  let authenticatedRunId = "run-1";
  const authenticateAndRemember = (
    capability: string,
    audience: "model-gateway" | "tool-facade",
  ): unknown => {
    const value = authenticate(capability, audience);
    if (typeof value === "object" && value !== null && "binding" in value) {
      const binding = value.binding;
      if (
        typeof binding === "object" &&
        binding !== null &&
        "runId" in binding &&
        typeof binding.runId === "string"
      ) {
        authenticatedRunId = binding.runId;
      }
    }
    return value;
  };
  return {
    ...depsValue(configValue(provider(), capability()), chatFactory),
    runtimeCapabilityAuthenticator: {
      authenticate: authenticateAndRemember,
      reservePromptTokens: () => ({ ok: true, runId: authenticatedRunId }),
    },
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
    correlationId: undefined,
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

// #3406/#3414: mirrors opencodeToolSchemas.ts's REPOSITORY_SEARCH_SCHEMA for #3386's H1 local
// repository-search handler, projected as keiko_repository_search.
const REPOSITORY_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["lexical", "literal", "regex", "symbol"],
      description:
        "lexical: natural-language keyword match. literal: exact substring. regex: bounded, ReDoS-safe pattern. symbol: exact identifier (no whitespace).",
    },
    query: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Search text for the selected mode.",
    },
    caseSensitive: { type: "boolean" },
    includeGlobs: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 200 },
      description: "Workspace-relative glob patterns to restrict the search to.",
    },
    excludeGlobs: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 200 },
      description: "Workspace-relative glob patterns to exclude from the search.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of bounded content excerpts to return.",
    },
  },
  required: ["mode", "query", "caseSensitive", "includeGlobs", "excludeGlobs", "maxResults"],
} as const;

const WORKSPACE_DISCOVER_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Case-insensitive filename/path keywords. Use a short distinctive term such as safeActivity, timeline, or composer. Use * only when a bounded repository overview is necessary.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum number of matching workspace-relative file paths to return.",
    },
  },
  required: ["query", "maxResults"],
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

// #3386/#3387/#3388: the Git status/diff/stage/commit, push/pull-request and CI-observation
// tools, independently hand-typed here (never imported from opencodeToolSchemas.ts) so this file
// keeps pinning the real OpenCode 1.17.17 wire contract against a second, independently authored
// source rather than the production array it verifies.
const GIT_STATUS_SCHEMA = { type: "object", properties: {}, required: [] } as const;
const GIT_PUSH_SCHEMA = { type: "object", properties: {}, required: [] } as const;
const GIT_DIFF_SCHEMA = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["working-tree", "index"] },
    paths: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description: "Workspace-relative paths to diff; denied or ignored paths never appear.",
    },
  },
  required: ["scope", "paths"],
} as const;
const GIT_STAGE_SCHEMA = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description: "Workspace-relative paths to propose staging.",
    },
  },
  required: ["paths"],
} as const;
const GIT_COMMIT_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: 8_192,
      description: "Proposed commit message. This proposes only; a human approval is required.",
    },
  },
  required: ["message"],
} as const;
const GIT_PULL_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^[^\\0\\r\\n]+$",
      description: "Proposed draft pull-request title.",
    },
  },
  required: ["title"],
} as const;
const GIT_CI_STATUS_SCHEMA = {
  type: "object",
  properties: {
    forceFresh: {
      type: "boolean",
      description:
        "Set true to bypass the cached readiness snapshot and force one fresh provider read.",
    },
  },
  required: ["forceFresh"],
} as const;
// Kept in exact sync with opencodeToolSchemas.ts's own GIT_EXECUTE_SCHEMA by hand (this file pins
// the real wire schema independently of that module's export, on purpose, as its own regression
// check) -- stage-/delivery-/commit- are the three prefixes the server actually mints, from
// gitDelivery/proposalId.ts's PROPOSAL_ID_PREFIXES. The literal pattern below may only keep
// restating that string because a test ("keeps the hand-typed proposalId pin in sync with the
// derived pattern", below) asserts it equals proposalIdPattern() -- if that assertion ever fails,
// fix this literal, not the test.
const GIT_EXECUTE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["stage", "commit", "push", "pull-request"] },
    proposalId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^(?:stage|delivery|commit)-[0-9]{1,39}$",
      description: "The proposalId returned by the matching propose-phase tool call.",
    },
  },
  required: ["kind", "proposalId"],
} as const;

const PINNED_MODEL_VISIBLE_TOOLS = [
  { name: "question", parameters: QUESTION_SCHEMA },
  { name: "keiko_workspace_discover", parameters: WORKSPACE_DISCOVER_SCHEMA },
  { name: "keiko_workspace_read", parameters: WORKSPACE_READ_SCHEMA },
  { name: "keiko_repository_search", parameters: REPOSITORY_SEARCH_SCHEMA },
  { name: "keiko_changeset_edit", parameters: CHANGESET_EDIT_SCHEMA },
  { name: "keiko_verification", parameters: VERIFICATION_PROJECTED_SCHEMA },
  { name: "keiko_research_fetch", parameters: RESEARCH_FETCH_SCHEMA },
  { name: "keiko_skill", parameters: SKILL_SCHEMA },
  { name: "keiko_child_agent", parameters: CHILD_AGENT_SCHEMA },
  { name: "keiko_git_status", parameters: GIT_STATUS_SCHEMA },
  { name: "keiko_git_diff", parameters: GIT_DIFF_SCHEMA },
  { name: "keiko_git_stage", parameters: GIT_STAGE_SCHEMA },
  { name: "keiko_git_commit", parameters: GIT_COMMIT_SCHEMA },
  { name: "keiko_git_push", parameters: GIT_PUSH_SCHEMA },
  { name: "keiko_pull_request", parameters: GIT_PULL_REQUEST_SCHEMA },
  { name: "keiko_git_execute", parameters: GIT_EXECUTE_SCHEMA },
  { name: "keiko_ci_status", parameters: GIT_CI_STATUS_SCHEMA },
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
  it.each([
    { label: "buffered", stream: false },
    { label: "streaming", stream: true },
  ])(
    "pins the $label sidecar request to the gateway resolved before body intake",
    async ({ stream }) => {
      resetGatewayInstanceCacheForTests();
      let requestedUrl: string | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request): Promise<Response> => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return Promise.reject(new Error("provider unavailable"));
        }),
      );
      const initialConfig = configValue(
        provider({ baseUrl: "https://initial-gateway.example/v1", maxRetries: 0 }),
        capability(),
      );
      const runtimeConfig = probeVerifiedGatewayConfig(initialConfig);
      const deps = {
        ...runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-pinned" } })),
        gatewayConfig: runtimeConfig,
      };
      const body = new PassThrough();
      const request = body as unknown as IncomingMessage & {
        method: string;
        url: string;
        headers: Record<string, string>;
      };
      request.method = "POST";
      request.url = "/api/coding-sidecar/gateway/chat/completions";
      request.headers = { authorization: "Bearer gateway-capability-material-0000000001" };
      const context = { ...authenticatedContext({}), req: request };

      try {
        const pending = handleCodingSidecarGatewayChatCompletions(context, deps);
        runtimeConfig.set(
          configValue(
            provider({ baseUrl: "https://replacement-gateway.example/v1", maxRetries: 0 }),
            capability(),
          ),
          true,
        );
        body.end(
          JSON.stringify({
            model: "coding",
            stream,
            messages: [{ role: "user", content: "continue" }],
            tools: modelVisibleTools(),
          }),
        );

        const result = await pending;
        if (stream) expect(result).toBe(STREAMING);
        else expect(result).toMatchObject({ status: 503 });
        expect(requestedUrl).toContain("initial-gateway.example");
        expect(requestedUrl).not.toContain("replacement-gateway.example");
      } finally {
        vi.unstubAllGlobals();
        resetGatewayInstanceCacheForTests();
      }
    },
  );

  it("produces a GatewayRequest whose toolCatalog projection canonically equals the forwarded managed tools and reaches fetch", async () => {
    resetGatewayInstanceCacheForTests();
    let requestBody:
      { tools?: readonly { function: { name: string; parameters: unknown } }[] } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = typeof init?.body === "string" ? init.body : "{}";
        requestBody = JSON.parse(body) as typeof requestBody;
        return Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    );
    const deps = runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-real" } }));
    try {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      assertRouteResult(result);
      expect(result.status).toBe(200);
      expect(requestBody?.tools).toBeDefined();
      const sentTools = requestBody?.tools ?? [];
      const advertisement = createOpenCodeGatewayToolCatalogAdvertisement(Date.now());
      // The forwarded set is the seven catalog-representable tools plus the two native
      // extensions (question/todowrite), merged by the model-gateway bridge (#3414 follow-up) --
      // canonically the full pinned OpenCode 1.17.17 model-visible set.
      const expectedParametersByName = new Map<string, unknown>([
        ...advertisement.projection.tools.map((tool): [string, unknown] => [
          tool.alias,
          tool.inputSchema,
        ]),
        ...PINNED_MODEL_VISIBLE_TOOLS.filter((tool) =>
          advertisement.projection.nativeExtensions.some(
            (extension) => extension.alias === tool.name,
          ),
        ).map((tool): [string, unknown] => [tool.name, tool.parameters]),
      ]);
      expect(new Set(sentTools.map((tool) => tool.function.name))).toEqual(
        new Set(OPENCODE_MODEL_VISIBLE_TOOL_NAMES),
      );
      for (const tool of sentTools) {
        expect(tool.function.parameters).toEqual(expectedParametersByName.get(tool.function.name));
      }
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
    }
  });

  it("passes a native extension tool call ('question') through unbound instead of rejecting it (#3414 follow-up)", async () => {
    resetGatewayInstanceCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn((): Promise<Response> =>
        Promise.resolve(
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
                        function: {
                          name: "question",
                          arguments: JSON.stringify({ questions: [] }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    const deps = runtimeGatewayDeps(() => ({ ok: true, binding: { runId: "run-question" } }));
    try {
      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "continue" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );
      assertRouteResult(result);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        choices: [{ message: { tool_calls: [{ function: { name: "question" } }] } }],
      });
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
    }
  });

  it("keeps circuit-breaker failures across separate production gateway requests", async () => {
    resetGatewayInstanceCacheForTests();
    const fetchMock = vi.fn(() => Promise.reject(new Error("provider unavailable")));
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      ...configValue(provider({ maxRetries: 0 }), capability()),
      circuitBreaker: { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 },
    };
    const deps = depsValue(config);
    const request = (): RouteContext =>
      authenticatedContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
        tools: [],
      });

    try {
      await handleCodingSidecarGatewayChatCompletions(request(), deps);
      await handleCodingSidecarGatewayChatCompletions(request(), deps);
      await handleCodingSidecarGatewayChatCompletions(request(), deps);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      resetGatewayInstanceCacheForTests();
    }
  });

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

  it("fails closed before provider dispatch when the cumulative prompt budget is exhausted", async () => {
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-1" } }),
        () => chat,
      ),
      runtimeCapabilityAuthenticator: {
        authenticate: (): unknown => ({ ok: true, binding: { runId: "run-1" } }),
        reservePromptTokens: (): unknown => ({
          ok: false,
          reason: "authority-budget-exceeded",
        }),
      },
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "continue" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 403 });
    expect(chat).not.toHaveBeenCalled();
  });

  it("keeps the hand-typed proposalId pin in sync with the derived pattern", () => {
    expect(GIT_EXECUTE_SCHEMA.properties.proposalId.pattern).toBe(proposalIdPattern());
  });

  it("accepts exactly the pinned OpenCode v1.17.17 visible schemas by canonical digest", async () => {
    expect(
      PINNED_MODEL_VISIBLE_TOOLS.map((tool) => [tool.name, schemaDigest(tool.parameters)]),
    ).toEqual([
      ["question", "4f618d23c27d7147ab8564c3ec1050c508762a19b9a4858951a9cd3089b52df3"],
      [
        "keiko_workspace_discover",
        "43c78833caee7bb83f746ae45cacd44d3b8cc07fc7a3b298a24caae993ba2978",
      ],
      ["keiko_workspace_read", "56d2649a7a308efdc47db2899922c9889822a17b9d9bd081ee0c099a066411ac"],
      // #3406/#3414: keiko_repository_search projects #3386's H1 local repository-search handler
      // (executeCodingRepositoryRequest); regenerated because the model-visible set changed.
      [
        "keiko_repository_search",
        "3abb5e7d1f1fa82aabb7b821c515078bc1a2e165a1471c940d4d72b9b9fc4069",
      ],
      ["keiko_changeset_edit", "59902a2dd9af28ed8b97d1108215c6e88bbe0fba017a4756a99e833b9af48952"],
      ["keiko_verification", "4cd58eaead9fef3c41ef7faaacd2feb5440755e052ed67efa6b9c4860e18e988"],
      ["keiko_research_fetch", "8510b5132cc06c627c2b46c20df92c3fcca392f0d16a621b7006eb41d2bf02b5"],
      ["keiko_skill", "c3a50e828f78a32481ce662f8cd92e04dd6375af8df916f3c588b0628ff2de2d"],
      ["keiko_child_agent", "aa977e5c893cef8e1c7f6e5185836e039bb0a874e35c476d6a896a14441cb0ab"],
      ["keiko_git_status", "c8a1ac469a826ea3547ac220c7bbfdcd6b58080d4ec596ff2a0149c5ccb9b699"],
      ["keiko_git_diff", "fa6966974e9e03d9fb30fb9b95a9f3dd53935ba03f991ce5b6575c5d5ee17a10"],
      ["keiko_git_stage", "647e9587fc6f6fff73280f3dca63fe3f66a7614eb14652a467acff7de2192dc4"],
      ["keiko_git_commit", "2df8d578416a283a3a72f8c71c4102264305107ae7c4e7b0e5d1806c3b066112"],
      ["keiko_git_push", "c8a1ac469a826ea3547ac220c7bbfdcd6b58080d4ec596ff2a0149c5ccb9b699"],
      ["keiko_pull_request", "459ee94f01b4f6fe7581ea0d365a6adfc702c298d8eec915c51c4da311967c0a"],
      // Digest recomputed: proposalId.pattern gained the "commit" prefix alongside stage/delivery
      // (fixed the commit-proposal-id pattern gap -- the prior pattern rejected every real
      // commit-* proposal id VerifiedCommitService.propose() mints, making #3386's commit
      // redemption unreachable through this tool's own schema).
      ["keiko_git_execute", "e86d3180571a32cdb281eead6c9ee58e9864e6d915a3cbeea14630c8a2c735cf"],
      ["keiko_ci_status", "ffc444855e40f3ea3f6f091de97e0f552480d929ff020bc9dc15c88c14199a80"],
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

  it("dispatches the model and reasoning effort bound to the authenticated run", async () => {
    const chat = vi.fn((_request: GatewayRequest) =>
      Promise.resolve(assistantResponse("qwen-coder")),
    );
    const selectedConfig: GatewayConfig = {
      ...configValue(provider(), capability()),
      providers: [
        provider(),
        provider({ modelId: "qwen-coder", endpointStyle: "openai-compatible" }),
      ],
      capabilities: [capability(), capability({ id: "qwen-coder" })],
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({
          ok: true,
          binding: {
            runId: "run-qwen",
            modelProfileId: "qwen-coder",
            reasoningEffort: "high",
          },
        }),
        () => chat,
      ),
      config: selectedConfig,
    };

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "use the selected model" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(chat.mock.calls[0]?.[0]).toMatchObject({
      modelId: "qwen-coder",
      reasoningEffort: "high",
    });
  });

  it.each(["coding", "coding-safe-openai-compatible"])(
    "treats %s as a runtime transport model id",
    async (modelProfileId) => {
      const chat = vi.fn((request: GatewayRequest) =>
        Promise.resolve(assistantResponse(request.modelId)),
      );
      const deps = runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-alias", modelProfileId } }),
        () => chat,
      );

      const result = await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "use the configured safe model" }],
          tools: modelVisibleTools(),
        }),
        deps,
      );

      expect(result).toMatchObject({ status: 200 });
      expect(chat).toHaveBeenCalledOnce();
      expect(chat.mock.calls[0]?.[0].modelId).toBe("azure-coding-model");
    },
  );

  it("keeps the safe runtime transport profile usable without a readiness registry", async () => {
    const chat = vi.fn((request: GatewayRequest) =>
      Promise.resolve(assistantResponse(request.modelId)),
    );
    const deps = runtimeGatewayDeps(
      () => ({
        ok: true,
        binding: {
          runId: "run-live",
          adapterKind: "model-gateway-sidecar",
          modelProfileId: "coding-safe-openai-compatible",
        },
      }),
      () => chat,
      undefined,
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content: "live runtime task" }],
        tools: modelVisibleTools(),
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0].modelId).toBe("azure-coding-model");
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
        messages: [{ role: "user", content: OPENCODE_RUNTIME_READINESS_PROMPT }],
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
        messages: [{ role: "user", content: OPENCODE_RUNTIME_READINESS_PROMPT }],
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
    const request = (
      tools?: readonly ModelVisibleRequestTool[],
      content = "bounded private runtime content",
    ): RouteContext =>
      authenticatedContext({
        model: "coding",
        messages: [{ role: "user", content }],
        ...(tools === undefined ? {} : { tools }),
      });

    expect(await handleCodingSidecarGatewayChatCompletions(request(), deps)).toMatchObject({
      status: 403,
    });
    expect(readiness.isVerified("run-1")).toBe(false);
    expect(
      await handleCodingSidecarGatewayChatCompletions(
        request(modelVisibleTools(), OPENCODE_RUNTIME_READINESS_PROMPT),
        deps,
      ),
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

  it("forwards a real exact-tool runtime turn and verifies the run for later compaction", async () => {
    const readiness = createOpenCodeGatewayReadinessRegistry();
    const chat = vi.fn(() => Promise.resolve(assistantResponse("azure-coding-model")));
    const deps = runtimeGatewayDeps(
      () => ({ ok: true, binding: { runId: "run-1" } }),
      () => chat,
      readiness,
    );

    expect(
      await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "real user task" }],
          tools: modelVisibleTools(),
        }),
        deps,
      ),
    ).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledOnce();
    expect(readiness.isVerified("run-1")).toBe(true);

    expect(
      await handleCodingSidecarGatewayChatCompletions(
        authenticatedContext({
          model: "coding",
          messages: [{ role: "user", content: "compaction follow-up" }],
        }),
        deps,
      ),
    ).toMatchObject({ status: 200 });
    expect(chat).toHaveBeenCalledTimes(2);
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
            name: "keiko_workspace_discover",
            parameters: {
              required: ["query", "maxResults"],
              properties: { ...WORKSPACE_DISCOVER_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_workspace_read",
            parameters: {
              required: ["relativePath", "startLine", "maxLines"],
              properties: { ...WORKSPACE_READ_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_repository_search",
            parameters: {
              required: [
                "mode",
                "query",
                "caseSensitive",
                "includeGlobs",
                "excludeGlobs",
                "maxResults",
              ],
              properties: { ...REPOSITORY_SEARCH_SCHEMA.properties },
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
            name: "keiko_git_status",
            parameters: { required: [], properties: {}, type: "object" },
          },
          {
            name: "keiko_git_diff",
            parameters: {
              required: ["scope", "paths"],
              properties: { ...GIT_DIFF_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_git_stage",
            parameters: {
              required: ["paths"],
              properties: { ...GIT_STAGE_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_git_commit",
            parameters: {
              required: ["message"],
              properties: { ...GIT_COMMIT_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_git_push",
            parameters: { required: [], properties: {}, type: "object" },
          },
          {
            name: "keiko_pull_request",
            parameters: {
              required: ["title"],
              properties: { ...GIT_PULL_REQUEST_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_git_execute",
            parameters: {
              required: ["kind", "proposalId"],
              properties: { ...GIT_EXECUTE_SCHEMA.properties },
              type: "object",
            },
          },
          {
            name: "keiko_ci_status",
            parameters: {
              required: ["forceFresh"],
              properties: { ...GIT_CI_STATUS_SCHEMA.properties },
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

  // 0.3.0 audit: `pumpGatewayStream` failing mid-response went into a bare `catch {}` — the exact
  // pattern AGENTS.md §7 forbids — on the coding path. The SSE error frame still went out, but the
  // cause was recorded nowhere, so an interrupted coding turn had no diagnosable reason. The frame is
  // unchanged; the redacted cause is added and is distinguishable from a pre-stream failure by `source`.
  it("records the mid-stream failure cause with the request correlation id", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: "partial" };
      throw Object.assign(new Error("upstream reset key sk-ABCDEFGHIJKLMNOPQRSTUV"), {
        code: "GATEWAY_TRANSPORT",
        partialUsage: { promptTokens: 11, completionTokens: 3 },
      });
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "mid-stream failure" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
      correlationId: "sidecar-corr-0001",
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-failure" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      diagnostics,
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    const streamRecords = diagnostics.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.source === "coding-sidecar-gateway.stream");
    expect(streamRecords).toHaveLength(1);
    expect(streamRecords[0]?.correlationId).toBe("sidecar-corr-0001");
    expect(streamRecords[0]?.errorClass).toBe("Error");
    expect(streamRecords[0]?.code).toBe("GATEWAY_TRANSPORT");
    // Interrupted-turn token counts survive the failure instead of vanishing with the error.
    expect(streamRecords[0]?.partialUsage).toEqual({ promptTokens: 11, completionTokens: 3 });
    expect(JSON.stringify(streamRecords)).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUV");
    expect(JSON.stringify(streamRecords)).not.toContain("upstream reset");
  });

  // Regression: a mid-stream failure with no request correlation id in scope used to fall back to
  // the bare literal `"unknown"` (7 characters), which fails `isValidCorrelationId`'s 8-character
  // floor and was silently rewritten by `emitServerDiagnostic`'s sanitizer to the "hostile value"
  // marker `"invalid-correlation-id"` — misreporting an honestly-absent id as a malformed one. The
  // fallback is now the shape-valid sentinel `UNKNOWN_CORRELATION_ID`, which survives the sanitizer
  // unchanged. This test fails against the old bare-`"unknown"` fallback.
  it("falls back the stream-failure correlation id to the unknown-id sentinel, never the invalid-id marker", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const stream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      await Promise.resolve();
      yield { type: "delta", token: "partial" };
      throw Object.assign(new Error("upstream reset"), { code: "GATEWAY_TRANSPORT" });
    };
    const response = mockResponse({ captureBody: true });
    const context: RouteContext = {
      ...authenticatedContext({
        model: "coding",
        stream: true,
        messages: [{ role: "user", content: "mid-stream failure, no correlation id" }],
        tools: modelVisibleTools(),
      }),
      res: response.res,
    };
    const deps = {
      ...runtimeGatewayDeps(
        () => ({ ok: true, binding: { runId: "run-stream-failure-no-corr" } }),
        undefined,
        createOpenCodeGatewayReadinessRegistry(),
        (): (() => AsyncIterable<GatewayStreamChunk>) => (): AsyncIterable<GatewayStreamChunk> =>
          stream(),
      ),
      diagnostics,
    } as UiHandlerDeps;

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    expect(result).toBe(STREAMING);
    const streamRecords = diagnostics.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.source === "coding-sidecar-gateway.stream");
    expect(streamRecords).toHaveLength(1);
    expect(streamRecords[0]?.correlationId).toBe(UNKNOWN_CORRELATION_ID);
    expect(streamRecords[0]?.correlationId).not.toBe("invalid-correlation-id");
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
      correlationId: undefined,
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

  // F-01: `status: "available"` describes the stored configuration. A deps assembly with no probe
  // record must therefore publish `verification: "unverified"` — the Workbench renders this field,
  // and a missing one would let it keep reading a configured source as a healthy one.
  it("publishes the last probe outcome alongside the config-derived profile", () => {
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
      correlationId: undefined,
    } satisfies RouteContext;
    const config = configValue(provider(), capability());
    const unprobed = handleCodingSidecarGatewayProfile(context, depsValue(config));

    expect(unprobed.body).toMatchObject({ status: "available", verification: "unverified" });

    const verified = handleCodingSidecarGatewayProfile(context, {
      ...depsValue(config),
      gatewayConfig: {
        storagePath: "/dev/null",
        current: () => config,
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => "verified",
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    });

    expect(verified.body).toMatchObject({ status: "available", verification: "verified" });
  });

  it("fails closed through the profile route when the injected model source is subscription-backed", () => {
    const context = {
      req: mockRequest({ method: "GET", url: "/api/coding-sidecar/gateway/profile" }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/coding-sidecar/gateway/profile"),
      correlationId: undefined,
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

  // ADR-0173 D5: the buffered chat completion request built for the gateway must carry the HTTP
  // request's correlation id in GatewayCallRequest.logContext, so a gateway retry/circuit-breaker
  // line for this call joins the same trail as the sidecar request that triggered it.
  it("threads the request correlation id into the Gateway double's GatewayCallRequest.logContext", async () => {
    const seenRequests: GatewayCallRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability()),
      (
        _config: GatewayConfig,
        modelId: string,
      ): ((request: GatewayCallRequest) => Promise<NormalizedResponse>) => {
        return (request: GatewayCallRequest): Promise<NormalizedResponse> => {
          seenRequests.push(request);
          return Promise.resolve(assistantResponse(modelId));
        };
      },
    );
    const context: RouteContext = {
      ...routeContext({
        model: "azure-coding-model",
        messages: [{ role: "user", content: "continue" }],
      }),
      correlationId: "sidecar-corr-logcontext-0001",
    };

    const result = await handleCodingSidecarGatewayChatCompletions(context, deps);

    assertRouteResult(result);
    expect(result.status).toBe(200);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.logContext?.correlationId).toBe("sidecar-corr-logcontext-0001");
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

  it("accepts normal prompts when capability token geometry is not yet enriched", async () => {
    const seenRequests: GatewayRequest[] = [];
    const deps = depsValue(
      configValue(provider(), capability({ contextWindow: 0, maxOutputTokens: 0 })),
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
        messages: [{ role: "user", content: "normal prompt ".repeat(50) }],
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(seenRequests).toHaveLength(1);
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

  it("diagnoses unavailable gateway profiles without recording request bodies", async () => {
    const diagnostics = { record: vi.fn<(record: ServerDiagnosticRecord) => void>() };
    const deps = depsValue(
      configValue(provider(), capability()),
      undefined,
      { KEIKO_CODING_SIDECAR_DISABLED: "1" },
      undefined,
      { diagnostics },
    );

    const result = await handleCodingSidecarGatewayChatCompletions(
      routeContext({
        messages: [{ role: "user", content: "private runtime task text" }],
      }),
      deps,
    );

    expect(result).toMatchObject({ status: 503 });
    expect(diagnostics.record).toHaveBeenCalledOnce();
    expect(diagnostics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "coding-sidecar-gateway.chat",
        errorClass: "CodingSidecarGatewayUnavailable",
        message: "coding-sidecar-gateway-profile-unavailable",
        code: "status=unavailable:reason=deployment-policy-disabled:config=configured:gateway=configured:source=model-gateway:selector=absent:authority=gateway",
      }),
    );
    expect(JSON.stringify(diagnostics.record.mock.calls)).not.toContain("private runtime task");
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
