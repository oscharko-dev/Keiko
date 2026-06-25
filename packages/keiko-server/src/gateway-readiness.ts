import type { IncomingMessage } from "node:http";
import {
  apiKeyHeaderValue,
  DEFAULT_API_KEY_HEADER_NAME,
  isConversationEligibleModel,
  listConfiguredCapabilities,
  type GatewayConfig,
  type ModelCapability,
  type ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import {
  gatewayFetch,
  readJsonCapped,
  readSseStream,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import type {
  GatewayReadinessOptions,
  GatewayReadinessProbeName,
  GatewayReadinessProbeResult,
  GatewayReadinessReport,
  GatewayReadinessRequest,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig, currentGatewayEgressConfig } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";

const DEFAULT_PROBES: readonly GatewayReadinessProbeName[] = [
  "chat",
  "streaming",
  "tool_calling",
  "json_schema",
];
const DEEP_PROBES: readonly GatewayReadinessProbeName[] = [
  "reasoning",
  "image_input",
  "document_input",
  "long_context",
];
const ALL_PROBES = new Set<GatewayReadinessProbeName>([...DEFAULT_PROBES, ...DEEP_PROBES]);
const VERIFIED_CAPABILITY_PROBES = [
  ["streaming", "streaming"],
  ["toolCalling", "tool_calling"],
  ["structuredOutput", "json_schema"],
  ["reasoningOutput", "reasoning"],
  ["imageInput", "image_input"],
  ["documentInput", "document_input"],
] as const satisfies readonly (readonly [
  keyof GatewayReadinessReport["verifiedCapabilities"],
  GatewayReadinessProbeName,
])[];
const MAX_MODEL_ID_CHARS = 240;
const MAX_BODY_BYTES = 64_000;
const MAX_CONTEXT_TOKENS = 128_000;
const DEFAULT_LONG_CONTEXT_TOKENS = 32_000;
const EXTENDED_LONG_CONTEXT_TOKENS = 64_000;
const MAX_PROVIDER_RESPONSE_BYTES = 500_000;
const RED_PIXEL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const MINI_PDF_DATA_URL =
  "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2MSA+PgpzdHJlYW0KQlQKL0YxIDE4IFRmCjUwIDgwIFRkCihLRUlLTyBQREYgUkVBRElORVNTIFBST0JFKSBUagpFVApzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNjIgMDAwMDAgbiAKMDAwMDAwMDM3MyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9Sb290IDEgMCBSIC9TaXplIDYgPj4Kc3RhcnR4cmVmCjQ0MgolJUVPRgo=";

type ProbeStatus = GatewayReadinessProbeResult["status"];

interface ParsedReadinessBody {
  readonly parsed: GatewayReadinessRequest;
}

interface ProviderRequestOptions {
  readonly stream?: boolean | undefined;
}

interface ProviderSelection {
  readonly config: GatewayConfig;
  readonly provider: ModelProviderConfig;
  readonly capability: ModelCapability | undefined;
}

class ReadinessBodyTooLargeError extends Error {
  constructor() {
    super("Readiness request body exceeds the size limit.");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      bytes += buffer.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        reject(new ReadinessBodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function error(code: string, message: string, status = 400): RouteResult {
  return { status, body: { error: { code, message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbeName(value: unknown): value is GatewayReadinessProbeName {
  return typeof value === "string" && ALL_PROBES.has(value as GatewayReadinessProbeName);
}

async function readJsonBody(req: IncomingMessage): Promise<ParsedReadinessBody | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (bodyError) {
    if (bodyError instanceof ReadinessBodyTooLargeError) {
      return error("PAYLOAD_TOO_LARGE", "Readiness request body exceeds the size limit.", 413);
    }
    return error("BAD_REQUEST", "The readiness request body could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch {
    return error("BAD_REQUEST", "The readiness request body must be valid JSON.");
  }
  if (!isRecord(parsed)) {
    return error("BAD_REQUEST", "The readiness request body must be a JSON object.");
  }
  return { parsed: parseReadinessRequest(parsed) };
}

function parseReadinessRequest(raw: Record<string, unknown>): GatewayReadinessRequest {
  const modelId =
    typeof raw.modelId === "string" && raw.modelId.trim().length > 0
      ? raw.modelId.trim().slice(0, MAX_MODEL_ID_CHARS)
      : undefined;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(isRecord(raw.options) ? { options: parseReadinessOptions(raw.options) } : {}),
  };
}

function parseReadinessOptions(raw: Record<string, unknown>): GatewayReadinessOptions {
  const probes = Array.isArray(raw.probes) ? uniqueProbeNames(raw.probes) : undefined;
  const includeDeepProbes =
    typeof raw.includeDeepProbes === "boolean" ? raw.includeDeepProbes : undefined;
  const maxContextTokens =
    typeof raw.maxContextTokens === "number" && Number.isFinite(raw.maxContextTokens)
      ? Math.max(1, Math.min(MAX_CONTEXT_TOKENS, Math.trunc(raw.maxContextTokens)))
      : undefined;
  return {
    ...(probes !== undefined ? { probes } : {}),
    ...(includeDeepProbes !== undefined ? { includeDeepProbes } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
  };
}

function uniqueProbeNames(values: readonly unknown[]): readonly GatewayReadinessProbeName[] {
  const out: GatewayReadinessProbeName[] = [];
  for (const value of values) {
    if (isProbeName(value) && !out.includes(value)) {
      out.push(value);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_PROBES];
}

function requestedProbeNames(
  options: GatewayReadinessOptions | undefined,
): readonly GatewayReadinessProbeName[] {
  const base = options?.probes ?? DEFAULT_PROBES;
  const names = new Set<GatewayReadinessProbeName>(["chat", ...base]);
  if (options?.includeDeepProbes === true) {
    for (const probe of DEEP_PROBES) names.add(probe);
  }
  return Array.from(names);
}

function chooseProvider(
  config: GatewayConfig | undefined,
  requestedModelId: string | undefined,
): ProviderSelection | RouteResult {
  if (config === undefined || config.providers.length === 0) {
    return error("NO_MODEL", "Configure a gateway before running readiness checks.");
  }
  const capabilities = listConfiguredCapabilities(config);
  const modelId =
    requestedModelId ??
    capabilities.find((capability) => isConversationEligibleModel(capability))?.id ??
    config.providers[0]?.modelId;
  const provider = config.providers.find((candidate) => candidate.modelId === modelId);
  if (provider === undefined) {
    return error("NO_MODEL", "Select a configured chat model before running readiness checks.");
  }
  const capability = capabilities.find((candidate) => candidate.id === provider.modelId);
  if (capability !== undefined && !isConversationEligibleModel(capability)) {
    return error(
      "NO_MODEL",
      "Select a conversation-capable model before running readiness checks.",
    );
  }
  return { config, provider, capability };
}

function providerHeaders(provider: ModelProviderConfig): Record<string, string> {
  const headerName = provider.apiKeyHeaderName ?? DEFAULT_API_KEY_HEADER_NAME;
  return {
    "content-type": "application/json",
    [headerName]: apiKeyHeaderValue(headerName, provider.apiKey),
  };
}

async function providerRequest(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
  body: Readonly<Record<string, unknown>>,
  options: ProviderRequestOptions = {},
): Promise<Response> {
  const requestBody = JSON.stringify({
    model: provider.modelId,
    ...body,
    ...(options.stream === true ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
  return gatewayFetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: providerHeaders(provider),
    body: requestBody,
    fetchImpl: deps.gatewayReadinessFetch,
    timeoutMs: provider.timeoutMs,
    maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
    egress: provider.egress ?? currentGatewayEgressConfig(deps),
  });
}

function result(
  name: GatewayReadinessProbeName,
  status: ProbeStatus,
  start: number,
  evidence: string,
  warning?: string,
): GatewayReadinessProbeResult {
  return {
    name,
    status,
    latencyMs: Math.max(0, Date.now() - start),
    evidence,
    ...(warning !== undefined ? { warning } : {}),
  };
}

function skipped(name: GatewayReadinessProbeName, evidence: string): GatewayReadinessProbeResult {
  return { name, status: "skipped", latencyMs: 0, evidence };
}

function providerWarning(errorValue: unknown): string {
  if (errorValue instanceof DOMException && errorValue.name === "TimeoutError") {
    return "The probe timed out before the provider answered.";
  }
  return "The provider could not complete this probe. Chat configuration was not changed.";
}

function unsupportedStatus(response: Response): boolean {
  return (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 422 ||
    response.status === 501
  );
}

function unsuccessfulEvidence(label: string, response: Response): string {
  return `${label} endpoint returned HTTP ${response.status.toString()}.`;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function firstMessage(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const choices: readonly unknown[] = payload.choices;
  const choice = choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  return choice.message;
}

function assistantText(payload: unknown): string {
  return textFromContent(firstMessage(payload)?.content);
}

function hasToolCall(payload: unknown, toolName: string): boolean {
  const message = firstMessage(payload);
  if (message === undefined || !Array.isArray(message.tool_calls)) return false;
  return message.tool_calls.some((call) => {
    if (!isRecord(call) || !isRecord(call.function)) return false;
    return call.function.name === toolName;
  });
}

function parseJsonObjectFromAssistant(payload: unknown): Record<string, unknown> | undefined {
  const text = assistantText(payload).trim();
  if (text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function reasoningDetectedInMessage(message: Record<string, unknown> | undefined): boolean {
  if (message === undefined) return false;
  const fields = ["reasoning", "reasoning_content", "reasoning_details"];
  return (
    fields.some((field) => message[field] !== undefined) ||
    /<think>[\s\S]*<\/think>/iu.test(textFromContent(message.content))
  );
}

function firstDelta(chunk: unknown): Record<string, unknown> | undefined {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices)) return undefined;
  const choices: readonly unknown[] = chunk.choices;
  const choice = choices[0];
  return isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
}

function deltaContent(chunk: unknown): string {
  return textFromContent(firstDelta(chunk)?.content);
}

async function readProviderJson(response: Response): Promise<unknown> {
  return readJsonCapped(response, MAX_PROVIDER_RESPONSE_BYTES);
}

async function probeChat(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, provider, {
      messages: [
        { role: "system", content: "You are a minimal readiness probe." },
        { role: "user", content: "Reply with exactly: keiko-ready" },
      ],
    });
    if (!response.ok) {
      return result("chat", "failed", start, unsuccessfulEvidence("Basic chat", response));
    }
    const text = assistantText(await readProviderJson(response)).toLowerCase();
    const passed = text.includes("keiko-ready");
    return result(
      "chat",
      passed ? "passed" : "failed",
      start,
      passed
        ? "Working today: basic chat returned the expected readiness token."
        : "Basic chat answered, but did not return the expected readiness token.",
    );
  } catch (probeError) {
    return result(
      "chat",
      "failed",
      start,
      "Basic chat could not be verified.",
      providerWarning(probeError),
    );
  }
}

async function probeStreaming(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(
      deps,
      provider,
      {
        messages: [
          { role: "system", content: "You are a minimal streaming readiness probe." },
          { role: "user", content: "Reply with exactly: stream-ok" },
        ],
      },
      { stream: true },
    );
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return result("streaming", status, start, "Streaming was not accepted by the endpoint.");
    }
    let text = "";
    for await (const chunk of readSseStream(response, MAX_PROVIDER_RESPONSE_BYTES)) {
      text += deltaContent(chunk);
    }
    const passed = text.toLowerCase().includes("stream-ok");
    return result(
      "streaming",
      passed ? "passed" : "unsupported",
      start,
      passed
        ? "Streaming produced content deltas."
        : "Streaming completed without the expected text delta.",
    );
  } catch (probeError) {
    return result(
      "streaming",
      "failed",
      start,
      "Streaming could not be verified.",
      providerWarning(probeError),
    );
  }
}

async function probeToolCalling(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, provider, toolCallingBody());
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return toolCallingResult(provider, status, start);
    }
    return toolCallingPayloadResult(provider, start, await readProviderJson(response));
  } catch (probeError) {
    return result(
      "tool_calling",
      "failed",
      start,
      "Tool calling could not be verified.",
      providerWarning(probeError),
    );
  }
}

function toolCallingBody(): Readonly<Record<string, unknown>> {
  return {
    messages: [
      { role: "system", content: "Use the provided tool for readiness checks." },
      { role: "user", content: "Call the report_readiness tool with status ok." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "report_readiness",
          description: "Report gateway readiness.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { status: { type: "string", enum: ["ok"] } },
            required: ["status"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "report_readiness" } },
  };
}

function toolCallingResult(
  provider: ModelProviderConfig,
  status: ProbeStatus,
  start: number,
): GatewayReadinessProbeResult {
  return result(
    "tool_calling",
    status,
    start,
    "Tool calling was not accepted by the endpoint.",
    qwenToolWarning(provider, status),
  );
}

function toolCallingPayloadResult(
  provider: ModelProviderConfig,
  start: number,
  payload: unknown,
): GatewayReadinessProbeResult {
  const passed = hasToolCall(payload, "report_readiness");
  return result(
    "tool_calling",
    passed ? "passed" : "unsupported",
    start,
    passed
      ? "OpenAI-compatible tool call returned the expected function name."
      : "The endpoint answered without a valid tool call.",
    passed ? undefined : qwenToolWarning(provider, "unsupported"),
  );
}

function qwenToolWarning(provider: ModelProviderConfig, status: ProbeStatus): string | undefined {
  if (status === "passed" || !provider.modelId.toLowerCase().includes("qwen3-coder"))
    return undefined;
  return "For Qwen3-Coder on vLLM, ask the provider to enable auto tool choice and the qwen3_coder tool parser.";
}

async function probeJsonSchema(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, provider, jsonSchemaBody());
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return jsonSchemaResult(status, start);
    }
    return jsonSchemaPayloadResult(start, await readProviderJson(response));
  } catch (probeError) {
    return result(
      "json_schema",
      "failed",
      start,
      "Structured JSON output could not be verified.",
      providerWarning(probeError),
    );
  }
}

function jsonSchemaBody(): Readonly<Record<string, unknown>> {
  return {
    messages: [
      { role: "system", content: "Return only JSON matching the schema." },
      { role: "user", content: 'Return {"status":"json-ok"}.' },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "keiko_readiness_probe",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { status: { const: "json-ok" } },
          required: ["status"],
        },
      },
    },
  };
}

function jsonSchemaResult(status: ProbeStatus, start: number): GatewayReadinessProbeResult {
  return result(
    "json_schema",
    status,
    start,
    "JSON schema response_format was not accepted by the endpoint.",
  );
}

function jsonSchemaPayloadResult(start: number, payload: unknown): GatewayReadinessProbeResult {
  const json = parseJsonObjectFromAssistant(payload);
  const passed = json?.status === "json-ok";
  return result(
    "json_schema",
    passed ? "passed" : "unsupported",
    start,
    passed
      ? "Structured JSON output matched the expected schema."
      : "The endpoint answered, but did not produce schema-valid JSON.",
  );
}

async function probeReasoning(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, provider, {
      messages: [
        { role: "system", content: "Run a reasoning readiness probe. Do not reveal private data." },
        { role: "user", content: "/think\nWhat is 1 + 1? End with FINAL: 2." },
      ],
      reasoning_effort: "low",
    });
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return result(
        "reasoning",
        status,
        start,
        "Reasoning parameters were not accepted by the endpoint.",
        qwenReasoningWarning(provider),
      );
    }
    const payload = await readProviderJson(response);
    const detected = reasoningDetectedInMessage(firstMessage(payload));
    return result(
      "reasoning",
      detected ? "passed" : "unsupported",
      start,
      detected
        ? "Reasoning output was detected in provider fields or think tags."
        : "Reasoning output not verified on this deployment.",
      detected ? undefined : qwenReasoningWarning(provider),
    );
  } catch (probeError) {
    return result(
      "reasoning",
      "failed",
      start,
      "Reasoning output could not be verified.",
      providerWarning(probeError),
    );
  }
}

function qwenReasoningWarning(provider: ModelProviderConfig): string | undefined {
  return provider.modelId.toLowerCase().includes("qwen3-coder")
    ? "Reasoning output is not assumed from the model name; it must be confirmed by this deployment."
    : undefined;
}

async function probeImageInput(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, provider, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this one-pixel image? Answer one word." },
            { type: "image_url", image_url: { url: RED_PIXEL_PNG_DATA_URL } },
          ],
        },
      ],
    });
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return result("image_input", status, start, "Image input was not accepted by the endpoint.");
    }
    const passed = /\bred\b/iu.test(assistantText(await readProviderJson(response)));
    return result(
      "image_input",
      passed ? "passed" : "unsupported",
      start,
      passed
        ? "Mini image content was interpreted correctly."
        : "The endpoint accepted image input but did not identify the test image content.",
    );
  } catch (probeError) {
    return result(
      "image_input",
      "failed",
      start,
      "Image input could not be verified.",
      providerWarning(probeError),
    );
  }
}

async function probeDocumentInput(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, provider, documentInputBody());
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return documentInputResult(status, start);
    }
    return documentInputPayloadResult(start, await readProviderJson(response));
  } catch (probeError) {
    return result(
      "document_input",
      "failed",
      start,
      "Document input could not be verified.",
      providerWarning(probeError),
    );
  }
}

function documentInputBody(): Readonly<Record<string, unknown>> {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the attached PDF. Reply with the exact probe phrase." },
          {
            type: "file",
            file: {
              filename: "keiko-readiness.pdf",
              file_data: MINI_PDF_DATA_URL,
            },
          },
        ],
      },
    ],
  };
}

function documentInputResult(status: ProbeStatus, start: number): GatewayReadinessProbeResult {
  return result(
    "document_input",
    status,
    start,
    "PDF document input was not accepted by the endpoint.",
  );
}

function documentInputPayloadResult(start: number, payload: unknown): GatewayReadinessProbeResult {
  const passed = /keiko pdf readiness probe/iu.test(assistantText(payload));
  return result(
    "document_input",
    passed ? "passed" : "unsupported",
    start,
    passed
      ? "Mini PDF content was interpreted correctly."
      : "The endpoint accepted a document part but did not extract the test PDF content.",
  );
}

function longContextTokens(
  options: GatewayReadinessOptions | undefined,
  capability: ModelCapability | undefined,
): number {
  const contextWindow = capability?.contextWindow ?? 0;
  if (options?.maxContextTokens !== undefined) {
    const deploymentCeiling = contextWindow > 0 ? contextWindow : MAX_CONTEXT_TOKENS;
    return Math.min(options.maxContextTokens, deploymentCeiling, MAX_CONTEXT_TOKENS);
  }
  if (contextWindow >= EXTENDED_LONG_CONTEXT_TOKENS) return EXTENDED_LONG_CONTEXT_TOKENS;
  return DEFAULT_LONG_CONTEXT_TOKENS;
}

function longContextBody(tokens: number): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly sentinel: string;
} {
  const approximateChars = tokens * 4;
  const filler = "alpha beta gamma delta epsilon zeta eta theta\n".repeat(
    Math.max(1, Math.ceil(approximateChars / 46)),
  );
  const sentinel = "KEIKO_LONG_CONTEXT_SENTINEL";
  return {
    sentinel,
    body: {
      messages: [
        { role: "system", content: "Find the sentinel at the end of the user message." },
        {
          role: "user",
          content: `${filler.slice(0, approximateChars)}\n${sentinel}\nReply with exactly the sentinel.`,
        },
      ],
    },
  };
}

function longContextPayloadResult(
  start: number,
  tokens: number,
  sentinel: string,
  payload: unknown,
): GatewayReadinessProbeResult {
  const passed = assistantText(payload).includes(sentinel);
  return result(
    "long_context",
    passed ? "passed" : "unsupported",
    start,
    passed
      ? `${tokens.toString()} approximate tokens were accepted and the sentinel was recovered.`
      : "The endpoint answered, but did not recover the long-context sentinel.",
  );
}

async function probeLongContext(
  deps: UiHandlerDeps,
  provider: ModelProviderConfig,
  capability: ModelCapability | undefined,
  options: GatewayReadinessOptions | undefined,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  const tokens = longContextTokens(options, capability);
  const { body, sentinel } = longContextBody(tokens);
  try {
    const response = await providerRequest(deps, provider, body);
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return result(
        "long_context",
        status,
        start,
        `${tokens.toString()} approximate tokens were not accepted.`,
      );
    }
    return longContextPayloadResult(start, tokens, sentinel, await readProviderJson(response));
  } catch (probeError) {
    return result(
      "long_context",
      "failed",
      start,
      "Long-context input could not be verified.",
      providerWarning(probeError),
    );
  }
}

async function runProbe(
  name: GatewayReadinessProbeName,
  deps: UiHandlerDeps,
  selection: ProviderSelection,
  options: GatewayReadinessOptions | undefined,
): Promise<GatewayReadinessProbeResult> {
  if (name === "chat") return probeChat(deps, selection.provider);
  if (name === "streaming") return probeStreaming(deps, selection.provider);
  if (name === "tool_calling") return probeToolCalling(deps, selection.provider);
  if (name === "json_schema") return probeJsonSchema(deps, selection.provider);
  if (name === "reasoning") return probeReasoning(deps, selection.provider);
  if (name === "image_input") return probeImageInput(deps, selection.provider);
  if (name === "document_input") return probeDocumentInput(deps, selection.provider);
  return probeLongContext(deps, selection.provider, selection.capability, options);
}

function reportStatus(
  probes: readonly GatewayReadinessProbeResult[],
): GatewayReadinessReport["overallStatus"] {
  const chat = probes.find((probe) => probe.name === "chat");
  if (chat?.status !== "passed") return "failed";
  return probes.every((probe) => probe.status === "passed") ? "ready" : "partial";
}

function verifiedCapabilities(
  probes: readonly GatewayReadinessProbeResult[],
): GatewayReadinessReport["verifiedCapabilities"] {
  const passed = new Set(
    probes
      .filter((probe) => probe.status === "passed")
      .map((probe): GatewayReadinessProbeName => probe.name),
  );
  const longContext = probes.find(
    (probe) => probe.name === "long_context" && probe.status === "passed",
  );
  const tokenMatch = longContext?.evidence.match(/(\d+) approximate tokens/u);
  const testedContextTokens =
    tokenMatch === undefined || tokenMatch === null
      ? undefined
      : Number.parseInt(tokenMatch[1] ?? "0", 10);
  const verified = Object.fromEntries(
    VERIFIED_CAPABILITY_PROBES.map(([key, probe]) => [key, passed.has(probe) || undefined]),
  ) as Omit<GatewayReadinessReport["verifiedCapabilities"], "testedContextTokens">;
  return {
    ...verified,
    testedContextTokens,
  };
}

export async function runGatewayReadiness(
  request: GatewayReadinessRequest,
  deps: UiHandlerDeps,
): Promise<GatewayReadinessReport | RouteResult> {
  const selection = chooseProvider(currentGatewayConfig(deps), request.modelId);
  if ("status" in selection) return selection;
  const names = requestedProbeNames(request.options);
  const probes: GatewayReadinessProbeResult[] = [];
  const chat = await runProbe("chat", deps, selection, request.options);
  probes.push(chat);
  if (chat.status !== "passed") {
    for (const name of names.filter((candidate) => candidate !== "chat")) {
      probes.push(skipped(name, "Skipped because basic chat was not verified."));
    }
  } else {
    for (const name of names.filter((candidate) => candidate !== "chat")) {
      probes.push(await runProbe(name, deps, selection, request.options));
    }
  }
  return {
    modelId: selection.provider.modelId,
    checkedAt: new Date().toISOString(),
    overallStatus: reportStatus(probes),
    probes,
    verifiedCapabilities: verifiedCapabilities(probes),
  };
}

export async function handleGatewayReadiness(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonBody(ctx.req);
  if ("status" in body) return body;
  const report = await runGatewayReadiness(body.parsed, deps);
  if ("status" in report) return report;
  return { status: 200, body: report };
}
