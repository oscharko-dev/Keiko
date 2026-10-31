// Bounded OOXML package reader shared by presentation-style parsers. It carries the same
// guards the docx/xlsx adapters apply to their packages: input stays in memory, every inflated
// entry is capped by size and compression ratio, the central-directory walk honours the entry
// count, the deadline and the caller's abort signal, and an archive that lists the same wanted
// part twice is rejected instead of guessing which one is authoritative.

import { Buffer } from "node:buffer";

import yauzl from "yauzl";

import type { ParserOptions } from "./types.js";

const OOXML_SCAN_BUDGET_EXCEEDED = Symbol("keiko:ooxml:scanBudgetExceeded");
const OOXML_SCAN_CANCELLED = Symbol("keiko:ooxml:scanCancelled");
const MAX_INFLATE_RATIO = 100;

export interface OoxmlZipReadPlan {
  /** Short format label used in error messages (no content). */
  readonly format: string;
  /** Selects the entries to inflate; every other entry is skipped without decompression. */
  readonly isWanted: (entryName: string) => boolean;
  /** Ceiling on central-directory entries walked before the scan gives up. */
  readonly maxEntries: number;
  /** Ceiling on one inflated entry. */
  readonly maxEntryInflatedBytes: number;
  /** Ceiling on all inflated entries together. */
  readonly maxTotalInflatedBytes: number;
}

export type OoxmlZipFailure = "budget" | "cancelled" | "malformed";

interface ScanLimits {
  readonly plan: OoxmlZipReadPlan;
  readonly options: ParserOptions;
  readonly startedAt: number;
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function markedError(message: string, marker: symbol): Error {
  const error = new Error(message);
  Object.defineProperty(error, marker, { value: true, enumerable: false });
  return error;
}

function hasMarker(error: unknown, marker: symbol): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<PropertyKey, unknown>)[marker] === true
  );
}

/** Maps a reader failure onto the diagnostic family the caller should emit. */
export function classifyOoxmlZipError(error: unknown): OoxmlZipFailure {
  if (hasMarker(error, OOXML_SCAN_CANCELLED)) return "cancelled";
  if (hasMarker(error, OOXML_SCAN_BUDGET_EXCEEDED)) return "budget";
  return "malformed";
}

/** Per-entry inflated ceiling derived from the caller's input byte budget. */
export function ooxmlEntryInflatedLimit(maxInputBytes: number, hardCeiling: number): number {
  return Math.min(hardCeiling, Math.max(1, Math.floor(maxInputBytes)) * 10);
}

function openZip(bytes: Uint8Array, format: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, decodeStrings: true },
      (error, zip) => {
        if (error !== null) {
          reject(toError(error, `failed to open ${format} zip`));
          return;
        }
        resolve(zip);
      },
    );
  });
}

function closeZipQuietly(zip: yauzl.ZipFile): void {
  try {
    zip.close();
  } catch {
    // Close failures are non-fatal during parser cleanup.
  }
}

function assertEntryDeclaredSize(entry: yauzl.Entry, plan: OoxmlZipReadPlan, total: number): void {
  if (entry.uncompressedSize > plan.maxEntryInflatedBytes) {
    throw new Error(`${plan.format} entry inflated size exceeds limit`);
  }
  if (total + entry.uncompressedSize > plan.maxTotalInflatedBytes) {
    throw new Error(`${plan.format} package inflated size exceeds limit`);
  }
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_INFLATE_RATIO
  ) {
    throw new Error(`${plan.format} entry compression ratio exceeds limit`);
  }
}

function scanStop(limits: ScanLimits, entriesSeen: number): Error | undefined {
  const { plan, options, startedAt } = limits;
  if (options.signal?.aborted === true) {
    return markedError(`${plan.format} zip scan cancelled`, OOXML_SCAN_CANCELLED);
  }
  if (entriesSeen > plan.maxEntries) {
    return markedError(
      `${plan.format} zip scan exceeded entry ceiling`,
      OOXML_SCAN_BUDGET_EXCEEDED,
    );
  }
  if (options.now() - startedAt > options.timeoutMs) {
    return markedError(`${plan.format} zip scan exceeded deadline`, OOXML_SCAN_BUDGET_EXCEEDED);
  }
  return undefined;
}

function destroyStream(readStream: NodeJS.ReadableStream, error: Error): void {
  const destroy = (readStream as { readonly destroy?: (cause?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(readStream, error);
  }
}

function readEntryText(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  plan: OoxmlZipReadPlan,
  remainingTotal: number,
): Promise<string> {
  const ceiling = Math.min(plan.maxEntryInflatedBytes, remainingTotal);
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(toError(error, `failed to open ${plan.format} entry stream`));
        return;
      }
      const readStream = stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      let inflatedBytes = 0;
      let settled = false;
      const rejectOnce = (streamError: Error): void => {
        if (settled) return;
        settled = true;
        reject(streamError);
        destroyStream(readStream, streamError);
      };
      readStream.on("data", (chunk: Buffer) => {
        if (settled) return;
        inflatedBytes += chunk.byteLength;
        if (inflatedBytes > ceiling) {
          rejectOnce(new Error(`${plan.format} inflated stream exceeds limit`));
          return;
        }
        chunks.push(chunk);
      });
      readStream.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      readStream.on("error", rejectOnce);
    });
  });
}

interface ScanProgress {
  readonly parts: Map<string, string>;
  entriesSeen: number;
  totalInflated: number;
}

async function inflateWantedEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  plan: OoxmlZipReadPlan,
  progress: ScanProgress,
): Promise<void> {
  if (progress.parts.has(entry.fileName)) {
    throw new Error(`${plan.format} package lists a part twice`);
  }
  assertEntryDeclaredSize(entry, plan, progress.totalInflated);
  const remaining = plan.maxTotalInflatedBytes - progress.totalInflated;
  const text = await readEntryText(zip, entry, plan, remaining);
  progress.totalInflated += Buffer.byteLength(text, "utf8");
  progress.parts.set(entry.fileName, text);
}

function walkEntries(zip: yauzl.ZipFile, limits: ScanLimits): Promise<ReadonlyMap<string, string>> {
  const { plan } = limits;
  return new Promise((resolve, reject) => {
    const progress: ScanProgress = { parts: new Map(), entriesSeen: 0, totalInflated: 0 };
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve(progress.parts);
      else reject(error);
    };
    const handleEntry = async (entry: yauzl.Entry): Promise<void> => {
      progress.entriesSeen += 1;
      const stop = scanStop(limits, progress.entriesSeen);
      if (stop !== undefined) {
        finish(stop);
        return;
      }
      try {
        if (plan.isWanted(entry.fileName)) await inflateWantedEntry(zip, entry, plan, progress);
        zip.readEntry();
      } catch (error) {
        finish(toError(error, `failed to read ${plan.format} entry`));
      }
    };
    zip.on("entry", (entry: yauzl.Entry) => {
      void handleEntry(entry);
    });
    zip.once("end", () => {
      finish();
    });
    zip.once("error", (error: unknown) => {
      finish(toError(error, `failed to read ${plan.format} zip`));
    });
    zip.readEntry();
  });
}

/**
 * Inflates the wanted parts of an OOXML package into memory, keyed by part name. Throws on a
 * malformed archive, an exceeded inflate bound, an exhausted scan budget or a caller abort;
 * {@link classifyOoxmlZipError} names which.
 */
export async function readOoxmlZipEntries(
  bytes: Uint8Array,
  options: ParserOptions,
  startedAt: number,
  plan: OoxmlZipReadPlan,
): Promise<ReadonlyMap<string, string>> {
  const zip = await openZip(bytes, plan.format);
  try {
    return await walkEntries(zip, { plan, options, startedAt });
  } finally {
    closeZipQuietly(zip);
  }
}
