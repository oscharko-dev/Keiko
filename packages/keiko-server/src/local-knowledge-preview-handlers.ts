import type { IncomingMessage } from "node:http";

import type {
  PdfCitationPreviewOpenResponse,
  PdfCitationPreviewOrigin,
  PdfCitationPreviewReasonCode,
  PdfCitationPreviewSelection,
  PdfCitationPreviewStatusRequest,
} from "@oscharko-dev/keiko-contracts";
import { pdfCitationPreviewFailureState } from "@oscharko-dev/keiko-contracts";
import { createSqliteAuditSink } from "@oscharko-dev/keiko-local-knowledge";

import type { UiHandlerDeps } from "./deps.js";
import { openStoreForDeps } from "./local-knowledge-grounded-qa.js";
import type { HandlerOutcome, RouteContext, RouteResult } from "./routes.js";
import { STREAMING, errorBody } from "./routes.js";
import {
  authorizePdfCitationPreview,
  getPdfCitationPreviewStatus,
  projectPdfCitationPreviewAuthorizationResponse,
  verifyPdfCitationPreviewDocumentAccess,
} from "./local-knowledge-preview-service.js";
import { normalizePreviewMarkerIndex } from "./local-knowledge-preview-authority.js";
import {
  canReuseVerifiedPdfPreviewSource,
  loadPdfPreviewSourceForSession,
  loadVerifiedPdfPreviewSource,
  MAX_PDF_PREVIEW_RANGE_BYTES,
  openPdfPreviewSourceReader,
  pdfPreviewStreamChunkBytes,
  type PdfCitationPreviewSource,
} from "./local-knowledge-preview-delivery.js";
import { previewSessionManagerFor } from "./local-knowledge-preview-session-manager.js";

const MAX_BODY_BYTES = 16_000;
const PDF_PREVIEW_DRAIN_TIMEOUT_MS = 15_000;
const MAX_PDF_PREVIEW_STREAMS = 16;

let activePdfPreviewStreams = 0;

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
    throw new InvalidRequest('Field "chatId" must be a non-empty string.');
  }
  if (typeof body.assistantMessageId !== "string" || body.assistantMessageId.trim().length === 0) {
    throw new InvalidRequest('Field "assistantMessageId" must be a non-empty string.');
  }
  if (body.stableId !== undefined && typeof body.stableId !== "string") {
    throw new InvalidRequest('Field "stableId" must be a string when present.');
  }
  return {
    chatId: body.chatId,
    assistantMessageId: body.assistantMessageId,
    ...(typeof body.stableId === "string" ? { stableId: body.stableId } : {}),
  };
}

function parseMarker(
  body: Record<string, unknown>,
  required: boolean,
): string | number | undefined {
  if (!("marker" in body)) {
    if (required) {
      throw new InvalidRequest('Field "marker" is required.');
    }
    return undefined;
  }
  const marker = body.marker;
  if (typeof marker !== "string" && typeof marker !== "number") {
    throw new InvalidRequest('Field "marker" must be a string or number.');
  }
  if (normalizePreviewMarkerIndex(marker) === undefined) {
    throw new InvalidRequest('Field "marker" must resolve to a positive citation index.');
  }
  return marker;
}

function parseOrigin(body: Record<string, unknown>): PdfCitationPreviewOrigin | undefined {
  const origin = body.origin;
  return origin === "inline-marker" || origin === "citation-chip" ? origin : undefined;
}

function invalidRequestResult(message: string): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message) };
}

interface PreviewSourceErrorSpec {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

const PREVIEW_SOURCE_ERROR_SPECS = new Map<string, PreviewSourceErrorSpec>([
  [
    "source-modified",
    {
      status: 409,
      code: "PREVIEW_SOURCE_CHANGED",
      message: "The verified PDF bytes no longer match the citation.",
    },
  ],
  [
    "document-content-mismatch",
    {
      status: 409,
      code: "PREVIEW_SOURCE_CHANGED",
      message: "The verified PDF bytes no longer match the citation.",
    },
  ],
  [
    "document-not-pdf",
    {
      status: 409,
      code: "PREVIEW_SOURCE_NOT_PDF",
      message: "The verified citation source is no longer a PDF.",
    },
  ],
  [
    "document-not-ready",
    {
      status: 503,
      code: "PREVIEW_SOURCE_NOT_READY",
      message: "The verified citation source is not ready for preview.",
    },
  ],
  [
    "source-dehydrated",
    {
      status: 503,
      code: "PREVIEW_SOURCE_DEHYDRATED",
      message: "The verified PDF source could not provide the requested bytes.",
    },
  ],
  [
    "preview-source-oversized",
    {
      status: 413,
      code: "PREVIEW_SOURCE_TOO_LARGE",
      message: "The verified PDF exceeds the preview size limit.",
    },
  ],
  [
    "preview-source-unreadable",
    {
      status: 503,
      code: "PREVIEW_SOURCE_UNREADABLE",
      message: "The verified PDF could not be read safely.",
    },
  ],
  [
    "source-needs-rebind",
    {
      status: 410,
      code: "PREVIEW_SOURCE_REBIND_REQUIRED",
      message: "The verified PDF source must be located or rebound before preview.",
    },
  ],
]);

const DEFAULT_PREVIEW_SOURCE_ERROR_SPEC: PreviewSourceErrorSpec = {
  status: 410,
  code: "PREVIEW_SOURCE_MISSING",
  message: "The verified PDF source is no longer available.",
};

function previewSourceError(reason: string): RouteResult {
  const spec = PREVIEW_SOURCE_ERROR_SPECS.get(reason) ?? DEFAULT_PREVIEW_SOURCE_ERROR_SPEC;
  return { status: spec.status, body: errorBody(spec.code, spec.message) };
}

function documentAccessDeniedResult(reason: PdfCitationPreviewReasonCode): RouteResult {
  return {
    status: 403,
    body: errorBody(
      "PREVIEW_SESSION_FORBIDDEN",
      `The preview session is no longer authorized for this citation (${reason}).`,
    ),
  };
}

function selectionInput(body: Record<string, unknown>): PdfCitationPreviewSelection {
  const base = parseBaseBody(body);
  const marker = parseMarker(body, true);
  const origin = parseOrigin(body);
  return {
    ...base,
    marker: marker ?? "[1]",
    ...(origin === undefined ? {} : { origin }),
  };
}

function invalidRangeResult(message: string): RouteResult {
  return {
    status: 416,
    body: errorBody("PREVIEW_RANGE_NOT_SATISFIABLE", message),
  };
}

interface ParsedPreviewRange {
  readonly end: number;
  readonly rangeRequested: boolean;
  readonly start: number;
  readonly status: 200 | 206;
}

function parseSafeDecimal(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function invalidRangeBounds(start: number, end: number, totalBytes: number): boolean {
  return (
    !Number.isSafeInteger(totalBytes) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    totalBytes <= 0 ||
    start < 0 ||
    end < start ||
    start >= totalBytes
  );
}

function invalidRangeContentLength(contentLength: number): boolean {
  return (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_PDF_PREVIEW_RANGE_BYTES
  );
}

function validatedRange(
  start: number,
  end: number,
  totalBytes: number,
  rangeRequested: boolean,
): ParsedPreviewRange | RouteResult {
  if (invalidRangeBounds(start, end, totalBytes)) {
    return invalidRangeResult("The requested byte range is invalid.");
  }
  const boundedEnd = Math.min(end, totalBytes - 1);
  const contentLength = boundedEnd - start + 1;
  if (invalidRangeContentLength(contentLength)) {
    return invalidRangeResult("The requested byte range exceeds the preview limit.");
  }
  return {
    start,
    end: boundedEnd,
    rangeRequested,
    status: rangeRequested ? 206 : boundedEnd === totalBytes - 1 ? 200 : 206,
  };
}

function parsedExplicitRange(
  startRaw: string,
  endRaw: string,
  totalBytes: number,
): ParsedPreviewRange | RouteResult {
  const start = parseSafeDecimal(startRaw);
  const end = parseSafeDecimal(endRaw);
  if (start === undefined || end === undefined) {
    return invalidRangeResult("The requested byte range is invalid.");
  }
  return validatedRange(start, end, totalBytes, true);
}

function parsedOpenEndedRange(
  startRaw: string,
  totalBytes: number,
): ParsedPreviewRange | RouteResult {
  const start = parseSafeDecimal(startRaw);
  if (start === undefined) return invalidRangeResult("The requested byte range is invalid.");
  return validatedRange(start, totalBytes - 1, totalBytes, true);
}

function parsedSuffixRange(endRaw: string, totalBytes: number): ParsedPreviewRange | RouteResult {
  const suffixLength = parseSafeDecimal(endRaw);
  if (suffixLength === undefined || suffixLength <= 0) {
    return invalidRangeResult("The requested byte range is invalid.");
  }
  return validatedRange(Math.max(0, totalBytes - suffixLength), totalBytes - 1, totalBytes, true);
}

function parsedMatchedRange(
  startRaw: string,
  endRaw: string,
  totalBytes: number,
): ParsedPreviewRange | RouteResult {
  if (startRaw.length > 0 && endRaw.length > 0) {
    return parsedExplicitRange(startRaw, endRaw, totalBytes);
  }
  if (startRaw.length > 0) return parsedOpenEndedRange(startRaw, totalBytes);
  if (endRaw.length > 0) return parsedSuffixRange(endRaw, totalBytes);
  return invalidRangeResult("The requested byte range is invalid.");
}

function parseRangeHeader(
  header: string | undefined,
  totalBytes: number,
): ParsedPreviewRange | RouteResult {
  if (header === undefined) {
    return validatedRange(
      0,
      Math.min(totalBytes - 1, MAX_PDF_PREVIEW_RANGE_BYTES - 1),
      totalBytes,
      false,
    );
  }
  const trimmed = header.trim();
  const match = /^bytes=(\d*)-(\d*)$/u.exec(trimmed);
  if (match === null || trimmed.includes(",")) {
    return invalidRangeResult("Only a single bounded byte range is supported.");
  }
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  return parsedMatchedRange(startRaw, endRaw, totalBytes);
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
    const input = selectionInput(body);
    const authorized = authorizePdfCitationPreview(deps, input);
    if ("kind" in authorized) {
      return rejectedOpenResult(authorized.reason, authorized.display);
    }
    const manager = previewSessionManagerFor(deps);
    const existing = manager.lookupOpenSession(authorized.authority);
    if (existing !== undefined && canReuseVerifiedPdfPreviewSource(existing.session.source)) {
      const refreshed = manager.openSession(authorized.authority, existing.session.source, input);
      return openSessionResult(authorized.display, refreshed, refreshed.session.source.byteLength);
    }
    const verified = await loadVerifiedPdfPreviewSource(deps, authorized.authority);
    if (verified.kind !== "ok") {
      return rejectedOpenResult(verified.reason, authorized.display);
    }
    const opened = manager.openSession(authorized.authority, verified.source, input);
    return openSessionResult(authorized.display, opened, verified.source.byteLength);
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

function expectedSessionExpiresAt(body: Record<string, unknown>): string | undefined {
  const expected = body.expectedExpiresAt;
  if (expected === undefined) return undefined;
  if (typeof expected !== "string" || expected.trim().length === 0) {
    throw new InvalidRequest('Field "expectedExpiresAt" must be a non-empty string when provided.');
  }
  return expected;
}

function sessionLookupResult(
  manager: ReturnType<typeof previewSessionManagerFor>,
  sessionHandle: string,
):
  | Extract<
      import("./local-knowledge-preview-session-manager.js").PdfCitationPreviewSessionLookup,
      { readonly kind: "open" }
    >
  | RouteResult {
  const lookup = manager.beginSessionUse(sessionHandle);
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
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

function pdfPreviewEtag(source: PdfCitationPreviewSource): string {
  return `"${source.contentHash}"`;
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function forbiddenDocumentRequestResult(): RouteResult {
  return {
    status: 403,
    body: errorBody("FORBIDDEN_CSRF", "Cross-site preview document requests are not allowed."),
  };
}

function lowerHeaderValue(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function requestHost(ctx: RouteContext): string {
  return firstHeaderValue(ctx.req.headers.host) ?? ctx.url.host;
}

function originMatchesRequest(ctx: RouteContext, origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === ctx.url.protocol && originUrl.host === requestHost(ctx);
  } catch {
    return false;
  }
}

function documentFetchMetadataResult(ctx: RouteContext): RouteResult | undefined {
  const origin = firstHeaderValue(ctx.req.headers.origin);
  if (origin !== undefined && !originMatchesRequest(ctx, origin)) {
    return forbiddenDocumentRequestResult();
  }

  const fetchSite = lowerHeaderValue(firstHeaderValue(ctx.req.headers["sec-fetch-site"]));
  if (fetchSite === "cross-site") {
    return forbiddenDocumentRequestResult();
  }

  const fetchMode = lowerHeaderValue(firstHeaderValue(ctx.req.headers["sec-fetch-mode"]));
  if (
    fetchMode !== undefined &&
    fetchMode !== "cors" &&
    fetchMode !== "navigate" &&
    fetchMode !== "no-cors" &&
    fetchMode !== "same-origin"
  ) {
    return forbiddenDocumentRequestResult();
  }

  return undefined;
}

function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry === etag);
}

function writeNotModified(ctx: RouteContext, source: PdfCitationPreviewSource): HandlerOutcome {
  ctx.res.writeHead(304, {
    "Cache-Control": "no-store",
    ETag: pdfPreviewEtag(source),
    "X-Content-Type-Options": "nosniff",
  });
  ctx.res.end();
  return STREAMING;
}

function tryBeginPdfPreviewStream(): boolean {
  if (activePdfPreviewStreams >= MAX_PDF_PREVIEW_STREAMS) return false;
  activePdfPreviewStreams += 1;
  return true;
}

function endPdfPreviewStream(): void {
  if (activePdfPreviewStreams > 0) {
    activePdfPreviewStreams -= 1;
  }
}

async function writeResponseChunk(ctx: RouteContext, chunk: Uint8Array): Promise<boolean> {
  const isConnectionDestroyed = (): boolean => ctx.res.destroyed || ctx.req.destroyed;
  if (isConnectionDestroyed()) return false;
  let flushed: boolean;
  try {
    flushed = ctx.res.write(Buffer.from(chunk));
  } catch {
    return false;
  }
  if (flushed) {
    return true;
  }
  const drained = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      finish(false);
    }, PDF_PREVIEW_DRAIN_TIMEOUT_MS);
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      ctx.res.off("drain", onDrain);
      ctx.res.off("close", onClose);
      ctx.res.off("error", onClose);
      ctx.req.off("close", onClose);
      resolve(value);
    };
    const onDrain = (): void => {
      finish(true);
    };
    const onClose = (): void => {
      finish(false);
    };
    timer.unref();
    ctx.res.once("drain", onDrain);
    ctx.res.once("close", onClose);
    ctx.res.once("error", onClose);
    ctx.req.once("close", onClose);
  });
  return drained && !isConnectionDestroyed();
}

function previewResponseHeaders(
  source: PdfCitationPreviewSource,
  range: ParsedPreviewRange,
  contentLength: number,
): Record<string, string> {
  return {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(contentLength),
    "Content-Type": "application/pdf",
    ETag: pdfPreviewEtag(source),
    ...(range.status === 206
      ? {
          "Content-Range": `bytes ${String(range.start)}-${String(range.end)}/${String(source.byteLength)}`,
        }
      : {}),
    "X-Content-Type-Options": "nosniff",
  };
}

type PdfPreviewSourceReader = NonNullable<Awaited<ReturnType<typeof openPdfPreviewSourceReader>>>;

async function readExpectedChunk(
  reader: PdfPreviewSourceReader,
  start: number,
  length: number,
): Promise<Uint8Array | undefined> {
  try {
    const chunk = await reader.readRange(start, length);
    return chunk.byteLength === length ? chunk : undefined;
  } catch {
    return undefined;
  }
}

async function streamPdfPreview(
  deps: UiHandlerDeps,
  ctx: RouteContext,
  source: PdfCitationPreviewSource,
  range: ParsedPreviewRange,
): Promise<HandlerOutcome> {
  const contentLength = range.end - range.start + 1;
  if (!tryBeginPdfPreviewStream()) {
    return previewSourceError("preview-source-unreadable");
  }
  let reader: PdfPreviewSourceReader | undefined;
  try {
    reader = await openPdfPreviewSourceReader(deps, source);
    if (reader === undefined) {
      return previewSourceError("preview-source-unreadable");
    }
    const chunks: Uint8Array[] = [];
    for (let offset = range.start; offset <= range.end; offset += pdfPreviewStreamChunkBytes()) {
      const length = Math.min(pdfPreviewStreamChunkBytes(), range.end - offset + 1);
      const chunk = await readExpectedChunk(reader, offset, length);
      if (chunk === undefined) {
        return previewSourceError("source-dehydrated");
      }
      chunks.push(chunk);
    }
    ctx.res.writeHead(range.status, previewResponseHeaders(source, range, contentLength));
    for (const chunk of chunks) {
      const keepGoing = await writeResponseChunk(ctx, chunk);
      if (!keepGoing) return STREAMING;
    }
    ctx.res.end();
    return STREAMING;
  } finally {
    try {
      await reader?.close();
    } catch {
      // Best-effort cleanup; stream error handling already chose the response outcome.
    }
    endPdfPreviewStream();
  }
}

function conditionalDocumentResult(
  ctx: RouteContext,
  source: PdfCitationPreviewSource,
  rangeHeader: string | undefined,
): HandlerOutcome | undefined {
  if (rangeHeader !== undefined) return undefined;
  if (
    !ifNoneMatchMatches(firstHeaderValue(ctx.req.headers["if-none-match"]), pdfPreviewEtag(source))
  ) {
    return undefined;
  }
  return writeNotModified(ctx, source);
}

function emitDocumentAccessAudit(
  deps: UiHandlerDeps,
  source: PdfCitationPreviewSource,
  range: ParsedPreviewRange | undefined,
  outcome: "failure" | "not-modified" | "success",
  reasonCode?: PdfCitationPreviewReasonCode,
): void {
  const session = openStoreForDeps(deps);
  try {
    createSqliteAuditSink(session.store).emit({
      kind: "citation-preview-document-accessed",
      capsuleId: source.capsuleId,
      sourceId: source.sourceId,
      documentId: source.documentId,
      ...(range === undefined
        ? {}
        : {
            byteStart: range.start,
            byteEnd: range.end,
            byteCount: range.end - range.start + 1,
          }),
      outcome,
      sourceKind: source.kind,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      occurredAt: Date.now(),
    });
  } finally {
    session.close();
  }
}

type OpenPreviewSessionLookup = Extract<
  import("./local-knowledge-preview-session-manager.js").PdfCitationPreviewSessionLookup,
  { readonly kind: "open" }
>;

async function serveOpenPdfPreviewSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  lookup: OpenPreviewSessionLookup,
): Promise<HandlerOutcome> {
  const access = verifyPdfCitationPreviewDocumentAccess(
    deps,
    lookup.session.context,
    lookup.session.authority,
  );
  if (access.kind !== "ok") {
    emitDocumentAccessAudit(deps, lookup.session.source, undefined, "failure", access.reason);
    return documentAccessDeniedResult(access.reason);
  }
  const verified = loadPdfPreviewSourceForSession(
    deps,
    lookup.session.authority,
    lookup.session.source,
  );
  if (verified.kind !== "ok") {
    emitDocumentAccessAudit(deps, lookup.session.source, undefined, "failure", verified.reason);
    return previewSourceError(verified.reason);
  }
  const rangeHeader = firstHeaderValue(ctx.req.headers.range);
  const conditional = conditionalDocumentResult(ctx, verified.source, rangeHeader);
  if (conditional !== undefined) {
    emitDocumentAccessAudit(deps, verified.source, undefined, "not-modified");
    return conditional;
  }
  const parsedRange = parseRangeHeader(rangeHeader, verified.source.byteLength);
  if (isRouteResult(parsedRange)) {
    emitDocumentAccessAudit(deps, verified.source, undefined, "failure");
    return parsedRange;
  }
  const streamed = await streamPdfPreview(deps, ctx, verified.source, parsedRange);
  emitDocumentAccessAudit(
    deps,
    verified.source,
    parsedRange,
    isRouteResult(streamed) ? "failure" : "success",
  );
  return streamed;
}

export async function handleGetPdfCitationPreviewDocument(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<HandlerOutcome> {
  const sessionHandle = sessionHandleFromContext(ctx);
  if (isRouteResult(sessionHandle)) {
    return sessionHandle;
  }
  const fetchMetadata = documentFetchMetadataResult(ctx);
  if (fetchMetadata !== undefined) {
    return fetchMetadata;
  }
  const manager = previewSessionManagerFor(deps);
  const lookup = sessionLookupResult(manager, sessionHandle);
  if (isRouteResult(lookup)) {
    return lookup;
  }
  try {
    return await serveOpenPdfPreviewSession(ctx, deps, lookup);
  } finally {
    manager.endSessionUse(sessionHandle);
  }
}

export async function handleClosePdfCitationPreviewSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const sessionHandle = sessionHandleFromContext(ctx);
  if (isRouteResult(sessionHandle)) {
    return sessionHandle;
  }
  try {
    const expectedExpiresAt = expectedSessionExpiresAt(await readJsonObject(ctx.req));
    const manager = previewSessionManagerFor(deps);
    const lookup = manager.lookupSession(sessionHandle);
    if (lookup.kind === "open" && lookup.session.expiresAt === expectedExpiresAt) {
      const access = verifyPdfCitationPreviewDocumentAccess(
        deps,
        lookup.session.context,
        lookup.session.authority,
      );
      if (access.kind === "ok") {
        manager.closeSession(sessionHandle);
      }
    } else if (lookup.kind === "open" && expectedExpiresAt === undefined) {
      const access = verifyPdfCitationPreviewDocumentAccess(
        deps,
        lookup.session.context,
        lookup.session.authority,
      );
      if (access.kind === "ok") {
        manager.closeSession(sessionHandle);
      }
    }
    return { status: 200, body: { ok: true } };
  } catch (error) {
    if (error instanceof InvalidRequest) {
      return invalidRequestResult(error.message);
    }
    throw error;
  }
}
