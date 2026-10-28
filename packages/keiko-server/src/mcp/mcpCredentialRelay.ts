import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  createSecretSpellingStreamRedactor,
  SecretSpellingOverflowError,
  type SecretSpellingStreamRedactor,
} from "@oscharko-dev/keiko-security";
import type { McpRemoteSecretHeader } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

/**
 * Static credentials of a remote MCP server (#3903 AC3), kept out of the runtime. A registry entry
 * names, for each header the server expects, a `KEIKO_MCP_SECRET_*` variable of Keiko's own
 * environment; the run never receives that value. Its binding addresses this relay on Keiko's
 * attested loopback origin instead of the server, with a capability minted for the one run and the
 * one server. The relay authenticates that capability, adds the credential headers and forwards the
 * request to exactly the registered URL through Keiko's egress (no redirect, loopback and private
 * targets refused). A leaked capability reaches only that server for that run's lifetime, through
 * Keiko; the credential itself cannot leave Keiko through the run. A server that answers with the
 * credential it received has it replaced in the response before the run reads it.
 */
export const MCP_RELAY_ROUTE = "/api/coding-sidecar/mcp/:relayId";
export const MCP_RELAY_PATH_PREFIX = "/api/coding-sidecar/mcp/";
export const MCP_RELAY_CAPABILITY_HEADER = "x-keiko-mcp-relay";
export const MCP_RELAY_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
export const MCP_RELAY_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_BINDINGS = 256;
const SECRET_VALUE = /^[\x20-\x7E]{1,8192}$/u;
// A shorter credential could not be told apart from ordinary text in a response, and its base64
// form would match unrelated encoded data, so the relay could not keep its promise to replace it.
export const MCP_SECRET_MIN_CHARS = 16;
const RELAY_ID = /^[A-Za-z0-9_-]{22}$/u;

// Headers of the MCP Streamable HTTP transport that pass in each direction; nothing else does.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];

export interface McpRelayTarget {
  readonly runId: string;
  readonly url: string;
  /** The resolved credential headers; held only by the relay, never written to a run. */
  readonly headers: Readonly<Record<string, string>>;
  /** The credential values behind those headers, without their prefixes; held only by the relay. */
  readonly secrets: readonly string[];
}

export interface McpRelayBinding {
  readonly relayId: string;
  readonly capability: string;
}

export interface McpRelayAdmission {
  readonly target: McpRelayTarget;
  /** Aborted once the run is released, which ends every exchange it still holds. */
  readonly signal: AbortSignal;
}

export interface McpCredentialRelay {
  /** A capability for one run and one server; `undefined` when the relay holds its maximum. */
  bind(target: McpRelayTarget): McpRelayBinding | undefined;
  authenticate(relayId: string, capability: string | undefined): McpRelayAdmission | undefined;
  releaseRun(runId: string): void;
}

interface StoredBinding {
  readonly capabilityHash: Buffer;
  readonly target: McpRelayTarget;
  readonly controller: AbortController;
}

function capabilityHash(capability: string): Buffer {
  return createHash("sha256").update(capability, "utf8").digest();
}

class InMemoryMcpCredentialRelay implements McpCredentialRelay {
  private readonly bindings = new Map<string, StoredBinding>();

  public bind(target: McpRelayTarget): McpRelayBinding | undefined {
    if (this.bindings.size >= MAX_BINDINGS) return undefined;
    const relayId = randomBytes(16).toString("base64url");
    const capability = randomBytes(32).toString("base64url");
    this.bindings.set(relayId, {
      capabilityHash: capabilityHash(capability),
      target: Object.freeze({
        ...target,
        headers: Object.freeze({ ...target.headers }),
        secrets: Object.freeze([...target.secrets]),
      }),
      controller: new AbortController(),
    });
    return { relayId, capability };
  }

  public authenticate(
    relayId: string,
    capability: string | undefined,
  ): McpRelayAdmission | undefined {
    if (!RELAY_ID.test(relayId) || capability === undefined) return undefined;
    const stored = this.bindings.get(relayId);
    if (stored === undefined) return undefined;
    if (!timingSafeEqual(stored.capabilityHash, capabilityHash(capability))) return undefined;
    return { target: stored.target, signal: stored.controller.signal };
  }

  public releaseRun(runId: string): void {
    for (const [relayId, stored] of this.bindings) {
      if (stored.target.runId !== runId) continue;
      stored.controller.abort();
      this.bindings.delete(relayId);
    }
  }
}

export function createMcpCredentialRelay(): McpCredentialRelay {
  return new InMemoryMcpCredentialRelay();
}

export type McpSecretHeaderResolution =
  | {
      readonly ok: true;
      readonly headers: Readonly<Record<string, string>>;
      readonly secrets: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "secret-unavailable" | "secret-invalid" | "secret-too-short";
    };

/** The credential headers of one server from Keiko's environment, or why they cannot be had. */
export function resolveMcpSecretHeaders(
  headers: Readonly<Record<string, McpRemoteSecretHeader>>,
  env: Readonly<Record<string, string | undefined>>,
): McpSecretHeaderResolution {
  const resolved: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [name, header] of Object.entries(headers)) {
    const secret = env[header.secretEnv];
    if (secret === undefined || secret.length === 0)
      return { ok: false, reason: "secret-unavailable" };
    const value = `${header.prefix ?? ""}${secret}`;
    if (!SECRET_VALUE.test(value)) return { ok: false, reason: "secret-invalid" };
    if (secret.length < MCP_SECRET_MIN_CHARS) return { ok: false, reason: "secret-too-short" };
    resolved[name] = value;
    secrets.push(secret);
  }
  return { ok: true, headers: resolved, secrets };
}

// ─── the exchange ──────────────────────────────────────────────────────────────────────────────

const METHODS = ["GET", "POST", "DELETE"] as const;
export type McpRelayMethod = (typeof METHODS)[number];
const OUTCOMES = ["bound", "relayed", "cancelled", "refused", "failed"] as const;
const REASONS = [
  "origin-not-allowed",
  "capability-invalid",
  "body-too-large",
  "redirect-refused",
  "response-too-large",
  "upstream-failed",
  "cancelled",
  "secret-unavailable",
  "secret-invalid",
  "secret-too-short",
  "relay-unavailable",
  "credential-in-response-header",
  "credential-spelling-unbounded",
] as const;
type RelayReason = (typeof REASONS)[number];

const MCP_RELAY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.mcp-relay",
  category: "security",
  owner: "keiko-server",
  emitter: "mcp.mcpCredentialRelay.recordMcpRelay",
  fields: {
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["bind", "request"],
    },
    outcome: { type: "string", dataClass: "closed-enum", required: true, values: [...OUTCOMES] },
    reason: { type: "string", dataClass: "closed-enum", required: false, values: [...REASONS] },
    method: { type: "string", dataClass: "closed-enum", required: false, values: [...METHODS] },
    status: { type: "integer", dataClass: "count", required: false },
    // Servers relayed for a run, and servers left out because their credential could not be had.
    relayedServerCount: { type: "integer", dataClass: "count", required: false },
    refusedServerCount: { type: "integer", dataClass: "count", required: false },
    requestBytes: { type: "integer", dataClass: "count", required: false },
    responseBytes: { type: "integer", dataClass: "count", required: false },
    // Credential occurrences the relay replaced in the server's response before the run read it.
    redactedCount: { type: "integer", dataClass: "count", required: false },
    durationMs: { type: "integer", dataClass: "count", required: false },
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
  diagnosticWhen: [{ field: "outcome", values: ["failed"] }],
  failureClasses: ["coding-runtime-mcp-relay"],
  proofIds: ["coding-runtime.mcp-relay.emitted-line"],
  releaseImpact: "patch",
});

export interface McpRelayLine {
  readonly action: "bind" | "request";
  readonly outcome: (typeof OUTCOMES)[number];
  readonly reason?: RelayReason | undefined;
  readonly method?: McpRelayMethod | undefined;
  readonly status?: number | undefined;
  readonly relayedServerCount?: number | undefined;
  readonly refusedServerCount?: number | undefined;
  readonly requestBytes?: number | undefined;
  readonly responseBytes?: number | undefined;
  readonly redactedCount?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly error?: unknown;
}

function optionalFields(line: McpRelayLine): Readonly<Record<string, number | string>> {
  const fields: Record<string, number | string> = {};
  for (const key of [
    "reason",
    "method",
    "status",
    "relayedServerCount",
    "refusedServerCount",
    "requestBytes",
    "responseBytes",
    "redactedCount",
    "durationMs",
  ] as const) {
    const value = line[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

/** Counts and closed values only; never a credential, a URL or a server name. */
export function recordMcpRelay(
  activityLog: ServerLogSink | undefined,
  correlationId: string,
  line: McpRelayLine,
): void {
  const failed = line.outcome === "failed";
  activityLog?.write(
    activityLogEvent(
      MCP_RELAY_OPERATION,
      {
        correlationId,
        ...(failed ? { level: "warn" as const, errorKind: "internal" as const } : {}),
        ...(line.outcome === "refused" ? { level: "warn" as const } : {}),
      },
      {
        action: line.action,
        outcome: line.outcome,
        ...optionalFields(line),
        ...(line.error === undefined
          ? {}
          : { frames: keikoStackFrames(line.error), causeChain: causeChain(line.error) }),
      },
    ),
  );
}

export interface McpUpstreamRequest {
  readonly method: McpRelayMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array<ArrayBuffer> | undefined;
  readonly signal: AbortSignal;
}

export type McpRelayUpstream = (url: string, request: McpUpstreamRequest) => Promise<Response>;

/** The production upstream: Keiko's egress, no redirect, loopback and private targets refused. */
export function egressMcpRelayUpstream(
  egress: () => OutboundHttpEgressConfig | undefined,
): McpRelayUpstream {
  return (url, request) =>
    gatewayFetch(url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "manual",
      egress: { ...egress(), denyLoopback: true, pinProxiedConnectTarget: true },
      maxResponseBytes: MCP_RELAY_RESPONSE_MAX_BYTES,
      signal: request.signal,
    });
}

export interface McpRelayServeOptions {
  readonly relay: McpCredentialRelay | undefined;
  readonly upstream: McpRelayUpstream;
  readonly activityLog: ServerLogSink | undefined;
  /** The request's own correlation, for a request no run's capability accounts for. */
  readonly correlationId: string;
  readonly nowMs?: (() => number) | undefined;
}

class RelayRefusal extends Error {
  public constructor(
    public readonly status: number,
    public readonly reason: RelayReason,
  ) {
    super(reason);
    this.name = "RelayRefusal";
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MCP_RELAY_REQUEST_MAX_BYTES) throw new RelayRefusal(413, "body-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function upstreamHeaders(
  request: IncomingMessage,
  target: McpRelayTarget,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headerValue(request, name);
    if (value !== undefined) headers[name] = value;
  }
  return { ...headers, ...target.headers };
}

// A forwarded header the run reads back as it is (the session id is echoed on every request), so a
// header that spells a credential cannot be rewritten: the response is refused instead.
function responseHeaders(
  upstream: Response,
  target: McpRelayTarget,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value === null) continue;
    const scrubbed = createSecretSpellingStreamRedactor(credentialForms(target));
    scrubbed.push(value);
    scrubbed.finish();
    if (scrubbed.redactedCount() > 0) throw new RelayRefusal(502, "credential-in-response-header");
    headers[name] = value;
  }
  return headers;
}

// A refused response is not read further.
async function admittedResponseHeaders(
  upstream: Response,
  target: McpRelayTarget,
): Promise<Readonly<Record<string, string>>> {
  try {
    return responseHeaders(upstream, target);
  } catch (error) {
    await upstream.body?.cancel();
    throw error;
  }
}

// The credential as a reflecting server may return it: each header value and each bare credential,
// in any spelling a JSON parser, URL decoder or browser restores (createSecretSpellingStreamRedactor),
// and inside base64 or base64url text.
function credentialForms(target: McpRelayTarget): readonly string[] {
  const values = [...Object.values(target.headers), ...target.secrets];
  return [...new Set([...values, ...values.flatMap(base64Cores)])];
}

// The characters every base64 text holding `value` contains, at each of the three byte alignments:
// the characters that depend on a neighbouring byte at either end are left out. An admitted
// credential has at least MCP_SECRET_MIN_CHARS characters, so each core has at least 20.
function base64Cores(value: string): readonly string[] {
  const bytes = Buffer.from(value, "utf8");
  return [0, 1, 2].flatMap((offset) => {
    // base64url carries no padding; the standard alphabet differs only in two characters.
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64url");
    const head = [0, 2, 3][offset] ?? 0;
    const tail = (offset + bytes.length) % 3 === 0 ? 0 : 1;
    const core = encoded.slice(head, encoded.length - tail);
    return [core.replaceAll("-", "+").replaceAll("_", "/"), core];
  });
}

async function writeChunk(response: ServerResponse, text: string): Promise<void> {
  if (text === "" || response.write(text)) return;
  await new Promise<void>((resolve) => response.once("drain", resolve));
}

// A response that keeps holding back a possible spelling ends where it is; nothing held is published.
function pushed(redactor: SecretSpellingStreamRedactor, text: string): string {
  try {
    return redactor.push(text);
  } catch (error) {
    if (error instanceof SecretSpellingOverflowError)
      throw new RelayRefusal(502, "credential-spelling-unbounded");
    throw error;
  }
}

/**
 * Streams the upstream body with backpressure, stops at the response bound and replaces every
 * spelling of a credential, one split across chunks included. MCP's Streamable HTTP transport is UTF-8
 * JSON or event-stream text, decoded and re-encoded unchanged; an event ends with a line break,
 * which no credential contains, so a whole event is never held back. Returns the upstream byte
 * count and the number of replaced occurrences.
 */
async function pipeResponse(
  upstream: Response,
  response: ServerResponse,
  target: McpRelayTarget,
): Promise<{ readonly bytes: number; readonly redacted: number }> {
  let bytes = 0;
  if (upstream.body === null) return { bytes, redacted: 0 };
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const redactor = createSecretSpellingStreamRedactor(credentialForms(target));
  for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > MCP_RELAY_RESPONSE_MAX_BYTES) throw new RelayRefusal(502, "response-too-large");
    await writeChunk(response, pushed(redactor, decoder.decode(chunk, { stream: true })));
  }
  await writeChunk(response, pushed(redactor, decoder.decode()) + redactor.finish());
  return { bytes, redacted: redactor.redactedCount() };
}

function refuse(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "cache-control": "no-store" }).end();
}

function admittedExchange(
  request: IncomingMessage,
  relayId: string,
  options: McpRelayServeOptions,
): McpRelayAdmission {
  if (request.headers.origin !== undefined) throw new RelayRefusal(403, "origin-not-allowed");
  const admission = options.relay?.authenticate(
    relayId,
    headerValue(request, MCP_RELAY_CAPABILITY_HEADER),
  );
  if (admission === undefined) throw new RelayRefusal(401, "capability-invalid");
  return admission;
}

interface ExchangeState {
  correlationId: string;
  requestBytes: number;
  responseBytes: number;
  redactedCount: number;
  status?: number;
  signal?: AbortSignal;
}

async function exchange(
  request: IncomingMessage,
  response: ServerResponse,
  admission: McpRelayAdmission,
  method: McpRelayMethod,
  options: McpRelayServeOptions,
  state: ExchangeState,
): Promise<void> {
  const body = method === "POST" ? await requestBody(request) : undefined;
  state.requestBytes = body?.byteLength ?? 0;
  const upstream = await options.upstream(admission.target.url, {
    method,
    headers: upstreamHeaders(request, admission.target),
    ...(body === undefined ? {} : { body }),
    signal: state.signal ?? admission.signal,
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    throw new RelayRefusal(502, "redirect-refused");
  }
  state.status = upstream.status;
  response.writeHead(upstream.status, await admittedResponseHeaders(upstream, admission.target));
  const piped = await pipeResponse(upstream, response, admission.target);
  state.responseBytes = piped.bytes;
  state.redactedCount = piped.redacted;
  response.end();
}

// The exchange ends when the run is released or the runtime closes the request (an MCP client
// closes its event streams when it disconnects).
function exchangeSignal(
  response: ServerResponse,
  admission: McpRelayAdmission,
): {
  readonly signal: AbortSignal;
  readonly detach: () => void;
} {
  const disconnect = new AbortController();
  const onClose = (): void => {
    if (!response.writableFinished) disconnect.abort();
  };
  response.once("close", onClose);
  return {
    signal: AbortSignal.any([admission.signal, disconnect.signal]),
    detach: (): void => {
      response.removeListener("close", onClose);
    },
  };
}

function settledLine(
  error: unknown,
  state: ExchangeState,
  headersSent: boolean,
): Pick<McpRelayLine, "outcome" | "reason" | "error"> {
  if (state.signal?.aborted === true) return { outcome: "cancelled", reason: "cancelled" };
  if (error instanceof RelayRefusal && !headersSent)
    return { outcome: "refused", reason: error.reason };
  return {
    outcome: "failed",
    reason: error instanceof RelayRefusal ? error.reason : "upstream-failed",
    error,
  };
}

/**
 * Serves one relayed request of the MCP Streamable HTTP transport and records one line for it. A
 * refused request answers its status without reaching the server; a failed one answers 502 before
 * any byte was sent and is cut off after.
 */
export async function serveMcpRelayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: { readonly relayId: string; readonly method: McpRelayMethod },
  options: McpRelayServeOptions,
): Promise<void> {
  const now = options.nowMs ?? Date.now;
  const startedAt = now();
  const state: ExchangeState = {
    correlationId: options.correlationId,
    requestBytes: 0,
    responseBytes: 0,
    redactedCount: 0,
  };
  const recordSettled = (settled: Pick<McpRelayLine, "outcome" | "reason" | "error">): void => {
    recordMcpRelay(options.activityLog, state.correlationId, {
      action: "request",
      ...settled,
      method: input.method,
      ...(state.status === undefined ? {} : { status: state.status }),
      requestBytes: state.requestBytes,
      responseBytes: state.responseBytes,
      redactedCount: state.redactedCount,
      durationMs: Math.max(0, now() - startedAt),
    });
  };
  let detach = (): void => undefined;
  try {
    const admission = admittedExchange(request, input.relayId, options);
    state.correlationId = admission.target.runId;
    const bound = exchangeSignal(response, admission);
    state.signal = bound.signal;
    detach = bound.detach;
    await exchange(request, response, admission, input.method, options, state);
    recordSettled({ outcome: "relayed" });
  } catch (error) {
    // A refusal answers its own status; a failure answers 502, or is cut off once bytes were sent.
    const settled = settledLine(error, state, response.headersSent);
    refuse(response, error instanceof RelayRefusal ? error.status : 502);
    recordSettled(settled);
  } finally {
    detach();
  }
}
