// Byte-level LSP base-protocol codec (Issue #1381, Epic #1491, ADR-0069 D3/I3). The reader consumes
// raw stdout chunks, splits `Content-Length: N\r\n\r\n` + exactly N bytes, and yields frame body
// buffers. It works purely at the Buffer level: headers are ASCII, but bodies are decoded as JSON
// only by the caller after exactly N bytes are accumulated, so a multi-byte UTF-8 sequence that
// straddles a chunk boundary is never split mid-character.
//
// ADR-0069 I3 (stream boundaries never buffer an oversized body): when the declared Content-Length
// exceeds `maxFrameBytes` the reader rejects the frame BEFORE reading the body and never accumulates
// the oversized payload. A missing or garbled header is rejected as MALFORMED_HEADER. The pre-header
// region is itself capped at `MAX_HEADER_BYTES` so a server that floods bytes WITHOUT ever sending a
// `\r\n\r\n` terminator cannot grow the accumulation buffer unbounded (OOM); such a stream is rejected
// as MALFORMED_HEADER. Incoming chunks accumulate in a list and are concatenated at most once per
// yielded frame, so a large body arriving in many small chunks costs O(n) total copy, not O(n^2).

import { parseLspFrameHeader } from "@oscharko-dev/keiko-contracts";
import type { LspFrameRejectReason } from "@oscharko-dev/keiko-contracts";

const HEADER_DELIMITER = Buffer.from("\r\n\r\n", "ascii");
const HEADER_LINE_DELIMITER = "\r\n";

// Per LSP-norm header bound: a well-formed `Content-Length` (+ optional `Content-Type`) header block
// is far under 8 KiB. Capping the pre-terminator region at this constant (independent of the body cap
// `maxFrameBytes`, which governs the declared body) means a delimiter-less flood is rejected promptly
// instead of accumulating without limit. 8192 is the conventional LSP base-protocol header ceiling.
const MAX_HEADER_BYTES = 8192;

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
//
// Accumulation is a list of chunks plus a running byte total; the list is concatenated into a single
// contiguous buffer only when a header terminator is present (so a complete header+body frame can be
// sliced). A large body delivered in many small chunks therefore incurs one O(n) concat at yield time
// rather than an O(n^2) concat-on-every-chunk. Before any terminator arrives, the accumulated size is
// bounded by `MAX_HEADER_BYTES`; exceeding it without a terminator is a MALFORMED_HEADER reject.
export async function* createLspFrameReader(
  source: LspByteSource,
  maxFrameBytes: number,
): AsyncGenerator<LspBytes, void, void> {
  const pending = createPendingBuffer();
  for await (const chunk of source) {
    pending.push(chunk);
    yield* drainFrames(pending, maxFrameBytes);
  }
}

const EMPTY = Buffer.alloc(0);

// Accumulates incoming chunks without a full concat per chunk. It tracks the running byte total and an
// incremental scan offset for the `\r\n\r\n` terminator: each push scans only the freshly-arrived
// region (plus a 3-byte overlap so a terminator straddling two chunks is still found), never rescanning
// settled bytes. The contiguous buffer is materialized lazily via `coalesce()` only when a terminator
// is known to be present, so the single concat cost is O(total) once per frame, not O(n^2).
interface PendingBuffer {
  push(chunk: LspBytes): void;
  // The total accumulated, not-yet-yielded byte count across all buffered chunks.
  byteLength(): number;
  // True once a `\r\n\r\n` terminator is present anywhere in the accumulated bytes.
  hasHeaderDelimiter(): boolean;
  // Concatenates the buffered chunks into one contiguous buffer and returns it. O(total bytes);
  // called at most once per frame slice, only after `hasHeaderDelimiter()` is true.
  coalesce(): LspBytes;
  // Replaces the buffered chunks with a single trailing remainder (the bytes after a sliced frame).
  reset(rest: LspBytes): void;
}

const DELIMITER_OVERLAP = HEADER_DELIMITER.length - 1;

function createPendingBuffer(): PendingBuffer {
  let chunks: LspBytes[] = [];
  let totalBytes = 0;
  let delimiterFound = false;
  // The last `DELIMITER_OVERLAP` bytes of already-scanned data, retained so a terminator straddling a
  // chunk boundary is detected by scanning only `tail + newChunk` — never a full re-concat (O(n)).
  let tail: LspBytes = EMPTY;

  const scanIncoming = (chunk: LspBytes): void => {
    const window = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
    if (window.includes(HEADER_DELIMITER)) {
      delimiterFound = true;
      return;
    }
    tail = window.subarray(Math.max(0, window.length - DELIMITER_OVERLAP));
  };

  return {
    push: (chunk): void => {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (!delimiterFound) {
        scanIncoming(chunk);
      }
    },
    byteLength: (): number => totalBytes,
    hasHeaderDelimiter: (): boolean => delimiterFound,
    coalesce: (): LspBytes => (chunks.length === 1 ? (chunks[0] ?? EMPTY) : Buffer.concat(chunks)),
    reset: (rest): void => {
      chunks = rest.length === 0 ? [] : [rest];
      totalBytes = rest.length;
      tail = EMPTY;
      delimiterFound = rest.includes(HEADER_DELIMITER);
    },
  };
}

// Rejects a delimiter-less accumulation that has grown past the header cap (ADR-0069 I3): a server
// that floods bytes without ever sending `\r\n\r\n` would otherwise grow the buffer unbounded.
function guardHeaderBound(pending: PendingBuffer): void {
  if (!pending.hasHeaderDelimiter() && pending.byteLength() > MAX_HEADER_BYTES) {
    throw new LspFrameRejectError("MALFORMED_HEADER");
  }
}

interface TakenFrame {
  readonly body: LspBytes;
  readonly rest: LspBytes;
}

// Attempts to slice one complete frame from the head of the buffer. Returns null when the full
// declared body is not yet present. Enforces the oversized cap at the header boundary, before any
// body byte is required (ADR-0069 I3). The caller only invokes this once a terminator is present, so
// `parseHeader` never returns null here.
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

// Slices every complete frame currently buffered, yielding each body. Enforces the header cap on the
// no-terminator path before coalescing, so a delimiter-less flood is rejected without an unbounded
// concat. Stops when neither a full header nor a full body is yet available (awaiting more chunks).
function* drainFrames(
  pending: PendingBuffer,
  maxFrameBytes: number,
): Generator<LspBytes, void, void> {
  for (;;) {
    if (!pending.hasHeaderDelimiter()) {
      guardHeaderBound(pending);
      return;
    }
    const frame = takeFrame(pending.coalesce(), maxFrameBytes);
    if (frame === null) {
      return;
    }
    pending.reset(frame.rest);
    yield frame.body;
  }
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
