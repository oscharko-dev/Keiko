// Bounded small-document evidence for grounded Repository Search (Issue #1285).
//
// Repository Search stays code-first, but a document that the user has EXPLICITLY connected to the
// chat (a `files` scope with `explicitConnection === true`) should no longer be silently dropped
// just because it is a `.docx`, `.xlsx`, or text-layer `.pdf`. This module reads those documents
// through the existing workspace path-safety primitives, extracts a bounded text projection via
// the reused Local Knowledge parsers (keiko-local-knowledge `extractBoundedDocumentText`), redacts
// the text, and turns the result into request-local `document-extract` evidence atoms + excerpt
// windows. Documents that cannot be used produce a stable skipped-document diagnostic instead of a
// crash or a silent omission.
//
// Trust-boundary notes:
//   - The 2 MiB input ceiling is enforced via `fs.stat` BEFORE any bytes are read.
//   - Bytes are read through `resolveWithinWorkspace` + `containedRealPathInfo` + the deny-list,
//     identical to every other workspace read; denied/escaping paths never reach the parser.
//   - Extracted text is `redact()`-ed here (the Local Knowledge extractor is pure and does not
//     redact) before it enters any excerpt, so credential-shaped strings inside a document never
//     reach the prompt, the citation surface, or the evidence manifest.
//   - Nothing is persisted: no Local Knowledge capsule, vector, index, or cache is written.

import {
  extractBoundedDocumentText,
  type BoundedDocumentExtractionOutcome,
  type BoundedDocumentFormat,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  isValidScopePath,
  type CandidateFile,
  type CandidateOmissionReason,
  type EvidenceAtom,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { redact } from "@oscharko-dev/keiko-security";
import {
  containedRealPathInfo,
  evidenceAtomStableId,
  isDenied,
  resolveWithinWorkspace,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import type { ExcerptWindow } from "@oscharko-dev/keiko-workflows";
import { createHash } from "node:crypto";

// ─── Bounds ──────────────────────────────────────────────────────────────────
export const MAX_DOCUMENT_INPUT_BYTES = 2 * 1024 * 1024; // 2 MiB, enforced before parser execution
export const MAX_DOCUMENT_EXTRACTED_BYTES = 32 * 1024; // per-document extracted-text ceiling
export const MAX_TOTAL_DOCUMENT_EXTRACTED_BYTES = 64 * 1024; // per grounded request, across documents
export const MAX_DOCUMENT_WINDOW_BYTES = 8 * 1024; // per excerpt window (matches the pack assembler)
export const MAX_DOCUMENT_WINDOWS = 8; // per document
export const DOCUMENT_PARSE_TIMEOUT_MS = 5_000; // per-document wall-clock budget
export const MAX_DOCUMENT_PARSE_UNITS = 5_000; // bounds paragraphs/rows/pages parsed

const TEXT_ENCODER = new TextEncoder();

interface FormatBinding {
  readonly format: BoundedDocumentFormat;
  readonly mediaType: string;
}

const EXTENSION_BINDINGS: ReadonlyMap<string, FormatBinding> = new Map([
  [
    "docx",
    {
      format: "docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ],
  [
    "xlsx",
    {
      format: "xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ],
  ["pdf", { format: "pdf", mediaType: "application/pdf" }],
]);

// Document container formats that are deliberately out of scope for bounded extraction (legacy
// binary Office, presentations, OpenDocument, rich text, Apple iWork). A connected file with one of
// these extensions is reported with a stable `unsupported-format` diagnostic instead of being
// silently dropped on the binary excerpt path — Repository Search does not parse these (Issue
// #1285 Out of Scope), and Local Knowledge remains the path for them.
const UNSUPPORTED_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "doc",
  "dot",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "pages",
  "key",
  "numbers",
]);

function extensionOf(scopePath: string): string {
  const name = scopePath.slice(scopePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function documentBindingForPath(scopePath: string): FormatBinding | undefined {
  return EXTENSION_BINDINGS.get(extensionOf(scopePath));
}

// True when `scopePath` is any document the bounded-extraction path owns — either a supported small
// document (DOCX/XLSX/PDF) or a known-but-unsupported document format. The orchestrator uses this
// to keep every such file off the code-first excerpt-read path so document handling (extraction or
// a stable unsupported diagnostic) is the single source of truth (Issue #1285).
export function isConnectedDocumentPath(scopePath: string): boolean {
  const extension = extensionOf(scopePath);
  return EXTENSION_BINDINGS.has(extension) || UNSUPPORTED_DOCUMENT_EXTENSIONS.has(extension);
}

// ─── Public surface ────────────────────────────────────────────────────────────

export interface DocumentEvidenceInputs {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
}

export interface DocumentEvidenceResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly candidates: readonly CandidateFile[];
  readonly excerpts: ReadonlyMap<string, readonly ExcerptWindow[]>;
  readonly omitted: readonly OmittedContextEntry[];
  readonly uncertainty: readonly UncertaintyMarker[];
}

const EMPTY_RESULT: DocumentEvidenceResult = {
  atoms: [],
  candidates: [],
  excerpts: new Map(),
  omitted: [],
  uncertainty: [],
};

// ─── Outcome → omission reason ───────────────────────────────────────────────────

function omissionReasonForOutcome(
  outcome: Exclude<BoundedDocumentExtractionOutcome, "extracted">,
): CandidateOmissionReason {
  switch (outcome) {
    case "oversized":
      return "size-exceeded";
    case "unsupported-format":
      return "unsupported-format";
    // A scanned PDF and an empty-but-valid container are both "supported container, no extractable
    // text"; they share the no-text-layer diagnostic so the user sees one stable message.
    case "no-text-layer":
    case "empty":
      return "no-text-layer";
    case "malformed":
      return "malformed-document";
    case "encrypted":
      return "encrypted-document";
    case "timed-out":
      return "budget-exhausted";
  }
}

// ─── Excerpt windowing over extracted text ───────────────────────────────────────

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

// Split already-redacted extracted text into non-overlapping windows, each at most
// MAX_DOCUMENT_WINDOW_BYTES and capped at MAX_DOCUMENT_WINDOWS. Line numbers index the extracted
// text projection itself (DOCX paragraph / XLSX row / PDF page lines), so a citation such as
// `[report.docx:1-40]` references a reproducible span of the extracted text rather than an
// original on-screen line.
function windowExtractedText(text: string): readonly ExcerptWindow[] {
  const lines = text.split("\n");
  const windows: ExcerptWindow[] = [];
  let startIndex = 0;
  let buffer: string[] = [];
  let bufferBytes = 0;

  const flush = (endIndexExclusive: number): void => {
    if (buffer.length === 0) {
      return;
    }
    windows.push({
      startLine: startIndex + 1,
      endLine: endIndexExclusive,
      content: buffer.join("\n"),
    });
    buffer = [];
    bufferBytes = 0;
    startIndex = endIndexExclusive;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (windows.length >= MAX_DOCUMENT_WINDOWS) {
      break;
    }
    const line = lines[i] ?? "";
    const lineBytes = utf8ByteLength(line) + 1;
    if (buffer.length > 0 && bufferBytes + lineBytes > MAX_DOCUMENT_WINDOW_BYTES) {
      flush(i);
      if (windows.length >= MAX_DOCUMENT_WINDOWS) {
        break;
      }
    }
    buffer.push(line);
    bufferBytes += lineBytes;
  }
  if (windows.length < MAX_DOCUMENT_WINDOWS) {
    flush(startIndex + buffer.length);
  }
  return windows;
}

// ─── Atom construction ───────────────────────────────────────────────────────────

function documentQueryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "document-extract",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function documentAtom(
  scope: SelectedScope,
  scopePath: string,
  window: ExcerptWindow,
  queryFingerprint: string,
  nowMs: number,
): EvidenceAtom {
  const lineRange = { startLine: window.startLine, endLine: window.endLine };
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange,
      provenanceKind: "document-extract",
      provenanceTool: "repo.documentExtract",
      queryFingerprint,
    }),
    scopePath,
    lineRange,
    score: 1,
    provenance: {
      kind: "document-extract",
      tool: "repo.documentExtract",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs,
    ledgerRef: undefined,
  };
}

function documentCandidate(scopePath: string): CandidateFile {
  return {
    scopePath,
    score: 1,
    signals: [{ name: "document-extract", value: 1 }],
    omitted: undefined,
  };
}

// ─── Per-document processing ─────────────────────────────────────────────────────

interface MutableEvidence {
  readonly atoms: EvidenceAtom[];
  readonly candidates: CandidateFile[];
  readonly excerpts: Map<string, readonly ExcerptWindow[]>;
  readonly omitted: OmittedContextEntry[];
  totalExtractedBytes: number;
}

function omit(
  acc: MutableEvidence,
  scopePath: string,
  reason: CandidateOmissionReason,
  nowMs: number,
): void {
  acc.omitted.push({ scopePath, reason, omittedAtMs: nowMs });
}

interface ResolvedDocument {
  readonly absolutePath: string;
  readonly realRelative: string;
  readonly sizeBytes: number;
}

function resolveDocument(
  inputs: DocumentEvidenceInputs,
  scopePath: string,
): ResolvedDocument | "denied" | "unreadable" {
  try {
    const absolute = resolveWithinWorkspace(inputs.searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(inputs.fs, inputs.searchScope.workspace.root, absolute);
    if (isDenied(contained.realRelative)) {
      return "denied";
    }
    const stat = inputs.fs.stat(contained.path);
    if (!stat.isFile) {
      return "unreadable";
    }
    return {
      absolutePath: contained.path,
      realRelative: contained.realRelative,
      sizeBytes: stat.size,
    };
  } catch {
    return "denied";
  }
}

async function readDocumentBytes(
  inputs: DocumentEvidenceInputs,
  absolutePath: string,
  sizeBytes: number,
): Promise<Uint8Array | "unreadable"> {
  if (inputs.fs.readFileBytes === undefined) {
    return "unreadable";
  }
  try {
    return await inputs.fs.readFileBytes(
      absolutePath,
      Math.min(sizeBytes, MAX_DOCUMENT_INPUT_BYTES),
    );
  } catch {
    return "unreadable";
  }
}

// Resolves and reads the document bytes through the workspace path-safety primitives, returning the
// bytes or the precise omission reason for an unusable path.
async function loadDocumentBytes(
  inputs: DocumentEvidenceInputs,
  scopePath: string,
): Promise<Uint8Array | CandidateOmissionReason> {
  const resolved = resolveDocument(inputs, scopePath);
  if (resolved === "denied") {
    return "outside-scope";
  }
  if (resolved === "unreadable") {
    return "tool-unavailable";
  }
  if (resolved.sizeBytes > MAX_DOCUMENT_INPUT_BYTES) {
    return "size-exceeded";
  }
  const bytes = await readDocumentBytes(inputs, resolved.absolutePath, resolved.sizeBytes);
  return bytes === "unreadable" ? "tool-unavailable" : bytes;
}

// Redacts the extracted text and records the document atoms + excerpt windows, or an omission when
// redaction left no usable text.
function recordExtractedDocument(
  inputs: DocumentEvidenceInputs,
  scopePath: string,
  text: string,
  queryFingerprint: string,
  acc: MutableEvidence,
  nowMs: number,
): void {
  // The Local Knowledge extractor is pure and does NOT redact; the document text is redacted here,
  // before it enters any excerpt window, prompt, or citation surface (Issue #1285 trust boundary).
  const windows = windowExtractedText(redact(text));
  if (windows.length === 0) {
    // All extracted text was redaction-stripped — disclose the document was reachable but unusable.
    omit(acc, scopePath, "redacted-only", nowMs);
    return;
  }
  for (const window of windows) {
    acc.atoms.push(documentAtom(inputs.scope, scopePath, window, queryFingerprint, nowMs));
  }
  acc.candidates.push(documentCandidate(scopePath));
  acc.excerpts.set(scopePath, windows);
  acc.totalExtractedBytes += windows.reduce(
    (sum, window) => sum + utf8ByteLength(window.content),
    0,
  );
}

async function processDocument(
  inputs: DocumentEvidenceInputs,
  scopePath: string,
  binding: FormatBinding,
  queryFingerprint: string,
  acc: MutableEvidence,
): Promise<void> {
  const nowMs = inputs.nowMs();
  const remainingBudget = MAX_TOTAL_DOCUMENT_EXTRACTED_BYTES - acc.totalExtractedBytes;
  if (remainingBudget <= 0) {
    omit(acc, scopePath, "budget-exhausted", nowMs);
    return;
  }
  const loaded = await loadDocumentBytes(inputs, scopePath);
  if (typeof loaded === "string") {
    omit(acc, scopePath, loaded, nowMs);
    return;
  }
  const extraction = await extractBoundedDocumentText(
    { bytes: loaded, extension: binding.format, mediaType: binding.mediaType },
    {
      maxInputBytes: MAX_DOCUMENT_INPUT_BYTES,
      maxOutputBytes: Math.min(MAX_DOCUMENT_EXTRACTED_BYTES, remainingBudget),
      maxUnits: MAX_DOCUMENT_PARSE_UNITS,
      timeoutMs: DOCUMENT_PARSE_TIMEOUT_MS,
      now: inputs.nowMs,
      ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
    },
  );
  if (extraction.outcome !== "extracted") {
    omit(acc, scopePath, omissionReasonForOutcome(extraction.outcome), nowMs);
    return;
  }
  recordExtractedDocument(inputs, scopePath, extraction.text, queryFingerprint, acc, nowMs);
}

// ─── Public entry ────────────────────────────────────────────────────────────────

function disclosureMarker(omittedCount: number, nowMs: number): UncertaintyMarker {
  return {
    kind: "scope-incomplete",
    claim: `${String(
      omittedCount,
    )} connected document(s) were skipped: Repository Search reads text, code, and small DOCX/XLSX/text-layer-PDF files only.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

// Processes one connected scope entry: a supported document is extracted, a known-unsupported
// document format is reported, and anything else (code/text) is left to the code-first path.
async function processConnectedEntry(
  inputs: DocumentEvidenceInputs,
  entry: string,
  seen: Set<string>,
  queryFingerprint: string,
  acc: MutableEvidence,
): Promise<void> {
  if (!isValidScopePath(entry, { mustBeRelative: true })) {
    return;
  }
  const scopePath = entry.replace(/\\/gu, "/");
  if (seen.has(scopePath)) {
    return;
  }
  seen.add(scopePath);
  const binding = documentBindingForPath(scopePath);
  if (binding !== undefined) {
    await processDocument(inputs, scopePath, binding, queryFingerprint, acc);
    return;
  }
  if (UNSUPPORTED_DOCUMENT_EXTENSIONS.has(extensionOf(scopePath))) {
    // A known-but-unsupported document container (e.g. legacy .doc): emit a stable diagnostic.
    omit(acc, scopePath, "unsupported-format", inputs.nowMs());
  }
}

// Enumerates the explicitly-connected document files in a `files` scope, extracts bounded redacted
// text from each, and returns request-local document evidence ready to merge into the grounded
// context-pack assembly. Returns empty evidence for any scope that is not an explicit `files`
// connection, keeping whole-workspace and directory scopes on the unchanged code-first path.
export async function collectConnectedDocumentEvidence(
  inputs: DocumentEvidenceInputs,
): Promise<DocumentEvidenceResult> {
  if (inputs.scope.kind !== "files" || inputs.scope.explicitConnection !== true) {
    return EMPTY_RESULT;
  }
  const queryFingerprint = documentQueryFingerprint(inputs.query);
  const acc: MutableEvidence = {
    atoms: [],
    candidates: [],
    excerpts: new Map(),
    omitted: [],
    totalExtractedBytes: 0,
  };
  const seen = new Set<string>();
  for (const entry of inputs.scope.relativePaths) {
    if (inputs.signal?.aborted === true) {
      break;
    }
    await processConnectedEntry(inputs, entry, seen, queryFingerprint, acc);
  }
  const uncertainty =
    acc.omitted.length > 0 ? [disclosureMarker(acc.omitted.length, inputs.nowMs())] : [];
  return {
    atoms: acc.atoms,
    candidates: acc.candidates,
    excerpts: acc.excerpts,
    omitted: acc.omitted,
    uncertainty,
  };
}
