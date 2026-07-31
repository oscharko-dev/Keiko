import { createHash, type Hash } from "node:crypto";

export const CODING_RUNTIME_MAX_LINE_BYTES = 8 * 1024;
const CODING_RUNTIME_MAX_SUMMARY_BYTES = 1_073_741_824;
const CODING_RUNTIME_MAX_SUMMARY_LINES = 1_000_000;

export type CodingRuntimeProcessIoFailure = "callback-failed" | "line-oversized" | "utf8-invalid";
export type CodingRuntimeProcessIoResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: CodingRuntimeProcessIoFailure };

export interface CodingRuntimeLineParser {
  push(chunk: Buffer | string): CodingRuntimeProcessIoResult;
  finish(): CodingRuntimeProcessIoResult;
}

export interface CodingRuntimeLineParserOptions {
  readonly onLine: (line: string) => void;
  readonly maxLineBytes?: number | undefined;
}

export interface CodingRuntimeStderrSummary {
  readonly bytes: number;
  readonly lines: number;
  readonly truncated: boolean;
  readonly overflowed: boolean;
}

export interface CodingRuntimeStderrDrainer {
  push(chunk: Buffer | string): void;
  snapshot(): CodingRuntimeStderrSummary;
}

export interface CodingRuntimeStderrDrainerOptions {
  readonly maxBytes?: number | undefined;
  readonly maxLines?: number | undefined;
  readonly summaryIntervalBytes?: number | undefined;
  readonly onSummary?: ((summary: CodingRuntimeStderrSummary) => void) | undefined;
}

export interface CodingRuntimeProcessSummary {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface CodingRuntimeProcessSummaryAccumulator {
  readonly push: (chunk: Buffer | string) => void;
  readonly snapshot: () => CodingRuntimeProcessSummary;
}

/** Retains no process body: only saturating counts and an incremental SHA-256 digest. */
export function createCodingRuntimeProcessSummaryAccumulator(): CodingRuntimeProcessSummaryAccumulator {
  let byteCount = 0;
  let lineCount = 0;
  let truncated = false;
  const hash: Hash = createHash("sha256");
  return {
    push(chunk): void {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      hash.update(value);
      const bytes = saturatingCount(byteCount, value.length, CODING_RUNTIME_MAX_SUMMARY_BYTES);
      const lines = saturatingCount(
        lineCount,
        countNewlines(value),
        CODING_RUNTIME_MAX_SUMMARY_LINES,
      );
      byteCount = bytes.value;
      lineCount = lines.value;
      truncated ||= bytes.truncated || lines.truncated;
    },
    snapshot(): CodingRuntimeProcessSummary {
      return { byteCount, lineCount, sha256: hash.copy().digest("hex"), truncated };
    },
  };
}

const DEFAULT_STDERR_MAX_BYTES = 1024 * 1024;
const DEFAULT_STDERR_MAX_LINES = 16 * 1024;
const DEFAULT_STDERR_SUMMARY_INTERVAL_BYTES = 64 * 1024;

export function createCodingRuntimeLineParser(
  options: CodingRuntimeLineParserOptions,
): CodingRuntimeLineParser {
  return new BoundedLineParser(options.onLine, boundedLimit(options.maxLineBytes));
}

export function createCodingRuntimeStderrDrainer(
  options: CodingRuntimeStderrDrainerOptions = {},
): CodingRuntimeStderrDrainer {
  return new CountOnlyStderrDrainer(
    boundedLimit(options.maxBytes, DEFAULT_STDERR_MAX_BYTES),
    boundedLimit(options.maxLines, DEFAULT_STDERR_MAX_LINES),
    boundedLimit(options.summaryIntervalBytes, DEFAULT_STDERR_SUMMARY_INTERVAL_BYTES),
    options.onSummary,
  );
}

class BoundedLineParser implements CodingRuntimeLineParser {
  private partial = Buffer.alloc(0);
  private failure: CodingRuntimeProcessIoFailure | undefined;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineBytes: number,
  ) {}

  push(chunk: Buffer | string): CodingRuntimeProcessIoResult {
    if (this.failure !== undefined) return failed(this.failure);
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let offset = 0;
    while (offset < input.length) {
      const newline = input.indexOf(0x0a, offset);
      if (newline < 0) return this.append(input.subarray(offset), false);
      const result = this.append(input.subarray(offset, newline), true);
      if (!result.ok) return result;
      offset = newline + 1;
    }
    return { ok: true };
  }

  finish(): CodingRuntimeProcessIoResult {
    if (this.failure !== undefined) return failed(this.failure);
    if (this.partial.length === 0) return { ok: true };
    return this.emitPartial();
  }

  private append(segment: Buffer, complete: boolean): CodingRuntimeProcessIoResult {
    const size = this.partial.length + segment.length;
    if (size > this.maxLineBytes) return this.reject("line-oversized");
    this.partial = size === 0 ? Buffer.alloc(0) : Buffer.concat([this.partial, segment], size);
    return complete ? this.emitPartial() : { ok: true };
  }

  private emitPartial(): CodingRuntimeProcessIoResult {
    const line = this.partial;
    this.partial = Buffer.alloc(0);
    const decoded = decodeUtf8(line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
    if (decoded === undefined) return this.reject("utf8-invalid");
    try {
      this.onLine(decoded);
      return { ok: true };
    } catch {
      return this.reject("callback-failed");
    }
  }

  private reject(reason: CodingRuntimeProcessIoFailure): CodingRuntimeProcessIoResult {
    this.partial = Buffer.alloc(0);
    this.failure = reason;
    return failed(reason);
  }
}

class CountOnlyStderrDrainer implements CodingRuntimeStderrDrainer {
  private bytes = 0;
  private lines = 0;
  private truncated = false;
  private overflowed = false;
  private bytesSinceSummary = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number,
    private readonly summaryIntervalBytes: number,
    private readonly onSummary: ((summary: CodingRuntimeStderrSummary) => void) | undefined,
  ) {}

  push(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
    const lines = countNewlines(chunk);
    this.bytes = this.addCount(this.bytes, bytes, this.maxBytes);
    this.lines = this.addCount(this.lines, lines, this.maxLines);
    this.bytesSinceSummary = Math.min(this.summaryIntervalBytes, this.bytesSinceSummary + bytes);
    if (this.bytesSinceSummary === this.summaryIntervalBytes) this.emitSummary();
  }

  snapshot(): CodingRuntimeStderrSummary {
    return {
      bytes: this.bytes,
      lines: this.lines,
      truncated: this.truncated,
      overflowed: this.overflowed,
    };
  }

  private addCount(current: number, increment: number, maximum: number): number {
    if (increment < maximum - current) return current + increment;
    this.truncated = true;
    if (increment > maximum - current) this.overflowed = true;
    return maximum;
  }

  private emitSummary(): void {
    this.bytesSinceSummary = 0;
    try {
      this.onSummary?.(this.snapshot());
    } catch {
      // Diagnostics are advisory; retaining or replaying stderr would violate the drain boundary.
    }
  }
}

function boundedLimit(value: number | undefined, fallback = CODING_RUNTIME_MAX_LINE_BYTES): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1)
    throw new TypeError("process-io-limit-invalid");
  return resolved;
}

function decodeUtf8(value: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function failed(reason: CodingRuntimeProcessIoFailure): CodingRuntimeProcessIoResult {
  return { ok: false, reason };
}

function countNewlines(chunk: Buffer | string): number {
  let count = 0;
  for (const value of chunk) if (value === 0x0a || value === "\n") count += 1;
  return count;
}

function saturatingCount(
  current: number,
  increment: number,
  maximum: number,
): { readonly value: number; readonly truncated: boolean } {
  const available = maximum - current;
  return increment > available
    ? { value: maximum, truncated: true }
    : { value: current + increment, truncated: false };
}
