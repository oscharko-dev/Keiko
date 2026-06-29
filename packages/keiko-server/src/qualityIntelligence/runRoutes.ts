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
  QualityIntelligenceCapsuleSource,
  QualityIntelligenceCapsuleSetSource,
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  QualityIntelligenceRunStreamMessage,
  QualityIntelligenceSkippedSource,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceModelPolicy,
  QualityIntelligenceModelRouting,
} from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import { SSE_HEADERS } from "../sse.js";
import { writeOrDestroy } from "../sse-write.js";
import {
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
  type RouteDefinition,
} from "../routes.js";
import type { Redactor, UiHandlerDeps } from "../deps.js";
import {
  executeQiRun,
  QiGenerationError,
  QiIngestionError,
  type QiRunAccepted,
} from "./runExecution.js";
import { parseFigmaSnapshotScreenIds } from "./figmaSnapshotScreenIds.js";
import type { QiSkippedSource } from "./runIngestion.js";
import { qiRunRegistry } from "./runRegistry.js";
import { buildQiModelRoutingForRun, QiModelPolicyError } from "./modelPolicyRoutes.js";

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

function validateCapsuleSource(
  label: string,
  raw: Record<string, unknown>,
): QualityIntelligenceCapsuleSource | RouteResult {
  if (typeof raw.capsuleId !== "string" || raw.capsuleId.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "A capsule source requires a non-empty capsuleId.");
  }
  return { kind: "capsule", label, capsuleId: raw.capsuleId };
}

function validateCapsuleSetSource(
  label: string,
  raw: Record<string, unknown>,
): QualityIntelligenceCapsuleSetSource | RouteResult {
  if (typeof raw.capsuleSetId !== "string" || raw.capsuleSetId.trim().length === 0) {
    return errorResult(
      400,
      "QI_BAD_REQUEST",
      "A capsule-set source requires a non-empty capsuleSetId.",
    );
  }
  return { kind: "capsule-set", label, capsuleSetId: raw.capsuleSetId };
}

function validateFigmaSnapshotSource(
  label: string,
  raw: Record<string, unknown>,
): QualityIntelligenceFigmaSnapshotSource | RouteResult {
  if (typeof raw.snapshotRunId !== "string" || raw.snapshotRunId.trim().length === 0) {
    return errorResult(
      400,
      "QI_BAD_REQUEST",
      "A figma-snapshot source requires a non-empty snapshotRunId.",
    );
  }
  // Single source of truth shared with the re-check route so run/recheck never diverge. An absent
  // field stays a whole-snapshot source; a present field must be a non-empty, bounded, canonicalised
  // scope — an explicit empty array is rejected here so it can never silently widen to the whole board.
  const parsed = parseFigmaSnapshotScreenIds(raw.screenIds);
  if (!parsed.ok) {
    return errorResult(400, "QI_BAD_REQUEST", parsed.reason);
  }
  return {
    kind: "figma-snapshot",
    label,
    snapshotRunId: raw.snapshotRunId,
    ...(parsed.screenIds !== undefined ? { screenIds: parsed.screenIds } : {}),
  };
}

function validateImageSource(
  label: string,
  raw: Record<string, unknown>,
): QualityIntelligenceImageSource | RouteResult {
  if (raw.sourceKind !== "figma-snapshot-screen") {
    return errorResult(
      400,
      "QI_BAD_REQUEST",
      "An image source requires sourceKind figma-snapshot-screen.",
    );
  }
  if (typeof raw.snapshotRunId !== "string" || raw.snapshotRunId.trim().length === 0) {
    return errorResult(
      400,
      "QI_BAD_REQUEST",
      "An image source requires a non-empty snapshotRunId.",
    );
  }
  if (typeof raw.screenId !== "string" || raw.screenId.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "An image source requires a non-empty screenId.");
  }
  return {
    kind: "image",
    label,
    sourceKind: "figma-snapshot-screen",
    snapshotRunId: raw.snapshotRunId,
    screenId: raw.screenId,
  };
}

// Connector sources (Local Knowledge capsule / capsule-set, Figma snapshot). Split out so
// validateSource stays under the complexity budget as the source-kind union grows (Epic #710/#750).
function validateConnectorSource(
  label: string,
  raw: Record<string, unknown>,
): QualityIntelligenceInlineSource | RouteResult | undefined {
  if (raw.kind === "capsule") {
    return validateCapsuleSource(label, raw);
  }
  if (raw.kind === "capsule-set") {
    return validateCapsuleSetSource(label, raw);
  }
  if (raw.kind === "figma-snapshot") {
    return validateFigmaSnapshotSource(label, raw);
  }
  if (raw.kind === "image") {
    return validateImageSource(label, raw);
  }
  return undefined;
}

function validateSource(raw: unknown): QualityIntelligenceInlineSource | RouteResult | undefined {
  if (!isObject(raw) || typeof raw.label !== "string") return undefined;
  const label = raw.label;
  if (raw.kind === "requirements" && typeof raw.text === "string") {
    return { kind: "requirements", label, text: raw.text };
  }
  if (raw.kind === "workspace" && typeof raw.path === "string") {
    return { kind: "workspace", label, path: raw.path };
  }
  if (raw.kind === "file" && typeof raw.path === "string") {
    return { kind: "file", label, path: raw.path };
  }
  return validateConnectorSource(label, raw);
}

function isRouteResult(v: unknown): v is RouteResult {
  return isObject(v) && typeof v.status === "number";
}

function validateSourceEntry(raw: unknown): QualityIntelligenceInlineSource | RouteResult {
  const source = validateSource(raw);
  if (source === undefined) {
    return errorResult(400, "QI_BAD_SOURCE", "A source entry is malformed.");
  }
  // A capsule (or other) field-level validation failure surfaces as a RouteResult — propagate it.
  if (isRouteResult(source)) {
    return source;
  }
  if (source.kind === "file" && !isAbsolute(source.path)) {
    return errorResult(400, "QI_BAD_SOURCE", "File source paths must be absolute local paths.");
  }
  return source;
}

type ParseOutcome =
  | { readonly ok: true; readonly request: QualityIntelligenceStartRunRequest }
  | { readonly ok: false; readonly result: RouteResult };

type SourcesOutcome =
  | { readonly ok: true; readonly sources: QualityIntelligenceInlineSource[] }
  | { readonly ok: false; readonly result: RouteResult };

function collectSources(rawSources: readonly unknown[]): SourcesOutcome {
  const sources: QualityIntelligenceInlineSource[] = [];
  for (const raw of rawSources) {
    // validateSourceEntry adds the absolute-path guard for file sources (#791) on top of the
    // shape + capsule validation, surfacing any failure as a RouteResult.
    const source = validateSourceEntry(raw);
    if (isRouteResult(source)) {
      return { ok: false, result: source };
    }
    sources.push(source);
  }
  return { ok: true, sources };
}

function parseOptionalSeed(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseOptionalModelPolicy(
  value: unknown,
): QualityIntelligenceModelPolicy | null | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return null;
  if (value.policyVersion !== 1) return null;
  return {
    policyVersion: 1,
    ...(typeof value.testDesignModelId === "string"
      ? { testDesignModelId: value.testDesignModelId }
      : {}),
    ...(typeof value.judgeModelId === "string" ? { judgeModelId: value.judgeModelId } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function buildStartRequest(
  sources: QualityIntelligenceInlineSource[],
  profileId: string | undefined,
  modelId: string | undefined,
  modelPolicy: QualityIntelligenceModelPolicy | undefined,
  seed: number | undefined,
): QualityIntelligenceStartRunRequest {
  return {
    sources,
    ...(profileId ? { profileId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(modelPolicy !== undefined ? { modelPolicy } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };
}

function validateRequest(parsed: unknown): ParseOutcome {
  if (!isObject(parsed) || !Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "At least one source is required."),
    };
  }
  const collected = collectSources(parsed.sources);
  if (!collected.ok) return collected;
  const profileId = typeof parsed.profileId === "string" ? parsed.profileId : undefined;
  const modelId = typeof parsed.modelId === "string" ? parsed.modelId : undefined;
  const modelPolicy = parseOptionalModelPolicy(parsed.modelPolicy);
  if (modelPolicy === null) {
    return {
      ok: false,
      result: errorResult(
        400,
        "QI_BAD_MODEL_POLICY",
        "The Quality Intelligence model policy is malformed.",
      ),
    };
  }
  const seed = parseOptionalSeed(parsed.seed);
  if (seed === null) {
    return {
      ok: false,
      result: errorResult(
        400,
        "QI_BAD_REQUEST",
        "Seed must be a non-negative safe integer when provided.",
      ),
    };
  }
  return {
    ok: true,
    request: buildStartRequest(collected.sources, profileId, modelId, modelPolicy, seed),
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

// Exported for unit testing of the reasonSummary redaction backstop (#279 AC3); not part of the
// package public surface (the QI index re-exports only the route handlers, not this helper).
export function toStreamEvent(
  event: QI.QualityIntelligenceRunEvent,
  redact: Redactor,
): QualityIntelligenceRunStreamMessage {
  const p = event.payload;
  return {
    type: "event",
    kind: p.kind,
    sequence: event.sequence,
    ...("stageName" in p ? { stageName: p.stageName } : {}),
    ...("candidateId" in p ? { candidateId: String(p.candidateId) } : {}),
    ...("findingId" in p ? { findingId: String(p.findingId) } : {}),
    // `reasonSummary` is the only free-text field on the QI event envelope. The workflow already
    // produces a fail-closed, secret-free summary (see `safeReasonSummary`), but pass it through the
    // live-payload redactor too so this SSE writer — the one QI surface with no other redaction —
    // can never stream a credential/endpoint substring should a future code path widen the field
    // (#279 AC3, defence-in-depth; mirrors the Conversation Center SSE redaction posture).
    ...("reasonSummary" in p ? { reasonSummary: applyRedactor(redact, p.reasonSummary) } : {}),
  };
}

// Apply the live-payload redactor to a string field. The redactor is typed `(unknown) => unknown`
// (it walks arbitrary structures); for a string input it returns the redacted string. Fall back to
// the already-safe input on the impossible non-string return so the field type stays `string`.
function applyRedactor(redact: Redactor, value: string): string {
  const out = redact(value);
  return typeof out === "string" ? out : value;
}

function classifyStartError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof QiIngestionError || error instanceof QiGenerationError) {
    return { code: error.code, message: error.message };
  }
  return { code: "QI_RUN_FAILED", message: "The Quality Intelligence run failed to complete." };
}

type WriteFn = (message: QualityIntelligenceRunStreamMessage) => void;
type QiExecutionSummary = Awaited<ReturnType<typeof executeQiRun>>;
type StreamTotals = Extract<QualityIntelligenceRunStreamMessage, { type: "done" }>["totals"];

// Project the internal QiSkippedSource[] (which also carries a free-text `message`) to exactly the
// wire contract QualityIntelligenceSkippedSource[] ({label, kind, code}). Streaming `message`
// verbatim would widen the browser-facing SSE surface — the `accepted` frame bypasses deps.redactor,
// unlike `event` — so it is dropped here (Issue #730).
function toWireSkippedSources(
  skipped: readonly QiSkippedSource[],
): readonly QualityIntelligenceSkippedSource[] {
  return skipped.map((s) => ({ label: s.label, kind: s.kind, code: s.code }));
}

function writeAcceptedFrame(write: WriteFn, accepted: QiRunAccepted): void {
  write({
    type: "accepted",
    runId: accepted.runId,
    requestedAt: accepted.requestedAt,
    sourceCount: accepted.sourceCount,
    atomCount: accepted.atomCount,
    ...(accepted.modelRouting !== undefined
      ? {
          modelRouting: {
            resolved: accepted.modelRouting.resolved,
            preflight: accepted.modelRouting.preflight,
          },
        }
      : {}),
    ...(accepted.droppedSourceCount > 0 ? { droppedSourceCount: accepted.droppedSourceCount } : {}),
    ...(accepted.skippedSources.length > 0
      ? { skippedSources: toWireSkippedSources(accepted.skippedSources) }
      : {}),
  });
}

export function doneFrameForSummary(
  deps: UiHandlerDeps,
  runId: string,
  summary: QiExecutionSummary,
  totals: StreamTotals,
  modelRouting?: QualityIntelligenceModelRouting,
): QualityIntelligenceRunStreamMessage {
  // Surface the bounded reasonSummary for BOTH a terminal failed run and a succeeded-but-degraded run
  // (model/parser fell back to the deterministic baseline). The reason is already safeReasonSummary-
  // bounded server-side; re-redact defensively before it reaches the wire.
  const reasonSummary =
    summary.reasonSummary !== undefined
      ? applyRedactor(deps.redactor, summary.reasonSummary)
      : undefined;
  const degraded = summary.status === "succeeded" && reasonSummary !== undefined ? true : undefined;
  return {
    type: "done",
    runId,
    status: summary.status,
    totals,
    ...(modelRouting !== undefined
      ? { modelRouting: { resolved: modelRouting.resolved, preflight: modelRouting.preflight } }
      : {}),
    ...(reasonSummary !== undefined ? { reasonSummary } : {}),
    ...(degraded !== undefined ? { degraded } : {}),
  };
}

async function streamRunExecution(
  deps: UiHandlerDeps,
  request: QualityIntelligenceStartRunRequest,
  modelRouting: QualityIntelligenceModelRouting,
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
      modelRouting,
      runId,
      deps,
      registeredAt,
      signal,
      onAccepted: (accepted) => {
        writeAcceptedFrame(write, accepted);
      },
      onEvent: (event) => {
        if (event.payload.kind === "candidate:proposed") totals.candidates += 1;
        if (event.payload.kind === "finding:recorded") totals.findings += 1;
        qiRunRegistry.updateTotals(runId, totals);
        write(toStreamEvent(event, deps.redactor));
      },
    });
    terminal = summary.status;
    write(doneFrameForSummary(deps, runId, summary, totals, modelRouting));
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
  let modelRouting: QualityIntelligenceModelRouting;
  try {
    modelRouting = await buildQiModelRoutingForRun(deps, parsed.request);
  } catch (error) {
    if (error instanceof QiModelPolicyError) {
      return errorResult(400, error.code, error.message);
    }
    return errorResult(
      500,
      "QI_MODEL_PREFLIGHT_FAILED",
      "The Quality Intelligence model preflight failed.",
    );
  }

  const runId = `qi-run-${randomUUID()}`;
  const registeredAt = new Date().toISOString();
  // Register and wire the disconnect listener BEFORE writeHead to close the narrow race where a
  // client disconnects after parsing succeeds but before the response is committed.
  const controller = qiRunRegistry.register(runId, registeredAt);
  ctx.res.on("close", () => {
    controller.abort();
  });
  ctx.res.writeHead(200, { ...SSE_HEADERS, "X-Accel-Buffering": "no" });
  const write: WriteFn = (message) => {
    writeOrDestroy(ctx.res, `data: ${JSON.stringify(message)}\n\n`, controller);
  };

  await streamRunExecution(
    deps,
    parsed.request,
    modelRouting,
    runId,
    registeredAt,
    controller.signal,
    write,
  );
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
