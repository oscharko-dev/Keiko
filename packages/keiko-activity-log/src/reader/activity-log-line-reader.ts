// Bounded-memory line iteration over one Activity Log artifact (#3531).
//
// `keiko support analyze`, `query`, the segment manifests and selective export never load a whole
// file: they pull lines through this reader, which holds one fixed read chunk plus at most one
// pending line. A persisted Activity Log line is at most 8 KiB (`MAX_LOG_LINE_BYTES`), so a line
// longer than `MAX_ACTIVITY_LOG_READ_LINE_BYTES` can only be hostile or foreign input: its bytes are
// counted but never buffered, and it is yielded as an empty line, which every consumer classifies as
// corrupt (or truncated, when it is the unterminated tail). Lines split on the newline byte, which
// never occurs inside a multi-byte UTF-8 sequence, and each line is decoded once, whole.

import { closeSync, readSync } from "node:fs";
import type { ActivityLogTextLine } from "./support-analyze.js";
import { describeErrorKind } from "./error-kind.js";

export const ACTIVITY_LOG_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_ACTIVITY_LOG_READ_LINE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

// Scanning retained segments is sequential, but allocating one native read buffer per file leaves
// those buffers for a later GC and needlessly raises peak RSS. Keep at most one default-sized buffer
// between scans. A concurrently active reader simply allocates its own buffer and offers it back
// when done; custom chunk sizes are never retained.
let pooledReadChunk: Buffer | undefined;

function acquireReadChunk(chunkBytes: number | undefined): {
  readonly chunk: Buffer;
  readonly reusable: boolean;
} {
  if (chunkBytes !== undefined && chunkBytes !== ACTIVITY_LOG_READ_CHUNK_BYTES) {
    return { chunk: Buffer.allocUnsafe(chunkBytes), reusable: false };
  }
  const chunk = pooledReadChunk ?? Buffer.allocUnsafe(ACTIVITY_LOG_READ_CHUNK_BYTES);
  pooledReadChunk = undefined;
  return { chunk, reusable: true };
}

function releaseReadChunk(chunk: Buffer, reusable: boolean): void {
  if (reusable && pooledReadChunk === undefined) pooledReadChunk = chunk;
}

export interface ActivityLogReadLine extends ActivityLogTextLine {
  // The line's own bytes, without its newline.
  readonly byteLength: number;
  // True when the line exceeded the line bound and its bytes were discarded.
  readonly oversized: boolean;
}

interface MutableActivityLogReadLine {
  text: string;
  terminated: boolean;
  byteLength: number;
  oversized: boolean;
}

export interface ActivityLogReadOptions {
  readonly chunkBytes?: number | undefined;
  readonly maxLineBytes?: number | undefined;
  // Observes every raw chunk, in order, before its lines are yielded (manifest digests, metrics).
  readonly onChunk?: ((chunk: Uint8Array) => void) | undefined;
}

/**
 * A failure to open or read the artifact, distinct from any error a consumer of the lines raises.
 * `causeKind` is the closed, content-free diagnosis (`describeErrorKind`): never a message or path.
 */
export class ActivityLogReadError extends Error {
  public override readonly name = "ActivityLogReadError";
  public readonly causeKind: string;

  public constructor(cause: unknown) {
    super("Activity Log read failed");
    this.causeKind = describeErrorKind(cause);
  }
}

class PendingLine {
  private parts: Buffer[] = [];
  private bytes = 0;
  private discarded = false;

  public constructor(private readonly maxBytes: number) {}

  public append(part: Buffer, copy: boolean): void {
    if (part.length === 0) return;
    this.bytes += part.length;
    if (this.discarded) return;
    if (this.bytes > this.maxBytes) {
      this.discarded = true;
      this.parts = [];
      return;
    }
    this.parts.push(copy ? Buffer.from(part) : part);
  }

  public get empty(): boolean {
    return this.bytes === 0;
  }

  public take(terminated: boolean): ActivityLogReadLine {
    const line: MutableActivityLogReadLine = {
      text: "",
      terminated,
      byteLength: 0,
      oversized: false,
    };
    this.takeInto(line, terminated);
    return line;
  }

  public takeInto(line: MutableActivityLogReadLine, terminated: boolean): void {
    line.text =
      this.discarded || this.parts.length === 0
        ? ""
        : this.parts.length === 1
          ? (this.parts[0]?.toString("utf8") ?? "")
          : Buffer.concat(this.parts, this.bytes).toString("utf8");
    line.terminated = terminated;
    line.byteLength = this.bytes;
    line.oversized = this.discarded;
    this.parts = [];
    this.bytes = 0;
    this.discarded = false;
  }
}

function readChunk(descriptor: number, chunk: Buffer, position: number): number {
  try {
    return readSync(descriptor, chunk, 0, chunk.length, position);
  } catch (error) {
    throw new ActivityLogReadError(error);
  }
}

class DescriptorLineCursor {
  private readonly chunk: Buffer;
  private readonly reusable: boolean;
  private readonly maxLineBytes: number;
  private readonly pending: PendingLine;
  private position = 0;
  private view: Buffer | undefined;
  private start = 0;
  private closed = false;

  public constructor(
    private readonly descriptor: number,
    private readonly options: ActivityLogReadOptions,
  ) {
    const acquired = acquireReadChunk(options.chunkBytes);
    this.chunk = acquired.chunk;
    this.reusable = acquired.reusable;
    this.maxLineBytes = options.maxLineBytes ?? MAX_ACTIVITY_LOG_READ_LINE_BYTES;
    this.pending = new PendingLine(this.maxLineBytes);
  }

  public next(): ActivityLogReadLine | undefined {
    const line: MutableActivityLogReadLine = {
      text: "",
      terminated: false,
      byteLength: 0,
      oversized: false,
    };
    return this.nextInto(line) ? line : undefined;
  }

  public nextInto(line: MutableActivityLogReadLine): boolean {
    while (!this.closed) {
      if (this.view !== undefined) {
        const newline = this.view.indexOf(NEWLINE, this.start);
        if (newline >= 0) {
          const byteLength = newline - this.start;
          if (this.pending.empty && byteLength <= this.maxLineBytes) {
            // Most persisted lines are wholly inside one chunk. Decode that byte range directly so
            // the hot path creates neither a Buffer view nor a one-element pending-parts array.
            line.text = this.view.toString("utf8", this.start, newline);
            line.terminated = true;
            line.byteLength = byteLength;
            line.oversized = false;
          } else {
            // A line completed across chunks (or exceeded the configured bound) still needs the
            // bounded pending-line state before the read buffer may be reused.
            this.pending.append(this.view.subarray(this.start, newline), false);
            this.pending.takeInto(line, true);
          }
          this.start = newline + 1;
          return true;
        }
        this.pending.append(this.view.subarray(this.start), true);
      }

      const count = readChunk(this.descriptor, this.chunk, this.position);
      if (count === 0) {
        this.close();
        if (this.pending.empty) return false;
        this.pending.takeInto(line, false);
        return true;
      }
      this.position += count;
      this.view = this.chunk.subarray(0, count);
      this.start = 0;
      this.options.onChunk?.(this.view);
    }
    return false;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    releaseReadChunk(this.chunk, this.reusable);
  }
}

/**
 * Yields every line of an open descriptor, from offset 0, in order. The final line is yielded with
 * `terminated: false` when the file does not end in a newline (a torn tail). The caller owns the
 * descriptor.
 */
export function* readDescriptorLines(
  descriptor: number,
  options: ActivityLogReadOptions = {},
): Generator<ActivityLogReadLine> {
  const cursor = new DescriptorLineCursor(descriptor, options);
  try {
    for (let line = cursor.next(); line !== undefined; line = cursor.next()) yield line;
  } finally {
    cursor.close();
  }
}

/** Consumes every line while reusing the callback value for the manifest-only drain path. */
function consumeDescriptorLines(
  descriptor: number,
  consume: (line: ActivityLogReadLine) => void,
  options: ActivityLogReadOptions = {},
): void {
  const cursor = new DescriptorLineCursor(descriptor, options);
  const line: MutableActivityLogReadLine = {
    text: "",
    terminated: false,
    byteLength: 0,
    oversized: false,
  };
  try {
    while (cursor.nextInto(line)) consume(line);
  } finally {
    cursor.close();
  }
}

/** Opens with `open` (the caller's trust policy), yields every line, and always closes. */
export function* readActivityLogFileLines(
  open: () => number,
  options: ActivityLogReadOptions = {},
): Generator<ActivityLogReadLine> {
  let descriptor: number;
  try {
    descriptor = open();
  } catch (error) {
    throw new ActivityLogReadError(error);
  }
  try {
    yield* readDescriptorLines(descriptor, options);
  } finally {
    closeSync(descriptor);
  }
}

/** Opens, consumes and closes one file without allocating a line wrapper for every line. */
export function consumeActivityLogFileLines(
  open: () => number,
  consume: (line: ActivityLogReadLine) => void,
  options: ActivityLogReadOptions = {},
): void {
  let descriptor: number;
  try {
    descriptor = open();
  } catch (error) {
    throw new ActivityLogReadError(error);
  }
  try {
    consumeDescriptorLines(descriptor, consume, options);
  } finally {
    closeSync(descriptor);
  }
}
