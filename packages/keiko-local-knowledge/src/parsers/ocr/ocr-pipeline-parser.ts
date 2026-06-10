// OCR pipeline parser (Epic #189, Issue #202). A `ParserAdapter` factory that wraps an
// `OcrAdapter`. The sync `parse` method always fires the unsupported-media diagnostic (the
// `ParserAdapter.parse` contract is synchronous and cannot await the OCR result). The async
// `parseAsync` method is the real entry point for callers that can await: when OCR succeeds
// it emits one `ParsedUnit { kind: "page" }` per recognised page; when OCR fails it fires
// the standard unsupported-media diagnostic consistent with unsupported-parser.ts (#266).
//
// No multi-page splitter ships yet — until a real splitter exists the input bytes are treated
// as page 1. That assumption is isolated here and collapses when a splitter is added.

import type { ParsedUnit, ParserResult } from "@oscharko-dev/keiko-contracts";

import { diagnostic, emptyResult, oversizeDiagnostic, shouldStop } from "../_internal.js";
import type { ParserAdapter, ParserCapability, ParserOptions, ParserSelectionInput } from "../types.js";
import type { OcrAdapter, OcrPageResult } from "./types.js";

const PARSER_ID = "ocr-pipeline";
const PARSER_VERSION = "1";

const OCR_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp",
]);

const OCR_MEDIA_PREFIXES: readonly string[] = ["image/", "application/pdf"];

// Magic-byte table for fallback detection when no extension / media type is present.
const OCR_MAGIC: readonly { readonly prefix: readonly number[] }[] = Object.freeze([
  { prefix: [0x25, 0x50, 0x44, 0x46] }, // PDF: %PDF
  { prefix: [0x89, 0x50, 0x4e, 0x47] }, // PNG
  { prefix: [0xff, 0xd8, 0xff] },        // JPEG
  { prefix: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { prefix: [0x42, 0x4d] },             // BMP
]);

function matchesMagicBytes(bytes: Uint8Array): boolean {
  for (const entry of OCR_MAGIC) {
    if (bytes.length < entry.prefix.length) continue;
    let match = true;
    for (let i = 0; i < entry.prefix.length; i += 1) {
      if (bytes[i] !== entry.prefix[i]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function isOcrCandidate(input: ParserSelectionInput): boolean {
  if (OCR_EXTENSIONS.has(input.extension.toLowerCase())) return true;
  for (const prefix of OCR_MEDIA_PREFIXES) {
    if (input.mediaType.toLowerCase().startsWith(prefix)) return true;
  }
  return matchesMagicBytes(input.bytes);
}

function unsupportedReason(input: ParserSelectionInput): string {
  if (input.extension.toLowerCase() === "pdf" || input.mediaType.toLowerCase() === "application/pdf")
    return "pdf-not-implemented";
  return "image-not-supported";
}

// Reads signal.aborted via function call to defeat TypeScript cross-await control-flow
// narrowing that incorrectly marks the boolean as `false` after a prior check.
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function cancelled(cap: ParserCapability, input: ParserSelectionInput, options: ParserOptions): ParserResult {
  return emptyResult(cap, input.documentId, options, [
    diagnostic("PARSER_CANCELLED", "caller aborted parser", input.documentId, "info"),
  ]);
}

function resultFromOcrOutcome(
  ocrResult: OcrPageResult,
  cap: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult {
  if (!ocrResult.ok) {
    const reason =
      ocrResult.reason === "ocr-not-configured"
        ? unsupportedReason(input)
        : `ocr-failed:${ocrResult.reason}`;
    return emptyResult(
      cap, input.documentId, options,
      [diagnostic("UNSUPPORTED_FORMAT", `ocr adapter returned ok:false (${ocrResult.reason})`, input.documentId, "info")],
      [{ kind: "unsupported-media", documentId: input.documentId, reason }],
    );
  }
  const pageUnit: ParsedUnit = { kind: "page", documentId: input.documentId, pageNumber: 1, characterStart: 0, characterEnd: ocrResult.text.length };
  return emptyResult(cap, input.documentId, options, [], [pageUnit]);
}

function buildSyncParse(cap: ParserCapability) {
  return (input: ParserSelectionInput, options: ParserOptions): ParserResult => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(cap, input.documentId, options, [oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes)]);
    }
    if (isAborted(options.signal)) return cancelled(cap, input, options);
    const reason = unsupportedReason(input);
    return emptyResult(
      cap, input.documentId, options,
      [diagnostic("UNSUPPORTED_FORMAT", `ocr adapter present but sync parse called; use parseAsync (${reason})`, input.documentId, "info")],
      [{ kind: "unsupported-media", documentId: input.documentId, reason }],
    );
  };
}

function buildAsyncParse(cap: ParserCapability, adapter: OcrAdapter) {
  return async (input: ParserSelectionInput, options: ParserOptions): Promise<ParserResult> => {
    if (input.bytes.byteLength > options.maxBytes) {
      return emptyResult(cap, input.documentId, options, [oversizeDiagnostic(input.documentId, input.bytes.byteLength, options.maxBytes)]);
    }
    if (isAborted(options.signal)) return cancelled(cap, input, options);
    const startedAt = options.now();
    const preCheck = shouldStop(startedAt, options, 0);
    if (preCheck.stop && preCheck.code !== undefined && preCheck.message !== undefined) {
      return emptyResult(cap, input.documentId, options, [diagnostic(preCheck.code, preCheck.message, input.documentId, "info")]);
    }
    const ocrResult = await adapter.ocrPage({ bytes: input.bytes, pageNumber: 1 });
    if (isAborted(options.signal)) return cancelled(cap, input, options);
    const postCheck = shouldStop(startedAt, options, 0);
    if (postCheck.stop && postCheck.code !== undefined && postCheck.message !== undefined) {
      return emptyResult(cap, input.documentId, options, [diagnostic(postCheck.code, postCheck.message, input.documentId, "info")]);
    }
    return resultFromOcrOutcome(ocrResult, cap, input, options);
  };
}

// ─── OcrPipelineAdapter interface ────────────────────────────────────────────
// Extends ParserAdapter with an async entrypoint. The sync `parse` is required by the
// registry contract; `parseAsync` is the real OCR path.
export interface OcrPipelineAdapter extends ParserAdapter {
  readonly parseAsync: (input: ParserSelectionInput, options: ParserOptions) => Promise<ParserResult>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createOcrPipelineParser(adapter: OcrAdapter): OcrPipelineAdapter {
  const capability = Object.freeze({ parserId: PARSER_ID, parserVersion: PARSER_VERSION, matches: isOcrCandidate });
  return Object.freeze({ capability, parse: buildSyncParse(capability), parseAsync: buildAsyncParse(capability, adapter) });
}
