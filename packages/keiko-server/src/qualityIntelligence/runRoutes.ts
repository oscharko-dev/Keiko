// Quality Intelligence run start + cancel BFF routes (Epic #270, Issue #273/#280).
//
//   * POST /api/quality-intelligence/runs        — start a run; responds with an SSE progress stream
//   * POST /api/quality-intelligence/runs/:id/cancel — cancel an in-flight run
//
// The start route validates the body, then writes a `text/event-stream` of
// `QualityIntelligenceRunStreamMessage`s as the run progresses (accepted → events → done|error).
// All stream payloads carry only ids / counts / safe enums — never prompts, model output, source
// content, or credentials. A client disconnect aborts the run via the registry.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isAbsolute } from "node:path";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceRunStreamMessage,
  QualityIntelligenceStartRunRequest,
} from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import { SSE_HEADERS } from "../sse.js";
import {
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
  type RouteDefinition,
} from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { executeQiRun, QiGenerationError, QiIngestionError } from "./runExecution.js";
import { qiRunRegistry } from "./runRegistry.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

class BodyTooLargeError extends Error {}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorResult = (status: number, code: string, message: string): RouteResult => ({
  status,
  body: { error: { code, message } },
});

function validateSource(raw: unknown): QualityIntelligenceInlineSource | undefined {
  if (!isObject(raw) || typeof raw.label !== "string") return undefined;
  if (raw.kind === "requirements" && typeof raw.text === "string") {
    return { kind: "requirements", label: raw.label, text: raw.text };
  }
  if (raw.kind === "workspace" && typeof raw.path === "string") {
    return { kind: "workspace", label: raw.label, path: raw.path };
  }
  if (raw.kind === "file" && typeof raw.path === "string") {
    return { kind: "file", label: raw.label, path: raw.path };
  }
  return undefined;
}

function validateSourceEntry(raw: unknown): QualityIntelligenceInlineSource | RouteResult {
  const source = validateSource(raw);
  if (source === undefined) {
    return errorResult(400, "QI_BAD_SOURCE", "A source entry is malformed.");
  }
  if (source.kind === "file" && !isAbsolute(source.path)) {
    return errorResult(400, "QI_BAD_SOURCE", "File source paths must be absolute local paths.");
  }
  return source;
}

type ParseOutcome =
  | { readonly ok: true; readonly request: QualityIntelligenceStartRunRequest }
  | { readonly ok: false; readonly result: RouteResult };

function validateRequest(parsed: unknown): ParseOutcome {
  if (!isObject(parsed) || !Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "At least one source is required."),
    };
  }
  const sources: QualityIntelligenceInlineSource[] = [];
  for (const raw of parsed.sources) {
    const source = validateSourceEntry(raw);
    if ("status" in source) {
      return {
        ok: false,
        result: source,
      };
    }
    sources.push(source);
  }
  const profileId = typeof parsed.profileId === "string" ? parsed.profileId : undefined;
  const modelId = typeof parsed.modelId === "string" ? parsed.modelId : undefined;
  return {
    ok: true,
    request: { sources, ...(profileId ? { profileId } : {}), ...(modelId ? { modelId } : {}) },
  };
}

async function parseStartBody(req: IncomingMessage): Promise<ParseOutcome> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    return error instanceof BodyTooLargeError
      ? { ok: false, result: errorResult(413, "QI_BODY_TOO_LARGE", "Request body is too large.") }
      : { ok: false, result: errorResult(400, "QI_BAD_REQUEST", "Could not read request body.") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Request body is not valid JSON."),
    };
  }
  return validateRequest(parsed);
}

function toStreamEvent(event: QI.QualityIntelligenceRunEvent): QualityIntelligenceRunStreamMessage {
  const p = event.payload;
  return {
    type: "event",
    kind: p.kind,
    sequence: event.sequence,
    ...("stageName" in p ? { stageName: p.stageName } : {}),
    ...("candidateId" in p ? { candidateId: String(p.candidateId) } : {}),
    ...("findingId" in p ? { findingId: String(p.findingId) } : {}),
    ...("reasonSummary" in p ? { reasonSummary: p.reasonSummary } : {}),
  };
}

function classifyStartError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof QiIngestionError || error instanceof QiGenerationError) {
    return { code: error.code, message: error.message };
  }
  return { code: "QI_RUN_FAILED", message: "The Quality Intelligence run failed to complete." };
}

type WriteFn = (message: QualityIntelligenceRunStreamMessage) => void;

async function streamRunExecution(
  deps: UiHandlerDeps,
  request: QualityIntelligenceStartRunRequest,
  runId: string,
  registeredAt: string,
  signal: AbortSignal,
  write: WriteFn,
): Promise<void> {
  const totals = { candidates: 0, findings: 0, exports: 0 };
  let terminal: "succeeded" | "failed" | "cancelled" = "failed";
  try {
    const summary = await executeQiRun({
      request,
      runId,
      deps,
      registeredAt,
      signal,
      onAccepted: (accepted) => {
        write({
          type: "accepted",
          runId: accepted.runId,
          requestedAt: accepted.requestedAt,
          sourceCount: accepted.sourceCount,
          atomCount: accepted.atomCount,
          ...(accepted.droppedSourceCount > 0
            ? { droppedSourceCount: accepted.droppedSourceCount }
            : {}),
        });
      },
      onEvent: (event) => {
        if (event.payload.kind === "candidate:proposed") totals.candidates += 1;
        if (event.payload.kind === "finding:recorded") totals.findings += 1;
        qiRunRegistry.updateTotals(runId, totals);
        write(toStreamEvent(event));
      },
    });
    terminal = summary.status;
    write({ type: "done", runId, status: summary.status, totals });
  } catch (error) {
    const { code, message } = classifyStartError(error);
    write({ type: "error", code, message });
  } finally {
    qiRunRegistry.complete(runId, terminal);
  }
}

export async function handleStartQiRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const parsed = await parseStartBody(ctx.req);
  if (!parsed.ok) return parsed.result;

  const runId = `qi-run-${randomUUID()}`;
  const registeredAt = new Date().toISOString();
  ctx.res.writeHead(200, { ...SSE_HEADERS, "X-Accel-Buffering": "no" });
  const write: WriteFn = (message) => {
    ctx.res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  const controller = qiRunRegistry.register(runId, registeredAt);
  ctx.res.on("close", () => {
    controller.abort();
  });

  await streamRunExecution(deps, parsed.request, runId, registeredAt, controller.signal, write);
  ctx.res.end();
  return STREAMING;
}

export function handleCancelQiRun(ctx: RouteContext, _deps: UiHandlerDeps): RouteResult {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const cancelled = qiRunRegistry.cancel(id);
  return cancelled
    ? { status: 200, body: { cancelled: true, runId: id } }
    : errorResult(404, "QI_NOT_ACTIVE", "No in-flight run with that id.");
}

export const QI_RUN_EXECUTION_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/quality-intelligence/runs", handler: handleStartQiRun },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/runs/:id/cancel",
    handler: handleCancelQiRun,
  },
];
