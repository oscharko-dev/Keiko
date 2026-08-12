"use client";

import {
  CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
  validateCodingAppSessionChannelSnapshot,
  type CodingAppSessionChannelSnapshot,
  type CodingWorkbenchValidationResult,
} from "@oscharko-dev/keiko-contracts";

import { ApiError } from "./api";
import { clientErrorSummary } from "./client-error-summary";
import { reportClientDiagnostic } from "./client-diagnostics";
import { bffFetchJson, newClientCorrelationId, CORRELATION_HEADER } from "./http";

const CHANNEL_PATH = "/api/coding-workbench/app-session/channel";
const CHANNEL_STREAM_PATH = `${CHANNEL_PATH}/stream`;
const MAX_STREAM_BUFFER_CHARS = CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES * 2;

// KEIKO-0308 — the server heartbeats this stream every 15s even when it has nothing to deliver
// (packages/keiko-server/src/coding-app-session/codingAppSessionRoutes.ts, `setInterval(..., 15_000)`
// writing ": heartbeat\n\n"), specifically so a live client can tell "quiet" apart from "dead". That
// guarantee only protects the client if something on this side actually notices silence — a stalled
// or half-broken TCP connection leaves `reader.read()` pending forever otherwise. 45s is three missed
// heartbeats: generous enough to absorb one dropped write, tight enough that the UI does not hang
// indefinitely. Exported so the regression test can advance fake timers by this exact value instead
// of restating it (AGENTS.md: a fixture derives from the production entry point, never restates it).
export const STREAM_INACTIVITY_TIMEOUT_MS = 45_000;

function channelValidator(path: string, value: unknown): CodingAppSessionChannelSnapshot {
  const result: CodingWorkbenchValidationResult<CodingAppSessionChannelSnapshot> =
    validateCodingAppSessionChannelSnapshot(value);
  if (result.ok) return result.value;
  throw new ApiError(
    "CONTRACT_VALIDATION_FAILED",
    `BFF response for ${path} failed contract validation.`,
    502,
  );
}

/** Read the latest authenticated activity projection without putting authority in a URL. */
export function getCodingAppSessionChannelSnapshot(
  signal?: AbortSignal,
): Promise<CodingAppSessionChannelSnapshot> {
  return bffFetchJson(
    CHANNEL_PATH,
    { cache: "no-store", ...(signal === undefined ? {} : { signal }) },
    { validator: channelValidator },
  );
}

export interface CodingAppSessionStreamInput {
  readonly signal: AbortSignal;
  readonly onSnapshot: (snapshot: CodingAppSessionChannelSnapshot) => void;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Consume the authenticated fetch stream. This deliberately is not EventSource: content-bearing
 * activity stays on the cookie-authenticated app-session channel and never widens the content-free
 * runtime SSE union.
 */
export async function streamCodingAppSessionChannelSnapshots(
  input: CodingAppSessionStreamInput,
): Promise<void> {
  // The stream bypasses bffFetchJson, so it has to carry the same correlation id itself; without
  // it a stream failure cannot be traced UI -> server the way every other request can.
  const response = await (input.fetchImpl ?? globalThis.fetch)(CHANNEL_STREAM_PATH, {
    cache: "no-store",
    headers: { Accept: "text/event-stream", [CORRELATION_HEADER]: newClientCorrelationId() },
    signal: input.signal,
  });
  if (!response.ok) throw streamError(response.status);
  if (response.body === null) throw streamError(502);
  await consumeStream(response.body.getReader(), input);
}

function streamError(status: number): ApiError {
  return new ApiError(
    "CODING_APP_SESSION_STREAM_UNAVAILABLE",
    "The authenticated activity stream is unavailable.",
    status,
  );
}

// KEIKO-0308 — distinct from `streamError`: the connection DID establish, so this is not "the
// stream is unavailable" (which other callers may reasonably retry immediately) but "the stream
// went quiet past the point the server's own heartbeat guarantee allows for". Kept as its own typed
// ApiError code, behind the same typed error surface every other failure in this module uses.
function streamStalledError(): ApiError {
  return new ApiError(
    "CODING_APP_SESSION_STREAM_STALLED",
    "The authenticated activity stream stopped receiving data.",
    504,
  );
}

/**
 * Races one `reader.read()` call against the inactivity timer. Resolves/rejects exactly like
 * `reader.read()` when bytes (or EOF) arrive first — the timer is cleared in `finally` so a healthy
 * read never leaves a stray timeout armed. On timeout, the reader is presumed dead: it is cancelled
 * AFTER the typed stall rejection is committed, and the fire-and-forget cancel resolves the pending
 * read into `{ done: true }` for a separate GC path, not for this call's outcome. Codex on PR #3089
 * caught the reverse ordering where `cancel()` fulfilled the pending read with a clean EOF before
 * the rejection settled, so a stall silently reported disconnect instead of the typed stall error.
 * `consumeStream` calls this once per loop iteration, so a fresh timer guards every read — including
 * the first — and is effectively cleared-and-recreated ("reset") on every chunk that arrives, since
 * arrival is what makes the read that started the race resolve.
 */
function readWithInactivityGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stallError = streamStalledError();
  const stall = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      // Reject FIRST so the outer Promise.race locks the stall verdict before `cancel()` can
      // fulfil the pending `reader.read()` with `{ done: true }` on the microtask queue.
      reject(stallError);
      // CodeRabbit 3765131337: route cancellation failures to the redacted client-diagnostic
      // sink instead of silently swallowing them (AGENTS.md §7 "no silent failures"). The typed
      // stall rejection stays authoritative — a cancel that fails just leaves the reader for GC.
      reader.cancel(stallError).catch((error: unknown) => {
        reportClientDiagnostic(
          `[keiko] coding app-session stream cancel-on-stall failed: ${clientErrorSummary(error)}`,
        );
      });
    }, STREAM_INACTIVITY_TIMEOUT_MS);
  });
  return Promise.race([reader.read(), stall]).finally(() => clearTimeout(timer));
}

async function consumeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  input: CodingAppSessionStreamInput,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!input.signal.aborted) {
      const result = await readWithInactivityGuard(reader);
      buffer += decoder.decode(result.value, { stream: !result.done });
      buffer = deliverFrames(buffer, input.onSnapshot);
      if (buffer.length > MAX_STREAM_BUFFER_CHARS) throw streamError(502);
      if (result.done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function deliverFrames(
  input: string,
  onSnapshot: (snapshot: CodingAppSessionChannelSnapshot) => void,
): string {
  const normalized = input.replaceAll("\r\n", "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";
  for (const frame of frames) deliverFrame(frame, onSnapshot);
  return remainder;
}

function deliverFrame(
  frame: string,
  onSnapshot: (snapshot: CodingAppSessionChannelSnapshot) => void,
): void {
  const lines = frame.split("\n");
  const event = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  if (event !== "snapshot") return;
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) throw streamError(502);
  onSnapshot(parseSnapshot(data));
}

function parseSnapshot(data: string): CodingAppSessionChannelSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw streamError(502);
  }
  return channelValidator(CHANNEL_STREAM_PATH, value);
}
