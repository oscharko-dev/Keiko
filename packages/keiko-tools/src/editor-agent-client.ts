import {
  isEditorAgentActionResult,
  parseEditorAgentQueryGitData,
  isEditorAgentSessionSnapshot,
  parseEditorAgentVerificationResult,
  type EditorAgentAction,
  type EditorAgentActionQueuedResponse,
  type EditorAgentActionResult,
  type EditorAgentSessionsResponse,
  type EditorAgentSnapshotRequest,
  type EditorAgentSnapshotResponse,
  type EditorAgentVerificationResult,
  type EditorAgentVerificationRunRequest,
} from "@oscharko-dev/keiko-contracts";

type EditorAgentConflictDetail = NonNullable<EditorAgentActionResult["conflict"]>;
type EditorAgentFileActionResult = NonNullable<EditorAgentActionResult["files"]>[number];

export const DEFAULT_EDITOR_AGENT_HTTP_TIMEOUT_MS = 2_000;
// Issue #2298: allow a 5-second client margin over the bounded 20-second server worst case.
export const DEFAULT_EDITOR_AGENT_QUERY_GIT_TIMEOUT_MS = 25_000;
export const DEFAULT_EDITOR_AGENT_MAX_RESPONSE_BYTES = 256 * 1024;
// Issue #2214 (AC7) — a verification run's own wall-time ceiling is DEFAULT_VERIFICATION_LIMITS.wallTimeMs
// (120_000 ms). The synchronous, single-shot verification route holds its POST open until the run
// resolves, so this call needs a timeout that spans that ceiling plus margin — NOT the shared 2-second
// default, which would abort every real `npm test`/`npm run build`. Early cancellation still flows
// through `request.signal`; this ceiling only bounds a run the caller does not cancel.
export const DEFAULT_EDITOR_AGENT_VERIFICATION_TIMEOUT_MS = 135_000;

export interface EditorAgentHttpTransportRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: string | undefined;
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
}

export interface EditorAgentHttpTransportResponse {
  readonly status: number;
  readonly body: Uint8Array;
  readonly url: string;
  readonly redirected: boolean;
}

export interface EditorAgentHttpTransport {
  readonly request: (
    request: EditorAgentHttpTransportRequest,
  ) => Promise<EditorAgentHttpTransportResponse>;
}

export interface EditorAgentTimeoutScheduler {
  readonly set: (callback: () => void, timeoutMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export type EditorAgentClientErrorKind = "cancelled" | "transport" | "route" | "malformed-response";

export interface EditorAgentClientError {
  readonly kind: EditorAgentClientErrorKind;
  readonly code: string;
  readonly message: string;
  readonly status?: number | undefined;
}

interface EditorAgentClientFailure {
  readonly ok: false;
  readonly error: EditorAgentClientError;
}

export type EditorAgentClientResult<T> =
  { readonly ok: true; readonly value: T } | EditorAgentClientFailure;

interface TransportSuccess {
  readonly ok: true;
  readonly response: EditorAgentHttpTransportResponse;
}

type TransportOutcome = TransportSuccess | EditorAgentClientFailure;

type ResponseParser<T> = (value: unknown) => T | null;

const scheduler: EditorAgentTimeoutScheduler = {
  set: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clear: (handle): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function error(
  kind: EditorAgentClientErrorKind,
  code: string,
  message: string,
  status?: number,
): EditorAgentClientError {
  return { kind, code, message, ...(status === undefined ? {} : { status }) };
}

function transportError(code: string, message: string): EditorAgentClientFailure {
  return { ok: false, error: error("transport", code, message) };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function isOriginOnly(url: URL): boolean {
  return url.pathname === "/" && url.search === "" && url.hash === "";
}

function parseLoopbackOrigin(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Editor agent base URL must be a loopback HTTP origin.");
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new Error("Editor agent base URL must be a loopback HTTP origin.");
  }
  if (!isOriginOnly(url) || url.username !== "" || url.password !== "") {
    throw new Error("Editor agent base URL must be a loopback HTTP origin.");
  }
  return new URL(url.origin);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessions(value: unknown): EditorAgentSessionsResponse | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null;
  return value.sessions.every(isEditorAgentSessionSnapshot) ? { sessions: value.sessions } : null;
}

function parseSnapshot(value: unknown): EditorAgentSnapshotResponse | null {
  if (!isRecord(value)) return null;
  if (value.snapshot === null) return { snapshot: null };
  return isEditorAgentSessionSnapshot(value.snapshot) ? { snapshot: value.snapshot } : null;
}

const REDACTED_ROUTE_MESSAGE = "Editor agent route detail redacted.";

function redactConflict(conflict: EditorAgentConflictDetail): EditorAgentConflictDetail {
  return {
    code: conflict.code,
    message: REDACTED_ROUTE_MESSAGE,
    ...(conflict.file === undefined ? {} : { file: conflict.file }),
  };
}

function redactFileResult(result: EditorAgentFileActionResult): EditorAgentFileActionResult {
  return {
    file: result.file,
    status: result.status,
    ...(result.message === undefined ? {} : { message: REDACTED_ROUTE_MESSAGE }),
    ...(result.conflict === undefined ? {} : { conflict: redactConflict(result.conflict) }),
  };
}

function redactActionResult(result: EditorAgentActionResult): EditorAgentActionResult {
  return {
    schemaVersion: result.schemaVersion,
    actionId: result.actionId,
    sessionId: result.sessionId,
    status: result.status,
    ...(result.message === undefined ? {} : { message: REDACTED_ROUTE_MESSAGE }),
    ...(result.conflict === undefined ? {} : { conflict: redactConflict(result.conflict) }),
    ...(result.failure === undefined
      ? {}
      : { failure: { code: result.failure.code, message: REDACTED_ROUTE_MESSAGE } }),
    ...(result.files === undefined
      ? {}
      : { files: result.files.map((file) => redactFileResult(file)) }),
    ...(result.data === undefined ? {} : { data: result.data }),
  };
}

function redactUnknownConflict(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    code: value.code,
    message: typeof value.message === "string" ? REDACTED_ROUTE_MESSAGE : value.message,
    ...(value.file === undefined ? {} : { file: value.file }),
  };
}

function redactUnknownFileResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    file: value.file,
    status: value.status,
    ...(value.message === undefined
      ? {}
      : {
          message: typeof value.message === "string" ? REDACTED_ROUTE_MESSAGE : value.message,
        }),
    ...(value.conflict === undefined ? {} : { conflict: redactUnknownConflict(value.conflict) }),
  };
}

function redactUnknownActionResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    schemaVersion: value.schemaVersion,
    actionId: value.actionId,
    sessionId: value.sessionId,
    status: value.status,
    ...(value.message === undefined
      ? {}
      : {
          message: typeof value.message === "string" ? REDACTED_ROUTE_MESSAGE : value.message,
        }),
    ...(value.conflict === undefined ? {} : { conflict: redactUnknownConflict(value.conflict) }),
    ...(value.failure === undefined ? {} : { failure: redactUnknownConflict(value.failure) }),
    ...(Array.isArray(value.files)
      ? { files: value.files.map((file) => redactUnknownFileResult(file)) }
      : value.files === undefined
        ? {}
        : { files: value.files }),
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

function parseActionResult(value: unknown): EditorAgentActionQueuedResponse | null {
  if (!isRecord(value)) return null;
  const result = redactUnknownActionResult(value.result);
  return isEditorAgentActionResult(result) ? { result: redactActionResult(result) } : null;
}

function parseQueryGitActionResult(value: unknown): EditorAgentActionQueuedResponse | null {
  const parsed = parseActionResult(value);
  if (parsed === null) return null;
  if (parsed.result.status !== "succeeded") {
    return parsed.result.data === undefined ? parsed : null;
  }
  const data = parseEditorAgentQueryGitData(parsed.result.data);
  return data.ok ? { result: { ...parsed.result, data: { ...data.value } } } : null;
}

// Issue #2214 — the verification route's response is content-free BY CONSTRUCTION (the redacted report
// type has no field for raw output), so the client validates its shape rather than re-redacting it.
function parseVerificationResult(
  value: unknown,
  expectedKind: EditorAgentVerificationRunRequest["kind"],
): EditorAgentVerificationResult | null {
  if (!isRecord(value)) return null;
  const parsed = parseEditorAgentVerificationResult(value.result);
  if (parsed?.outcome !== "completed") return parsed;
  return parsed.report.steps.length === 1 && parsed.report.steps[0]?.kind === expectedKind
    ? parsed
    : null;
}

function parseRouteCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const code = value.error.code;
  return typeof code === "string" && code.length > 0 && code.length <= 128 ? code : null;
}

function decodeJson(body: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return JSON.parse(text) as unknown;
}

function responseIsRedirect(
  request: EditorAgentHttpTransportRequest,
  response: EditorAgentHttpTransportResponse,
): boolean {
  return (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    response.url !== request.url
  );
}

function allowedStatus(status: number, statuses: readonly number[]): boolean {
  return statuses.includes(status);
}

class ResponseTooLargeError extends Error {}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError("response exceeded cap");
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createFetchEditorAgentHttpTransport(
  fetchFn: typeof fetch = fetch,
): EditorAgentHttpTransport {
  return {
    request: async (request): Promise<EditorAgentHttpTransportResponse> => {
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.method === "POST" ? { "X-Keiko-CSRF": "1" } : {}),
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: request.signal,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      return {
        status: response.status,
        body: await readBoundedBody(response, request.maxResponseBytes),
        url: response.url || request.url,
        redirected: response.redirected,
      };
    },
  };
}

export class EditorAgentHttpClient {
  private readonly origin: URL;
  private readonly transport: EditorAgentHttpTransport;
  private readonly timeoutMs: number;
  private readonly queryGitTimeoutMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly scheduler: EditorAgentTimeoutScheduler;

  constructor(deps: {
    readonly baseUrl: string;
    readonly transport: EditorAgentHttpTransport;
    readonly timeoutMs?: number | undefined;
    readonly queryGitTimeoutMs?: number | undefined;
    readonly verificationTimeoutMs?: number | undefined;
    readonly maxResponseBytes?: number | undefined;
    readonly scheduler?: EditorAgentTimeoutScheduler | undefined;
  }) {
    this.origin = parseLoopbackOrigin(deps.baseUrl);
    this.transport = deps.transport;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EDITOR_AGENT_HTTP_TIMEOUT_MS;
    this.queryGitTimeoutMs = deps.queryGitTimeoutMs ?? DEFAULT_EDITOR_AGENT_QUERY_GIT_TIMEOUT_MS;
    this.verificationTimeoutMs =
      deps.verificationTimeoutMs ?? DEFAULT_EDITOR_AGENT_VERIFICATION_TIMEOUT_MS;
    this.maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_EDITOR_AGENT_MAX_RESPONSE_BYTES;
    this.scheduler = deps.scheduler ?? scheduler;
    if (
      !isPositiveInteger(this.timeoutMs) ||
      !isPositiveInteger(this.queryGitTimeoutMs) ||
      !isPositiveInteger(this.verificationTimeoutMs) ||
      !isPositiveInteger(this.maxResponseBytes)
    ) {
      throw new Error("Editor agent HTTP bounds must be positive.");
    }
  }

  listSessions(signal: AbortSignal): Promise<EditorAgentClientResult<EditorAgentSessionsResponse>> {
    return this.request(
      "/api/editor/agent/sessions",
      "GET",
      undefined,
      signal,
      [200],
      parseSessions,
      this.timeoutMs,
    );
  }

  snapshot(
    body: EditorAgentSnapshotRequest,
    signal: AbortSignal,
  ): Promise<EditorAgentClientResult<EditorAgentSnapshotResponse>> {
    return this.request(
      "/api/editor/agent/snapshot",
      "POST",
      body,
      signal,
      [200],
      parseSnapshot,
      this.timeoutMs,
    );
  }

  action(
    body: EditorAgentAction,
    signal: AbortSignal,
  ): Promise<EditorAgentClientResult<EditorAgentActionQueuedResponse>> {
    return this.request(
      "/api/editor/agent/actions",
      "POST",
      body,
      signal,
      [200, 202, 403, 409, 429],
      body.type === "queryGit" ? parseQueryGitActionResult : parseActionResult,
      body.type === "queryGit" ? this.queryGitTimeoutMs : this.timeoutMs,
    );
  }

  // Issue #2214 — call item 2's synchronous verification route. Governance (classify → compose →
  // reserve → audit) runs server-side BEFORE any run starts; the route holds the POST open until the
  // run resolves, so this uses the long verification timeout (AC7). A 200 carries either the redacted
  // completed report or the governance not-run disposition; both are typed, non-throwing results.
  requestVerification(
    body: EditorAgentVerificationRunRequest,
    signal: AbortSignal,
  ): Promise<EditorAgentClientResult<EditorAgentVerificationResult>> {
    return this.request(
      "/api/editor/verification/agent-runs",
      "POST",
      body,
      signal,
      [200],
      (value): EditorAgentVerificationResult | null => parseVerificationResult(value, body.kind),
      this.verificationTimeoutMs,
    );
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    signal: AbortSignal,
    statuses: readonly number[],
    parser: ResponseParser<T>,
    timeoutMs: number,
  ): Promise<EditorAgentClientResult<T>> {
    const request: EditorAgentHttpTransportRequest = {
      method,
      url: new URL(path, this.origin).toString(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: new AbortController().signal,
      maxResponseBytes: this.maxResponseBytes,
    };
    const outcome = await this.perform(request, signal, timeoutMs);
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return this.parseResponse(request, outcome.response, statuses, parser);
  }

  private async perform(
    request: EditorAgentHttpTransportRequest,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<TransportOutcome> {
    if (isAborted(signal)) {
      return {
        ok: false,
        error: error("cancelled", "CANCELLED", "Editor agent call cancelled."),
      };
    }
    const controller = new AbortController();
    const boundedRequest = { ...request, signal: controller.signal };
    let stop: ((outcome: TransportOutcome) => void) | undefined;
    const stopped = new Promise<TransportOutcome>((resolve) => {
      stop = resolve;
    });
    const onAbort = (): void => {
      controller.abort();
      stop?.({ ok: false, error: error("cancelled", "CANCELLED", "Editor agent call cancelled.") });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (isAborted(signal)) onAbort();
    const handle = this.scheduler.set(() => {
      controller.abort();
      stop?.(transportError("TIMED_OUT", "The editor agent route timed out."));
    }, timeoutMs);
    const transport = this.callTransport(boundedRequest, signal);
    const outcome = await Promise.race([transport, stopped]);
    this.scheduler.clear(handle);
    signal.removeEventListener("abort", onAbort);
    return outcome;
  }

  private async callTransport(
    request: EditorAgentHttpTransportRequest,
    outerSignal: AbortSignal,
  ): Promise<TransportOutcome> {
    try {
      return { ok: true, response: await this.transport.request(request) };
    } catch (cause) {
      if (cause instanceof ResponseTooLargeError) {
        return transportError("RESPONSE_TOO_LARGE", "The editor agent response exceeded its cap.");
      }
      if (outerSignal.aborted) {
        return {
          ok: false,
          error: error("cancelled", "CANCELLED", "Editor agent call cancelled."),
        };
      }
      return transportError("TRANSPORT_FAILURE", "The editor agent route was unavailable.");
    }
  }

  private parseResponse<T>(
    request: EditorAgentHttpTransportRequest,
    response: EditorAgentHttpTransportResponse,
    statuses: readonly number[],
    parser: ResponseParser<T>,
  ): EditorAgentClientResult<T> {
    if (responseIsRedirect(request, response)) {
      return transportError("REDIRECT_BLOCKED", "Editor agent redirects are forbidden.");
    }
    if (response.body.byteLength > this.maxResponseBytes) {
      return transportError("RESPONSE_TOO_LARGE", "The editor agent response exceeded its cap.");
    }
    let decoded: unknown;
    try {
      decoded = decodeJson(response.body);
    } catch {
      return this.malformed();
    }
    if (!allowedStatus(response.status, statuses)) return this.routeError(decoded, response.status);
    const value = parser(decoded);
    return value === null ? this.malformed() : { ok: true, value };
  }

  private routeError<T>(value: unknown, status: number): EditorAgentClientResult<T> {
    const code = parseRouteCode(value);
    if (code === null) return this.malformed();
    return {
      ok: false,
      error: error("route", code, "The editor agent route rejected the request.", status),
    };
  }

  private malformed<T>(): EditorAgentClientResult<T> {
    return {
      ok: false,
      error: error(
        "malformed-response",
        "MALFORMED_RESPONSE",
        "The editor agent route returned an invalid response.",
      ),
    };
  }
}
