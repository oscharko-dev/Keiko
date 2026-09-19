import { OPENCODE_HISTORY_RESPONSE_MAX_BYTES } from "./opencodeProtocol.js";

const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,251}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const MAX_JSON_BYTES = OPENCODE_HISTORY_RESPONSE_MAX_BYTES;
const MAX_TEXT_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;
const MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGES = 64;
const MAX_MESSAGES = 4096;
const MAX_EVENT_FRAME_BYTES = 1024 * 1024;

export interface OpenCodeV2HttpClientOptions {
  readonly endpoint: string;
  readonly password: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface OpenCodeV2HttpClient {
  info(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  document(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  events(signal: AbortSignal): AsyncIterable<Readonly<Record<string, unknown>>>;
  createSession(
    directory: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
  sessions(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  messages(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly Readonly<Record<string, unknown>>[]>;
  prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<void>;
  interrupt(sessionId: string, signal?: AbortSignal): Promise<void>;
  active(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
  permissions(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  forms(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
  replyForm(
    sessionId: string,
    formId: string,
    answer: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<void>;
  cancelForm(sessionId: string, formId: string, signal?: AbortSignal): Promise<void>;
  replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "reject",
    signal?: AbortSignal,
  ): Promise<void>;
}

export function parseOpenCodeV2ChildEndpoint(output: string): string | undefined {
  const match = /^server listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\n$/u.exec(output);
  const port = Number(match?.[1]);
  return Number.isSafeInteger(port) && port <= 65_535
    ? `http://127.0.0.1:${String(port)}`
    : undefined;
}

function parseEndpoint(value: string): URL | undefined {
  try {
    const endpoint = new URL(value);
    return endpoint.protocol === "http:" &&
      endpoint.hostname === "127.0.0.1" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.pathname === "/" &&
      endpoint.search === "" &&
      endpoint.hash === ""
      ? endpoint
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

async function boundedJson(response: Response): Promise<Readonly<Record<string, unknown>>> {
  if (response.status === 204) return {};
  if (
    !response.ok ||
    !(response.headers.get("content-type") ?? "").startsWith("application/json")
  ) {
    throw new Error("opencode-v2-response-invalid");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new Error("opencode-v2-response-oversized");
  }
  if (response.body === null) throw new Error("opencode-v2-response-invalid");
  const bytes = await readBoundedJsonBytes(response.body);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(decoded);
  const parsed = record(value);
  if (parsed === undefined) throw new Error("opencode-v2-response-invalid");
  return parsed;
}

async function readBoundedJsonBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > MAX_JSON_BYTES) throw new Error("opencode-v2-response-oversized");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function envelope(value: Readonly<Record<string, unknown>>): unknown {
  if (!("data" in value)) throw new Error("opencode-v2-envelope-invalid");
  return value.data;
}

function objectEnvelope(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const parsed = record(envelope(value));
  if (parsed === undefined) throw new Error("opencode-v2-envelope-invalid");
  return parsed;
}

function arrayEnvelope(
  value: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const data = envelope(value);
  if (!Array.isArray(data) || !data.every((item: unknown) => record(item) !== undefined)) {
    throw new Error("opencode-v2-envelope-invalid");
  }
  return data as readonly Readonly<Record<string, unknown>>[];
}

function safeSessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error("opencode-v2-session-invalid");
  return value;
}

function safeRequestId(value: string): string {
  if (!REQUEST_ID.test(value)) throw new Error("opencode-v2-request-invalid");
  return value;
}

function safeFormId(value: string): string {
  if (!/^frm_[A-Za-z0-9_-]{1,251}$/u.test(value)) throw new Error("opencode-v2-form-invalid");
  return value;
}

type V2Request = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<Readonly<Record<string, unknown>>>;

function parseEventFrame(frame: string): Readonly<Record<string, unknown>> | undefined {
  if (frame.startsWith(":")) return undefined;
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");
  if (data.length === 0) throw new Error("opencode-v2-event-invalid");
  const parsed: unknown = JSON.parse(data);
  const event = record(parsed);
  if (event === undefined || typeof event.id !== "string" || typeof event.type !== "string") {
    throw new Error("opencode-v2-event-invalid");
  }
  return event;
}

async function* readEventFrames(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Readonly<Record<string, unknown>>> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    pending = pending.replaceAll("\r\n", "\n");
    if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_FRAME_BYTES) {
      throw new Error("opencode-v2-event-oversized");
    }
    let boundary = pending.indexOf("\n\n");
    while (boundary >= 0) {
      const event = parseEventFrame(pending.slice(0, boundary));
      pending = pending.slice(boundary + 2);
      if (event !== undefined) yield event;
      boundary = pending.indexOf("\n\n");
    }
  }
  if (pending.length > 0) throw new Error("opencode-v2-event-truncated");
}

async function* openEvents(
  endpoint: URL,
  authorization: string,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal,
): AsyncIterable<Readonly<Record<string, unknown>>> {
  const response = await fetchFn(new URL("/api/event", endpoint), {
    method: "GET",
    redirect: "manual",
    signal,
    headers: { Authorization: authorization, Accept: "text/event-stream" },
  });
  if (
    !response.ok ||
    response.headers.get("content-type")?.startsWith("text/event-stream") !== true ||
    response.body === null
  ) {
    throw new Error("opencode-v2-event-unavailable");
  }
  yield* readEventFrames(response.body);
}

async function pagedMessages(
  request: V2Request,
  sessionId: string,
  signal?: AbortSignal,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const base = `/api/session/${safeSessionId(sessionId)}/message`;
  const rows: Readonly<Record<string, unknown>>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const query = cursor === undefined ? "order=desc" : `cursor=${encodeURIComponent(cursor)}`;
    const response = await request(
      "GET",
      `${base}?limit=${String(MESSAGE_PAGE_SIZE)}&${query}`,
      undefined,
      signal,
    );
    const batch = arrayEnvelope(response);
    if (rows.length + batch.length > MAX_MESSAGES) throw new Error("opencode-v2-history-oversized");
    rows.push(...batch);
    if (batch.length < MESSAGE_PAGE_SIZE) return rows.reverse();
    const next = record(response.cursor)?.next;
    if (typeof next !== "string" || next.length > 2048 || cursors.has(next)) {
      throw new Error("opencode-v2-cursor-invalid");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("opencode-v2-history-oversized");
}

/** Only the session API needed by a governed run is reachable from this client. */
// eslint-disable-next-line max-lines-per-function -- one closed method table makes the admitted V2 API auditable.
export function createOpenCodeV2HttpClient(
  options: OpenCodeV2HttpClientOptions,
): OpenCodeV2HttpClient {
  const endpoint = parseEndpoint(options.endpoint);
  if (endpoint === undefined || options.password.length === 0) {
    throw new Error("opencode-v2-endpoint-invalid");
  }
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`;
  async function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = await (options.fetch ?? globalThis.fetch)(new URL(path, endpoint), {
      method,
      redirect: "manual",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      headers: {
        Authorization: authorization,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.type === "opaqueredirect") throw new Error("opencode-v2-redirect-denied");
    return boundedJson(response);
  }
  return {
    info: (signal) => request("GET", "/api/info", undefined, signal),
    document: (signal) => request("GET", "/openapi.json", undefined, signal),
    events: (signal) =>
      openEvents(endpoint, authorization, options.fetch ?? globalThis.fetch, signal),
    createSession: async (directory, signal): Promise<Readonly<Record<string, unknown>>> => {
      if (!directory.startsWith("/")) throw new Error("opencode-v2-directory-invalid");
      return objectEnvelope(
        await request(
          "POST",
          "/api/session",
          {
            title: "Keiko governed runtime",
            location: { directory },
          },
          signal,
        ),
      );
    },
    sessions: async (signal) =>
      arrayEnvelope(await request("GET", "/api/session", undefined, signal)),
    messages: (sessionId, signal) => pagedMessages(request, sessionId, signal),
    prompt: async (sessionId, value, signal): Promise<void> => {
      if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES)
        throw new Error("opencode-v2-prompt-oversized");
      objectEnvelope(
        await request(
          "POST",
          `/api/session/${safeSessionId(sessionId)}/prompt`,
          { text: value },
          signal,
        ),
      );
    },
    interrupt: async (sessionId, signal): Promise<void> => {
      await request("POST", `/api/session/${safeSessionId(sessionId)}/interrupt`, {}, signal);
    },
    active: async (signal) =>
      objectEnvelope(await request("GET", "/api/session/active", undefined, signal)),
    permissions: async (signal) =>
      arrayEnvelope(await request("GET", "/api/permission/request", undefined, signal)),
    forms: async (signal) => arrayEnvelope(await request("GET", "/api/form", undefined, signal)),
    replyForm: async (sessionId, formId, answer, signal): Promise<void> => {
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/form/${safeFormId(formId)}/reply`,
        { answer },
        signal,
      );
    },
    cancelForm: async (sessionId, formId, signal): Promise<void> => {
      await request(
        "DELETE",
        `/api/session/${safeSessionId(sessionId)}/form/${safeFormId(formId)}`,
        undefined,
        signal,
      );
    },
    replyPermission: async (sessionId, requestId, decision, signal): Promise<void> => {
      await request(
        "POST",
        `/api/session/${safeSessionId(sessionId)}/permission/${safeRequestId(requestId)}/reply`,
        { decision },
        signal,
      );
    },
  };
}
