// The one bounded OOXML package reader, shared by the docx, xlsx and pptx parsers. Input stays in
// memory and every inflated entry is capped by size and compression ratio. Unless a plan opts
// out, the central-directory walk honours the entry count, the deadline and the caller's abort
// signal, the inflated total is capped, and an archive that lists the same wanted part twice is
// rejected instead of guessing which one is authoritative.

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
  /** Ceiling on central-directory entries walked before the scan gives up; absent = unbounded. */
  readonly maxEntries?: number;
  /** Ceiling on one inflated entry. */
  readonly maxEntryInflatedBytes: number;
  /** Ceiling on all inflated entries together; absent = only the per-entry ceiling applies. */
  readonly maxTotalInflatedBytes?: number;
  /**
   * Whether the central-directory walk honours the caller's deadline and abort signal between
   * entries. Defaults to `enforced`; `none` leaves the walk uncooperative.
   */
  readonly scanBudget?: "enforced" | "none";
  /**
   * What a second listing of a wanted part does: `reject` fails the read (default), `replace`
   * lets the later listing win.
   */
  readonly duplicateParts?: "reject" | "replace";
}

// A password-protected Office file is not an OOXML ZIP package: Office wraps the encrypted package
// in a Compound File Binary (OLE2) container whose 8-byte signature is D0 CF 11 E0 A1 B1 1A E1.
const OLE_COMPOUND_FILE_SIGNATURE: readonly number[] = [
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
];

/**
 * True when the bytes open with the OLE2 compound-file signature, which is how Office stores a
 * password-protected docx, xlsx or pptx. Such a file has no readable ZIP directory, so callers
 * name it as encrypted instead of reporting a generic malformed package. The signature alone
 * cannot tell an encrypted package from a legacy binary file saved under an OOXML extension; both
 * are unreadable here and both are refused.
 */
export function isEncryptedOoxmlContainer(bytes: Uint8Array): boolean {
  return (
    bytes.length >= OLE_COMPOUND_FILE_SIGNATURE.length &&
    OLE_COMPOUND_FILE_SIGNATURE.every((byte, index) => bytes[index] === byte)
  );
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

function assertEntryDeclaredSize(entry: yauzl.Entry, plan: OoxmlZipReadPlan, total: number): void {
  if (entry.uncompressedSize > plan.maxEntryInflatedBytes) {
    throw new Error(`${plan.format} entry inflated size exceeds limit`);
  }
  if (
    plan.maxTotalInflatedBytes !== undefined &&
    total + entry.uncompressedSize > plan.maxTotalInflatedBytes
  ) {
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
  if (plan.scanBudget === "none") return undefined;
  if (options.signal?.aborted === true) {
    return markedError(`${plan.format} zip scan cancelled`, OOXML_SCAN_CANCELLED);
  }
  if (plan.maxEntries !== undefined && entriesSeen > plan.maxEntries) {
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

function readEntryBytes(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  plan: OoxmlZipReadPlan,
  remainingTotal: number,
): Promise<Buffer> {
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
        resolve(Buffer.concat(chunks));
      });
      readStream.on("error", rejectOnce);
    });
  });
}

interface ScanProgress {
  readonly parts: Map<string, Buffer>;
  entriesSeen: number;
  totalInflated: number;
}

async function inflateWantedEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  plan: OoxmlZipReadPlan,
  progress: ScanProgress,
): Promise<void> {
  if (plan.duplicateParts !== "replace" && progress.parts.has(entry.fileName)) {
    throw new Error(`${plan.format} package lists a part twice`);
  }
  assertEntryDeclaredSize(entry, plan, progress.totalInflated);
  const remaining =
    plan.maxTotalInflatedBytes === undefined
      ? Number.POSITIVE_INFINITY
      : plan.maxTotalInflatedBytes - progress.totalInflated;
  const bytes = await readEntryBytes(zip, entry, plan, remaining);
  progress.totalInflated += bytes.byteLength;
  progress.parts.set(entry.fileName, bytes);
}

interface EntryWalk {
  readonly zip: yauzl.ZipFile;
  readonly limits: ScanLimits;
  readonly progress: ScanProgress;
  /** Claims the single settlement; false once the read already settled. */
  readonly claim: () => boolean;
}

async function walkEntry(
  walk: EntryWalk,
  entry: yauzl.Entry,
  reject: Parameters<ConstructorParameters<PromiseConstructor>[0]>[1],
): Promise<void> {
  const { zip, limits, progress } = walk;
  progress.entriesSeen += 1;
  const stop = scanStop(limits, progress.entriesSeen);
  if (stop !== undefined) {
    if (walk.claim()) reject(stop);
    return;
  }
  try {
    if (limits.plan.isWanted(entry.fileName)) {
      await inflateWantedEntry(zip, entry, limits.plan, progress);
    }
    zip.readEntry();
  } catch (error) {
    // The entry failure rejects the whole read; the parser classifies it.
    if (walk.claim()) reject(error);
  }
}

function walkEntries(zip: yauzl.ZipFile, limits: ScanLimits): Promise<ReadonlyMap<string, Buffer>> {
  const { plan } = limits;
  return new Promise((resolve, reject) => {
    const progress: ScanProgress = { parts: new Map(), entriesSeen: 0, totalInflated: 0 };
    let settled = false;
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };
    const walk: EntryWalk = { zip, limits, progress, claim };
    zip.on("entry", (entry: yauzl.Entry) => {
      void walkEntry(walk, entry, reject);
    });
    zip.once("end", () => {
      if (claim()) resolve(progress.parts);
    });
    zip.once("error", (error: unknown) => {
      if (claim()) reject(toError(error, `failed to read ${plan.format} zip`));
    });
    zip.readEntry();
  });
}

/**
 * Inflates the wanted parts of an OOXML package into memory as raw bytes, keyed by part name.
 * Throws on a malformed archive, an exceeded inflate bound, an exhausted scan budget or a caller
 * abort; {@link classifyOoxmlZipError} names which.
 */
export async function readOoxmlZipEntryBytes(
  bytes: Uint8Array,
  options: ParserOptions,
  startedAt: number,
  plan: OoxmlZipReadPlan,
): Promise<ReadonlyMap<string, Buffer>> {
  const zip = await openZip(bytes, plan.format);
  try {
    return await walkEntries(zip, { plan, options, startedAt });
  } finally {
    // A buffer-backed archive releases no descriptor; close only marks it closed.
    zip.close();
  }
}

/** {@link readOoxmlZipEntryBytes}, with every part decoded as UTF-8 text. */
export async function readOoxmlZipEntries(
  bytes: Uint8Array,
  options: ParserOptions,
  startedAt: number,
  plan: OoxmlZipReadPlan,
): Promise<ReadonlyMap<string, string>> {
  const parts = await readOoxmlZipEntryBytes(bytes, options, startedAt, plan);
  return new Map([...parts].map(([name, part]) => [name, part.toString("utf8")]));
}
