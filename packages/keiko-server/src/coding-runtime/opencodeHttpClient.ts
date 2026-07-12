import {
  createOpenCodeSseDecoder,
  parseOpenCodeJson,
  type OpenCodeSseMessage,
} from "./opencodeProtocol.js";

const APPROVED = new Set([
  "GET /global/health",
  "GET /global/event",
  "GET /doc",
  "GET /session",
  "GET /session/status",
  "POST /session",
  "POST /sync/history",
  "GET /permission",
  "GET /question",
]);
const DYNAMIC_APPROVED = [
  /^POST \/session\/ses_[A-Za-z0-9_-]+\/(?:prompt_async|abort)$/u,
  /^POST \/permission\/per[A-Za-z0-9_-]+\/reply$/u,
  /^POST \/question\/que[A-Za-z0-9_-]+\/(?:reply|reject)$/u,
] as const;

const MAX_BODY = 1024 * 1024;
const MAX_DOCUMENT_BODY = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 10_000;
const MAX_PROMPT_TEXT_BYTES = 65_536;
const MAX_SESSION_STATUSES = 256;
const MAX_QUESTION_REQUESTS = 256;
const MAX_QUESTIONS_PER_REQUEST = 32;
const MAX_OPTIONS_PER_QUESTION = 32;
const MAX_ANSWERS = 32;
const MAX_SELECTED_ANSWERS = 32;
const FIXED_SESSION_TITLE = "Keiko governed runtime";
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
const QUESTION_ID = /^que_[A-Za-z0-9_-]{1,251}$/u;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,251}$/u;

export interface OpenCodeQuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: readonly OpenCodeQuestion[];
  readonly tool?: { readonly messageID: string; readonly callID: string } | undefined;
}

export interface OpenCodeQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly multiple?: boolean | undefined;
  readonly custom?: boolean | undefined;
}

export type OpenCodeSessionStatus =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly next: number;
    };
export type OpenCodeHttpResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: "endpoint-invalid" | "request-denied" | "http-failed" | "response-invalid";
    };
export interface OpenCodeHttpClient {
  health(): Promise<OpenCodeHttpResult<Record<string, unknown>>>;
  document(requestOptions?: OpenCodeHttpRequestOptions): Promise<Record<string, unknown>>;
  createSession(requestOptions?: OpenCodeHttpRequestOptions): Promise<Record<string, unknown>>;
  sessions(
    requestOptions?: OpenCodeHttpRequestOptions,
  ): Promise<readonly Record<string, unknown>[]>;
  history(
    checkpoints: Readonly<Record<string, number>>,
    requestOptions?: OpenCodeHttpRequestOptions,
  ): Promise<readonly Record<string, unknown>[]>;
  events(requestOptions?: OpenCodeHttpRequestOptions): AsyncIterable<OpenCodeSseMessage>;
  promptAsync(
    sessionId: string,
    text: string,
    requestOptions?: OpenCodeHttpRequestOptions,
  ): Promise<void>;
  abortSession(sessionId: string, requestOptions?: OpenCodeHttpRequestOptions): Promise<boolean>;
  sessionStatuses(
    requestOptions?: OpenCodeHttpRequestOptions,
  ): Promise<Readonly<Record<string, OpenCodeSessionStatus>>>;
  listQuestions(
    requestOptions?: OpenCodeHttpRequestOptions,
  ): Promise<readonly OpenCodeQuestionRequest[]>;
  answerQuestion(
    requestId: string,
    answers: readonly (readonly string[])[],
    requestOptions?: OpenCodeHttpRequestOptions,
  ): Promise<boolean>;
  rejectQuestion(requestId: string, requestOptions?: OpenCodeHttpRequestOptions): Promise<boolean>;
  request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    requestOptions?: OpenCodeHttpRequestOptions,
  ): Promise<OpenCodeHttpResult<Record<string, unknown>>>;
}
export interface OpenCodeHttpRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}
export interface OpenCodeHttpClientOptions {
  readonly endpoint: string;
  readonly password: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly eventIdleTimeoutMs?: number | undefined;
}
export function parseOpenCodeChildEndpoint(
  output: string,
):
  | { readonly ok: true; readonly endpoint: string }
  | { readonly ok: false; readonly reason: "endpoint-invalid" } {
  const match = /^opencode server listening on http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\n$/u.exec(
    output,
  );
  const port = Number(match?.[1]);
  return Number.isSafeInteger(port) && port <= 65_535
    ? { ok: true, endpoint: `http://127.0.0.1:${String(port)}` }
    : { ok: false, reason: "endpoint-invalid" };
}
// eslint-disable-next-line max-lines-per-function -- keeps the closed request policy and client methods in one closure.
export function createOpenCodeHttpClient(options: OpenCodeHttpClientOptions): OpenCodeHttpClient {
  const parsed = parseEndpoint(options.endpoint);
  const auth = `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`;
  // eslint-disable-next-line complexity -- independent network and protocol failures must not leak secrets.
  async function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    requestOptions: OpenCodeHttpRequestOptions = {},
  ): Promise<OpenCodeHttpResult<Record<string, unknown>>> {
    if (parsed === undefined || !approved(method, path))
      return { ok: false, reason: "request-denied" };
    const cancellation = cancellationFor(
      requestOptions.signal,
      requestOptions.timeoutMs ?? options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await (options.fetch ?? globalThis.fetch)(new URL(path, parsed), {
        method,
        redirect: "manual",
        signal: cancellation.signal,
        headers: {
          Authorization: auth,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || response.type === "opaqueredirect")
        return { ok: false, reason: "http-failed" };
      const type = response.headers.get("content-type") ?? "";
      if (!type.startsWith("application/json")) return { ok: false, reason: "response-invalid" };
      const text = await readBoundedBody(response, MAX_BODY);
      if (text === undefined) return { ok: false, reason: "response-invalid" };
      const parsedBody = parseOpenCodeJson(text);
      return parsedBody.ok && isRecord(parsedBody.value)
        ? { ok: true, value: parsedBody.value }
        : { ok: false, reason: "response-invalid" };
    } catch {
      return { ok: false, reason: "http-failed" };
    } finally {
      cancellation.dispose();
    }
  }
  return {
    health: () => call("GET", "/global/health"),
    document: (requestOptions = {}) => document(options, parsed, auth, requestOptions),
    createSession: (requestOptions = {}) =>
      jsonObject(
        options,
        parsed,
        auth,
        "POST",
        "/session",
        { title: FIXED_SESSION_TITLE },
        requestOptions,
      ),
    sessions: (requestOptions = {}) =>
      jsonArray(options, parsed, auth, "GET", "/session", undefined, requestOptions),
    request: call,
    history: (checkpoints, requestOptions = {}) =>
      history(options, parsed, auth, checkpoints, requestOptions),
    events: (requestOptions = {}) => events(options, parsed, auth, requestOptions),
    promptAsync: (sessionId, text, requestOptions = {}) =>
      promptAsync(options, parsed, auth, sessionId, text, requestOptions),
    abortSession: (sessionId, requestOptions = {}) =>
      abortSession(options, parsed, auth, sessionId, requestOptions),
    sessionStatuses: (requestOptions = {}) =>
      sessionStatuses(options, parsed, auth, requestOptions),
    listQuestions: (requestOptions = {}) => listQuestions(options, parsed, auth, requestOptions),
    answerQuestion: (requestId, answers, requestOptions = {}) =>
      answerQuestion(options, parsed, auth, requestId, answers, requestOptions),
    rejectQuestion: (requestId, requestOptions = {}) =>
      rejectQuestion(options, parsed, auth, requestId, requestOptions),
  };
}

async function listQuestions(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<readonly OpenCodeQuestionRequest[]> {
  const value = await jsonArray(
    options,
    endpoint,
    auth,
    "GET",
    "/question",
    undefined,
    requestOptions,
  );
  if (value.length > MAX_QUESTION_REQUESTS || !value.every(validQuestionRequest)) {
    throw new Error("opencode-question-invalid");
  }
  return value as unknown as readonly OpenCodeQuestionRequest[];
}

async function answerQuestion(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  requestId: string,
  answers: readonly (readonly string[])[],
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<boolean> {
  if (!QUESTION_ID.test(requestId) || !validQuestionAnswers(answers)) {
    throw new Error("opencode-question-invalid");
  }
  return booleanResponse(
    options,
    endpoint,
    auth,
    `/question/${requestId}/reply`,
    { answers },
    requestOptions,
  );
}

async function rejectQuestion(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  requestId: string,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<boolean> {
  if (!QUESTION_ID.test(requestId)) throw new Error("opencode-question-invalid");
  return booleanResponse(
    options,
    endpoint,
    auth,
    `/question/${requestId}/reject`,
    undefined,
    requestOptions,
  );
}

async function promptAsync(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  sessionId: string,
  text: string,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<void> {
  if (!SESSION_ID.test(sessionId) || !validPromptText(text))
    throw new Error("opencode-prompt-invalid");
  const cancellation = requestCancellation(options, requestOptions);
  try {
    const response = await responseFor(
      options,
      endpoint,
      auth,
      "POST",
      `/session/${sessionId}/prompt_async`,
      { parts: [{ type: "text", text }] },
      cancellation.signal,
    );
    if (response?.status !== 204) throw new Error("opencode-prompt-failed");
    await response.body?.cancel();
  } finally {
    cancellation.dispose();
  }
}

async function abortSession(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  sessionId: string,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) throw new Error("opencode-abort-invalid");
  return booleanResponse(
    options,
    endpoint,
    auth,
    `/session/${sessionId}/abort`,
    undefined,
    requestOptions,
  );
}

async function booleanResponse(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  path: string,
  body: unknown,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<boolean> {
  const cancellation = requestCancellation(options, requestOptions);
  try {
    const response = await responseFor(
      options,
      endpoint,
      auth,
      "POST",
      path,
      body,
      cancellation.signal,
    );
    if (response === undefined || !isJson(response)) throw new Error("opencode-boolean-failed");
    const responseBody = await readBoundedBody(response, 5);
    if (responseBody !== "true" && responseBody !== "false")
      throw new Error("opencode-boolean-invalid");
    return responseBody === "true";
  } finally {
    cancellation.dispose();
  }
}

async function sessionStatuses(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<Readonly<Record<string, OpenCodeSessionStatus>>> {
  const value = await jsonObject(
    options,
    endpoint,
    auth,
    "GET",
    "/session/status",
    undefined,
    requestOptions,
  );
  if (Object.keys(value).length > MAX_SESSION_STATUSES) throw new Error("opencode-status-invalid");
  const statuses: Record<string, OpenCodeSessionStatus> = {};
  for (const [sessionId, status] of Object.entries(value)) {
    if (!SESSION_ID.test(sessionId) || !validSessionStatus(status))
      throw new Error("opencode-status-invalid");
    statuses[sessionId] =
      status.type === "retry"
        ? { type: "retry", attempt: status.attempt, next: status.next }
        : status;
  }
  return statuses;
}

function validPromptText(text: string): boolean {
  const size = Buffer.byteLength(text, "utf8");
  return size >= 1 && size <= MAX_PROMPT_TEXT_BYTES && !text.includes("\u0000");
}

type OpenCodeWireSessionStatus =
  | OpenCodeSessionStatus
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly message: string;
      readonly next: number;
      readonly action?: Readonly<Record<string, unknown>>;
    };

// eslint-disable-next-line complexity -- exact pinned retry/action variants are an explicit trust gate.
function validSessionStatus(value: unknown): value is OpenCodeWireSessionStatus {
  if (!isRecord(value)) return false;
  if (exactRecord(value, ["type"])) return value.type === "idle" || value.type === "busy";
  return (
    (exactRecord(value, ["type", "attempt", "message", "next"]) ||
      exactRecord(value, ["type", "attempt", "message", "next", "action"])) &&
    value.type === "retry" &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) >= 0 &&
    typeof value.message === "string" &&
    value.message.length <= 4096 &&
    Number.isSafeInteger(value.next) &&
    Number(value.next) >= 0 &&
    (value.action === undefined || validStatusAction(value.action))
  );
}

function validStatusAction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const exact =
    exactRecord(value, ["reason", "provider", "title", "message", "label"]) ||
    exactRecord(value, ["reason", "provider", "title", "message", "label", "link"]);
  return (
    exact &&
    [value.reason, value.provider, value.title, value.message, value.label, value.link].every(
      (item) => item === undefined || (typeof item === "string" && item.length <= 4096),
    )
  );
}

function validQuestionRequest(value: Record<string, unknown>): boolean {
  if (
    !(
      exactRecord(value, ["id", "sessionID", "questions"]) ||
      exactRecord(value, ["id", "sessionID", "questions", "tool"])
    ) ||
    !QUESTION_ID.test(String(value.id)) ||
    !SESSION_ID.test(String(value.sessionID)) ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > MAX_QUESTIONS_PER_REQUEST ||
    !value.questions.every(validQuestion)
  )
    return false;
  return value.tool === undefined || validQuestionTool(value.tool);
}

function validQuestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    validQuestionShape(value) &&
    validQuestionBase(value) &&
    validQuestionOptions(value) &&
    validQuestionFlags(value)
  );
}

function validQuestionShape(value: Record<string, unknown>): boolean {
  return (
    exactRecord(value, ["question", "header", "options"]) ||
    exactRecord(value, ["question", "header", "options", "multiple"]) ||
    exactRecord(value, ["question", "header", "options", "custom"]) ||
    exactRecord(value, ["question", "header", "options", "multiple", "custom"])
  );
}

function validQuestionBase(value: Record<string, unknown>): boolean {
  return boundedString(value.question, 4_096) && boundedString(value.header, 30);
}

function validQuestionOptions(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.options) &&
    value.options.length <= MAX_OPTIONS_PER_QUESTION &&
    value.options.every(validQuestionOption)
  );
}

function validQuestionFlags(value: Record<string, unknown>): boolean {
  return (
    (value.multiple === undefined || typeof value.multiple === "boolean") &&
    (value.custom === undefined || typeof value.custom === "boolean")
  );
}

function validQuestionOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ["label", "description"]) &&
    boundedString(value.label, 256) &&
    boundedString(value.description, 4_096)
  );
}

function validQuestionTool(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactRecord(value, ["messageID", "callID"]) &&
    MESSAGE_ID.test(String(value.messageID)) &&
    boundedString(value.callID, 256)
  );
}

function validQuestionAnswers(value: readonly (readonly string[])[]): boolean {
  return (
    value.length <= MAX_ANSWERS &&
    value.every(
      (answer) =>
        answer.length <= MAX_SELECTED_ANSWERS &&
        answer.every((selection) => boundedString(selection, 4_096)),
    )
  );
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function exactRecord(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

async function history(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  checkpoints: Readonly<Record<string, number>>,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<readonly Record<string, unknown>[]> {
  if (!validCheckpoints(checkpoints)) throw new Error("opencode-history-invalid");
  return jsonArray(options, endpoint, auth, "POST", "/sync/history", checkpoints, requestOptions);
}

async function jsonObject(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<Record<string, unknown>> {
  const cancellation = requestCancellation(options, requestOptions);
  try {
    const response = await responseFor(
      options,
      endpoint,
      auth,
      method,
      path,
      body,
      cancellation.signal,
    );
    if (response === undefined || !isJson(response)) throw new Error("opencode-object-failed");
    const text = await readBoundedBody(response, MAX_BODY);
    if (text === undefined) throw new Error("opencode-object-oversized");
    const parsedBody = parseOpenCodeJson(text);
    if (!parsedBody.ok || !isRecord(parsedBody.value)) throw new Error("opencode-json-invalid");
    return parsedBody.value;
  } finally {
    cancellation.dispose();
  }
}

async function jsonArray(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<readonly Record<string, unknown>[]> {
  const cancellation = requestCancellation(options, requestOptions);
  try {
    const response = await responseFor(
      options,
      endpoint,
      auth,
      method,
      path,
      body,
      cancellation.signal,
    );
    if (response === undefined || !isJson(response)) throw new Error("opencode-history-failed");
    const text = await readBoundedBody(response, MAX_BODY);
    if (text === undefined) throw new Error("opencode-history-oversized");
    const parsedBody = parseOpenCodeJson(text);
    if (!parsedBody.ok || !Array.isArray(parsedBody.value) || !parsedBody.value.every(isRecord))
      throw new Error("opencode-json-invalid");
    return parsedBody.value;
  } finally {
    cancellation.dispose();
  }
}

async function document(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  requestOptions: OpenCodeHttpRequestOptions,
): Promise<Record<string, unknown>> {
  const cancellation = requestCancellation(options, requestOptions);
  try {
    const response = await responseFor(
      options,
      endpoint,
      auth,
      "GET",
      "/doc",
      undefined,
      cancellation.signal,
    );
    if (response === undefined || !isJson(response)) throw new Error("opencode-document-failed");
    const text = await readBoundedBody(response, MAX_DOCUMENT_BODY);
    if (text === undefined) throw new Error("opencode-document-oversized");
    const parsedBody = parseOpenCodeJson(text);
    if (!parsedBody.ok || !isRecord(parsedBody.value)) throw new Error("opencode-json-invalid");
    return parsedBody.value;
  } finally {
    cancellation.dispose();
  }
}

// eslint-disable-next-line complexity -- independent stream trust-boundary failures fail closed.
async function* events(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  requestOptions: OpenCodeHttpRequestOptions,
): AsyncIterable<OpenCodeSseMessage> {
  const establishment = requestCancellation(options, requestOptions);
  let response: Response | undefined;
  try {
    response = await responseFor(
      options,
      endpoint,
      auth,
      "GET",
      "/global/event",
      undefined,
      establishment.signal,
    );
  } finally {
    establishment.dispose();
  }
  if (response === undefined || !isSse(response) || response.body === null) {
    throw new Error("opencode-events-failed");
  }
  const reader = response.body.getReader();
  const decoder = createOpenCodeSseDecoder();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const chunk = await readEventChunk(reader, requestOptions.signal, options.eventIdleTimeoutMs);
      if (chunk.done) break;
      const parsed = decoder.push(utf8.decode(chunk.value, { stream: true }));
      if (!parsed.ok) throw new Error("opencode-events-invalid");
      for (const message of parsed.value) yield message;
    }
    const tail = utf8.decode();
    const parsedTail = tail.length === 0 ? { ok: true as const, value: [] } : decoder.push(tail);
    if (!parsedTail.ok) throw new Error("opencode-events-invalid");
    for (const message of parsedTail.value) yield message;
    const final = decoder.finish();
    if (!final.ok) throw new Error("opencode-events-invalid");
    for (const message of final.value) yield message;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function validCheckpoints(value: Readonly<Record<string, number>>): boolean {
  return Object.entries(value).every(
    ([aggregateId, sequence]) =>
      /^ses_[A-Za-z0-9_-]{1,251}$/u.test(aggregateId) &&
      Number.isSafeInteger(sequence) &&
      sequence >= 0,
  );
}

async function responseFor(
  options: OpenCodeHttpClientOptions,
  endpoint: URL | undefined,
  auth: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response | undefined> {
  if (endpoint === undefined || !approved(method, path)) return undefined;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(new URL(path, endpoint), {
      method,
      redirect: "manual",
      signal,
      headers: {
        Authorization: auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.ok && response.type !== "opaqueredirect" ? response : undefined;
  } catch {
    return undefined;
  }
}

function requestCancellation(
  options: OpenCodeHttpClientOptions,
  requestOptions: OpenCodeHttpRequestOptions,
): { readonly signal: AbortSignal; dispose(): void } {
  return cancellationFor(
    requestOptions.signal,
    requestOptions.timeoutMs ?? options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

function isJson(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").startsWith("application/json");
}

function isSse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
}

function readEventChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutMs =
    typeof idleTimeoutMs === "number" && Number.isSafeInteger(idleTimeoutMs) && idleTimeoutMs > 0
      ? idleTimeoutMs
      : DEFAULT_EVENT_IDLE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("opencode-event-idle"));
    }, timeoutMs);
    timer.unref();
    const abort = (): void => {
      reject(new Error("opencode-event-aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      });
  });
}
function approved(method: "GET" | "POST", path: string): boolean {
  const route = `${method} ${path}`;
  return APPROVED.has(route) || DYNAMIC_APPROVED.some((pattern) => pattern.test(route));
}
function cancellationFor(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  if (callerSignal?.aborted === true) abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  const boundedTimeout =
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(abort, boundedTimeout);
  timer.unref();
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}
async function readBoundedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } finally {
    reader.releaseLock();
  }
}
function parseEndpoint(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
