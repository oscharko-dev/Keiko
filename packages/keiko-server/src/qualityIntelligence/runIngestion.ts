// Quality Intelligence run-source ingestion (Epic #270, Issue #278).
//
// Converts the inline sources of a start-run request into content-bearing evidence atoms +
// browser-safe source envelopes, reusing the pure-domain ingestion + hardening helpers from
// `@oscharko-dev/keiko-quality-intelligence`. The server tier owns IO (it is the only layer that
// may touch the filesystem); the pure domain owns splitting + hashing. Oversize and unsupported
// inputs fail with user-actionable errors (#278 AC) before any model prompt is built.

import { dirname, isAbsolute, relative, resolve } from "node:path";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import { redact, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  QualityIntelligenceGeneration,
  QualityIntelligenceHardening,
} from "@oscharko-dev/keiko-quality-intelligence";
import {
  detectWorkspaceAt,
  discoverWithStats,
  buildContextPackFromFiles,
  readWorkspaceFile,
  isDenied,
  DEFAULT_CONTEXT_REQUEST,
  DEFAULT_READ_OPTIONS,
  WorkspaceError,
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  WorkspaceReadError,
} from "@oscharko-dev/keiko-workspace";
import type { QualityIntelligenceIngestedAtom } from "@oscharko-dev/keiko-workflows";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceStartRunRequest,
} from "@oscharko-dev/keiko-contracts";
import type { CapsuleResolver } from "./capsuleAdapter.js";

const MAX_TOTAL_ATOMS = 120;
const MAX_LABEL_CHARS = 120;
// Mirrors the Chat multi-source cap (MAX_CONNECTED_SOURCES / MAX_SCOPES = 16). Sources beyond this
// are dropped before ingestion with a user-actionable coverage notice (Epic #729, Issue #730).
const MAX_QI_SOURCES = 16;

/**
 * Fair per-source atom budget — mirrors Chat's splitExplorationBudget floor-division semantics
 * (grounded-qa-multi-source.ts): the global budget is shared evenly so no single source starves the
 * others. A single source keeps the whole budget.
 */
function perSourceAtomBudget(total: number, sourceCount: number): number {
  if (sourceCount <= 1) return total;
  return Math.max(1, Math.floor(total / sourceCount));
}

export class QiIngestionError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "QiIngestionError";
  }
}

export interface QiSourceSummary {
  readonly label: string;
  readonly kind: QualityIntelligenceInlineSource["kind"];
  readonly atomCount: number;
}

export interface QiIngestionResult {
  readonly envelopes: readonly QI.QualityIntelligenceSourceEnvelope[];
  readonly ingestedAtoms: readonly QualityIntelligenceIngestedAtom[];
  readonly provenanceRefs: {
    readonly envelopeIds: readonly string[];
    readonly auditSummaryId: QI.QualityIntelligenceAuditSummaryId;
  };
  readonly sourceSummaries: readonly QiSourceSummary[];
  /** Number of sources dropped because the request exceeded MAX_QI_SOURCES (Epic #729). */
  readonly droppedSourceCount: number;
}

const sanitiseLabel = (label: string): string => {
  const trimmed = label.replace(/https?:\/\/\S+/giu, "").trim();
  const safe = trimmed.length === 0 ? "Untitled source" : trimmed;
  return safe.length > MAX_LABEL_CHARS ? `${safe.slice(0, MAX_LABEL_CHARS - 1)}…` : safe;
};

const envelopeIdFor = (
  index: number,
  label: string,
  content: string,
): QI.QualityIntelligenceSourceEnvelopeId => {
  const digest = sha256Hex(`qi-src-v1|${String(index)}|${label}|${content}`).slice(0, 24);
  return QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(`qi-src-${digest}`);
};

const auditSummaryIdFor = (runId: string): QI.QualityIntelligenceAuditSummaryId =>
  QualityIntelligence.asQualityIntelligenceAuditSummaryId(
    `qi-audit-${sha256Hex(runId).slice(0, 24)}`,
  );

interface OneSource {
  readonly envelope: QI.QualityIntelligenceSourceEnvelope;
  readonly atoms: readonly QualityIntelligenceIngestedAtom[];
}

function ingestRequirements(
  source: Extract<QualityIntelligenceInlineSource, { kind: "requirements" }>,
  index: number,
  registeredAt: string,
): OneSource {
  const text = typeof source.text === "string" ? source.text : "";
  const oversize = QualityIntelligenceHardening.assertSourceSize(text);
  if (!oversize.ok) {
    throw new QiIngestionError(
      "QI_SOURCE_TOO_LARGE",
      "A requirements source exceeds the size limit.",
    );
  }
  const label = sanitiseLabel(source.label);
  const envelopeId = envelopeIdFor(index, label, text);
  const atoms = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(text, { envelopeId });
  if (atoms.length === 0) {
    throw new QiIngestionError(
      "QI_SOURCE_EMPTY",
      `Source "${label}" produced no usable requirement statements.`,
    );
  }
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "human-context",
    displayLabel: label,
    provenance: {
      origin: "requirements",
      registeredAt,
      integrityHashSha256Hex: sha256Hex(text),
    },
    localRef: String(envelopeId),
  };
  return { envelope, atoms };
}

const WORKSPACE_BUDGET_BYTES = 196_608;
const WORKSPACE_MAX_BYTES_PER_FILE = 16_384;
const CODE_EXTENSION =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rb|rs|cs|cpp|cc|c|h|hpp|kt|swift|php|scala|sql)$/iu;

const atomKindForPath = (path: string): "code-fragment" | "document-excerpt" =>
  CODE_EXTENSION.test(path) ? "code-fragment" : "document-excerpt";

const workspaceAtom = (
  entry: { readonly path: string; readonly excerpt: string },
  envelopeId: QI.QualityIntelligenceSourceEnvelopeId,
  index: number,
): QualityIntelligenceIngestedAtom => {
  // entry.excerpt is already redacted by keiko-workspace; prefix the path so the model can
  // attribute generated cases to a file.
  const canonicalText = `${entry.path}\n${entry.excerpt}`;
  const digest = sha256Hex(
    `qi-atom-ws-v1|${String(envelopeId)}|${String(index)}|${entry.path}`,
  ).slice(0, 32);
  const atom: QI.QualityIntelligenceEvidenceAtom = {
    kind: atomKindForPath(entry.path),
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(`qi-atom-${digest}`),
    sourceEnvelopeId: envelopeId,
    canonicalHashSha256Hex: sha256Hex(canonicalText),
    redactionStatus: "redacted",
    lifecycleStatus: "draft",
  };
  return { atom, canonicalText };
};

// Ingest a local folder by REUSING keiko-workspace traversal + redaction (no independent
// repository traversal — Issue #278 stop condition). Each selected, already-redacted context
// entry becomes one content-bearing atom under a single repository-context envelope.
function ingestWorkspace(
  source: Extract<QualityIntelligenceInlineSource, { kind: "workspace" }>,
  index: number,
  registeredAt: string,
): OneSource {
  const label = sanitiseLabel(source.label);
  let workspace: ReturnType<typeof detectWorkspaceAt>;
  try {
    workspace = detectWorkspaceAt(source.path);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw new QiIngestionError(
        "QI_WORKSPACE_NOT_FOUND",
        "The selected folder could not be opened as a workspace.",
      );
    }
    throw error;
  }
  const { files } = discoverWithStats(workspace, DEFAULT_CONTEXT_REQUEST.discovery);
  const pack = buildContextPackFromFiles(
    workspace,
    {
      ...DEFAULT_CONTEXT_REQUEST,
      budgetBytes: WORKSPACE_BUDGET_BYTES,
      maxBytesPerFile: WORKSPACE_MAX_BYTES_PER_FILE,
    },
    files,
  );
  if (pack.selected.length === 0) {
    throw new QiIngestionError("QI_SOURCE_EMPTY", `No readable files were found in "${label}".`);
  }
  const envelopeId = envelopeIdFor(index, label, pack.workspaceRoot);
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "repository-context",
    displayLabel: label,
    provenance: {
      origin: "workspace",
      registeredAt,
      integrityHashSha256Hex: sha256Hex(
        `${pack.workspaceRoot}|${pack.selected.map((e) => e.path).join(",")}`,
      ),
    },
    localRef: String(envelopeId),
  };
  const atoms = pack.selected.map((entry, i) => workspaceAtom(entry, envelopeId, i));
  return { envelope, atoms };
}

// A single Fachkonzept document may use the full per-run workspace byte budget — it is the only
// file — bounded so an oversized file fails with a user-actionable error instead of silently
// dominating the prompt budget.
const SINGLE_FILE_MAX_BYTES = WORKSPACE_BUDGET_BYTES;

// Text-like single-file documents share the strict NUL-byte check because they are expected to be
// ordinary UTF-8-ish text. Code files reuse the shared CODE_EXTENSION set above.
const DOC_TEXT_EXTENSION =
  /\.(?:md|markdown|txt|text|rst|adoc|asciidoc|json|ya?ml|xml|html?|csv|tsv|ini|toml|cfg|conf|properties|tex|org)$/iu;

// PDF and DOCX are accepted in single-file mode for parity with folder-backed QI: the read path
// stays keiko-workspace only (best-effort UTF-8/redaction reads, no dedicated document parser). A
// genuinely text-based PDF/DOCX decodes to usable prose and is ingested; a compressed/binary one
// decodes to NUL bytes + control-character noise (the real text lives in DEFLATE streams) and is
// rejected with a user-actionable error rather than silently feeding the model garbage (#713).
const BEST_EFFORT_DOCUMENT_EXTENSION = /\.(?:pdf|docx)$/iu;

const isSupportedFilePath = (path: string): boolean =>
  CODE_EXTENSION.test(path) ||
  DOC_TEXT_EXTENSION.test(path) ||
  BEST_EFFORT_DOCUMENT_EXTENSION.test(path);

const requiresStrictTextGuard = (path: string): boolean =>
  CODE_EXTENSION.test(path) || DOC_TEXT_EXTENSION.test(path);

// A best-effort document whose decoded text is dominated by binary noise carries none of the
// document's actual prose. Reject above this control-character density so the model never receives
// unusable content. Kept low (10%) but non-zero so that prose with stray control bytes still reads.
const DOCUMENT_CONTROL_CHAR_RATIO_LIMIT = 0.1;

// A control character (excluding ordinary tab/newline/CR), DEL, or the Unicode replacement char —
// the residue of decoding compressed/binary bytes as UTF-8. Printable prose (incl. umlauts/ß) is
// never counted.
function isControlChar(code: number): boolean {
  const allowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
  return (code < 0x20 && !allowedWhitespace) || code === 0x7f || code === 0xfffd;
}

// Detect a best-effort PDF/DOCX read that produced binary noise instead of extractable text. A NUL
// byte is the canonical binary marker; a high control-character ratio catches mojibake without one.
// German prose (umlauts, ß) is fully printable, so it never trips this guard.
function looksBinaryDocument(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let control = 0;
  let total = 0;
  for (const ch of text) {
    total += 1;
    if (isControlChar(ch.codePointAt(0) ?? 0)) control += 1;
  }
  return total > 0 && control / total > DOCUMENT_CONTROL_CHAR_RATIO_LIMIT;
}

const documentFormatLabel = (path: string): string => (/\.pdf$/iu.test(path) ? "PDF" : "Word");

// A best-effort PDF/DOCX whose decoded text is binary noise (compressed streams, ZIP members)
// carries none of the document's prose. Reject with actionable guidance instead of ingesting
// garbage the model cannot use — a text-based PDF/DOCX still ingests normally (#713).
function assertBestEffortDocumentText(absFile: string, label: string, text: string): void {
  if (!BEST_EFFORT_DOCUMENT_EXTENSION.test(absFile) || !looksBinaryDocument(text)) return;
  throw new QiIngestionError(
    "QI_SOURCE_UNSUPPORTED",
    `File "${label}" is a ${documentFormatLabel(absFile)} document whose text could not be ` +
      `extracted. Export it to Markdown or plain text and connect that instead.`,
  );
}

// Resolve a single file's workspace root and read it through the keiko-workspace boundary-checked
// read path (`readWorkspaceFile`: lexical containment -> deny rules -> symlink realpath gate -> size
// cap -> redaction). Every workspace failure is mapped to a safe, user-actionable QiIngestionError.
function readSingleFileContent(
  absFile: string,
  label: string,
): ReturnType<typeof readWorkspaceFile> {
  let workspace: ReturnType<typeof detectWorkspaceAt>;
  try {
    workspace = detectWorkspaceAt(dirname(absFile));
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw new QiIngestionError(
        "QI_WORKSPACE_NOT_FOUND",
        "The selected file could not be opened.",
      );
    }
    throw error;
  }
  try {
    return readWorkspaceFile(workspace, relative(workspace.root, absFile), {
      ...DEFAULT_READ_OPTIONS,
      maxBytes: SINGLE_FILE_MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw new QiIngestionError(
        "QI_SOURCE_TOO_LARGE",
        `File "${label}" exceeds the single-file size limit.`,
      );
    }
    if (error instanceof PathDeniedError || error instanceof PathEscapeError) {
      throw new QiIngestionError("QI_SOURCE_DENIED", `File "${label}" is in a protected location.`);
    }
    if (error instanceof WorkspaceReadError) {
      throw new QiIngestionError("QI_WORKSPACE_NOT_FOUND", "The selected file could not be read.");
    }
    throw error;
  }
}

// Ingest a single local file by REUSING the keiko-workspace boundary-checked read path. No
// independent file reader is added (Issue #713 stop condition). The same protections that guard the
// folder path apply identically to the single file; binary / unsupported / oversized / denied /
// empty inputs each fail with a safe, user-actionable code before any model prompt.
function ingestFile(
  source: Extract<QualityIntelligenceInlineSource, { kind: "file" }>,
  index: number,
  registeredAt: string,
): OneSource {
  const label = sanitiseLabel(source.label);
  if (!isAbsolute(source.path)) {
    throw new QiIngestionError("QI_BAD_SOURCE", "File source paths must be absolute local paths.");
  }
  const absFile = resolve(source.path);
  if (!isSupportedFilePath(absFile)) {
    throw new QiIngestionError(
      "QI_SOURCE_UNSUPPORTED",
      `File "${label}" is not a supported single-file document.`,
    );
  }
  // Defense in depth: reject any path whose segments name a denied credential directory or file
  // (.ssh, .aws, .env, *.pem, id_rsa, …) regardless of how the workspace root resolves below.
  // isDenied inspects EVERY segment of the absolute path, so a denied ancestor directory cannot be
  // hidden by rooting the read at the file's own parent directory.
  if (isDenied(absFile)) {
    throw new QiIngestionError("QI_SOURCE_DENIED", `File "${label}" is in a protected location.`);
  }
  const content = readSingleFileContent(absFile, label);
  // keiko-workspace decodes as UTF-8; a NUL byte is the canonical binary marker. A binary file that
  // slipped past the strict text/code gate (e.g. a mis-named ".txt") is rejected here, never
  // partially ingested. PDF/DOCX get a dedicated binary-noise check below (their own format).
  if (requiresStrictTextGuard(absFile) && content.text.includes("\u0000")) {
    throw new QiIngestionError(
      "QI_SOURCE_UNSUPPORTED",
      `File "${label}" appears to be binary, not text.`,
    );
  }
  assertBestEffortDocumentText(absFile, label, content.text);
  if (content.text.trim().length === 0) {
    throw new QiIngestionError("QI_SOURCE_EMPTY", `File "${label}" produced no usable content.`);
  }
  const envelopeId = envelopeIdFor(index, label, content.relativePath);
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "repository-context",
    displayLabel: label,
    provenance: {
      origin: "file",
      registeredAt,
      integrityHashSha256Hex: sha256Hex(`${content.relativePath}|${content.text}`),
    },
    localRef: String(envelopeId),
  };
  const atoms = [
    workspaceAtom({ path: content.relativePath, excerpt: content.text }, envelopeId, 0),
  ];
  return { envelope, atoms };
}

// A single capsule document may use the per-document byte budget; the whole capsule corpus is
// bounded by CAPSULE_BUDGET_BYTES. These mirror the folder path's per-file and per-run budgets so a
// large capsule degrades gracefully (a bounded prompt) instead of failing the entire run with
// QI_PROMPT_TOO_LARGE (Epic #710, Issue #717 — resilience parity with workspace/file sources).
const CAPSULE_MAX_BYTES_PER_DOCUMENT = WORKSPACE_MAX_BYTES_PER_FILE;
const CAPSULE_BUDGET_BYTES = WORKSPACE_BUDGET_BYTES;

const utf8Encoder = new TextEncoder();
const utf8ByteLength = (text: string): number => utf8Encoder.encode(text).length;

// Truncate to at most maxBytes UTF-8 bytes without splitting a multi-byte code point.
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const cp of text) {
    const cpBytes = utf8ByteLength(cp);
    if (bytes + cpBytes > maxBytes) break;
    out += cp;
    bytes += cpBytes;
  }
  return out;
}

interface CorpusDoc {
  readonly documentId: string;
  readonly text: string;
}

// Redact every member document and cap it. The LK corpus text is NOT redacted at index time — the
// workspace/file paths redact at read time via keiko-workspace, so the capsule path MUST redact
// here to honour the atom's redactionStatus:"redacted" and the epic's no-credential-leakage DoD
// (Epic #710, Issue #717). Each document is capped to the per-document budget and ingestion stops
// once the cumulative corpus reaches the per-run budget so an oversized capsule degrades gracefully.
function processCapsuleDocs(docs: readonly CorpusDoc[]): readonly CorpusDoc[] {
  const processed: CorpusDoc[] = [];
  let totalBytes = 0;
  for (const doc of docs) {
    const capped = truncateToUtf8Bytes(redact(doc.text), CAPSULE_MAX_BYTES_PER_DOCUMENT);
    if (capped.trim().length === 0) continue;
    const bytes = utf8ByteLength(capped);
    // Always include the first usable document (capped to ≤ the per-document budget); thereafter
    // stop before a document would push the corpus past the per-run budget so the total stays
    // bounded (never the raw corpus) and the run never hard-fails on QI_PROMPT_TOO_LARGE.
    if (processed.length > 0 && totalBytes + bytes > CAPSULE_BUDGET_BYTES) break;
    processed.push({ documentId: doc.documentId, text: capped });
    totalBytes += bytes;
  }
  return processed;
}

// Build one evidence atom per capsule document. Reuses the workspace atom shape so the model sees
// structured text (documentId prefix + body), consistent with folder/file sources. The text is
// already redacted + capped by processCapsuleDocs, so redactionStatus:"redacted" is truthful.
function capsuleDocAtom(
  docId: string,
  text: string,
  envelopeId: QI.QualityIntelligenceSourceEnvelopeId,
  atomIndex: number,
): QualityIntelligenceIngestedAtom {
  const canonicalText = `${docId}\n${text}`;
  const digest = sha256Hex(
    `qi-atom-cap-v1|${String(envelopeId)}|${String(atomIndex)}|${docId}`,
  ).slice(0, 32);
  const atom: QI.QualityIntelligenceEvidenceAtom = {
    kind: "document-excerpt",
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(`qi-atom-${digest}`),
    sourceEnvelopeId: envelopeId,
    canonicalHashSha256Hex: sha256Hex(canonicalText),
    redactionStatus: "redacted",
    lifecycleStatus: "draft",
  };
  return { atom, canonicalText };
}

interface CapsuleSourceBuild {
  readonly label: string;
  readonly index: number;
  readonly registeredAt: string;
  /** Stable key folded into the envelope id (the capsule id or capsule-set id). */
  readonly envelopeKey: string;
  /** Provenance origin descriptor (no secrets — an id, never content). */
  readonly origin: string;
  readonly rawDocs: readonly CorpusDoc[];
  /** User-actionable message when the connector resolves to no indexed content. */
  readonly emptyError: string;
}

// Shared builder for capsule and capsule-set sources: both resolve to a flat list of corpus
// documents that are redacted, budget-capped, and mapped to one local-knowledge-capsule envelope
// plus per-document atoms (Epic #710, Issue #716/#717).
function buildCapsuleSource(build: CapsuleSourceBuild): OneSource {
  if (build.rawDocs.length === 0) {
    throw new QiIngestionError("QI_CAPSULE_UNAVAILABLE", build.emptyError);
  }
  const docs = processCapsuleDocs(build.rawDocs);
  if (docs.length === 0) {
    throw new QiIngestionError(
      "QI_SOURCE_EMPTY",
      `Source "${build.label}" produced no usable content.`,
    );
  }
  const joinedText = docs.map((d) => d.text).join("\n");
  const envelopeId = envelopeIdFor(build.index, build.label, build.envelopeKey);
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "local-knowledge-capsule",
    displayLabel: build.label,
    provenance: {
      origin: build.origin,
      registeredAt: build.registeredAt,
      integrityHashSha256Hex: sha256Hex(joinedText),
    },
    localRef: String(envelopeId),
  };
  const atoms = docs.map((d, i) => capsuleDocAtom(d.documentId, d.text, envelopeId, i));
  return { envelope, atoms };
}

function ingestCapsule(
  source: Extract<QualityIntelligenceInlineSource, { kind: "capsule" }>,
  index: number,
  registeredAt: string,
  resolver: CapsuleResolver,
): OneSource {
  const label = sanitiseLabel(source.label);
  return buildCapsuleSource({
    label,
    index,
    registeredAt,
    envelopeKey: source.capsuleId,
    origin: `local-knowledge-capsule:${source.capsuleId}`,
    rawDocs: resolver.capsule(source.capsuleId),
    emptyError: `Capsule "${label}" has no indexed content or could not be opened.`,
  });
}

function ingestCapsuleSet(
  source: Extract<QualityIntelligenceInlineSource, { kind: "capsule-set" }>,
  index: number,
  registeredAt: string,
  resolver: CapsuleResolver,
): OneSource {
  const label = sanitiseLabel(source.label);
  return buildCapsuleSource({
    label,
    index,
    registeredAt,
    envelopeKey: source.capsuleSetId,
    origin: `local-knowledge-capsule-set:${source.capsuleSetId}`,
    rawDocs: resolver.capsuleSet(source.capsuleSetId),
    emptyError: `Capsule set "${label}" has no indexed content or could not be opened.`,
  });
}

function ingestOne(
  source: QualityIntelligenceInlineSource,
  index: number,
  registeredAt: string,
  capsuleResolver: CapsuleResolver | undefined,
): OneSource {
  switch (source.kind) {
    case "requirements":
      return ingestRequirements(source, index, registeredAt);
    case "workspace":
      return ingestWorkspace(source, index, registeredAt);
    case "file":
      return ingestFile(source, index, registeredAt);
    case "capsule":
      if (capsuleResolver === undefined) {
        throw new QiIngestionError(
          "QI_CAPSULE_UNAVAILABLE",
          "Capsule sources are unavailable: the Local Knowledge store is not configured.",
        );
      }
      return ingestCapsule(source, index, registeredAt, capsuleResolver);
    case "capsule-set":
      if (capsuleResolver === undefined) {
        throw new QiIngestionError(
          "QI_CAPSULE_UNAVAILABLE",
          "Capsule-set sources are unavailable: the Local Knowledge store is not configured.",
        );
      }
      return ingestCapsuleSet(source, index, registeredAt, capsuleResolver);
  }
}

export interface IngestInlineSourcesInput {
  readonly request: QualityIntelligenceStartRunRequest;
  readonly runId: string;
  readonly registeredAt: string;
  /** Optional capsule resolver (Epic #710, Issue #717). Absent → capsule sources throw QI_CAPSULE_UNAVAILABLE. */
  readonly capsuleResolver?: CapsuleResolver | undefined;
}

/**
 * Ingest the inline sources of a start-run request into content-bearing atoms + browser-safe
 * envelopes. Requirements text is split by the pure domain; workspace folders are read through
 * keiko-workspace traversal + redaction (no independent repository traversal). Throws
 * `QiIngestionError` with a safe, user-actionable code on empty / oversized / unreadable input.
 */
export function ingestInlineSources(input: IngestInlineSourcesInput): QiIngestionResult {
  // Read through the typed property in the loop: `Array.isArray` would widen a local binding of the
  // readonly union array to `any[]`, so the guard checks length on the typed property directly.
  const allSources: readonly QualityIntelligenceInlineSource[] = input.request.sources;
  if (allSources.length === 0) {
    throw new QiIngestionError("QI_NO_SOURCES", "At least one source is required to start a run.");
  }
  // Cap the source count BEFORE ingestion (no partial work for dropped sources), then split the
  // global atom budget fairly so no single source starves the others (Chat N+1 parity, #730).
  const sources = allSources.slice(0, MAX_QI_SOURCES);
  const droppedSourceCount = allSources.length - sources.length;
  const perSourceBudget = perSourceAtomBudget(MAX_TOTAL_ATOMS, sources.length);
  const envelopes: QI.QualityIntelligenceSourceEnvelope[] = [];
  const ingestedAtoms: QualityIntelligenceIngestedAtom[] = [];
  const sourceSummaries: QiSourceSummary[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    if (source === undefined) continue;
    const { envelope, atoms } = ingestOne(source, i, input.registeredAt, input.capsuleResolver);
    // Each source gets its fair share, bounded by the global cap so the total never exceeds it.
    const take = Math.min(perSourceBudget, MAX_TOTAL_ATOMS - ingestedAtoms.length);
    const taken = take <= 0 ? [] : atoms.slice(0, take);
    envelopes.push(envelope);
    ingestedAtoms.push(...taken);
    sourceSummaries.push({
      label: envelope.displayLabel,
      kind: source.kind,
      atomCount: taken.length,
    });
  }
  if (ingestedAtoms.length === 0) {
    throw new QiIngestionError(
      "QI_SOURCE_EMPTY",
      "No usable evidence was produced from the sources.",
    );
  }
  return {
    envelopes,
    ingestedAtoms,
    provenanceRefs: {
      envelopeIds: envelopes.map((e) => String(e.id)),
      auditSummaryId: auditSummaryIdFor(input.runId),
    },
    sourceSummaries,
    droppedSourceCount,
  };
}
