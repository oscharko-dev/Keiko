import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FEEDBACK_BODY_SHA256_HEADER_V1,
  FEEDBACK_INTAKE_RECEIPT_PATH_PREFIX_V1,
  FEEDBACK_INTAKE_REPORT_PATH_V1,
  FEEDBACK_RECEIPT_AUTH_SCHEME_V1,
  isFeedbackReceiptIdV1,
  type FeedbackIntakeErrorV1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";
import { normalizeAddress, resolveClientAddress, type ClientAddressInput } from "./proxy.js";
import type { IntakeLimits, ReceiptResult, SubmitResult } from "./types.js";

export interface FeedbackIntakeHttpService {
  beginAttempt(
    address: Uint8Array,
  ): Promise<
    | { readonly ok: true; readonly release: () => void }
    | { readonly ok: false; readonly result: SubmitResult }
  >;
  submitReserved(bytes: Uint8Array, digest: string): Promise<SubmitResult>;
  submit(bytes: Uint8Array, digest: string, address: Uint8Array): Promise<SubmitResult>;
  receipt(id: string, secret: string): Promise<ReceiptResult>;
}

export interface FeedbackIntakeHttpOptions {
  readonly service: FeedbackIntakeHttpService;
  readonly limits: IntakeLimits;
  readonly proxy: Pick<ClientAddressInput, "family" | "trustedCidrs">;
}

type BodyRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly tooLarge: boolean };

type SubmitMetadata =
  | { readonly ok: true; readonly digest: string }
  | {
      readonly ok: false;
      readonly status: 400 | 413 | 415;
      readonly code: "invalid-request" | "payload-too-large" | "unsupported-media";
    };

type AttemptAddress =
  | { readonly ok: true; readonly chargeAddress: Uint8Array; readonly valid: boolean }
  | { readonly ok: false };

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": String(bytes.byteLength),
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(bytes);
}

function error(
  res: ServerResponse,
  status: 400 | 404 | 413 | 415,
  code: FeedbackIntakeErrorV1["error"],
): void {
  writeJson(res, status, { error: code });
}

async function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
  deadlineMs: number,
): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (value: BodyRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, tooLarge: false });
    }, deadlineMs);
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        tooLarge = true;
        req.pause();
        finish({ ok: false, tooLarge: true });
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      finish(
        tooLarge ? { ok: false, tooLarge: true } : { ok: true, bytes: Buffer.concat(chunks, size) },
      );
    });
    req.on("error", () => {
      finish({ ok: false, tooLarge: false });
    });
  });
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function duplicateRawHeader(req: IncomingMessage, names: readonly string[]): boolean {
  const tracked = new Set(names.map((name) => name.toLowerCase()));
  const counts = new Map<string, number>();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]?.toLowerCase();
    if (name === undefined || !tracked.has(name)) continue;
    const count = (counts.get(name) ?? 0) + 1;
    if (count > 1) return true;
    counts.set(name, count);
  }
  return false;
}

function unsupportedSubmitHeaders(req: IncomingMessage): boolean {
  if (
    duplicateRawHeader(req, [
      "content-type",
      "content-encoding",
      FEEDBACK_BODY_SHA256_HEADER_V1,
      "forwarded",
      "x-forwarded-for",
    ])
  ) {
    return true;
  }
  return (
    singleHeader(req, "content-type")?.toLowerCase() !== "application/json" ||
    req.headers["content-encoding"] !== undefined ||
    req.headers.cookie !== undefined ||
    req.headers.authorization !== undefined
  );
}

function rawHeaderBytes(req: IncomingMessage): number {
  return req.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value, "latin1") + 4, 2);
}

function attemptAddress(req: IncomingMessage, options: FeedbackIntakeHttpOptions): AttemptAddress {
  const resolved = requestAddress(req, options);
  if (resolved.ok) return { ok: true, chargeAddress: resolved.bytes, valid: true };
  const peer = req.socket.remoteAddress;
  const fallback = peer === undefined ? undefined : normalizeAddress(peer);
  return fallback === undefined
    ? { ok: false }
    : { ok: true, chargeAddress: fallback, valid: false };
}

function terminateUpload(req: IncomingMessage, res: ServerResponse): void {
  if (req.complete || req.destroyed) return;
  req.pause();
  res.shouldKeepAlive = false;
  if (!res.headersSent) res.setHeader("Connection", "close");
  res.once("finish", () => {
    const timer = setTimeout(() => {
      req.destroy();
    }, 100);
    timer.unref();
  });
}

function writeSubmitResult(res: ServerResponse, result: SubmitResult): void {
  writeJson(
    res,
    result.status,
    result.body,
    result.status === 429 ? { "Retry-After": String(result.retryAfterSeconds) } : {},
  );
}

function requestAddress(
  req: IncomingMessage,
  options: FeedbackIntakeHttpOptions,
): ReturnType<typeof resolveClientAddress> {
  const peer = req.socket.remoteAddress;
  if (peer === undefined) return { ok: false };
  return resolveClientAddress({
    peer,
    forwarded: singleHeader(req, "forwarded"),
    xForwardedFor: singleHeader(req, "x-forwarded-for"),
    family: options.proxy.family,
    trustedCidrs: options.proxy.trustedCidrs,
    maxHops: options.limits.proxyHops,
  });
}

function submitMetadata(req: IncomingMessage, limits: IntakeLimits): SubmitMetadata {
  if (rawHeaderBytes(req) > limits.headerBytes) {
    return { ok: false, status: 413, code: "payload-too-large" };
  }
  if (unsupportedSubmitHeaders(req)) {
    return { ok: false, status: 415, code: "unsupported-media" };
  }
  const digest = singleHeader(req, FEEDBACK_BODY_SHA256_HEADER_V1);
  if (digest === undefined) return { ok: false, status: 400, code: "invalid-request" };
  const declaredLength = Number(singleHeader(req, "content-length"));
  return Number.isFinite(declaredLength) && declaredLength > limits.bodyBytes
    ? { ok: false, status: 413, code: "payload-too-large" }
    : { ok: true, digest };
}

async function handleSubmit(
  req: IncomingMessage,
  res: ServerResponse,
  options: FeedbackIntakeHttpOptions,
): Promise<void> {
  const address = attemptAddress(req, options);
  if (!address.ok) {
    terminateUpload(req, res);
    error(res, 400, "invalid-request");
    return;
  }
  const lease = await options.service.beginAttempt(address.chargeAddress);
  if (!lease.ok) {
    terminateUpload(req, res);
    writeSubmitResult(res, lease.result);
    return;
  }
  try {
    if (!address.valid) {
      terminateUpload(req, res);
      error(res, 400, "invalid-request");
      return;
    }
    const metadata = submitMetadata(req, options.limits);
    if (!metadata.ok) {
      terminateUpload(req, res);
      error(res, metadata.status, metadata.code);
      return;
    }
    const body = await readBoundedBody(
      req,
      options.limits.bodyBytes,
      options.limits.bodyDeadlineMs,
    );
    if (!body.ok) {
      terminateUpload(req, res);
      error(
        res,
        body.tooLarge ? 413 : 400,
        body.tooLarge ? "payload-too-large" : "invalid-request",
      );
      return;
    }
    writeSubmitResult(res, await options.service.submitReserved(body.bytes, metadata.digest));
  } finally {
    lease.release();
  }
}

function receiptCredentials(req: IncomingMessage): string | undefined {
  const header = singleHeader(req, "authorization");
  const prefix = `${FEEDBACK_RECEIPT_AUTH_SCHEME_V1} `;
  return header?.startsWith(prefix) && header.length > prefix.length
    ? header.slice(prefix.length)
    : undefined;
}

async function handleReceipt(
  req: IncomingMessage,
  res: ServerResponse,
  options: FeedbackIntakeHttpOptions,
  id: string,
): Promise<void> {
  const secret = receiptCredentials(req);
  if (
    duplicateRawHeader(req, ["authorization"]) ||
    !isFeedbackReceiptIdV1(id) ||
    secret === undefined
  ) {
    error(res, 404, "invalid-request");
    return;
  }
  const result = await options.service.receipt(id, secret);
  writeJson(res, result.status, result.body);
}

export function createFeedbackIntakeHttpHandler(options: FeedbackIntakeHttpOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = req.url ?? "";
      if (req.method === "POST" && url === FEEDBACK_INTAKE_REPORT_PATH_V1) {
        await handleSubmit(req, res, options);
        return;
      }
      if (
        req.method === "GET" &&
        url.startsWith(FEEDBACK_INTAKE_RECEIPT_PATH_PREFIX_V1) &&
        !url.includes("?")
      ) {
        await handleReceipt(
          req,
          res,
          options,
          url.slice(FEEDBACK_INTAKE_RECEIPT_PATH_PREFIX_V1.length),
        );
        return;
      }
      error(res, 404, "invalid-request");
    } catch {
      if (!res.headersSent) writeJson(res, 503, { error: "temporarily-unavailable" });
      else res.end();
    }
  };
}
