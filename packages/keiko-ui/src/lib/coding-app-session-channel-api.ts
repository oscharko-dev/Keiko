"use client";

import {
  CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
  validateCodingAppSessionChannelSnapshot,
  type CodingAppSessionChannelSnapshot,
  type CodingWorkbenchValidationResult,
} from "@oscharko-dev/keiko-contracts";

import { ApiError } from "./api";
import { bffFetchJson, newClientCorrelationId, CORRELATION_HEADER } from "./http";

const CHANNEL_PATH = "/api/coding-workbench/app-session/channel";
const CHANNEL_STREAM_PATH = `${CHANNEL_PATH}/stream`;
const MAX_STREAM_BUFFER_CHARS = CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES * 2;

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

async function consumeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  input: CodingAppSessionStreamInput,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!input.signal.aborted) {
      const result = await reader.read();
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
