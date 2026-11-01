// Every part of an OOXML package as raw bytes, under the same bounded reader the docx, xlsx and
// pptx parsers use (#4176). The text extractors read only the parts that carry a document's body;
// a caller that must vouch for the whole package (a Jira attachment leaving the machine) needs
// the comments, headers, embedded media and any other entry as well, so this reads all of them.

import type { Buffer } from "node:buffer";

import { buildParserOptions } from "./parsers/registry.js";
import { classifyOoxmlZipError, readOoxmlZipEntryBytes } from "./parsers/ooxml-zip.js";

export interface BoundedOoxmlPackageOptions {
  /** Refuse a package larger than this before opening it. */
  readonly maxInputBytes: number;
  /** Ceiling on the number of entries in the central directory. */
  readonly maxEntries: number;
  /** Ceiling on all inflated parts together; one part is bounded by the same value. */
  readonly maxInflatedBytes: number;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}

export type BoundedOoxmlPackageResult =
  | { readonly ok: true; readonly parts: ReadonlyMap<string, Buffer> }
  | { readonly ok: false; readonly reason: "oversized" | "budget" | "cancelled" | "malformed" };

/** Inflate every part of the package, or name why the package cannot be read whole. */
export async function readBoundedOoxmlPackage(
  bytes: Uint8Array,
  options: BoundedOoxmlPackageOptions,
): Promise<BoundedOoxmlPackageResult> {
  if (bytes.byteLength > options.maxInputBytes) return { ok: false, reason: "oversized" };
  const parserOptions = buildParserOptions({
    maxBytes: options.maxInputBytes,
    timeoutMs: options.timeoutMs,
    now: options.now,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    const parts = await readOoxmlZipEntryBytes(bytes, parserOptions, options.now(), {
      format: "ooxml",
      isWanted: () => true,
      maxEntries: options.maxEntries,
      maxEntryInflatedBytes: options.maxInflatedBytes,
      maxTotalInflatedBytes: options.maxInflatedBytes,
    });
    return { ok: true, parts };
  } catch (error) {
    return { ok: false, reason: classifyOoxmlZipError(error) };
  }
}
