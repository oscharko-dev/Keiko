// The five run-engine BFF endpoints (ADR-0011 D5 routes 5–9). POST /api/runs starts a dry-run-first
// run in the background and returns 202 {runId, fingerprint}; the SSE route replays the bounded ring
// buffer (respecting Last-Event-ID) then streams live redacted events, closing after the terminal
// event; cancel propagates to the underlying harness/workflow AbortController; GET returns the
// redacted final report projection (or status:"running"); apply is the ONLY write path, re-invoking
// the same workflow with apply:true through the existing gated path. No model is ever called
// directly; no guard is reimplemented; no secret reaches any response (live payloads are redacted).

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseRunRequest } from "./run-request.js";
import type { RunRequest } from "./run-request.js";
import { startRun, applyRun, type EngineContext } from "./run-engine.js";
import { ActiveRunLimitError, type RunRecord } from "./runs.js";
import { SSE_HEADERS, writeEvent, readyMessage } from "./sse.js";
import type { SseWriter, StreamEvent } from "./sink.js";
import type { RouteContext, RouteResult, HandlerOutcome } from "./routes.js";
import { errorBody, STREAMING } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { UiStoreError, type ChatMessage, type NewChatMessage } from "./store/index.js";

const MAX_BODY_BYTES = 1_000_000;

const VERIFY_NOOP_MODEL: ModelPort = {
  call: () => Promise.reject(new Error("verify runs must not call the model")),
};

// Sentinel thrown (and caught in handleCreateRun) when the body exceeds MAX_BODY_BYTES. Using a
// typed class avoids fragile string matching and clearly separates this case from I/O errors.
class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "BodyTooLargeError";
  }
}

// Reads the request body up to a byte cap (a bounded read protects the loopback BFF from an
// oversized body). Resolves the decoded UTF-8 text, or rejects with BodyTooLargeError past the cap.
// When the cap is exceeded the stream is switched to flowing/drain mode (req.resume) so Node.js
// continues consuming the socket data and the HTTP server can still write the 413 response over
// the same connection (FIX H). The chunks array is cleared at that point to free accumulated memory.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0; // release accumulated buffers before draining
          reject(new BodyTooLargeError());
          req.resume(); // drain without buffering; lets the server write the 413 response
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", reject);
  });
}

// Composer-launched runs operate on the host filesystem. Reject workspaceRoot paths not registered
// in the local project store so a CSRF-equipped local client cannot trigger workflows in arbitrary
// directories. Returns a RouteResult to return, or null when the check passes.
function rejectUnregisteredWorkspace(parsed: RunRequest, deps: UiHandlerDeps): RouteResult | null {
  const root = typeof parsed.input.workspaceRoot === "string" ? parsed.input.workspaceRoot : "";
  const registered = deps.store.listProjects().some((p) => p.path === root);
  return registered
    ? null
    : {
        status: 403,
        body: errorBody(
          "WORKSPACE_NOT_REGISTERED",
          "The workspaceRoot is not a registered project.",
        ),
      };
}

function resolveRunModel(parsed: RunRequest, deps: UiHandlerDeps): ModelPort | undefined {
  return parsed.kind === "verify" ? VERIFY_NOOP_MODEL : deps.modelPortFactory(parsed.modelId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBodyString(body: Record<string, unknown>, name: string): string | RouteResult {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", `Field "${name}" is required.`) };
  }
  return value;
}

function requireBodyNumber(body: Record<string, unknown>, name: string): number | RouteResult {
  const value = body[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      status: 400,
      body: errorBody("BAD_REQUEST", `Field "${name}" must be a finite number.`),
    };
  }
  return value;
}

function requireBodyRecord(
  body: Record<string, unknown>,
  name: string,
): Record<string, unknown> | RouteResult {
  const value = body[name];
  if (!isRecord(value)) {
    return { status: 400, body: errorBody("BAD_REQUEST", `Field "${name}" must be an object.`) };
  }
  return value;
}

function parseJsonRecord(raw: string): Record<string, unknown> | RouteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body is not valid JSON.") };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: errorBody("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  return parsed;
}

function isRouteResult(value: unknown): value is RouteResult {
  return isRecord(value) && typeof value.status === "number" && "body" in value;
}

function chatBelongsToProject(deps: UiHandlerDeps, projectPath: string, chatId: string): boolean {
  return deps.store.listChats(projectPath).some((chat) => chat.id === chatId);
}

function runSummaryDiscriminator(
  request: RunRequest,
): Pick<NewChatMessage, "workflowId" | "taskType"> {
  if (request.kind === "unit-tests") {
    return { workflowId: "unit-test-generation", taskType: undefined };
  }
  if (request.kind === "bug-investigation") {
    return { workflowId: "bug-investigation", taskType: undefined };
  }
  if (request.kind === "explain-plan") {
    return { workflowId: undefined, taskType: "explain-plan" };
  }
  return { workflowId: undefined, taskType: "verify" };
}

function buildChatRunMessages(
  body: Record<string, unknown>,
  request: RunRequest,
  chatId: string,
  runId: string,
): readonly [NewChatMessage, NewChatMessage] | RouteResult {
  const user = requireBodyRecord(body, "user");
  if (isRouteResult(user)) return user;
  const summary = requireBodyRecord(body, "summary");
  if (isRouteResult(summary)) return summary;
  const userContent = requireBodyString(user, "content");
  if (typeof userContent !== "string") return userContent;
  const userTimestamp = requireBodyNumber(user, "timestamp");
  if (typeof userTimestamp !== "number") return userTimestamp;
  const summaryContent = requireBodyString(summary, "content");
  if (typeof summaryContent !== "string") return summaryContent;
  const summaryTimestamp = requireBodyNumber(summary, "timestamp");
  if (typeof summaryTimestamp !== "number") return summaryTimestamp;
  const discriminator = runSummaryDiscriminator(request);
  return [
    {
      chatId,
      role: "user",
      content: userContent,
      timestamp: userTimestamp,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    },
    {
      chatId,
      role: "system",
      content: summaryContent,
      timestamp: summaryTimestamp,
      runId,
      workflowId: discriminator.workflowId,
      workflowStatus: "running",
      shortResult: undefined,
      taskType: discriminator.taskType,
    },
  ];
}

function storeErrorResult(error: UiStoreError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function markSummaryFailed(deps: UiHandlerDeps, message: ChatMessage, shortResult: string): void {
  try {
    deps.store.updateMessage(message.id, { workflowStatus: "failed", shortResult });
  } catch {
    // Best-effort compensation only. The original start error remains the response source.
  }
}

interface ChatRunEnvelope {
  readonly body: Record<string, unknown>;
  readonly chatId: string;
  readonly projectPath: string;
  readonly runBody: Record<string, unknown>;
}

function parseChatRunEnvelope(raw: string, deps: UiHandlerDeps): ChatRunEnvelope | RouteResult {
  const body = parseJsonRecord(raw);
  if (isRouteResult(body)) return body;
  const chatId = requireBodyString(body, "chatId");
  if (isRouteResult(chatId)) return chatId;
  const projectPath = requireBodyString(body, "projectPath");
  if (isRouteResult(projectPath)) return projectPath;
  if (!chatBelongsToProject(deps, projectPath, chatId)) {
    return { status: 404, body: errorBody("NOT_FOUND", "Chat not found.") };
  }
  const runBody = requireBodyRecord(body, "run");
  if (isRouteResult(runBody)) return runBody;
  return { body, chatId, projectPath, runBody };
}

interface ValidatedRun {
  readonly request: RunRequest;
  readonly model: ModelPort;
}

function validateChatRunRequest(
  runBody: Record<string, unknown>,
  deps: UiHandlerDeps,
): ValidatedRun | RouteResult {
  const parsed = parseRunRequest(JSON.stringify(runBody));
  if ("code" in parsed) {
    return { status: 400, body: errorBody(parsed.code, parsed.message) };
  }
  const unregistered = rejectUnregisteredWorkspace(parsed, deps);
  if (unregistered !== null) return unregistered;
  const model = resolveRunModel(parsed, deps);
  return model === undefined
    ? { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") }
    : { request: parsed, model };
}

function engineContextFor(
  deps: UiHandlerDeps,
  request: RunRequest,
  model: ModelPort,
): EngineContext {
  return {
    request,
    model,
    registry: deps.registry,
    evidence: {
      store: deps.evidenceStore,
      env: deps.env,
      additionalSecrets: currentRedactionSecrets(deps),
    },
  };
}

function persistChatRunMessages(
  deps: UiHandlerDeps,
  envelope: ChatRunEnvelope,
  request: RunRequest,
  runId: string,
): readonly ChatMessage[] | RouteResult {
  const messagesInput = buildChatRunMessages(envelope.body, request, envelope.chatId, runId);
  if (isRouteResult(messagesInput)) return messagesInput;
  try {
    return deps.store.createMessages(messagesInput);
  } catch (error) {
    if (error instanceof UiStoreError) return storeErrorResult(error);
    throw error;
  }
}

function startPersistedChatRun(
  deps: UiHandlerDeps,
  request: RunRequest,
  model: ModelPort,
  runId: string,
  messages: readonly ChatMessage[],
): RouteResult {
  try {
    const run = startRun(engineContextFor(deps, request, model), deps.redactor, { runId });
    return { status: 202, body: { run, messages } };
  } catch (error) {
    const summary = messages[1];
    if (summary !== undefined) {
      markSummaryFailed(deps, summary, "Run could not be started.");
    }
    if (error instanceof ActiveRunLimitError) {
      return { status: 429, body: errorBody("TOO_MANY_RUNS", "The active run limit is reached.") };
    }
    throw error;
  }
}

// Route 5 — POST /api/runs. Validates the body, resolves the ModelPort, starts the run, returns 202.
export async function handleCreateRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  const parsed = parseRunRequest(raw);
  if ("code" in parsed) {
    return { status: 400, body: errorBody(parsed.code, parsed.message) };
  }
  const unregistered = rejectUnregisteredWorkspace(parsed, deps);
  if (unregistered !== null) {
    return unregistered;
  }
  const model = resolveRunModel(parsed, deps);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  const engineCtx: EngineContext = {
    request: parsed,
    model,
    registry: deps.registry,
    evidence: {
      store: deps.evidenceStore,
      env: deps.env,
      additionalSecrets: currentRedactionSecrets(deps),
    },
  };
  try {
    const started = startRun(engineCtx, deps.redactor);
    return { status: 202, body: { runId: started.runId, fingerprint: started.fingerprint } };
  } catch (error) {
    if (error instanceof ActiveRunLimitError) {
      return { status: 429, body: errorBody("TOO_MANY_RUNS", "The active run limit is reached.") };
    }
    throw error;
  }
}

// Route — POST /api/chats/runs. Composer-specific path that makes Issue #66's chat invariant
// explicit: a successful workflow launch first reserves a runId and persists exactly one user
// message plus one system run summary, then starts the run with that reserved runId. If persistence
// fails, no run is started; if the start is refused, the summary is terminalized as failed.
export async function handleCreateChatRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  let raw: string;
  try {
    raw = await readBody(ctx.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    throw error;
  }
  const envelope = parseChatRunEnvelope(raw, deps);
  if (isRouteResult(envelope)) return envelope;
  const validated = validateChatRunRequest(envelope.runBody, deps);
  if (isRouteResult(validated)) return validated;
  const runId = randomUUID();
  const messages = persistChatRunMessages(deps, envelope, validated.request, runId);
  if (isRouteResult(messages)) return messages;
  return startPersistedChatRun(deps, validated.request, validated.model, runId, messages);
}

function lastEventId(req: IncomingMessage): number {
  const header = req.headers["last-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return -1;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

// Route 6 — GET /api/runs/:runId/events (SSE). Replays the ring buffer (after Last-Event-ID), sends
// `ready`, then streams live events, closing after the run terminates. The writer is detached on
// client disconnect to avoid leaks and unbounded fan-out.
export function handleRunEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  openSseStream(ctx.res, record, lastEventId(ctx.req), deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

function openSseStream(
  res: ServerResponse,
  record: RunRecord,
  afterSeq: number,
  redactor: UiHandlerDeps["redactor"],
): void {
  res.writeHead(200, SSE_HEADERS);
  const writer: SseWriter = {
    write: (event: StreamEvent): boolean => {
      const accepted = writeEvent(res, event, redactor);
      if (!accepted) {
        res.destroy();
      }
      return accepted;
    },
    close: (): void => {
      res.end();
    },
  };
  const detach = record.sink.attach(writer, afterSeq);
  res.write(readyMessage());
  res.on("close", detach);
  if (record.sink.isTerminated()) {
    detach();
    res.end();
  }
}

// Route 7 — POST /api/runs/:runId/cancel. Idempotent; 404 unknown.
export function handleCancelRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  record.cancel("cancelled via UI");
  return { status: 200, body: { ok: true } };
}

// Route 8 — GET /api/runs/:runId. Final redacted report projection, or status:"running".
export function handleGetRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (record.status === "running") {
    return { status: 200, body: { report: { status: "running" } } };
  }
  return {
    status: 200,
    body: { report: reportWithApply(record.report, record.applyReport, record.appliedAt) },
  };
}

function reportWithApply(
  report: unknown,
  applyReport: unknown,
  appliedAt: number | undefined,
): unknown {
  if (applyReport === undefined || appliedAt === undefined) {
    return report;
  }
  if (!isRecord(report)) {
    return { report, applyReport, appliedAt };
  }
  return { ...report, applyReport, appliedAt };
}

// Route 9 — POST /api/runs/:runId/apply. The ONLY write path. 404 unknown; 409 when not in an
// appliable (dry-run-success) state; otherwise re-invokes the gated workflow with apply:true.
export async function handleApplyRun(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (record.appliable === undefined) {
    return {
      status: 409,
      body: errorBody("NOT_APPLIABLE", "The run is not in an appliable state."),
    };
  }
  const model = deps.modelPortFactory(record.modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  const report = await applyRun(record.appliable, model, record.modelId, deps.redactor);
  record.appliable = undefined;
  record.applyReport = report;
  record.appliedAt = Date.now();
  return {
    status: 200,
    body: { report: reportWithApply(record.report, record.applyReport, record.appliedAt) },
  };
}
