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
import { describeErrorKind } from "./support-export.js";

export const ACTIVITY_LOG_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_ACTIVITY_LOG_READ_LINE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export interface ActivityLogReadLine extends ActivityLogTextLine {
  // The line's own bytes, without its newline.
  readonly byteLength: number;
  // True when the line exceeded the line bound and its bytes were discarded.
  readonly oversized: boolean;
}

export interface ActivityLogReadOptions {
  readonly chunkBytes?: number | undefined;
  readonly maxLineBytes?: number | undefined;
  // Observes every chunk read; used by tests and budget accounting, never for content.
  readonly onChunk?: ((bytes: number) => void) | undefined;
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
    const line: ActivityLogReadLine = {
      text: this.discarded ? "" : Buffer.concat(this.parts, this.bytes).toString("utf8"),
      terminated,
      byteLength: this.bytes,
      oversized: this.discarded,
    };
    this.parts = [];
    this.bytes = 0;
    this.discarded = false;
    return line;
  }
}

function readChunk(descriptor: number, chunk: Buffer, position: number): number {
  try {
    return readSync(descriptor, chunk, 0, chunk.length, position);
  } catch (error) {
    throw new ActivityLogReadError(error);
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
  const chunk = Buffer.allocUnsafe(options.chunkBytes ?? ACTIVITY_LOG_READ_CHUNK_BYTES);
  const pending = new PendingLine(options.maxLineBytes ?? MAX_ACTIVITY_LOG_READ_LINE_BYTES);
  let position = 0;
  for (let count = readChunk(descriptor, chunk, position); count > 0;) {
    position += count;
    options.onChunk?.(count);
    const view = chunk.subarray(0, count);
    let start = 0;
    for (let newline = view.indexOf(NEWLINE, start); newline >= 0;) {
      // A line completed inside this chunk is decoded before the chunk is reused: no copy needed.
      pending.append(view.subarray(start, newline), false);
      yield pending.take(true);
      start = newline + 1;
      newline = view.indexOf(NEWLINE, start);
    }
    pending.append(view.subarray(start), true);
    count = readChunk(descriptor, chunk, position);
  }
  if (!pending.empty) yield pending.take(false);
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
