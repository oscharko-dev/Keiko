import type { IncomingMessage } from "node:http";
import {
  isConversationEligibleModel,
  listConfiguredCapabilities,
  requestGatewayReadinessChatCompletion,
  requestOpenAIEmbedding,
  vectorL2Norm,
  type GatewayConfig,
  type ModelCapability,
  type ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { readJsonCapped, readSseStream } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type {
  GatewayReadinessOptions,
  GatewayReadinessProbeName,
  GatewayReadinessProbeResult,
  GatewayReadinessReport,
  GatewayReadinessRequest,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { gatewayVerificationFromProbeOutcome } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import { maxUtf8BytesForTokenBudget } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { preferredConversationModelOrder } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import type { UiHandlerDeps, VerifiedModelCapabilityFields } from "./deps.js";
import { currentConversationReady, currentGatewayConfig } from "./deps.js";
import { newCorrelationId } from "./correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { rerankSelection } from "./grounded-rerank-facade.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "./bounded-request-body.js";
import { probeGatewayToolCalling } from "./gateway-tool-calling-probe.js";
import { reconcileGatewayToolCallingReadiness } from "./gateway-setup.js";

const DEFAULT_PROBES: readonly GatewayReadinessProbeName[] = [
  "chat",
  "streaming",
  "tool_calling",
  "json_schema",
  "embedding",
];
const DEEP_PROBES: readonly GatewayReadinessProbeName[] = [
  "reranker",
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
  ["embedding", "embedding"],
  ["reranker", "reranker"],
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

export type { GatewayToolCallingProbeStatus } from "./gateway-tool-calling-probe.js";

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

function error(code: string, message: string, status = 400): RouteResult {
  return { status, body: { error: { code, message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbeName(value: unknown): value is GatewayReadinessProbeName {
  return typeof value === "string" && ALL_PROBES.has(value as GatewayReadinessProbeName);
}

// Consolidated onto the shared bounded reader (#2902 w5-sse-counters) — the cap above is
// unchanged, only the ad hoc listener wiring is gone.
async function readJsonBody(
  req: IncomingMessage,
  correlationId?: string,
): Promise<ParsedReadinessBody | RouteResult> {
  let raw: string;
  try {
    raw = await readBoundedRequestBody(req, MAX_BODY_BYTES, undefined, correlationId);
  } catch (bodyError) {
    if (bodyError instanceof RequestBodyTooLargeError) {
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

async function providerRequest(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  provider: ModelProviderConfig,
  body: Readonly<Record<string, unknown>>,
  options: ProviderRequestOptions = {},
): Promise<Response> {
  return requestGatewayReadinessChatCompletion({
    config,
    provider,
    body,
    ...(deps.gatewayReadinessFetch !== undefined ? { fetchImpl: deps.gatewayReadinessFetch } : {}),
    ...(options.stream === true ? { stream: true } : {}),
    maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
  });
}

function providerCapability(
  config: GatewayConfig,
  provider: ModelProviderConfig,
): ModelCapability | undefined {
  return listConfiguredCapabilities(config).find(
    (capability) => capability.id === provider.modelId,
  );
}

function chooseEmbeddingProvider(config: GatewayConfig): ModelProviderConfig | undefined {
  return config.providers.find(
    (provider) => providerCapability(config, provider)?.kind === "embedding",
  );
}

// Surfaces the HTTP status when the gateway answered: "(http-error 400)" points at the request
// shape, "(transport)" at connectivity — collapsing the two once misdirected a whole
// connectivity investigation.
function embeddingFailureDetail(outcome: {
  readonly kind: string;
  readonly status?: number;
}): string {
  return outcome.status !== undefined ? `${outcome.kind} ${String(outcome.status)}` : outcome.kind;
}

function roundedNorm(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// eslint-disable-next-line max-lines-per-function
async function probeEmbedding(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  const provider = chooseEmbeddingProvider(config);
  if (provider === undefined) {
    return skipped("embedding", "No embedding-capable provider is configured.");
  }
  try {
    const outcome = await requestOpenAIEmbedding({
      endpoint: provider.baseUrl,
      apiKey: provider.apiKey,
      ...(provider.apiKeyHeaderName !== undefined
        ? { apiKeyHeaderName: provider.apiKeyHeaderName }
        : {}),
      modelId: provider.modelId,
      input: "Keiko embedding readiness probe",
      ...(deps.gatewayReadinessFetch !== undefined
        ? { fetchImpl: deps.gatewayReadinessFetch }
        : {}),
      timeoutMs: provider.timeoutMs,
      egress: config.egress,
    });
    if (!outcome.ok) {
      return result(
        "embedding",
        outcome.kind === "unsupported-model" ? "unsupported" : "failed",
        start,
        `Embedding endpoint could not be verified (${embeddingFailureDetail(outcome)}).`,
      );
    }
    const dimensions = outcome.value.vector.length;
    const norm = roundedNorm(vectorL2Norm(outcome.value.vector));
    const passed = dimensions > 0 && norm > 0;
    return result(
      "embedding",
      passed ? "passed" : "failed",
      start,
      passed
        ? `Embedding endpoint returned ${dimensions.toString()} dimensions with L2 norm ${norm.toFixed(4)}.`
        : "Embedding endpoint returned an empty or zero-norm vector.",
    );
  } catch (probeError) {
    return probeFailure(
      deps,
      correlationId,
      "embedding",
      start,
      "Embedding endpoint could not be verified.",
      probeError,
    );
  }
}

// Maps one reranker selection onto its probe result. Extracted so `probeReranker` stays inside the
// 50-line ceiling now that its catch reports through the diagnostic sink.
function rerankerSelectionResult(
  selection: Awaited<ReturnType<typeof rerankSelection<string>>>,
  expectedTopDocument: string,
  start: number,
): GatewayReadinessProbeResult {
  if (selection.diagnostics.status !== "applied") {
    const kind = selection.diagnostics.failureKind ?? "transport";
    return result(
      "reranker",
      kind === "unsupported-model" || kind === "not-configured" ? "unsupported" : "failed",
      start,
      `Reranker endpoint could not be verified (${kind}).`,
    );
  }
  const passed = selection.selected[0] === expectedTopDocument;
  return result(
    "reranker",
    passed ? "passed" : "unsupported",
    start,
    passed
      ? "Reranker returned the expected top document for a two-item probe."
      : "Reranker answered, but did not rank the expected document first.",
  );
}

// The config is threaded in from the readiness run's single `chooseProvider` snapshot rather than
// re-read live: probes execute concurrently, `currentGatewayConfig` is backed by a mutable closure
// the gateway-setup save route replaces, and one readiness report must describe one config
// generation across every probe in it.
async function probeReranker(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  if (config.reranker === undefined) {
    return skipped("reranker", "No reranker is configured.");
  }
  try {
    const documents = ["alpha readiness match", "unrelated beta"] as const;
    const selection = await rerankSelection({
      deps,
      gatewayConfig: config,
      query: "alpha readiness match",
      candidates: documents,
      documentFor: (document) => document,
      topN: 1,
      ...(deps.gatewayReadinessFetch !== undefined
        ? { fetchImpl: deps.gatewayReadinessFetch }
        : {}),
      fallbackMode: "slice-topN",
    });
    return rerankerSelectionResult(selection, documents[0], start);
  } catch (probeError) {
    return probeFailure(
      deps,
      correlationId,
      "reranker",
      start,
      "Reranker endpoint could not be verified.",
      probeError,
    );
  }
}

function result(
  name: GatewayReadinessProbeName,
  status: ProbeStatus,
  start: number,
  evidence: string,
  warning?: string,
  capabilityObservation?: boolean,
): GatewayReadinessProbeResult {
  return {
    name,
    status,
    latencyMs: Math.max(0, Date.now() - start),
    evidence,
    ...(warning !== undefined ? { warning } : {}),
    ...(capabilityObservation === undefined ? {} : { capabilityObservation }),
  };
}

function rejectedCapabilityResult(
  name: GatewayReadinessProbeName,
  status: ProbeStatus,
  start: number,
  evidence: string,
  warning?: string,
): GatewayReadinessProbeResult {
  return result(
    name,
    status,
    start,
    evidence,
    warning,
    status === "unsupported" ? false : undefined,
  );
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

// Every probe's `catch` used to collapse an actionable cause — an auth rejection, a DNS/TLS failure,
// a missing model — into the same two operator-facing sentences, and nothing anywhere else recorded
// it. A readiness run is the product's ONLY live evidence about the gateway (F-01), so an
// unexplained failure here is the difference between "fix your API key" and "no idea". The probe
// result stays exactly as before (the browser learns nothing new); the CAUSE goes to the redacted
// operator sink keyed by the run's correlation id, with the failing probe named by `source`.
// Content-free: error class, machine code, gateway request id — never a probe body, an endpoint,
// or a credential.
function probeFailure(
  deps: UiHandlerDeps,
  correlationId: string,
  name: GatewayReadinessProbeName,
  start: number,
  evidence: string,
  probeError: unknown,
): GatewayReadinessProbeResult {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "gateway.readiness",
      source: `gateway-readiness.${name}`,
      error: probeError,
      summary: "A gateway readiness probe could not be completed.",
      redact: (message): string => String(deps.redactor(message)),
    }),
  );
  return result(name, "failed", start, evidence, providerWarning(probeError));
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
  config: GatewayConfig,
  provider: ModelProviderConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, config, provider, {
      messages: [
        { role: "system", content: "You are checking whether a chat endpoint can answer." },
        { role: "user", content: "Reply with exactly: OK" },
      ],
    });
    if (!response.ok) {
      return result("chat", "failed", start, unsuccessfulEvidence("Basic chat", response));
    }
    // Mirror the production floor exactly (openai-adapter assertUsableAssistantResponse +
    // normalize textFromContent): the extracted assistant text must be non-empty, and
    // content-part arrays count like plain strings. A probe stricter OR looser than the
    // adapter turns readiness into a lie in one direction or the other.
    const payload = await readProviderJson(response);
    const passed = firstMessage(payload) !== undefined && assistantText(payload).trim().length > 0;
    return result(
      "chat",
      passed ? "passed" : "failed",
      start,
      passed
        ? "Working today: basic chat returned a valid assistant response."
        : "Basic chat did not return a valid assistant response.",
    );
  } catch (probeError) {
    return probeFailure(
      deps,
      correlationId,
      "chat",
      start,
      "Basic chat could not be verified.",
      probeError,
    );
  }
}

async function probeStreaming(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  provider: ModelProviderConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(
      deps,
      config,
      provider,
      {
        messages: [
          { role: "system", content: "You are a minimal streaming readiness probe." },
          { role: "user", content: "Reply with exactly: stream-ok" },
        ],
      },
      { stream: true },
    );
    if (!response.ok) return rejectedStreamingResult(response, start);
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
    return probeFailure(
      deps,
      correlationId,
      "streaming",
      start,
      "Streaming could not be verified.",
      probeError,
    );
  }
}

function rejectedStreamingResult(response: Response, start: number): GatewayReadinessProbeResult {
  const status = unsupportedStatus(response) ? "unsupported" : "failed";
  return rejectedCapabilityResult(
    "streaming",
    status,
    start,
    "Streaming was not accepted by the endpoint.",
  );
}

async function probeToolCalling(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  provider: ModelProviderConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  let failure: GatewayReadinessProbeResult | undefined;
  const status = await probeGatewayToolCalling(
    config,
    provider,
    deps.gatewayReadinessFetch,
    (error) => {
      failure = probeFailure(
        deps,
        correlationId,
        "tool_calling",
        start,
        "Tool calling could not be verified.",
        error,
      );
    },
  );
  if (failure !== undefined) return failure;
  if (status === "verified") {
    return result(
      "tool_calling",
      "passed",
      start,
      "OpenAI-compatible tool call returned the expected function name.",
    );
  }
  return toolCallingResult(status === "unsupported" ? "unsupported" : "failed", start);
}

function toolCallingResult(status: ProbeStatus, start: number): GatewayReadinessProbeResult {
  return rejectedCapabilityResult(
    "tool_calling",
    status,
    start,
    "Tool calling was not accepted by the endpoint.",
  );
}

async function probeJsonSchema(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  provider: ModelProviderConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, config, provider, jsonSchemaBody());
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return jsonSchemaResult(status, start);
    }
    return jsonSchemaPayloadResult(start, await readProviderJson(response));
  } catch (probeError) {
    return probeFailure(
      deps,
      correlationId,
      "json_schema",
      start,
      "Structured JSON output could not be verified.",
      probeError,
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
          properties: { status: { type: "string", enum: ["json-ok"] } },
          required: ["status"],
        },
      },
    },
  };
}

function jsonSchemaResult(status: ProbeStatus, start: number): GatewayReadinessProbeResult {
  return rejectedCapabilityResult(
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
  config: GatewayConfig,
  provider: ModelProviderConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, config, provider, {
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
    return probeFailure(
      deps,
      correlationId,
      "reasoning",
      start,
      "Reasoning output could not be verified.",
      probeError,
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
  config: GatewayConfig,
  provider: ModelProviderConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, config, provider, {
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
      return rejectedCapabilityResult(
        "image_input",
        status,
        start,
        "Image input was not accepted by the endpoint.",
      );
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
    return probeFailure(
      deps,
      correlationId,
      "image_input",
      start,
      "Image input could not be verified.",
      probeError,
    );
  }
}

async function probeDocumentInput(
  deps: UiHandlerDeps,
  config: GatewayConfig,
  provider: ModelProviderConfig,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  try {
    const response = await providerRequest(deps, config, provider, documentInputBody());
    if (!response.ok) {
      const status = unsupportedStatus(response) ? "unsupported" : "failed";
      return documentInputResult(status, start);
    }
    return documentInputPayloadResult(start, await readProviderJson(response));
  } catch (probeError) {
    return probeFailure(
      deps,
      correlationId,
      "document_input",
      start,
      "Document input could not be verified.",
      probeError,
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
  return rejectedCapabilityResult(
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

// Exported for regression coverage of KEIKO-0358: an unknown contextWindow (0) must not
// cause the deep long-context probe to silently cap at DEFAULT_LONG_CONTEXT_TOKENS.
export function longContextTokens(
  options: GatewayReadinessOptions | undefined,
  capability: ModelCapability | undefined,
): number {
  const contextWindow = capability?.contextWindow ?? 0;
  if (options?.maxContextTokens !== undefined) {
    const deploymentCeiling = contextWindow > 0 ? contextWindow : MAX_CONTEXT_TOKENS;
    return Math.min(options.maxContextTokens, deploymentCeiling, MAX_CONTEXT_TOKENS);
  }
  if (contextWindow >= EXTENDED_LONG_CONTEXT_TOKENS) return EXTENDED_LONG_CONTEXT_TOKENS;
  // KEIKO-0358: an unknown/not-yet-probed contextWindow (0) is not evidence the model is
  // short-context; capping such probes at 32k lets a genuinely long-context model look
  // healthy from the readiness lane and then run out of room in production. Assume the
  // extended budget for the 0 case; genuinely small windows (1..EXTENDED-1) still cap at
  // DEFAULT_LONG_CONTEXT_TOKENS to avoid probing past the model's real ceiling.
  if (contextWindow === 0) return EXTENDED_LONG_CONTEXT_TOKENS;
  return DEFAULT_LONG_CONTEXT_TOKENS;
}

function longContextBody(tokens: number): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly sentinel: string;
} {
  const approximateChars = maxUtf8BytesForTokenBudget(tokens);
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
  config: GatewayConfig,
  provider: ModelProviderConfig,
  capability: ModelCapability | undefined,
  options: GatewayReadinessOptions | undefined,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const start = Date.now();
  const tokens = longContextTokens(options, capability);
  const { body, sentinel } = longContextBody(tokens);
  try {
    const response = await providerRequest(deps, config, provider, body);
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
    return probeFailure(
      deps,
      correlationId,
      "long_context",
      start,
      "Long-context input could not be verified.",
      probeError,
    );
  }
}

async function runProbe(
  name: GatewayReadinessProbeName,
  deps: UiHandlerDeps,
  selection: ProviderSelection,
  options: GatewayReadinessOptions | undefined,
  correlationId: string,
): Promise<GatewayReadinessProbeResult> {
  const { config, provider } = selection;
  if (name === "chat") return probeChat(deps, config, provider, correlationId);
  if (name === "streaming") return probeStreaming(deps, config, provider, correlationId);
  if (name === "tool_calling") return probeToolCalling(deps, config, provider, correlationId);
  if (name === "json_schema") return probeJsonSchema(deps, config, provider, correlationId);
  if (name === "embedding") return probeEmbedding(deps, config, correlationId);
  if (name === "reranker") return probeReranker(deps, config, correlationId);
  if (name === "reasoning") return probeReasoning(deps, config, provider, correlationId);
  if (name === "image_input") return probeImageInput(deps, config, provider, correlationId);
  if (name === "document_input") return probeDocumentInput(deps, config, provider, correlationId);
  return probeLongContext(deps, config, provider, selection.capability, options, correlationId);
}

function reportStatus(
  probes: readonly GatewayReadinessProbeResult[],
): GatewayReadinessReport["overallStatus"] {
  const chat = probes.find((probe) => probe.name === "chat");
  if (chat?.status !== "passed") return "failed";
  return probes.every((probe) => probe.status === "passed") ? "ready" : "partial";
}

// Digit/float quantifiers are bounded (S8786): both evidence strings are built from
// `.toString()`/`.toFixed(4)` on numeric probe results (see the `approximate tokens` and
// `dimensions with L2 norm` template literals above). Without a bound, an unanchored
// `\d+`/`[0-9.]+` that never reaches the expected trailing literal forces an O(n) backtrack retry
// at every one of the O(n) start positions in a long adversarial evidence string — quadratic in
// the input length.
//
// The norm capture's bound must cover more than "realistic" values, because `norm` is computed
// from an untrusted/hostile embedding provider's response (a `Float32Array` whose component
// magnitudes an adversarial or broken provider fully controls, up to ~3.4e38 each) — this is
// exactly the kind of external input this repo's trust model treats as hostile. `Number.toFixed`
// only switches to exponential notation at 1e21; below that threshold, the longest possible
// decimal string it can produce is 21 integer digits + "." + 4 fraction digits = 26 characters
// (e.g. "999999999999999999999.9999"). A bound of 20 truncates — rather than fails to match —
// any value in the 1e17..1e21 range, silently reporting a wrong (too-small) norm instead of a
// clean parse failure. 32 gives comfortable headroom over that 26-character mathematical ceiling
// while staying a small, finite bound for Sonar's static analysis. (Norms at/above 1e21 render in
// exponential notation, e.g. "1.2345e+21" — the `[0-9.]` class already stops at the non-digit "e"
// character before any bound is reached, matching the pre-existing, unbounded-original behavior
// for that extreme range unchanged; that is not a regression introduced by this bound.)
//
// Exported so the timing/equivalence regression can exercise the exact patterns used below rather
// than a hand-copied duplicate.
export const TESTED_CONTEXT_TOKENS_PATTERN = /(\d{1,15}) approximate tokens/u;
export const EMBEDDING_EVIDENCE_PATTERN =
  /returned (\d{1,15}) dimensions with L2 norm ([0-9.]{1,32})/u;

// eslint-disable-next-line complexity
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
  const tokenMatch = longContext?.evidence.match(TESTED_CONTEXT_TOKENS_PATTERN);
  const testedContextTokens =
    tokenMatch === undefined || tokenMatch === null
      ? undefined
      : Number.parseInt(tokenMatch[1] ?? "0", 10);
  const embedding = probes.find((probe) => probe.name === "embedding" && probe.status === "passed");
  const embeddingMatch = embedding?.evidence.match(EMBEDDING_EVIDENCE_PATTERN);
  const embeddingDimensions =
    embeddingMatch === undefined || embeddingMatch === null
      ? undefined
      : Number.parseInt(embeddingMatch[1] ?? "0", 10);
  const embeddingNorm =
    embeddingMatch === undefined || embeddingMatch === null
      ? undefined
      : Number.parseFloat(embeddingMatch[2] ?? "0");
  const verified = Object.fromEntries(
    VERIFIED_CAPABILITY_PROBES.map(([key, probe]) => [key, passed.has(probe) || undefined]),
  ) as Omit<
    GatewayReadinessReport["verifiedCapabilities"],
    "testedContextTokens" | "embeddingDimensions" | "embeddingNorm"
  >;
  return {
    ...verified,
    embeddingDimensions,
    embeddingNorm,
    testedContextTokens,
  };
}

const CATEGORICAL_OBSERVATION_PROBES: ReadonlySet<GatewayReadinessProbeName> = new Set([
  "streaming",
  "tool_calling",
  "json_schema",
  "image_input",
  "document_input",
]);

function executedCategoricalFeatureProbe(probes: readonly GatewayReadinessProbeResult[]): boolean {
  return probes.some(
    (probe) => CATEGORICAL_OBSERVATION_PROBES.has(probe.name) && probe.status !== "skipped",
  );
}

function categoricalProbeValue(
  probes: readonly GatewayReadinessProbeResult[],
  name: GatewayReadinessProbeName,
): boolean | undefined {
  const probe = probes.find((candidate) => candidate.name === name);
  if (probe?.status === "passed") return true;
  if (probe?.status === "unsupported" && probe.capabilityObservation === false) return false;
  return undefined;
}

function verifiedCapabilityObservation(
  probes: readonly GatewayReadinessProbeResult[],
): VerifiedModelCapabilityFields {
  const values = [
    ["conversationReady", categoricalProbeValue(probes, "chat")],
    ["streaming", categoricalProbeValue(probes, "streaming")],
    ["toolCalling", categoricalProbeValue(probes, "tool_calling")],
    ["structuredOutput", categoricalProbeValue(probes, "json_schema")],
    ["supportsImageInput", categoricalProbeValue(probes, "image_input")],
    ["supportsDocumentInput", categoricalProbeValue(probes, "document_input")],
  ] as const;
  return Object.fromEntries(values.filter(([, value]) => value !== undefined));
}

function recordReadinessObservation(
  deps: UiHandlerDeps,
  report: GatewayReadinessReport,
  observedGeneration: number | undefined,
): void {
  deps.gatewayConfig?.recordVerification(
    gatewayVerificationFromProbeOutcome(report.overallStatus),
    observedGeneration,
  );
  if (report.overallStatus === "failed") {
    deps.gatewayConfig?.clearVerifiedCapability(report.modelId, observedGeneration);
    return;
  }
  const observation = verifiedCapabilityObservation(report.probes);
  if (Object.keys(observation).length === 0) return;
  const previous = deps.gatewayConfig?.verifiedCapability(report.modelId);
  // Chat-only means no categorical feature probe EXECUTED. Keying this on observation keys
  // let a run whose only feature probe FAILED (yielding no observation) masquerade as a
  // chat-only refresh and re-stamp stale previous fields with a fresh checkedAt — verified
  // evidence contradicted by the very run recording it.
  const chatOnlyRun = !executedCategoricalFeatureProbe(report.probes);
  const fields =
    chatOnlyRun && previous !== undefined && previous.generation === observedGeneration
      ? { ...previous.fields, ...observation }
      : observation;
  deps.gatewayConfig?.recordVerifiedCapability(
    report.modelId,
    fields,
    report.checkedAt,
    observedGeneration,
  );
}

function reconcileToolCallingReadiness(
  deps: UiHandlerDeps,
  report: GatewayReadinessReport,
  observedGeneration: number | undefined,
  correlationId: string,
): void {
  if (!report.probes.some((probe) => probe.name === "tool_calling")) return;
  try {
    reconcileGatewayToolCallingReadiness(deps, report, observedGeneration, correlationId);
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId,
        operation: "gateway.readiness",
        source: "gateway-readiness.capability-reconcile",
        error,
        summary: "Gateway tool-calling verification could not be persisted.",
        redact: (message): string => String(deps.redactor(message)),
      }),
    );
  }
}

export async function runGatewayReadiness(
  request: GatewayReadinessRequest,
  deps: UiHandlerDeps,
  // RB-6: the request-scoped correlation id, so every probe diagnostic from ONE readiness run shares
  // one id. A caller without a request context (a scheduled/CLI run) gets a freshly minted id rather
  // than an id-less record.
  requestCorrelationId?: string,
): Promise<GatewayReadinessReport | RouteResult> {
  const selection = chooseProvider(currentGatewayConfig(deps), request.modelId);
  if ("status" in selection) return selection;
  // Capture the config generation BEFORE the async probes: the verdict describes this
  // configuration, and the holder drops it if the config was replaced mid-probe (#2847 review).
  const observedGeneration = deps.gatewayConfig?.generation();
  const correlationId = requestCorrelationId ?? newCorrelationId();
  const names = requestedProbeNames(request.options);
  const probes: GatewayReadinessProbeResult[] = [];
  const chat = await runProbe("chat", deps, selection, request.options, correlationId);
  probes.push(chat);
  if (chat.status !== "passed") {
    for (const name of names.filter((candidate) => candidate !== "chat")) {
      probes.push(skipped(name, "Skipped because basic chat was not verified."));
    }
  } else {
    probes.push(
      ...(await Promise.all(
        names
          .filter((candidate) => candidate !== "chat")
          .map((name) => runProbe(name, deps, selection, request.options, correlationId)),
      )),
    );
  }
  const report: GatewayReadinessReport = {
    modelId: selection.provider.modelId,
    checkedAt: new Date().toISOString(),
    overallStatus: reportStatus(probes),
    probes,
    verifiedCapabilities: verifiedCapabilities(probes),
  };
  // F-01: this run is the product's only live evidence about the gateway. Record its outcome on the
  // config holder so the surfaces that used to infer readiness from configuration alone (the editor
  // AI-assist badge, the Coding Workbench source projection) report what was actually observed.
  // Content-free: one state word, no probe bodies, no endpoints, no credentials.
  recordReadinessObservation(deps, report, observedGeneration);
  reconcileToolCallingReadiness(deps, report, observedGeneration, correlationId);
  return report;
}

// Fresh-install gap (customer field incident, 0.3.10): a configured gateway carries NO
// readiness observation until someone runs the settings probe, so every chat create/send was
// rejected as "not ready" until the user manually verified each model in the settings dialog.
// When a conversation guard finds no CURRENT-GENERATION observation for the model, verify on
// demand with the minimal chat probe. The admission stays honest — the probe must actually
// pass. Concurrent callers share one in-flight probe per model.
const onDemandReadinessProbes = new Map<string, Promise<void>>();

// A failed probe must not pin the model for the whole configuration generation: a transient
// gateway outage would brick every chat surface until a manual re-probe or restart (the
// readiness twin of the 0.3.11 endless-indexing incident). It must not be re-probed on every
// request either — each probe can burn the full provider timeout against a dead gateway. So a
// current-generation non-ready observation answers the guard only within this window; after it,
// the next conversation attempt re-probes and either heals or refreshes the pin.
export const NOT_READY_REPROBE_COOLDOWN_MS = 30_000;

function withinNotReadyCooldown(
  holder: NonNullable<UiHandlerDeps["gatewayConfig"]>,
  modelId: string,
): boolean {
  const observation = holder.verifiedCapability(modelId);
  if (observation?.generation !== holder.generation()) return false;
  // Only an EXPLICIT failed chat probe earns a cooldown. An observation without a
  // conversationReady field (e.g. a capability record carrying other probe fields) is unknown
  // readiness, and unknown must probe immediately — never sit out a 30-second admission block
  // (review finding on #3220).
  if (observation.fields.conversationReady !== false) return false;
  const ageMs = Date.now() - Date.parse(observation.checkedAt);
  // Malformed AND future timestamps fail open toward probing — never toward a pin: NaN and
  // negative ages both miss the [0, cooldown) window.
  return ageMs >= 0 && ageMs < NOT_READY_REPROBE_COOLDOWN_MS;
}

export async function ensureOnDemandConversationReadiness(
  deps: UiHandlerDeps,
  modelId: string,
): Promise<void> {
  const holder = deps.gatewayConfig;
  if (holder === undefined || modelId.length === 0) return;
  if (currentConversationReady(deps, modelId)) return;
  if (withinNotReadyCooldown(holder, modelId)) return;
  // The in-flight key carries the generation: a config replaced mid-probe must not hand the
  // NEW generation's caller the OLD generation's discarded report.
  const key = `${String(holder.generation())}:${modelId}`;
  const inFlight = onDemandReadinessProbes.get(key);
  if (inFlight !== undefined) {
    await inFlight;
    return;
  }
  const probe = runOnDemandReadinessProbe(deps, holder, modelId).finally(() => {
    onDemandReadinessProbes.delete(key);
  });
  onDemandReadinessProbes.set(key, probe);
  await probe;
}

async function runOnDemandReadinessProbe(
  deps: UiHandlerDeps,
  holder: NonNullable<UiHandlerDeps["gatewayConfig"]>,
  modelId: string,
): Promise<void> {
  const generation = holder.generation();
  try {
    await runGatewayReadiness({ modelId, options: { probes: [] } }, deps);
  } catch (error) {
    // The route still answers with the honest unready result — but never silently: the
    // underlying failure lands as a redacted operator diagnostic with a correlation id.
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: newCorrelationId(),
        operation: "gateway.readiness",
        source: "gateway-readiness.on-demand",
        error,
        summary: "A gateway readiness probe could not be completed.",
        redact: (message): string => String(deps.redactor(message)),
      }),
    );
  }
  // A failed report CLEARS the capability entry; without a current-generation observation
  // every subsequent chat attempt would probe the provider again. Persist an explicit
  // not-ready so retries hit the guard instead of the wire (the settings probe replaces it).
  if (
    holder.generation() === generation &&
    holder.verifiedCapability(modelId)?.generation !== generation
  ) {
    holder.recordVerifiedCapability(
      modelId,
      { conversationReady: false },
      new Date().toISOString(),
      generation,
    );
  }
}

// Chat creation without an explicit model must not die on an unsuitable FIRST list entry
// (customer field incident: an OCR model at position 1 legitimately fails the chat probe;
// the single-model on-demand check then recorded not-ready and stopped, so every chat
// create failed until a suitable model was probed MANUALLY). When the requested default is
// not conversation-ready, walk the remaining configured chat models — mode-declared
// candidates first (keiko-contracts conversationDefaultRank) — until one verifies; the
// default-model selection then prefers the verified one.
//
// The walk is BOUNDED: probes are serial and each can burn the full provider timeout, so an
// aggregate budget caps what one interactive create may wait (the unbounded-sum lesson of the
// 0.3.11 embedding ladder, applied here). A probe that outlives the budget keeps running in
// the shared in-flight map — its observation lands for the NEXT attempt — but this request
// stops waiting.
export const CHAT_MODEL_WALK_BUDGET_MS = 45_000;

async function settledWithinBudget(probe: Promise<void>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, budgetMs);
  });
  try {
    return await Promise.race([probe.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function conversationWalkCandidates(
  deps: UiHandlerDeps,
  requestedModelId: string,
): readonly ModelCapability[] {
  const config = currentGatewayConfig(deps);
  if (config === undefined) return [];
  return preferredConversationModelOrder(
    listConfiguredCapabilities(config).filter(
      (capability) => capability.kind === "chat" && capability.id !== requestedModelId,
    ),
  );
}

export async function ensureAnyConversationReadyChatModel(
  deps: UiHandlerDeps,
  requestedModelId: string,
): Promise<void> {
  // The budget covers the REQUESTED model's probe too (review finding on the first cut):
  // computed after it, a hanging gateway burned the full provider timeout before the budget
  // even started. The interactive create never waits longer than the budget, full stop.
  const deadlineAt = Date.now() + CHAT_MODEL_WALK_BUDGET_MS;
  const firstProbe = ensureOnDemandConversationReadiness(deps, requestedModelId);
  if (!(await settledWithinBudget(firstProbe, CHAT_MODEL_WALK_BUDGET_MS))) return;
  if (currentConversationReady(deps, requestedModelId)) return;
  for (const capability of conversationWalkCandidates(deps, requestedModelId)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return;
    const probe = ensureOnDemandConversationReadiness(deps, capability.id);
    if (!(await settledWithinBudget(probe, remainingMs))) return;
    if (currentConversationReady(deps, capability.id)) return;
  }
}

export async function handleGatewayReadiness(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readJsonBody(ctx.req, ctx.correlationId);
  if ("status" in body) return body;
  const report = await runGatewayReadiness(body.parsed, deps, ctx.correlationId);
  if ("status" in report) return report;
  return { status: 200, body: report };
}
