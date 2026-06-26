// Byte-level LSP base-protocol codec (Issue #1381, Epic #1491, ADR-0069 D3/I3). The reader consumes
// raw stdout chunks, splits `Content-Length: N\r\n\r\n` + exactly N bytes, and yields frame body
// buffers. It works purely at the Buffer level: headers are ASCII, but bodies are decoded as JSON
// only by the caller after exactly N bytes are accumulated, so a multi-byte UTF-8 sequence that
// straddles a chunk boundary is never split mid-character.
//
// ADR-0069 I3 (stream boundaries never buffer an oversized body): when the declared Content-Length
// exceeds `maxFrameBytes` the reader rejects the frame BEFORE reading the body and never accumulates
// the oversized payload. A missing or garbled header is rejected as MALFORMED_HEADER.

import { parseLspFrameHeader } from "@oscharko-dev/keiko-contracts";
import type { LspFrameRejectReason } from "@oscharko-dev/keiko-contracts";

const HEADER_DELIMITER = Buffer.from("\r\n\r\n", "ascii");
const HEADER_LINE_DELIMITER = "\r\n";

// The byte type carried through the codec. Aliased so the source/sink/reader speak one name; it
// resolves to the Node `Buffer` whose backing-buffer generic accommodates `subarray`/`concat` results
// without an unsound cast.
export type LspBytes = Buffer;

// Thrown by the frame reader when a frame cannot be read safely. The `reason` is a content-free enum
// member; no header text or body bytes are carried on the error (ADR-0069 D6).
export class LspFrameRejectError extends Error {
  public readonly reason: LspFrameRejectReason;

  public constructor(reason: LspFrameRejectReason) {
    super(reason);
    this.name = "LspFrameRejectError";
    this.reason = reason;
  }
}

// A minimal readable source: anything async-iterable over Buffers (a Node Readable in object-less
// mode satisfies this). Kept structural so the fake harness need not subclass a Node stream.
export type LspByteSource = AsyncIterable<LspBytes>;

interface ParsedHeader {
  readonly contentLength: number;
  readonly headerEndIndex: number;
}

// Locates the `\r\n\r\n` header terminator in the accumulated buffer and parses the Content-Length.
// Returns null when the terminator is not yet present (more chunks needed). Throws LspFrameRejectError
// when a header is present but malformed, so the caller surfaces MALFORMED_HEADER deterministically.
function parseHeader(buffer: LspBytes): ParsedHeader | null {
  const delimiterIndex = buffer.indexOf(HEADER_DELIMITER);
  if (delimiterIndex === -1) {
    return null;
  }
  const headerBlock = buffer.subarray(0, delimiterIndex).toString("ascii");
  const contentLength = readContentLength(headerBlock);
  if (contentLength === null) {
    throw new LspFrameRejectError("MALFORMED_HEADER");
  }
  return { contentLength, headerEndIndex: delimiterIndex + HEADER_DELIMITER.length };
}

// Scans the header block lines for a parseable Content-Length. Other header lines (LSP allows an
// optional Content-Type) are ignored; absence of a valid Content-Length is malformed.
function readContentLength(headerBlock: string): number | null {
  const lines = headerBlock.split(HEADER_LINE_DELIMITER);
  for (const line of lines) {
    const parsed = parseLspFrameHeader(line);
    if (parsed !== null) {
      return parsed.contentLength;
    }
  }
  return null;
}

// Reads framed bodies from a byte source, yielding one Buffer per frame. Async-generator semantics
// give natural backpressure: a frame is yielded only once its full body is buffered, and the next
// source pull happens when the consumer requests the next frame.
export async function* createLspFrameReader(
  source: LspByteSource,
  maxFrameBytes: number,
): AsyncGenerator<LspBytes, void, void> {
  let buffer: LspBytes = Buffer.alloc(0);
  for await (const chunk of source) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    let frame = takeFrame(buffer, maxFrameBytes);
    while (frame !== null) {
      yield frame.body;
      buffer = frame.rest;
      frame = takeFrame(buffer, maxFrameBytes);
    }
  }
}

interface TakenFrame {
  readonly body: LspBytes;
  readonly rest: LspBytes;
}

// Attempts to slice one complete frame from the head of the buffer. Returns null when either the
// header terminator or the full declared body is not yet present. Enforces the oversized cap at the
// header boundary, before any body byte is required (ADR-0069 I3).
function takeFrame(buffer: LspBytes, maxFrameBytes: number): TakenFrame | null {
  const header = parseHeader(buffer);
  if (header === null) {
    return null;
  }
  if (header.contentLength > maxFrameBytes) {
    throw new LspFrameRejectError("RESPONSE_TOO_LARGE");
  }
  const bodyEnd = header.headerEndIndex + header.contentLength;
  if (buffer.length < bodyEnd) {
    return null;
  }
  return {
    body: buffer.subarray(header.headerEndIndex, bodyEnd),
    rest: buffer.subarray(bodyEnd),
  };
}

// Minimal writable sink: the codec only needs to push a fully-assembled frame buffer. Kept structural
// so the fake harness can supply a PassThrough without a Node Writable type dependency at the seam.
export interface LspByteSink {
  write(chunk: Buffer): void;
}

// Serializes a JSON-RPC body string as one LSP base-protocol frame: an ASCII Content-Length header
// (byte length of the UTF-8 body, not the string length) followed by `\r\n\r\n` and the body bytes.
export function writeLspFrame(sink: LspByteSink, body: string): void {
  const bodyBytes = Buffer.from(body, "utf8");
  const header = Buffer.from(`Content-Length: ${String(bodyBytes.length)}\r\n\r\n`, "ascii");
  sink.write(Buffer.concat([header, bodyBytes]));
}
