import { createHash } from "node:crypto";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  gatewayFetch,
  readBytesCapped,
  type GatewayFetchOptions,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

/**
 * The search integration the original `websearch` (T15) reaches in a native run (#3903 AC3, #3907
 * AC10, PR #4064 review 4372361272).
 *
 * The pinned 2.1.4 calls the selected provider of its websearch service. Keiko's generated plugin
 * registers its own provider, `keiko`, as that default, so the original tool, its permission ask
 * and its result formatting stay OpenCode's while the search itself runs here, in the server:
 * - only when the operator admitted an integration (`KEIKO_CODING_WEBSEARCH_ENDPOINT`, an Exa-style
 *   MCP endpoint, https or a loopback http service; an optional `KEIKO_CODING_WEBSEARCH_API_KEY`
 *   that never reaches the runtime). Without one the policy keeps its honest refusal;
 * - only for a query the run's native policy has just allowed for that very run (`grant`, one use,
 *   two minutes): the provider cannot search anything the policy did not see;
 * - through the gateway's outbound transport with the deployment's proxy and CA settings, one POST
 *   to the configured host only, no redirect, bounded time, bytes and results.
 * The model reads only titles, URLs, dates and bounded text of the results; the activity log only
 * the outcome, counts, sizes and duration, never the query, a result or the endpoint.
 */

export interface NativeWebSearchConfig {
  readonly endpoint: URL;
  readonly apiKey?: string | undefined;
}

export interface NativeWebSearchResult {
  readonly url: string;
  readonly title?: string;
  readonly content?: string;
  readonly published?: number;
}

export type NativeWebSearchOutcome =
  | { readonly status: "completed"; readonly results: readonly NativeWebSearchResult[] }
  | { readonly status: "refused"; readonly reason: "unconfigured" | "ungranted" }
  | { readonly status: "failed"; readonly reason: "transport" | "response" | "timeout" };

export type NativeWebSearchFetch = (url: string, options: GatewayFetchOptions) => Promise<Response>;

export interface NativeWebSearchDeps {
  readonly config: NativeWebSearchConfig | undefined;
  readonly activityLog: ServerLogSink;
  readonly egress?: (() => OutboundHttpEgressConfig | undefined) | undefined;
  readonly fetchImpl?: NativeWebSearchFetch | undefined;
  readonly now?: (() => number) | undefined;
}

export interface NativeWebSearch {
  /** Whether the operator admitted a search integration for this server. */
  readonly admitted: boolean;
  /** Records that the run's policy allowed this exact query. */
  readonly grant: (runId: string, query: string) => void;
  /** Searches once for a query the run was granted; the grant is spent either way. */
  readonly search: (
    runId: string,
    query: string,
    signal: AbortSignal | undefined,
  ) => Promise<NativeWebSearchOutcome>;
}

const ENDPOINT_ENV = "KEIKO_CODING_WEBSEARCH_ENDPOINT";
const API_KEY_ENV = "KEIKO_CODING_WEBSEARCH_API_KEY";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const GRANT_TTL_MS = 120_000;
const MAX_GRANTS_PER_RUN = 16;
const MAX_QUERY_CHARS = 1_024;
const TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RESULTS = 8;
// The operator service's own MCP tool that the outbound request calls. It is not a Keiko tool
// definition: the model sees only OpenCode's `websearch`, inventoried with the pinned OpenCode
// wire contract, and this name never reaches a model.
const EXA_SEARCH_TOOL = "web_search_exa";
const MAX_TITLE_CHARS = 512;
const MAX_CONTENT_CHARS = 4_000;
const MAX_URL_CHARS = 2_048;

export const NATIVE_WEBSEARCH_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.websearch.performed",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.nativeWebSearch.recordWebSearch",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["completed", "refused", "failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["unconfigured", "ungranted", "transport", "response", "timeout"],
    },
    resultCount: { type: "integer", dataClass: "count", required: true },
    responseBytes: { type: "integer", dataClass: "count", required: true },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["refused", "failed"] }],
  failureClasses: ["coding-runtime-websearch"],
  proofIds: ["coding-runtime.websearch.performed.emitted-line"],
  releaseImpact: "patch",
});

// An endpoint carries no credentials or fragment, and is https or a loopback http service.
function admittedEndpoint(raw: string | undefined): URL | undefined {
  if (raw === undefined || !URL.canParse(raw)) return undefined;
  const endpoint = new URL(raw);
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "")
    return undefined;
  const secure = endpoint.protocol === "https:";
  const local = endpoint.protocol === "http:" && LOOPBACK_HOSTS.has(endpoint.hostname);
  return secure || local ? endpoint : undefined;
}

/** The admitted integration, or none: an endpoint that is neither https nor loopback http is none. */
export function nativeWebSearchConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): NativeWebSearchConfig | undefined {
  const endpoint = admittedEndpoint(env[ENDPOINT_ENV]?.trim());
  if (endpoint === undefined) return undefined;
  const apiKey = env[API_KEY_ENV]?.trim() ?? "";
  return apiKey === "" ? { endpoint } : { endpoint, apiKey };
}

function queryDigest(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

interface Grant {
  readonly digest: string;
  readonly expiresAtMs: number;
}

function requestUrl(config: NativeWebSearchConfig): string {
  const url = new URL(config.endpoint);
  if (config.apiKey !== undefined) url.searchParams.set("exaApiKey", config.apiKey);
  return url.toString();
}

function requestBody(query: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: EXA_SEARCH_TOOL, arguments: { query, numResults: MAX_RESULTS } },
  });
}

function egressFor(
  config: NativeWebSearchConfig,
  base: OutboundHttpEgressConfig | undefined,
): OutboundHttpEgressConfig {
  return {
    denyLoopback: !LOOPBACK_HOSTS.has(config.endpoint.hostname),
    ...(base?.httpProxy === undefined ? {} : { httpProxy: base.httpProxy }),
    ...(base?.httpsProxy === undefined ? {} : { httpsProxy: base.httpsProxy }),
    ...(base?.noProxy === undefined ? {} : { noProxy: base.noProxy }),
    ...(base?.caBundlePath === undefined ? {} : { caBundlePath: base.caBundlePath }),
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

// A JSON-RPC answer arrives as one JSON body or as server-sent events; the first message that
// carries a result is the answer. A message that is not JSON throws, and the search fails as an
// unreadable response.
function rpcResult(text: string): Readonly<Record<string, unknown>> | undefined {
  const candidates = text.trimStart().startsWith("{")
    ? [text]
    : text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length));
  return candidates
    .map((candidate) => record(record(JSON.parse(candidate))?.result))
    .find((result) => result !== undefined);
}

function resultText(result: Readonly<Record<string, unknown>>): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (record(part)?.type === "text" && typeof text === "string") return text;
  }
  return undefined;
}

function present(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value === "" || value === "N/A" ? undefined : value;
}

// A labelled field is the rest of its own line; line scanning keeps parsing linear in the block.
function field(lines: readonly string[], label: string): string | undefined {
  const prefix = `${label}:`;
  return present(lines.find((line) => line.startsWith(prefix))?.slice(prefix.length));
}

// The excerpt runs from its label to the end of the block, including the label's own line.
function excerpt(lines: readonly string[]): string | undefined {
  const start = lines.findIndex((line) => /^(?:Highlights|Text):/u.test(line));
  const header = lines[start];
  if (header === undefined) return undefined;
  const rest = [header.slice(header.indexOf(":") + 1), ...lines.slice(start + 1)];
  return present(rest.join("\n"));
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  // eslint-disable-next-line no-control-regex -- control characters never reach the model
  const visible = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  return visible.length > max ? `${visible.slice(0, max)}…` : visible;
}

function parsedResult(block: string): NativeWebSearchResult | undefined {
  const lines = block.split("\n");
  const url = field(lines, "URL");
  if (url === undefined || url.length > MAX_URL_CHARS || !URL.canParse(url)) return undefined;
  if (!["http:", "https:"].includes(new URL(url).protocol)) return undefined;
  const title = bounded(field(lines, "Title"), MAX_TITLE_CHARS);
  const content = bounded(excerpt(lines), MAX_CONTENT_CHARS);
  const published = Date.parse(field(lines, "Published") ?? "");
  return {
    url,
    ...(title === undefined ? {} : { title }),
    ...(content === undefined ? {} : { content }),
    ...(Number.isFinite(published) ? { published } : {}),
  };
}

/** The results of one answer, in the provider's text format; anything else yields none. */
export function parseNativeWebSearchAnswer(
  text: string,
): readonly NativeWebSearchResult[] | undefined {
  const result = rpcResult(text);
  if (result === undefined || result.isError === true) return undefined;
  const body = resultText(result);
  if (body === undefined) return [];
  return body
    .split(/\n\n---\n\n/u)
    .map(parsedResult)
    .filter((entry): entry is NativeWebSearchResult => entry !== undefined)
    .slice(0, MAX_RESULTS);
}

function failureReason(error: unknown): "transport" | "response" | "timeout" {
  if (error instanceof SyntaxError) return "response";
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "transport";
}

interface SearchEvidence {
  readonly outcome: NativeWebSearchOutcome;
  readonly responseBytes: number;
  readonly error?: unknown;
}

/** One body-free line per search the provider asked for. */
export function recordWebSearch(
  activityLog: ServerLogSink,
  runId: string,
  evidence: SearchEvidence,
  durationMs: number,
): void {
  const { outcome } = evidence;
  const completed = outcome.status === "completed";
  activityLog.write(
    activityLogEvent(
      NATIVE_WEBSEARCH_OPERATION,
      completed
        ? { level: "info", correlationId: runId }
        : {
            level: "warn",
            correlationId: runId,
            ...(outcome.status === "failed" ? { errorKind: "unavailable" as const } : {}),
          },
      {
        outcome: outcome.status,
        ...(completed ? {} : { reason: outcome.reason }),
        resultCount: completed ? outcome.results.length : 0,
        responseBytes: evidence.responseBytes,
        durationMs: Math.max(0, Math.round(durationMs)),
        ...(evidence.error === undefined
          ? {}
          : { frames: keikoStackFrames(evidence.error), causeChain: causeChain(evidence.error) }),
      },
    ),
  );
}

interface SearchRequest {
  readonly runId: string;
  readonly query: string;
  readonly signal: AbortSignal | undefined;
  readonly startedAt: number;
}

async function performSearch(
  deps: NativeWebSearchDeps,
  config: NativeWebSearchConfig,
  request: SearchRequest,
): Promise<NativeWebSearchOutcome> {
  const now = deps.now ?? Date.now;
  let responseBytes = 0;
  try {
    const response = await (deps.fetchImpl ?? gatewayFetch)(requestUrl(config), {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: requestBody(request.query),
      egress: egressFor(config, deps.egress?.()),
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    const bytes = await readBytesCapped(response, MAX_RESPONSE_BYTES);
    responseBytes = bytes.byteLength;
    const results = response.ok
      ? parseNativeWebSearchAnswer(new TextDecoder().decode(bytes))
      : undefined;
    const outcome: NativeWebSearchOutcome =
      results === undefined
        ? { status: "failed", reason: "response" }
        : { status: "completed", results };
    recordWebSearch(
      deps.activityLog,
      request.runId,
      { outcome, responseBytes },
      now() - request.startedAt,
    );
    return outcome;
  } catch (error) {
    const outcome: NativeWebSearchOutcome = { status: "failed", reason: failureReason(error) };
    recordWebSearch(
      deps.activityLog,
      request.runId,
      { outcome, responseBytes, error },
      now() - request.startedAt,
    );
    return outcome;
  }
}

export function createNativeWebSearch(deps: NativeWebSearchDeps): NativeWebSearch {
  const now = deps.now ?? Date.now;
  const grants = new Map<string, Grant[]>();
  const live = (runId: string): Grant[] =>
    (grants.get(runId) ?? []).filter((grant) => grant.expiresAtMs > now());
  const take = (runId: string, query: string): boolean => {
    const digest = queryDigest(query);
    const current = live(runId);
    const index = current.findIndex((grant) => grant.digest === digest);
    if (index !== -1) current.splice(index, 1);
    grants.set(runId, current);
    return index !== -1;
  };
  return {
    admitted: deps.config !== undefined,
    grant: (runId, query): void => {
      if (deps.config === undefined || query.length > MAX_QUERY_CHARS) return;
      const current = live(runId);
      current.push({ digest: queryDigest(query), expiresAtMs: now() + GRANT_TTL_MS });
      grants.set(runId, current.slice(-MAX_GRANTS_PER_RUN));
    },
    search: (runId, query, signal): Promise<NativeWebSearchOutcome> => {
      const startedAt = now();
      const config = deps.config;
      if (config !== undefined && take(runId, query))
        return performSearch(deps, config, { runId, query, signal, startedAt });
      const outcome: NativeWebSearchOutcome = {
        status: "refused",
        reason: config === undefined ? "unconfigured" : "ungranted",
      };
      recordWebSearch(deps.activityLog, runId, { outcome, responseBytes: 0 }, 0);
      return Promise.resolve(outcome);
    },
  };
}

/** The generated provider's request: one query of one run (opencodeRuntimeAdapter.ts). */
export interface NativeWebSearchRequest {
  readonly runId: string;
  readonly query: string;
}

export const NATIVE_WEBSEARCH_ACTION = "web-search";

/** The provider's parsed request body, or nothing when the value is not one. */
export function parseNativeWebSearchRequest(value: unknown): NativeWebSearchRequest | undefined {
  const request = record(value);
  if (request?.action !== NATIVE_WEBSEARCH_ACTION) return undefined;
  const { runId, query } = request;
  return Object.keys(request).length === 3 &&
    typeof runId === "string" &&
    runId.length > 0 &&
    runId.length <= 256 &&
    typeof query === "string" &&
    query.trim() !== "" &&
    query.length <= MAX_QUERY_CHARS
    ? { runId, query }
    : undefined;
}

/** The provider's answer: the results, or the closed reason the search was refused or failed. */
export async function answerNativeWebSearch(
  search: NativeWebSearch | undefined,
  request: NativeWebSearchRequest,
  runLive: boolean,
  signal: AbortSignal | undefined,
): Promise<{ readonly status: number; readonly body: string }> {
  if (search === undefined || !runLive)
    return { status: 403, body: JSON.stringify({ status: "refused", reason: "unconfigured" }) };
  const outcome = await search.search(request.runId, request.query, signal);
  if (outcome.status === "completed")
    return { status: 200, body: JSON.stringify({ results: outcome.results }) };
  return {
    status: outcome.status === "refused" ? 403 : 502,
    body: JSON.stringify({ status: outcome.status, reason: outcome.reason }),
  };
}
