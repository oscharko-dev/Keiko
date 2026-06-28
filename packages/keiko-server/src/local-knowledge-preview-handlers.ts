import type { IncomingMessage } from "node:http";

import type {
  PdfCitationPreviewOpenResponse,
  PdfCitationPreviewSelection,
  PdfCitationPreviewStatusRequest,
} from "@oscharko-dev/keiko-contracts";
import { pdfCitationPreviewFailureState } from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "./deps.js";
import type { HandlerOutcome, RouteContext, RouteResult } from "./routes.js";
import { STREAMING, errorBody } from "./routes.js";
import {
  authorizePdfCitationPreview,
  getPdfCitationPreviewStatus,
  projectPdfCitationPreviewAuthorizationResponse,
} from "./local-knowledge-preview-service.js";
import { normalizePreviewMarkerIndex } from "./local-knowledge-preview-authority.js";
import { loadVerifiedPdfPreviewSource, MAX_PDF_PREVIEW_RANGE_BYTES } from "./local-knowledge-preview-delivery.js";
import { previewSessionManagerFor } from "./local-knowledge-preview-session-manager.js";

const MAX_BODY_BYTES = 16_000;

class InvalidRequest extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new InvalidRequest("Request body is too large."));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidRequest("Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequest("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseBaseBody(body: Record<string, unknown>): {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly stableId?: string;
} {
  if (typeof body.chatId !== "string" || body.chatId.trim().length === 0) {
    throw new InvalidRequest("Field \"chatId\" must be a non-empty string.");
  }
  if (
    typeof body.assistantMessageId !== "string" ||
    body.assistantMessageId.trim().length === 0
  ) {
    throw new InvalidRequest("Field \"assistantMessageId\" must be a non-empty string.");
  }
  if (body.stableId !== undefined && typeof body.stableId !== "string") {
    throw new InvalidRequest("Field \"stableId\" must be a string when present.");
  }
  return {
    chatId: body.chatId,
    assistantMessageId: body.assistantMessageId,
    ...(typeof body.stableId === "string" ? { stableId: body.stableId } : {}),
  };
}

function parseMarker(body: Record<string, unknown>, required: boolean): string | number | undefined {
  if (!("marker" in body)) {
    if (required) {
      throw new InvalidRequest("Field \"marker\" is required.");
    }
    return undefined;
  }
  const marker = body.marker;
  if (typeof marker !== "string" && typeof marker !== "number") {
    throw new InvalidRequest("Field \"marker\" must be a string or number.");
  }
  if (normalizePreviewMarkerIndex(marker) === undefined) {
    throw new InvalidRequest("Field \"marker\" must resolve to a positive citation index.");
  }
  return marker;
}

function invalidRequestResult(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

function previewSourceError(reason: string): RouteResult {
  switch (reason) {
    case "document-content-mismatch":
      return {
        status: 409,
        body: errorBody("PREVIEW_SOURCE_CHANGED", "The verified PDF bytes no longer match the citation."),
      };
    case "document-not-pdf":
      return {
        status: 409,
        body: errorBody("PREVIEW_SOURCE_NOT_PDF", "The verified citation source is no longer a PDF."),
      };
    case "document-not-ready":
      return {
        status: 409,
        body: errorBody("PREVIEW_SOURCE_NOT_READY", "The verified citation source is not ready for preview."),
      };
    case "preview-source-oversized":
      return {
        status: 413,
        body: errorBody("PREVIEW_SOURCE_TOO_LARGE", "The verified PDF exceeds the preview size limit."),
      };
    case "preview-source-unreadable":
      return {
        status: 503,
        body: errorBody("PREVIEW_SOURCE_UNREADABLE", "The verified PDF could not be read safely."),
      };
    default:
      return {
        status: 410,
        body: errorBody("PREVIEW_SOURCE_MISSING", "The verified PDF source is no longer available."),
      };
  }
}

function selectionInput(body: Record<string, unknown>): PdfCitationPreviewSelection {
  const base = parseBaseBody(body);
  const marker = parseMarker(body, true);
  return { ...base, marker: marker ?? "[1]" };
}

function invalidRangeResult(message: string): RouteResult {
  return {
    status: 416,
    body: errorBody("PREVIEW_RANGE_NOT_SATISFIABLE", message),
  };
}

function parseExplicitRange(
  startRaw: string,
  endRaw: string,
): { readonly end: number; readonly start: number } | undefined {
  if (startRaw.length === 0 || endRaw.length === 0) return undefined;
  return {
    start: Number.parseInt(startRaw, 10),
    end: Number.parseInt(endRaw, 10),
  };
}

function parseOpenEndedRange(
  startRaw: string,
  totalBytes: number,
): { readonly end: number; readonly start: number } | undefined {
  if (startRaw.length === 0) return undefined;
  return {
    start: Number.parseInt(startRaw, 10),
    end: totalBytes - 1,
  };
}

function parseSuffixRange(
  endRaw: string,
  totalBytes: number,
): { readonly end: number; readonly start: number } | undefined {
  if (endRaw.length === 0) return undefined;
  const suffixLength = Number.parseInt(endRaw, 10);
  return {
    start: Math.max(0, totalBytes - suffixLength),
    end: totalBytes - 1,
  };
}

function parsedRangeValues(
  startRaw: string,
  endRaw: string,
  totalBytes: number,
): { readonly end: number; readonly start: number } | undefined {
  return (
    parseExplicitRange(startRaw, endRaw) ??
    parseOpenEndedRange(startRaw, totalBytes) ??
    parseSuffixRange(endRaw, totalBytes)
  );
}

function validatedRange(
  start: number,
  end: number,
  totalBytes: number,
): { readonly end: number; readonly start: number } | RouteResult {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= totalBytes) {
    return invalidRangeResult("The requested byte range is invalid.");
  }
  const boundedEnd = Math.min(end, totalBytes - 1);
  if (boundedEnd - start + 1 > MAX_PDF_PREVIEW_RANGE_BYTES) {
    return invalidRangeResult("The requested byte range exceeds the preview limit.");
  }
  return { start, end: boundedEnd };
}

function parseRangeHeader(
  header: string | undefined,
  totalBytes: number,
): { readonly end: number; readonly start: number } | RouteResult {
  if (header === undefined) {
    return { start: 0, end: totalBytes - 1 };
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null || header.includes(",")) {
    return invalidRangeResult("Only a single bounded byte range is supported.");
  }
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  const parsed = parsedRangeValues(startRaw, endRaw, totalBytes);
  return parsed === undefined
    ? invalidRangeResult("The requested byte range is invalid.")
    : validatedRange(parsed.start, parsed.end, totalBytes);
}

export async function handleGetPdfCitationPreviewStatus(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readJsonObject(ctx.req);
    const base = parseBaseBody(body);
    const marker = parseMarker(body, false);
    const input: PdfCitationPreviewStatusRequest = {
      ...base,
      ...(marker !== undefined ? { marker } : {}),
    };
    return { status: 200, body: getPdfCitationPreviewStatus(deps, input) };
  } catch (error) {
    if (error instanceof InvalidRequest) {
      return invalidRequestResult(error.message);
    }
    throw error;
  }
}

export async function handleAuthorizePdfCitationPreview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readJsonObject(ctx.req);
    const input = selectionInput(body);
    return {
      status: 200,
      body: projectPdfCitationPreviewAuthorizationResponse(
        authorizePdfCitationPreview(deps, input),
      ),
    };
  } catch (error) {
    if (error instanceof InvalidRequest) {
      return invalidRequestResult(error.message);
    }
    throw error;
  }
}

export async function handleOpenPdfCitationPreviewSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  try {
    const body = await readJsonObject(ctx.req);
    const authorized = authorizePdfCitationPreview(deps, selectionInput(body));
    if ("kind" in authorized) {
      return rejectedOpenResult(authorized.reason, authorized.display);
    }
    const verified = await loadVerifiedPdfPreviewSource(deps, authorized.authority);
    if (verified.kind !== "ok") {
      return rejectedOpenResult(verified.reason, authorized.display);
    }
    const opened = previewSessionManagerFor(deps).openSession(authorized.authority);
    return openSessionResult(authorized.display, opened, verified.bytes.byteLength);
  } catch (error) {
    if (error instanceof InvalidRequest) {
      return invalidRequestResult(error.message);
    }
    throw error;
  }
}

function rejectedOpenResult(
  reason: import("@oscharko-dev/keiko-contracts").PdfCitationPreviewReasonCode,
  display: import("@oscharko-dev/keiko-contracts").PdfCitationPreviewDisplay | undefined,
): RouteResult {
  return {
    status: 200,
    body: {
      outcome: "rejected",
      state: pdfCitationPreviewFailureState(reason),
      reason,
      ...(display === undefined ? {} : { display }),
    } satisfies PdfCitationPreviewOpenResponse,
  };
}

function openSessionResult(
  display: import("@oscharko-dev/keiko-contracts").PdfCitationPreviewDisplay,
  opened: ReturnType<ReturnType<typeof previewSessionManagerFor>["openSession"]>,
  byteLength: number,
): RouteResult {
  return {
    status: 200,
    body: {
      outcome: "authorized",
      display,
      session: {
        handle: opened.session.handle,
        expiresAt: opened.session.expiresAt,
        reused: opened.reused,
        byteLength,
        contentType: "application/pdf",
      },
    } satisfies PdfCitationPreviewOpenResponse,
  };
}

function sessionHandleFromContext(ctx: RouteContext): string | RouteResult {
  const sessionHandle = ctx.params.sessionHandle ?? "";
  if (sessionHandle.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "sessionHandle is required.") };
  }
  return sessionHandle;
}

function sessionLookupResult(
  deps: UiHandlerDeps,
  sessionHandle: string,
):
  | Extract<
      import("./local-knowledge-preview-session-manager.js").PdfCitationPreviewSessionLookup,
      { readonly kind: "open" }
    >
  | RouteResult {
  const lookup = previewSessionManagerFor(deps).lookupSession(sessionHandle);
  if (lookup.kind === "missing") {
    return {
      status: 404,
      body: errorBody("PREVIEW_SESSION_NOT_FOUND", "Preview session not found."),
    };
  }
  if (lookup.kind === "closed") {
    return {
      status: 410,
      body: errorBody("PREVIEW_SESSION_CLOSED", "Preview session is closed."),
    };
  }
  if (lookup.kind === "expired") {
    return {
      status: 410,
      body: errorBody("PREVIEW_SESSION_EXPIRED", "Preview session expired."),
    };
  }
  return lookup;
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === "object" && value !== null && "status" in value;
}

function streamPdfPreview(
  ctx: RouteContext,
  bytes: Uint8Array,
  range: { readonly end: number; readonly start: number },
): HandlerOutcome {
  const isPartial = range.start !== 0 || range.end !== bytes.byteLength - 1;
  const chunk = bytes.subarray(range.start, range.end + 1);
  ctx.res.writeHead(isPartial ? 206 : 200, {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(chunk.byteLength),
    "Content-Type": "application/pdf",
    ...(isPartial
      ? { "Content-Range": `bytes ${String(range.start)}-${String(range.end)}/${String(bytes.byteLength)}` }
      : {}),
    "X-Content-Type-Options": "nosniff",
  });
  ctx.res.end(Buffer.from(chunk));
  return STREAMING;
}

export async function handleGetPdfCitationPreviewDocument(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const sessionHandle = sessionHandleFromContext(ctx);
  if (isRouteResult(sessionHandle)) {
    return sessionHandle;
  }
  const lookup = sessionLookupResult(deps, sessionHandle);
  if (isRouteResult(lookup)) {
    return lookup;
  }
  const verified = await loadVerifiedPdfPreviewSource(deps, lookup.session.authority);
  if (verified.kind !== "ok") {
    return previewSourceError(verified.reason);
  }
  const rangeHeader = ctx.req.headers.range;
  const parsedRange = parseRangeHeader(
    typeof rangeHeader === "string" ? rangeHeader : rangeHeader?.[0],
    verified.bytes.byteLength,
  );
  if ("status" in parsedRange) {
    return parsedRange;
  }
  return streamPdfPreview(ctx, verified.bytes, parsedRange);
}

export function handleClosePdfCitationPreviewSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const sessionHandle = sessionHandleFromContext(ctx);
  if (isRouteResult(sessionHandle)) {
    return sessionHandle;
  }
  previewSessionManagerFor(deps).closeSession(sessionHandle);
  return { status: 200, body: { ok: true } };
}
