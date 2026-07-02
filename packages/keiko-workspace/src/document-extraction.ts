// Issue #148 — Safe document context extraction for conversation inputs (Epic #142).
//
// This module turns a workspace-relative file path into a bounded, redacted text excerpt that
// the BFF and the model gateway can safely concatenate into a prompt. The extractor is text-only
// by deliberate design: PDF, Word, and other binary document parsing is OUT OF SCOPE for this
// issue because it would require a new parser dependency, a much larger trust surface (CVE-risk
// in parsing libraries), and an OCR strategy that #148 does not own.
//
// Byte-budget rationale (matches the per-payload aggregate budget on the server side):
//   - Per-document cap of 64 KiB (MAX_EXTRACTED_BYTES) is large enough to carry a typical
//     README/spec/JSON config in full and small enough that 4 attached files at the per-payload
//     aggregate cap of 256 KiB (MAX_TOTAL_EXTRACTED_BYTES) still fits inside the gateway's
//     128 K-character body cap (MAX_BODY_BYTES) with room for the user draft and JSON framing.
//   - Truncation is REPORTED to the caller (`truncated: true` + human-readable marker) so the
//     UI can render a badge and the prompt composer can append a fixed marker after the text.
//
// Path-safe error contract (AC #2):
//   - The failure tagged-union carries a `kind` ONLY. No `path` field; no message field that
//     embeds the resolved or relative path. This keeps absolute filesystem paths off the wire
//     for both reportable failures and unreportable ones (binary/empty/etc.).
//   - All four boundary errors (denied-path / not-found / unreadable / binary-file) are derived
//     from the existing workspace primitives (`resolveWithinWorkspace`,
//     `assertContainedRealPath`, `looksBinary`) so this module owns no new path-validation logic.

import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts";
import { redact } from "@oscharko-dev/keiko-security";
import { DEFAULT_BINARY_PROBE, looksBinary } from "./binaryDetect.js";
import { PathEscapeError, PathDeniedError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { resolveWithinWorkspace } from "./paths.js";
import { assertContainedRealPath } from "./realpath.js";
import { isDenied } from "./ignore.js";

export const MAX_EXTRACTED_BYTES = 65_536; // per-document budget (64 KiB)
export const MAX_TOTAL_EXTRACTED_BYTES = 262_144; // per-payload aggregate budget (256 KiB)

export const SUPPORTED_MIME_PREFIXES: readonly string[] = ["text/"];

export const SUPPORTED_MIME_LITERALS: ReadonlySet<string> = new Set([
  "application/json",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/toml",
  "application/sql",
]);

// File-extension → MIME map. Only text-like / structured-text formats are recognised. Anything
// outside this map falls into `unsupported-type` (e.g. `.exe`, `.pdf`, `.docx`, `.png`).
const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".txt", "text/plain"],
  [".log", "text/plain"],
  [".json", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".xml", "application/xml"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".css", "text/css"],
  [".js", "application/javascript"],
  [".jsx", "application/javascript"],
  [".mjs", "application/javascript"],
  [".cjs", "application/javascript"],
  [".ts", "application/typescript"],
  [".tsx", "application/typescript"],
  [".py", "text/x-python"],
  [".rb", "text/x-ruby"],
  [".go", "text/x-go"],
  [".rs", "text/x-rust"],
  [".java", "text/x-java"],
  [".kt", "text/x-kotlin"],
  [".cpp", "text/x-c++src"],
  [".cc", "text/x-c++src"],
  [".cxx", "text/x-c++src"],
  [".c", "text/x-csrc"],
  [".h", "text/x-chdr"],
  [".hpp", "text/x-c++hdr"],
  [".sh", "text/x-shellscript"],
  [".bash", "text/x-shellscript"],
  [".zsh", "text/x-shellscript"],
  [".toml", "application/toml"],
  [".ini", "text/plain"],
  [".csv", "text/csv"],
  [".tsv", "text/tab-separated-values"],
  [".sql", "application/sql"],
]);

const BINARY_PROBE_BYTES = DEFAULT_BINARY_PROBE.maxProbeBytes;
const FOCUS_SCAN_CHUNK_BYTES = 65_536;
const DEFAULT_FOCUS_CONTEXT_LINES = 2;
const MAX_FOCUS_CONTEXT_LINES = 200;

export type DocumentExtractionFailure =
  | { readonly kind: "binary-file"; readonly mimeHint?: string | undefined }
  | { readonly kind: "unsupported-type"; readonly mimeHint?: string | undefined }
  | { readonly kind: "denied-path" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "empty" };

export interface ExtractedDocumentContext {
  readonly id: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly extractedBytes: number;
  readonly truncated: boolean;
  readonly truncationMarker: string | undefined;
  readonly text: string;
}

export interface DocumentExtractionBudget {
  readonly perDocBytes: number;
  readonly totalBudgetUsedBytes: number;
  readonly totalBudgetBytes: number;
}

export interface DocumentExtractionLineFocus {
  readonly kind: "line-range";
  readonly startLine: number;
  readonly endLine?: number | undefined;
  readonly contextLines?: number | undefined;
}

export interface DocumentExtractionOptions {
  // Callers can pass a span resolved by the code/symbol index so large source files yield the
  // relevant declaration body instead of a prefix excerpt.
  readonly focus?: DocumentExtractionLineFocus | undefined;
}

export type DocumentExtractionResult =
  | { readonly ok: true; readonly context: ExtractedDocumentContext }
  | { readonly ok: false; readonly failure: DocumentExtractionFailure };

function classifyByExtension(relativePath: string): string | undefined {
  const ext = extname(relativePath).toLowerCase();
  if (ext.length === 0) {
    return undefined;
  }
  return EXTENSION_MIME.get(ext);
}

function isSupportedMime(mimeType: string): boolean {
  if (SUPPORTED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return true;
  }
  return SUPPORTED_MIME_LITERALS.has(mimeType);
}

function denied(): DocumentExtractionResult {
  return { ok: false, failure: { kind: "denied-path" } };
}

function notFound(): DocumentExtractionResult {
  return { ok: false, failure: { kind: "not-found" } };
}

function unreadable(): DocumentExtractionResult {
  return { ok: false, failure: { kind: "unreadable" } };
}

function empty(): DocumentExtractionResult {
  return { ok: false, failure: { kind: "empty" } };
}

function binary(mimeHint?: string): DocumentExtractionResult {
  if (mimeHint === undefined) {
    return { ok: false, failure: { kind: "binary-file" } };
  }
  return { ok: false, failure: { kind: "binary-file", mimeHint } };
}

function unsupported(mimeHint?: string): DocumentExtractionResult {
  if (mimeHint === undefined) {
    return { ok: false, failure: { kind: "unsupported-type" } };
  }
  return { ok: false, failure: { kind: "unsupported-type", mimeHint } };
}

// Internal step-result discriminator: distinguishes a tagged-union step success (which carries
// step-local data) from a propagated DocumentExtractionResult (terminal value).
type StepOk<T> = { readonly step: "ok" } & T;
type StepResult<T> = StepOk<T> | DocumentExtractionResult;

function isStepOk<T>(value: StepResult<T>): value is StepOk<T> {
  return "step" in value;
}

function resolveSafePath(
  fs: WorkspaceFs,
  workspaceRoot: string,
  relativePath: string,
): StepResult<{ readonly resolved: string }> {
  let absolutePath: string;
  try {
    absolutePath = resolveWithinWorkspace(workspaceRoot, relativePath);
  } catch (error) {
    if (error instanceof PathEscapeError) {
      return denied();
    }
    throw error;
  }
  const normalizedRel = absolutePath.slice(workspaceRoot.length).replace(/^[/\\]/, "");
  if (isDenied(normalizedRel)) {
    return denied();
  }
  let resolved: string;
  try {
    resolved = assertContainedRealPath(fs, workspaceRoot, absolutePath, normalizedRel);
  } catch (error) {
    if (error instanceof PathEscapeError || error instanceof PathDeniedError) {
      return denied();
    }
    throw error;
  }
  return { step: "ok", resolved };
}

function statFile(
  fs: WorkspaceFs,
  resolvedPath: string,
): StepResult<{ readonly size: number; readonly isFile: boolean }> {
  try {
    const stats = fs.stat(resolvedPath);
    return { step: "ok", size: stats.size, isFile: stats.isFile };
  } catch {
    if (!fs.exists(resolvedPath)) {
      return notFound();
    }
    return unreadable();
  }
}

function effectivePerDocBudget(budget: DocumentExtractionBudget): number {
  const remainingTotal = Math.max(0, budget.totalBudgetBytes - budget.totalBudgetUsedBytes);
  return Math.min(budget.perDocBytes, remainingTotal);
}

async function probeBinary(
  fs: WorkspaceFs,
  resolvedPath: string,
  size: number,
): Promise<StepResult<{ readonly bytes: Uint8Array }>> {
  if (fs.readFileBytes === undefined) {
    // Synchronous read fallback for FS adapters without the byte-level port. We only need a
    // small slice for the binary probe; reading utf-8-as-string and re-encoding is acceptable
    // here because EVERY adapter ships readFileUtf8 (it's a required port member).
    let utf8: string;
    try {
      utf8 = fs.readFileUtf8(resolvedPath);
    } catch {
      return unreadable();
    }
    const encoded = new TextEncoder().encode(utf8);
    return {
      step: "ok",
      bytes: encoded.subarray(0, Math.min(BINARY_PROBE_BYTES, encoded.length)),
    };
  }
  try {
    const bytes = await fs.readFileBytes(resolvedPath, Math.min(BINARY_PROBE_BYTES, size));
    return { step: "ok", bytes };
  } catch {
    return unreadable();
  }
}

async function readBudgetedBytes(
  fs: WorkspaceFs,
  resolvedPath: string,
  cap: number,
): Promise<StepResult<{ readonly bytes: Uint8Array }>> {
  if (cap === 0) {
    return { step: "ok", bytes: new Uint8Array(0) };
  }
  if (fs.readFileBytes !== undefined) {
    try {
      const bytes = await fs.readFileBytes(resolvedPath, cap);
      return { step: "ok", bytes };
    } catch {
      return unreadable();
    }
  }
  let utf8: string;
  try {
    utf8 = fs.readFileUtf8(resolvedPath);
  } catch {
    return unreadable();
  }
  const encoded = new TextEncoder().encode(utf8);
  return { step: "ok", bytes: encoded.subarray(0, Math.min(cap, encoded.length)) };
}

async function readRangeBytes(
  fs: WorkspaceFs,
  resolvedPath: string,
  startByte: number,
  length: number,
): Promise<StepResult<{ readonly bytes: Uint8Array }>> {
  if (length === 0) {
    return { step: "ok", bytes: new Uint8Array(0) };
  }
  if (fs.readFileRange !== undefined) {
    try {
      return { step: "ok", bytes: await fs.readFileRange(resolvedPath, startByte, length) };
    } catch {
      return unreadable();
    }
  }
  if (fs.openFileReader !== undefined) {
    try {
      const reader = await fs.openFileReader(resolvedPath);
      try {
        return { step: "ok", bytes: await reader.readRange(startByte, length) };
      } finally {
        await reader.close();
      }
    } catch {
      return unreadable();
    }
  }
  let utf8: string;
  try {
    utf8 = fs.readFileUtf8(resolvedPath);
  } catch {
    return unreadable();
  }
  const encoded = new TextEncoder().encode(utf8);
  return {
    step: "ok",
    bytes: encoded.subarray(startByte, Math.min(encoded.length, startByte + length)),
  };
}

function buildTruncationMarker(extractedBytes: number, originalBytes: number): string {
  return `[…truncated to first ${String(extractedBytes)} of ${String(originalBytes)} bytes]`;
}

// Returns the expected byte-length of the UTF-8 sequence starting with `lead`, or 0 when
// the byte is not a valid UTF-8 leading byte.
function utf8LeadByteSeqLen(lead: number): number {
  if ((lead & 0x80) === 0x00) return 1; // ASCII
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 0; // continuation byte or invalid — not a lead byte
}

// Returns the length of the valid UTF-8 prefix of `bytes`, backing off any incomplete
// multibyte sequence at the tail. A full file that is valid UTF-8 will have its entire
// length returned unchanged; a capped slice that was cut mid-codepoint will have at most
// 3 bytes trimmed (the maximum tail of an incomplete 4-byte sequence).
//
// Algorithm: scan backward from the end for the first byte that is NOT a UTF-8 continuation
// byte (0x80–0xBF). That byte is the start of the last (possibly incomplete) sequence.
// If the sequence is incomplete, exclude it; otherwise keep the full slice.
function validUtf8PrefixLength(bytes: Uint8Array): number {
  const len = bytes.length;
  if (len === 0) return 0;
  // Walk back over continuation bytes (0x80–0xBF), up to 3.
  let i = len - 1;
  const limit = Math.max(len - 4, -1);
  while (i > limit && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
    i -= 1;
  }
  const seqLen = utf8LeadByteSeqLen(bytes[i] ?? 0);
  if (seqLen === 0) return i; // not a lead byte — exclude it
  // If the sequence started at i extends past the slice end, exclude it.
  return i + seqLen <= len ? len : i;
}

type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be";

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function inferUtf16Encoding(bytes: Uint8Array): TextEncoding | undefined {
  if (bytes.length < 8) {
    return undefined;
  }
  let evenNuls = 0;
  let oddNuls = 0;
  let pairs = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    pairs += 1;
    if (bytes[i] === 0x00) evenNuls += 1;
    if (bytes[i + 1] === 0x00) oddNuls += 1;
  }
  const evenRatio = evenNuls / pairs;
  const oddRatio = oddNuls / pairs;
  if (evenRatio > 0.6 && oddRatio < 0.3) return "utf-16be";
  if (oddRatio > 0.6 && evenRatio < 0.3) return "utf-16le";
  return undefined;
}

function detectTextEncoding(bytes: Uint8Array): TextEncoding {
  if (bytes.length >= 4 && startsWithBytes(bytes, [0xff, 0xfe, 0x00, 0x00])) return "utf-32le";
  if (bytes.length >= 4 && startsWithBytes(bytes, [0x00, 0x00, 0xfe, 0xff])) return "utf-32be";
  if (bytes.length >= 2 && startsWithBytes(bytes, [0xff, 0xfe])) return "utf-16le";
  if (bytes.length >= 2 && startsWithBytes(bytes, [0xfe, 0xff])) return "utf-16be";
  return inferUtf16Encoding(bytes) ?? "utf-8";
}

function validTextPrefixLength(bytes: Uint8Array): number {
  const encoding = detectTextEncoding(bytes);
  if (encoding === "utf-8") return validUtf8PrefixLength(bytes);
  if (encoding === "utf-16le" || encoding === "utf-16be") return bytes.length - (bytes.length % 2);
  return bytes.length - (bytes.length % 4);
}

function readUtf32CodePoint(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  return littleEndian
    ? b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000
    : b3 + b2 * 0x100 + b1 * 0x10000 + b0 * 0x1000000;
}

function isUnicodeScalarValue(codePoint: number): boolean {
  return codePoint >= 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
}

function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): string {
  let out = "";
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const codePoint = readUtf32CodePoint(bytes, i, littleEndian);
    if (!isUnicodeScalarValue(codePoint)) {
      throw new Error("invalid UTF-32 code point");
    }
    out += String.fromCodePoint(codePoint);
  }
  return out;
}

function decodeTextBytes(bytes: Uint8Array): StepResult<{ readonly text: string }> {
  // fatal decoders make invalid byte sequences the second binary-classification gate after the
  // control-byte probe. Valid UTF-16/UTF-32 text is decoded instead of being rejected after the
  // binary classifier has already identified it as text-shaped.
  try {
    const encoding = detectTextEncoding(bytes);
    if (encoding === "utf-32le" || encoding === "utf-32be") {
      return { step: "ok", text: decodeUtf32(bytes, encoding === "utf-32le") };
    }
    const decoder = new TextDecoder(encoding, { fatal: true });
    return { step: "ok", text: decoder.decode(bytes) };
  } catch {
    return binary();
  }
}

function trimTrailingWhitespace(value: string): string {
  return value.replace(/\s+$/u, "");
}

interface ResolvedFile {
  readonly resolvedPath: string;
  readonly size: number;
}

async function classifyFileMime(
  fs: WorkspaceFs,
  file: ResolvedFile,
  relativePath: string,
): Promise<StepResult<{ readonly mimeType: string }>> {
  const probe = await probeBinary(fs, file.resolvedPath, file.size);
  if (!isStepOk(probe)) {
    return probe;
  }
  if (looksBinary(probe.bytes)) {
    return binary(classifyByExtension(relativePath));
  }
  const mimeType = classifyByExtension(relativePath);
  if (mimeType === undefined || !isSupportedMime(mimeType)) {
    return unsupported(mimeType);
  }
  return { step: "ok", mimeType };
}

interface ReadAndCapResult {
  readonly text: string;
  readonly extractedBytes: number;
  readonly truncated: boolean;
  readonly truncationMarker?: string | undefined;
}

async function readAndCap(
  fs: WorkspaceFs,
  file: ResolvedFile,
  budget: DocumentExtractionBudget,
): Promise<StepResult<{ readonly value: ReadAndCapResult }>> {
  const cap = effectivePerDocBudget(budget);
  const read = await readBudgetedBytes(fs, file.resolvedPath, cap);
  if (!isStepOk(read)) {
    return read;
  }
  // When the byte slice was capped below the file size a multibyte codepoint may straddle
  // the boundary. Back the slice to the last complete code unit/point for the detected text
  // encoding so the fatal decoder does not mistake a clean text file for binary.
  const isCapped = read.bytes.length < file.size;
  const bytes = isCapped ? read.bytes.subarray(0, validTextPrefixLength(read.bytes)) : read.bytes;
  const decoded = decodeTextBytes(bytes);
  if (!isStepOk(decoded)) {
    return decoded;
  }
  const text = trimTrailingWhitespace(stripUnsafeFormatChars(decoded.text));
  // Report the number of bytes actually read from disk (before the codepoint trim) so the
  // truncation marker quotes an honest byte count rather than the post-trim length.
  const extractedBytes = read.bytes.length;
  const truncated = extractedBytes < file.size;
  return { step: "ok", value: { text, extractedBytes, truncated } };
}

interface NormalizedLineFocus {
  readonly startLine: number;
  readonly endLine: number;
}

interface LineByteRange {
  readonly startByte: number;
  readonly endByte: number;
}

interface LineScanState {
  line: number;
  startByte: number | undefined;
  endByte: number | undefined;
}

function normalizeLineFocus(focus: DocumentExtractionLineFocus): NormalizedLineFocus | undefined {
  const startLine = Math.floor(focus.startLine);
  const requestedEndLine = Math.floor(focus.endLine ?? focus.startLine);
  if (!Number.isFinite(startLine) || !Number.isFinite(requestedEndLine)) {
    return undefined;
  }
  if (startLine < 1 || requestedEndLine < startLine) {
    return undefined;
  }
  const contextLines = Math.min(
    MAX_FOCUS_CONTEXT_LINES,
    Math.max(0, Math.floor(focus.contextLines ?? DEFAULT_FOCUS_CONTEXT_LINES)),
  );
  return {
    startLine: Math.max(1, startLine - contextLines),
    endLine: requestedEndLine + contextLines,
  };
}

function fallbackLineRangeFromUtf8Text(
  text: string,
  focus: NormalizedLineFocus,
): LineByteRange | undefined {
  let line = 1;
  let startByte = focus.startLine === 1 ? 0 : undefined;
  let endByte: number | undefined;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    if (line === focus.endLine) {
      endByte = Buffer.byteLength(text.slice(0, index), "utf8");
      break;
    }
    line += 1;
    if (line === focus.startLine) {
      startByte = Buffer.byteLength(text.slice(0, index + 1), "utf8");
    }
  }
  if (startByte === undefined) {
    return undefined;
  }
  return { startByte, endByte: endByte ?? Buffer.byteLength(text, "utf8") };
}

async function readFocusScanChunk(
  fs: WorkspaceFs,
  file: ResolvedFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (fs.readFileRange !== undefined) {
    return await fs.readFileRange(file.resolvedPath, offset, length);
  }
  const reader = await fs.openFileReader?.(file.resolvedPath);
  if (reader === undefined) {
    throw new Error("openFileReader unavailable");
  }
  try {
    return await reader.readRange(offset, length);
  } finally {
    await reader.close();
  }
}

function advanceLineScan(
  state: LineScanState,
  focus: NormalizedLineFocus,
  newlineByteOffset: number,
): void {
  if (state.line === focus.endLine) {
    state.endByte = newlineByteOffset;
    return;
  }
  state.line += 1;
  if (state.line === focus.startLine) {
    state.startByte = newlineByteOffset + 1;
  }
}

function scanChunkForLineRange(
  chunk: Uint8Array,
  offset: number,
  focus: NormalizedLineFocus,
  state: LineScanState,
): void {
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] === 0x0a) {
      advanceLineScan(state, focus, offset + index);
      if (state.endByte !== undefined) {
        return;
      }
    }
  }
}

async function scanUtf8LineRange(
  fs: WorkspaceFs,
  file: ResolvedFile,
  focus: NormalizedLineFocus,
): Promise<LineByteRange | undefined> {
  const state: LineScanState = {
    line: 1,
    startByte: focus.startLine === 1 ? 0 : undefined,
    endByte: undefined,
  };
  for (let offset = 0; offset < file.size; offset += FOCUS_SCAN_CHUNK_BYTES) {
    const chunk = await readFocusScanChunk(
      fs,
      file,
      offset,
      Math.min(FOCUS_SCAN_CHUNK_BYTES, file.size - offset),
    );
    if (chunk.length === 0) {
      break;
    }
    scanChunkForLineRange(chunk, offset, focus, state);
    if (state.endByte !== undefined) {
      break;
    }
  }
  if (state.startByte === undefined) {
    return undefined;
  }
  return { startByte: state.startByte, endByte: state.endByte ?? file.size };
}

async function locateUtf8LineRange(
  fs: WorkspaceFs,
  file: ResolvedFile,
  focus: NormalizedLineFocus,
): Promise<StepResult<{ readonly range: LineByteRange | undefined }>> {
  if (fs.readFileRange === undefined && fs.openFileReader === undefined) {
    try {
      return {
        step: "ok",
        range: fallbackLineRangeFromUtf8Text(fs.readFileUtf8(file.resolvedPath), focus),
      };
    } catch {
      return unreadable();
    }
  }
  try {
    return { step: "ok", range: await scanUtf8LineRange(fs, file, focus) };
  } catch {
    return unreadable();
  }
}

function buildFocusedTruncationMarker(
  focus: NormalizedLineFocus,
  extractedBytes: number,
  selectedBytes: number,
  fileSize: number,
): string {
  const cap =
    extractedBytes < selectedBytes
      ? `; selected span truncated to first ${String(extractedBytes)} of ${String(selectedBytes)} bytes`
      : "";
  return `[…selected lines ${String(focus.startLine)}-${String(focus.endLine)} from ${String(fileSize)} bytes${cap}]`;
}

function buildFocusedReadResult(input: {
  readonly text: string;
  readonly range: LineByteRange;
  readonly focus: NormalizedLineFocus;
  readonly extractedBytes: number;
  readonly selectedBytes: number;
  readonly fileSize: number;
}): ReadAndCapResult {
  const omittedFileContent =
    input.range.startByte > 0 || input.range.startByte + input.extractedBytes < input.fileSize;
  return {
    text: trimTrailingWhitespace(stripUnsafeFormatChars(input.text)),
    extractedBytes: input.extractedBytes,
    truncated: omittedFileContent,
    truncationMarker: omittedFileContent
      ? buildFocusedTruncationMarker(
          input.focus,
          input.extractedBytes,
          input.selectedBytes,
          input.fileSize,
        )
      : undefined,
  };
}

async function readFocusedRangeAndCap(
  fs: WorkspaceFs,
  file: ResolvedFile,
  budget: DocumentExtractionBudget,
  focus: DocumentExtractionLineFocus | undefined,
): Promise<StepResult<{ readonly value: ReadAndCapResult | undefined }>> {
  if (focus === undefined) {
    return { step: "ok", value: undefined };
  }
  const normalized = normalizeLineFocus(focus);
  if (normalized === undefined) {
    return { step: "ok", value: undefined };
  }
  const located = await locateUtf8LineRange(fs, file, normalized);
  if (!isStepOk(located)) {
    return located;
  }
  if (located.range === undefined) {
    return { step: "ok", value: undefined };
  }
  const selectedBytes = Math.max(0, located.range.endByte - located.range.startByte);
  const read = await readRangeBytes(
    fs,
    file.resolvedPath,
    located.range.startByte,
    Math.min(effectivePerDocBudget(budget), selectedBytes),
  );
  if (!isStepOk(read)) {
    return read;
  }
  const isCapped = read.bytes.length < selectedBytes;
  const bytes = isCapped ? read.bytes.subarray(0, validTextPrefixLength(read.bytes)) : read.bytes;
  const decoded = decodeTextBytes(bytes);
  if (!isStepOk(decoded)) {
    return decoded;
  }
  const extractedBytes = read.bytes.length;
  return {
    step: "ok",
    value: buildFocusedReadResult({
      text: decoded.text,
      range: located.range,
      focus: normalized,
      extractedBytes,
      selectedBytes,
      fileSize: file.size,
    }),
  };
}

function buildContext(
  relativePath: string,
  mimeType: string,
  file: ResolvedFile,
  capped: ReadAndCapResult,
): ExtractedDocumentContext {
  const marker = capped.truncated
    ? (capped.truncationMarker ?? buildTruncationMarker(capped.extractedBytes, file.size))
    : undefined;
  return {
    id: randomUUID(),
    displayName: basename(relativePath),
    mimeType,
    sizeBytes: file.size,
    extractedBytes: capped.extractedBytes,
    truncated: capped.truncated,
    truncationMarker: marker,
    text: redact(capped.text),
  };
}

function buildZeroBudgetContext(
  relativePath: string,
  mimeType: string,
  file: ResolvedFile,
): DocumentExtractionResult {
  return {
    ok: true,
    context: {
      id: randomUUID(),
      displayName: basename(relativePath),
      mimeType,
      sizeBytes: file.size,
      extractedBytes: 0,
      truncated: true,
      truncationMarker: buildTruncationMarker(0, file.size),
      text: "",
    },
  };
}

// Public entry: extracts text from a workspace-relative path. All error paths produce a path-
// safe DocumentExtractionFailure tagged-union (no path strings in the failure object).
export async function extractDocumentContext(
  fs: WorkspaceFs,
  workspaceRoot: string,
  relativePath: string,
  budget: DocumentExtractionBudget,
  options: DocumentExtractionOptions = {},
): Promise<DocumentExtractionResult> {
  const safe = resolveSafePath(fs, workspaceRoot, relativePath);
  if (isStepOk(safe)) {
    return extractFromResolvedPath(fs, relativePath, safe.resolved, budget, options);
  }
  return safe;
}

async function extractFromResolvedPath(
  fs: WorkspaceFs,
  relativePath: string,
  resolvedPath: string,
  budget: DocumentExtractionBudget,
  options: DocumentExtractionOptions,
): Promise<DocumentExtractionResult> {
  const stat = statFile(fs, resolvedPath);
  if (!isStepOk(stat)) {
    return stat;
  }
  if (!stat.isFile) {
    return notFound();
  }
  if (stat.size === 0) {
    return empty();
  }
  const file: ResolvedFile = { resolvedPath, size: stat.size };
  const mimeResult = await classifyFileMime(fs, file, relativePath);
  if (!isStepOk(mimeResult)) {
    return mimeResult;
  }
  const focused = await readFocusedRangeAndCap(fs, file, budget, options.focus);
  if (!isStepOk(focused)) {
    return focused;
  }
  const capped =
    focused.value === undefined
      ? await readAndCap(fs, file, budget)
      : ({ step: "ok", value: focused.value } satisfies StepResult<{
          readonly value: ReadAndCapResult;
        }>);
  if (!isStepOk(capped)) {
    return capped;
  }
  if (capped.value.extractedBytes === 0) {
    // Budget exhausted at entry: surface as a truncated zero-byte excerpt so the caller can
    // still render a chip + truncation badge. AC #3 — UI shows the doc contributed nothing.
    return buildZeroBudgetContext(relativePath, mimeResult.mimeType, file);
  }
  return { ok: true, context: buildContext(relativePath, mimeResult.mimeType, file, capped.value) };
}
