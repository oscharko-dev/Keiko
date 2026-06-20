// Bounded, request-local small-document text extraction for Repository Search (Issue #1285).
//
// This module is the documented reuse/generalization point: instead of duplicating DOCX/XLSX/
// PDF parsing, it composes the already-shipped Local Knowledge parser adapters (docx-parser,
// xlsx-parser, pdf-parser — Epic #189) into a single bounded, pure text projection that callers
// outside the indexing pipeline can use. keiko-workspace cannot host this (it is a leaf package
// that may not depend on keiko-local-knowledge, ADR-0019 direction 3b); keiko-local-knowledge is
// the only package that may compose the parsers, so the bounded extractor lives here and the
// grounded Repository Search path (keiko-server) calls it.
//
// Design invariants:
//   - PURE: bytes in, text out. No filesystem access, no clock beyond the injected `now()`, no
//     redaction. The caller (keiko-server) owns the path-safe byte read and the redaction step,
//     mirroring how the parser adapters themselves stay FS-free.
//   - BOUNDED: the input byte ceiling, the extracted-output byte ceiling, the parser unit ceiling,
//     and the per-document timeout are all enforced. No new parser logic and no new runtime
//     dependency is introduced — the existing yauzl + pdfjs-dist parsers are reused as-is.
//   - STABLE DIAGNOSTICS: every non-success path resolves to a stable outcome token so the caller
//     can emit a deterministic skipped-document diagnostic (oversized, unsupported-format,
//     no-text-layer, malformed, encrypted, empty, timed-out).

import type { DocumentId, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";

import { docxParser } from "./parsers/docx-parser.js";
import { pdfParser } from "./parsers/pdf-parser.js";
import { buildParserOptions } from "./parsers/registry.js";
import type {
  AsyncParserAdapter,
  InternalParserResult,
  ParserSelectionInput,
} from "./parsers/types.js";
import { xlsxParser } from "./parsers/xlsx-parser.js";

// ─── Public contract ───────────────────────────────────────────────────────────

export type BoundedDocumentFormat = "docx" | "xlsx" | "pdf";

export type BoundedDocumentExtractionOutcome =
  // Text was extracted (possibly truncated to the output cap).
  | "extracted"
  // Input exceeded the pre-parser byte ceiling.
  | "oversized"
  // Not a supported small-document container (e.g. legacy .doc, .ppt, image, archive).
  | "unsupported-format"
  // Supported container with no extractable text layer (typically a scanned PDF). No OCR.
  | "no-text-layer"
  // Supported container that could not be parsed because it is corrupt/truncated.
  | "malformed"
  // Password-protected / encrypted document that cannot be opened for extraction.
  | "encrypted"
  // Parsed successfully but produced no text (e.g. an empty workbook or blank document).
  | "empty"
  // The per-document timeout (or caller cancellation) fired before extraction completed.
  | "timed-out";

export interface BoundedDocumentExtractionInput {
  // The raw document bytes. Not mutated.
  readonly bytes: Uint8Array;
  // Lowercase file extension WITHOUT the leading dot (e.g. "docx"). Empty when unknown; the
  // optional mediaType is then consulted.
  readonly extension: string;
  // RFC 6838 media type (lowercase). Optional; used as a secondary format hint.
  readonly mediaType?: string;
  // Opaque request-local document id forwarded to the parser. Defaults to a fixed sentinel
  // because the bounded text projection does not depend on a stable document identity.
  readonly documentId?: DocumentId;
}

export interface BoundedDocumentExtractionOptions {
  // Refuse inputs larger than this many bytes before invoking any parser.
  readonly maxInputBytes: number;
  // Truncate the extracted UTF-8 text to at most this many bytes.
  readonly maxOutputBytes: number;
  // Forwarded to the parser as `maxUnitsPerDocument`: bounds paragraphs/rows/pages parsed.
  readonly maxUnits: number;
  // Per-document wall-clock budget. Enforced via both the parser deadline and an AbortSignal.
  readonly timeoutMs: number;
  // Optional caller cancellation, combined with the internal timeout signal.
  readonly signal?: AbortSignal;
  // Injected clock (epoch ms). Keeps the extractor deterministic in tests.
  readonly now: () => number;
}

export interface BoundedDocumentExtractionResult {
  readonly outcome: BoundedDocumentExtractionOutcome;
  // The recognized format, or undefined when the format was not supported.
  readonly format: BoundedDocumentFormat | undefined;
  // Extracted text; empty string unless `outcome === "extracted"`.
  readonly text: string;
  // UTF-8 byte length of `text`.
  readonly extractedBytes: number;
  // True when the extracted text was clipped to the output cap.
  readonly truncated: boolean;
  // Parser diagnostics (codes only, no absolute paths). Safe to surface in bounded form.
  readonly diagnostics: readonly ParserDiagnostic[];
}

// ─── Format resolution ──────────────────────────────────────────────────────────

const DEFAULT_DOCUMENT_ID = "bounded-document" as DocumentId;

const DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MEDIA = "application/pdf";

interface FormatBinding {
  readonly format: BoundedDocumentFormat;
  readonly parser: AsyncParserAdapter;
}

function resolveFormat(extension: string, mediaType: string): FormatBinding | undefined {
  const ext = extension.toLowerCase().replace(/^\./, "");
  const media = mediaType.toLowerCase();
  if (ext === "docx" || media === DOCX_MEDIA) {
    return { format: "docx", parser: docxParser };
  }
  if (ext === "xlsx" || media === XLSX_MEDIA) {
    return { format: "xlsx", parser: xlsxParser };
  }
  if (ext === "pdf" || media === PDF_MEDIA) {
    return { format: "pdf", parser: pdfParser };
  }
  return undefined;
}

// Office files protected with a password are not OOXML ZIP packages; they are wrapped in a
// Compound File Binary (CFB / OLE2) container whose 8-byte signature is D0 CF 11 E0 A1 B1 1A E1.
// Detecting that signature lets us report `encrypted` instead of a generic `malformed` for the
// common "password-protected Word/Excel" case. PDF /Encrypt detection is intentionally not
// attempted here; an unopenable encrypted PDF degrades to `malformed`, which the caller still
// surfaces as a stable skipped-document diagnostic.
const CFB_SIGNATURE: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function looksEncryptedOfficeContainer(bytes: Uint8Array): boolean {
  if (bytes.length < CFB_SIGNATURE.length) {
    return false;
  }
  return CFB_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

// ─── UTF-8-safe output clamp ─────────────────────────────────────────────────────

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

// Clamp to at most `maxBytes` UTF-8 bytes without splitting a multi-byte character. Returns the
// clamped string and whether truncation occurred.
function clampToUtf8Bytes(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (maxBytes <= 0) {
    return { text: "", truncated: text.length > 0 };
  }
  const encoded = TEXT_ENCODER.encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  const slice = encoded.subarray(0, maxBytes);
  const clamped = new TextDecoder("utf-8", { fatal: false }).decode(slice).replace(/�+$/u, "");
  return { text: clamped, truncated: true };
}

// ─── Outcome classification ──────────────────────────────────────────────────────

function hasDiagnostic(result: InternalParserResult, code: string): boolean {
  return result.diagnostics.some((diagnostic) => diagnostic.code === code);
}

function hasNoTextLayerUnit(result: InternalParserResult): boolean {
  return result.units.some(
    (unit) =>
      unit.kind === "unsupported-media" &&
      (unit.reason === "pdf-no-text-layer" || unit.reason === "docx-no-text"),
  );
}

function classifyParsedOutcome(
  result: InternalParserResult,
):
  | Exclude<BoundedDocumentExtractionOutcome, "extracted" | "oversized" | "unsupported-format">
  | "ok" {
  if (hasDiagnostic(result, "PARSER_TIMEOUT") || hasDiagnostic(result, "PARSER_CANCELLED")) {
    return "timed-out";
  }
  if (hasDiagnostic(result, "MALFORMED_INPUT")) {
    return "malformed";
  }
  if (hasNoTextLayerUnit(result)) {
    return "no-text-layer";
  }
  // An empty-but-valid container (e.g. a workbook with no rows) produces no normalized text; it is
  // resolved to the `empty` outcome after the output clamp rather than here, so the empty path has
  // a single source of truth.
  return "ok";
}

// ─── Result builders ─────────────────────────────────────────────────────────────

function failure(
  outcome: BoundedDocumentExtractionOutcome,
  format: BoundedDocumentFormat | undefined,
  diagnostics: readonly ParserDiagnostic[] = [],
): BoundedDocumentExtractionResult {
  return { outcome, format, text: "", extractedBytes: 0, truncated: false, diagnostics };
}

// ─── Timeout wiring ──────────────────────────────────────────────────────────────

interface TimeoutHandle {
  readonly signal: AbortSignal;
  dispose(): void;
}

function armTimeout(timeoutMs: number, callerSignal: AbortSignal | undefined): TimeoutHandle {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    Math.max(0, timeoutMs),
  );
  // Do not keep the event loop alive solely for the extraction deadline.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  const signal =
    callerSignal === undefined
      ? controller.signal
      : AbortSignal.any([callerSignal, controller.signal]);
  return {
    signal,
    dispose: (): void => {
      clearTimeout(timer);
    },
  };
}

// ─── Public entry ────────────────────────────────────────────────────────────────

function preflightFailure(
  input: BoundedDocumentExtractionInput,
  binding: FormatBinding,
  options: BoundedDocumentExtractionOptions,
): BoundedDocumentExtractionResult | undefined {
  if (input.bytes.byteLength > options.maxInputBytes) {
    return failure("oversized", binding.format);
  }
  if (
    (binding.format === "docx" || binding.format === "xlsx") &&
    looksEncryptedOfficeContainer(input.bytes)
  ) {
    return failure("encrypted", binding.format);
  }
  if (options.signal?.aborted === true) {
    return failure("timed-out", binding.format);
  }
  return undefined;
}

// Runs the reused parser under a per-document deadline. The adapter contract conveys failure through
// diagnostics rather than throwing; the try/catch is a boundary safety net so a parser-internal
// defect degrades to a stable `malformed` outcome instead of crashing the grounded request.
async function runParser(
  binding: FormatBinding,
  input: BoundedDocumentExtractionInput,
  options: BoundedDocumentExtractionOptions,
): Promise<InternalParserResult | "malformed"> {
  const timeout = armTimeout(options.timeoutMs, options.signal);
  const selection: ParserSelectionInput = {
    documentId: input.documentId ?? DEFAULT_DOCUMENT_ID,
    bytes: input.bytes,
    extension: input.extension.toLowerCase().replace(/^\./, ""),
    mediaType: (input.mediaType ?? "").toLowerCase(),
  };
  const parserOptions = buildParserOptions({
    maxBytes: options.maxInputBytes,
    maxUnitsPerDocument: options.maxUnits,
    timeoutMs: options.timeoutMs,
    signal: timeout.signal,
    now: options.now,
  });
  try {
    return await binding.parser.parseAsync(selection, parserOptions);
  } catch {
    return "malformed";
  } finally {
    timeout.dispose();
  }
}

export async function extractBoundedDocumentText(
  input: BoundedDocumentExtractionInput,
  options: BoundedDocumentExtractionOptions,
): Promise<BoundedDocumentExtractionResult> {
  const binding = resolveFormat(input.extension, input.mediaType ?? "");
  if (binding === undefined) {
    return failure("unsupported-format", undefined);
  }
  const preflight = preflightFailure(input, binding, options);
  if (preflight !== undefined) {
    return preflight;
  }
  const result = await runParser(binding, input, options);
  if (result === "malformed") {
    return failure("malformed", binding.format);
  }
  const classification = classifyParsedOutcome(result);
  if (classification !== "ok") {
    return failure(classification, binding.format, result.diagnostics);
  }
  const clamped = clampToUtf8Bytes(result.normalizedText ?? "", options.maxOutputBytes);
  if (clamped.text.length === 0) {
    return failure("empty", binding.format, result.diagnostics);
  }
  return {
    outcome: "extracted",
    format: binding.format,
    text: clamped.text,
    extractedBytes: utf8ByteLength(clamped.text),
    truncated: clamped.truncated,
    diagnostics: result.diagnostics,
  };
}
