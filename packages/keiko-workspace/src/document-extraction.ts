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

import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { redact } from "@oscharko-dev/keiko-security";
import { looksBinary } from "./binaryDetect.js";
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

const BINARY_PROBE_BYTES = 512;

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

function decodeUtf8(bytes: Uint8Array): StepResult<{ readonly text: string }> {
  // fatal: true makes the decoder throw on invalid UTF-8 byte sequences. This is the
  // second binary-classification gate after the NUL-byte probe — a file that survives the
  // probe but is still not valid UTF-8 is treated as binary, not silently decoded with
  // replacement characters.
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
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
  // the boundary. Back the slice to the last complete UTF-8 codepoint so the fatal decoder
  // does not mistake a clean text file for binary. A file that is genuinely NOT at a
  // codepoint boundary due to truncation will have at most 3 bytes trimmed.
  const isCapped = read.bytes.length < file.size;
  const bytes = isCapped ? read.bytes.subarray(0, validUtf8PrefixLength(read.bytes)) : read.bytes;
  const decoded = decodeUtf8(bytes);
  if (!isStepOk(decoded)) {
    return decoded;
  }
  const text = trimTrailingWhitespace(decoded.text);
  // Report the number of bytes actually read from disk (before the codepoint trim) so the
  // truncation marker quotes an honest byte count rather than the post-trim length.
  const extractedBytes = read.bytes.length;
  const truncated = extractedBytes < file.size;
  return { step: "ok", value: { text, extractedBytes, truncated } };
}

function buildContext(
  relativePath: string,
  mimeType: string,
  file: ResolvedFile,
  capped: ReadAndCapResult,
): ExtractedDocumentContext {
  const marker = capped.truncated
    ? buildTruncationMarker(capped.extractedBytes, file.size)
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

// Public entry: extracts text from a workspace-relative path. All error paths produce a path-
// safe DocumentExtractionFailure tagged-union (no path strings in the failure object).
export async function extractDocumentContext(
  fs: WorkspaceFs,
  workspaceRoot: string,
  relativePath: string,
  budget: DocumentExtractionBudget,
): Promise<DocumentExtractionResult> {
  const safe = resolveSafePath(fs, workspaceRoot, relativePath);
  if (isStepOk(safe)) {
    return extractFromResolvedPath(fs, relativePath, safe.resolved, budget);
  }
  return safe;
}

async function extractFromResolvedPath(
  fs: WorkspaceFs,
  relativePath: string,
  resolvedPath: string,
  budget: DocumentExtractionBudget,
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
  const capped = await readAndCap(fs, file, budget);
  if (!isStepOk(capped)) {
    return capped;
  }
  if (capped.value.extractedBytes === 0) {
    // Budget exhausted at entry: surface as a truncated zero-byte excerpt so the caller can
    // still render a chip + truncation badge. AC #3 — UI shows the doc contributed nothing.
    return {
      ok: true,
      context: {
        id: randomUUID(),
        displayName: basename(relativePath),
        mimeType: mimeResult.mimeType,
        sizeBytes: file.size,
        extractedBytes: 0,
        truncated: true,
        truncationMarker: buildTruncationMarker(0, file.size),
        text: "",
      },
    };
  }
  return { ok: true, context: buildContext(relativePath, mimeResult.mimeType, file, capped.value) };
}
