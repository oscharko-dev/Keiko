// Quality Intelligence run-source ingestion (Epic #270, Issue #278).
//
// Converts the inline sources of a start-run request into content-bearing evidence atoms +
// browser-safe source envelopes, reusing the pure-domain ingestion + hardening helpers from
// `@oscharko-dev/keiko-quality-intelligence`. The server tier owns IO (it is the only layer that
// may touch the filesystem); the pure domain owns splitting + hashing. Oversize and unsupported
// inputs fail with user-actionable errors (#278 AC) before any model prompt is built.

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import { redact, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  QualityIntelligenceGeneration,
  QualityIntelligenceHardening,
  QualityIntelligenceFigma,
  isUnsafeFormatCodePoint,
  stripUnsafeFormatChars,
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
import type { FigmaSnapshotLoader, FigmaVisionHintProvider } from "./figmaSnapshotAdapter.js";
import type { FigmaSnapshotRecord } from "@oscharko-dev/keiko-evidence";

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

// Global per-run evidence byte budget. Each source kind (workspace / file / capsule /
// figma-snapshot) was previously allowed ~192KB INDEPENDENTLY, so N large sources summed to N×192KB
// and blew the model prompt cap (MAX_PROMPT_BYTES = 256KB) — failing the entire N+1 run with
// QI_PROMPT_TOO_LARGE (Epic #729 headline). The byte budget is now a single global pool split fairly
// across sources, mirroring the atom-budget split, so the merged evidence text stays bounded
// regardless of N. A single source keeps the full budget (identical to the prior single-source
// behaviour). figma-snapshot uses the same split via figmaScreenDocs (mirrors processCapsuleDocs).
const EVIDENCE_BUDGET_BYTES = 196_608;
// Never starve a source below this many bytes — a tiny share is still usable context.
const MIN_SOURCE_BUDGET_BYTES = 4_096;
// Bound productive vision calls for one Figma snapshot source. The deterministic structural
// baseline still covers every parseable screen; vision hints are additive and sampled first-in-order.
const MAX_FIGMA_VISION_AUGMENTED_SCREENS = 12;

/**
 * Fair per-source UTF-8 byte budget — the byte analogue of {@link perSourceAtomBudget}. Floor-divides
 * the global evidence byte pool across sources (Chat byte-split parity) with a non-zero floor so the
 * summed canonical text of all sources stays under the model prompt ceiling and no single large
 * source can exhaust the budget for the others (Epic #729 / #730 multi-source containment).
 */
function perSourceByteBudget(sourceCount: number): number {
  if (sourceCount <= 1) return EVIDENCE_BUDGET_BYTES;
  return Math.max(MIN_SOURCE_BUDGET_BYTES, Math.floor(EVIDENCE_BUDGET_BYTES / sourceCount));
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

/**
 * A connected source that could not be ingested (empty, denied, binary, unavailable capsule, …) and
 * was SKIPPED so the remaining sources still produce a run (Epic #729 N+1 resilience / Chat parity).
 * Carries only a sanitised label + the safe coded reason — never source content. The run still fails
 * (re-raising the first coded error) when EVERY source is skipped.
 */
export interface QiSkippedSource {
  readonly label: string;
  readonly kind: QualityIntelligenceInlineSource["kind"];
  readonly code: string;
  readonly message: string;
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
  /**
   * Sources that ingested to nothing usable and were skipped (a subset of the connected sources),
   * so the healthy sources still produced the run (Epic #729 N+1 resilience). Empty on the happy path.
   */
  readonly skippedSources: readonly QiSkippedSource[];
}

// Credential token shapes mirrored from keiko-contracts `fieldLooksUnsafe` so a connected
// source's display label can never echo a secret back to the browser-surfaced envelope
// (#277/#278 envelope display-surface invariant — the label is the only user-derived envelope
// field; localRef/origin/integrityHash are server-built and hash-derived).
const CREDENTIAL_LABEL_SHAPES: readonly RegExp[] = [
  /AKIA[0-9A-Z]{12,}/gu,
  /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{10,}/gu,
  /sk-[A-Za-z0-9]{16,}/gu,
  /\bBearer\s+\S+/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
];

// Make a source label single-line AND spoof-safe with one code-point scan (the `no-control-regex`
// lint rule forbids a control-range regex literal, and a scan is the established in-package idiom —
// mirrors generationPort.scrubEvidenceText):
//   - C0 controls (incl. tab/newline/CR) and DEL become a SPACE, so a multi-line or control-laden
//     label can never glue a second line of content into the streamed displayLabel (#277/#278).
//   - Bidi overrides/isolates, zero-width/BOM, LRM/RLM, the Arabic letter mark, and C1 controls are
//     DROPPED outright. These are invisible or reorder surrounding text, so a source filename /
//     capsule id cannot smuggle a right-to-left or zero-width spoof into the browser-streamed
//     envelope display surface. The drop set is the SHARED `isUnsafeFormatCodePoint` predicate used
//     by the candidate-text scrubber (keiko-quality-intelligence stripUnsafeFormatChars), so the
//     source-label path is symmetric with the persisted/exported candidate-text path (Epic #729;
//     the bidi/zero-width display-hygiene class of #280/#284). C0/DEL are handled first (→ space)
//     because a single-line label spaces line breaks rather than gluing them.
function stripUnsafeLabelChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f) {
      out += " ";
      continue;
    }
    if (isUnsafeFormatCodePoint(cp)) {
      continue;
    }
    out += ch;
  }
  return out;
}

const sanitiseLabel = (label: string): string => {
  // Strip any URL authority — ANY scheme (http, file, s3, ftp, …), not just http(s) — plus the
  // well-known credential token shapes, so a browser-supplied label never carries a URL or secret
  // into the envelope display surface that is streamed back to the client (#277/#278).
  let cleaned = label.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, " ");
  for (const shape of CREDENTIAL_LABEL_SHAPES) cleaned = cleaned.replace(shape, " ");
  // Map control characters (newline, CR, tab, NUL, DEL, …) to spaces and DROP bidi-override,
  // zero-width, BOM, and C1 spoofing code points so a multi-line, control-laden, or
  // visually-reordered label can never carry a second line of content into — or spoof the reading
  // order of — the browser-streamed envelope displayLabel. Without the control→space step the
  // absolute-path basename-collapse below (which splits on "/" only) would keep a trailing
  // "\n<more content>" glued inside the final path segment, defeating the basename defence; without
  // the bidi/zero-width drop a crafted filename could reorder the displayed label (#277/#278
  // envelope display-surface invariant; Epic #729 symmetry with the candidate-text scrubber).
  cleaned = stripUnsafeLabelChars(cleaned);
  cleaned = cleaned.trim();
  // Collapse an absolute POSIX / Windows-drive / UNC path label to its final segment so the
  // display label never leaks the filesystem layout (the basename is the useful display token).
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(cleaned)) {
    const segments = cleaned.split(/[\\/]/u).filter((s) => s.length > 0);
    cleaned = (segments[segments.length - 1] ?? "").trim();
  }
  const safe = cleaned.length === 0 ? "Untitled source" : cleaned;
  return safe.length > MAX_LABEL_CHARS ? `${safe.slice(0, MAX_LABEL_CHARS - 1)}…` : safe;
};

// Reject a source whose absolute path (any segment) names a denied credential location. isDenied
// inspects EVERY path segment, so a denied ancestor cannot be hidden by rooting a read deeper. Shared
// by the folder and single-file paths so both honour the same containment guard (Epic #729 security).
// Also rejects the symlink variant (assertRealPathNotDenied) so a benign-named link cannot resolve
// into a protected location.
function assertNotDenied(absPath: string, label: string, noun: string): void {
  if (isDenied(absPath)) {
    throw new QiIngestionError(
      "QI_SOURCE_DENIED",
      `${noun} "${label}" is in a protected location.`,
    );
  }
  assertRealPathNotDenied(absPath, label, noun);
}

// Defense-in-depth against a symlinked workspace root. The keiko-workspace deny gate (readWorkspaceFile)
// inspects only the path RELATIVE to the realpath'd root, so a denied segment AT or ABOVE the connected
// root is invisible to it: a benign-named "~/docs" symlink whose real target is "~/.aws" lets a
// supported file inside it read through to the model, even though the lexical assertNotDenied above sees
// only "docs". Re-running the deny gate over the REAL (symlink-resolved) absolute path rejects it. The
// lexical check above already covers the no-symlink case, so this only ADDS denials when realpath
// diverges into a protected location; a non-existent target surfaces later as NOT_FOUND, so a failed
// realpath is a deliberate no-op here. (#713 single-file security review: "deny-list still applies";
// #729 folder-root parity — both ingest paths share this boundary blind spot.)
function assertRealPathNotDenied(absPath: string, label: string, noun: string): void {
  let realPath: string;
  try {
    realPath = realpathSync(absPath);
  } catch {
    return;
  }
  if (realPath !== absPath && isDenied(realPath)) {
    throw new QiIngestionError(
      "QI_SOURCE_DENIED",
      `${noun} "${label}" is in a protected location.`,
    );
  }
}

// Escape the field delimiter ("|") and the escape character ("\") in each user/path-controlled
// field so a label or content value can never inject a raw delimiter and forge another source's
// envelope id. The strictly-increasing loop index already disambiguates sources today; escaping
// makes the pre-image injective on its own — robust even if the fields were ever reordered —
// closing the latent cross-source provenance-spoofing surface flagged by the #732 composition
// security audit. A value with no "\" or "|" encodes to itself, so clean labels/paths keep their
// existing envelope id (and the atom ids derived from it), preserving re-check stability.
const escapeEnvelopeField = (value: string): string =>
  value.split("\\").join("\\\\").split("|").join("\\|");

export const envelopeIdFor = (
  index: number,
  label: string,
  content: string,
): QI.QualityIntelligenceSourceEnvelopeId => {
  const digest = sha256Hex(
    `qi-src-v1|${String(index)}|${escapeEnvelopeField(label)}|${escapeEnvelopeField(content)}`,
  ).slice(0, 24);
  return QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(`qi-src-${digest}`);
};

const REQUIREMENTS_ENVELOPE_PREFIX = "qi-src-req-";

const requirementsEnvelopeIdFor = (index: number): QI.QualityIntelligenceSourceEnvelopeId => {
  const digest = sha256Hex(`qi-src-req-v1|${String(index)}`).slice(0, 24);
  return QualityIntelligence.asQualityIntelligenceSourceEnvelopeId(
    `${REQUIREMENTS_ENVELOPE_PREFIX}${digest}`,
  );
};

const stableLocalRef = (prefix: string, value: string): string =>
  `${prefix}:${sha256Hex(value).slice(0, 24)}`;

const replacementGroupIdFor = (
  envelopeId: QI.QualityIntelligenceSourceEnvelopeId,
  stableKey: string,
): string => sha256Hex(`qi-replace-v1|${String(envelopeId)}|${stableKey}`);

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
  const envelopeId = requirementsEnvelopeIdFor(index);
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
    localRef: `req:${String(index)}`,
  };
  return {
    envelope,
    atoms: atoms.map((entry, ordinal) =>
      Object.freeze({
        ...entry,
        replacementGroupId: replacementGroupIdFor(envelopeId, `requirements:${String(index)}`),
        replacementOrdinal: ordinal,
      }),
    ),
  };
}

const WORKSPACE_BUDGET_BYTES = 196_608;
const WORKSPACE_MAX_BYTES_PER_FILE = 16_384;
const CODE_EXTENSION =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|go|rb|rs|cs|cpp|cc|c|h|hpp|kt|swift|php|scala|sql)$/iu;
const REQUIREMENT_TEXT_EXTENSION = /\.(?:md|markdown|txt|text|rst|adoc|asciidoc|org)$/iu;

const atomKindForPath = (path: string): "code-fragment" | "document-excerpt" =>
  CODE_EXTENSION.test(path) ? "code-fragment" : "document-excerpt";

const workspaceAtom = (
  entry: { readonly path: string; readonly excerpt: string },
  envelopeId: QI.QualityIntelligenceSourceEnvelopeId,
): QualityIntelligenceIngestedAtom => {
  // entry.excerpt is already redacted by keiko-workspace; prefix the path so the model can
  // attribute generated cases to a file.
  const canonicalText = `${entry.path}\n${entry.excerpt}`;
  // The atom id is derived from the file PATH only — never the file's position in the discovery
  // order (Epic #735 drift correctness). A path is unique within a workspace envelope, so the id is
  // stable when other files are added/removed/reordered; an unchanged file keeps its id (and its
  // canonicalHash), so drift detection never falsely orphans it. Content changes are caught by the
  // canonicalHash diff, not the id. (v1 folded in the array index, which shifted on add/remove and
  // false-orphaned every candidate of an otherwise-unchanged folder — see reCheckRoutes drift.)
  const digest = sha256Hex(`qi-atom-ws-v2|${String(envelopeId)}|${entry.path}`).slice(0, 32);
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

const requirementAtomIdFor = (
  envelopeId: QI.QualityIntelligenceSourceEnvelopeId,
  path: string,
  statement: string,
): QI.QualityIntelligenceEvidenceAtomId => {
  const digest = sha256Hex(`qi-atom-doc-req-v1|${String(envelopeId)}|${path}|${statement}`).slice(
    0,
    32,
  );
  return QualityIntelligence.asQualityIntelligenceEvidenceAtomId(`qi-atom-${digest}`);
};

const stripRequirementDocumentStructure = (text: string): string =>
  text
    .split(/\r?\n/u)
    .filter((line) => !/^\s{0,3}#{1,6}\s+\S/u.test(line))
    .join("\n");

function documentRequirementAtoms(
  entry: { readonly path: string; readonly excerpt: string },
  envelopeId: QI.QualityIntelligenceSourceEnvelopeId,
): readonly QualityIntelligenceIngestedAtom[] {
  if (!REQUIREMENT_TEXT_EXTENSION.test(entry.path)) return Object.freeze([]);
  const split = QualityIntelligenceGeneration.splitRequirementsIntoAtoms(
    stripRequirementDocumentStructure(entry.excerpt),
    {
      envelopeId,
      maxAtoms: MAX_TOTAL_ATOMS,
    },
  );
  if (split.length <= 1) return Object.freeze([]);
  return Object.freeze(
    split.map((requirement, ordinal) => {
      const canonicalText = `${entry.path}\n${requirement.canonicalText}`;
      const atom: QI.QualityIntelligenceRequirementAtom = {
        kind: "requirement",
        id: requirementAtomIdFor(envelopeId, entry.path, requirement.canonicalText),
        sourceEnvelopeId: envelopeId,
        canonicalHashSha256Hex: sha256Hex(canonicalText),
        redactionStatus: "redacted",
        lifecycleStatus: "draft",
      };
      return Object.freeze({
        atom: Object.freeze(atom),
        canonicalText,
        replacementGroupId: replacementGroupIdFor(envelopeId, `document:${entry.path}`),
        replacementOrdinal: ordinal,
      });
    }),
  );
}

function atomsForWorkspaceEntry(
  entry: { readonly path: string; readonly excerpt: string },
  envelopeId: QI.QualityIntelligenceSourceEnvelopeId,
): readonly QualityIntelligenceIngestedAtom[] {
  const requirementAtoms = documentRequirementAtoms(entry, envelopeId);
  return requirementAtoms.length > 0
    ? requirementAtoms
    : Object.freeze([workspaceAtom(entry, envelopeId)]);
}

// Ingest a local folder by REUSING keiko-workspace traversal + redaction (no independent
// repository traversal — Issue #278 stop condition). Each selected, already-redacted context
// entry becomes one content-bearing atom under a single repository-context envelope.
function ingestWorkspace(
  source: Extract<QualityIntelligenceInlineSource, { kind: "workspace" }>,
  index: number,
  registeredAt: string,
  byteBudget: number,
): OneSource {
  const label = sanitiseLabel(source.label);
  // Reject a folder whose ROOT names a denied credential location (lexically or via a symlinked root):
  // connecting e.g. ~/.aws AS A FOLDER would otherwise ingest credential files whose RELATIVE paths
  // ("credentials", "config.json") never trip the per-file deny check (#729 security).
  assertNotDenied(resolve(source.path), label, "Folder");
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
      budgetBytes: Math.min(WORKSPACE_BUDGET_BYTES, byteBudget),
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
    localRef: stableLocalRef("workspace", pack.workspaceRoot),
  };
  const atoms = pack.selected.flatMap((entry) => atomsForWorkspaceEntry(entry, envelopeId));
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
  byteBudget: number,
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
  // Reject any path whose segments name a denied credential directory or file (.ssh, .aws, .env,
  // *.pem, id_rsa, …) — lexically or after symlink resolution — regardless of the workspace root below.
  assertNotDenied(absFile, label, "File");
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
  // Bound the single file's contributed text to this source's fair share of the global evidence byte
  // budget so a large file cannot, alongside other connected sources, blow the model prompt cap and
  // fail the whole N+1 run (Epic #729). A lone connected file keeps the full budget unchanged
  // (byteBudget === EVIDENCE_BUDGET_BYTES, so boundedText === content.text).
  const boundedText = truncateToUtf8Bytes(content.text, byteBudget);
  const envelopeId = envelopeIdFor(index, label, content.relativePath);
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "repository-context",
    displayLabel: label,
    provenance: {
      origin: "file",
      registeredAt,
      integrityHashSha256Hex: sha256Hex(`${content.relativePath}|${boundedText}`),
    },
    localRef: stableLocalRef("file", absFile),
  };
  const atoms = atomsForWorkspaceEntry(
    { path: content.relativePath, excerpt: boundedText },
    envelopeId,
  );
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
  readonly fingerprintText?: string | undefined;
}

// Redact every member document and cap it. The LK corpus text is NOT redacted at index time — the
// workspace/file paths redact at read time via keiko-workspace, so the capsule path MUST redact
// here to honour the atom's redactionStatus:"redacted" and the epic's no-credential-leakage DoD
// (Epic #710, Issue #717). Each document is capped to the per-document budget and ingestion stops
// once the cumulative corpus reaches the per-run budget so an oversized capsule degrades gracefully.
function processCapsuleDocs(docs: readonly CorpusDoc[], byteBudget: number): readonly CorpusDoc[] {
  // The per-run corpus budget is the smaller of the capsule's own ceiling and this source's fair
  // share of the global evidence byte budget (Epic #729 N+1 split). The per-document cap is likewise
  // never larger than the per-run budget so the always-included first document cannot exceed it.
  const perRunBudget = Math.min(CAPSULE_BUDGET_BYTES, byteBudget);
  const perDocBudget = Math.min(CAPSULE_MAX_BYTES_PER_DOCUMENT, perRunBudget);
  const processed: CorpusDoc[] = [];
  let totalBytes = 0;
  for (const doc of docs) {
    const capped = truncateToUtf8Bytes(redact(stripUnsafeFormatChars(doc.text)), perDocBudget);
    if (capped.trim().length === 0) continue;
    const bytes = utf8ByteLength(capped);
    // Always include the first usable document (capped to ≤ the per-document budget); thereafter
    // stop before a document would push the corpus past the per-run budget so the total stays
    // bounded (never the raw corpus) and the run never hard-fails on QI_PROMPT_TOO_LARGE.
    if (processed.length > 0 && totalBytes + bytes > perRunBudget) break;
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
  fingerprintText = text,
): QualityIntelligenceIngestedAtom {
  const canonicalText = `${docId}\n${text}`;
  const fingerprintCanonicalText = `${docId}\n${fingerprintText}`;
  // Derive the atom id from the stable document id only — never its position in the corpus order
  // (Epic #735 drift correctness, mirrors workspaceAtom). A capsule document id (and a Figma
  // screen id) is unique within its envelope, so adding/removing a sibling document never shifts an
  // unchanged document's atom id and never false-orphans its candidates. Content edits are caught by
  // the canonicalHash diff.
  const digest = sha256Hex(`qi-atom-cap-v2|${String(envelopeId)}|${docId}`).slice(0, 32);
  const atom: QI.QualityIntelligenceEvidenceAtom = {
    kind: "document-excerpt",
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(`qi-atom-${digest}`),
    sourceEnvelopeId: envelopeId,
    canonicalHashSha256Hex: sha256Hex(fingerprintCanonicalText),
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
  /** Stable opaque source ref used for drift grouping. */
  readonly scopeRef: string;
  /** Provenance origin descriptor (no secrets — an id, never content). */
  readonly origin: string;
  readonly rawDocs: readonly CorpusDoc[];
  /** User-actionable message when the connector resolves to no indexed content. */
  readonly emptyError: string;
}

// Shared builder for capsule and capsule-set sources: both resolve to a flat list of corpus
// documents that are redacted, budget-capped, and mapped to one local-knowledge-capsule envelope
// plus per-document atoms (Epic #710, Issue #716/#717).
function buildCapsuleSource(build: CapsuleSourceBuild, byteBudget: number): OneSource {
  if (build.rawDocs.length === 0) {
    throw new QiIngestionError("QI_CAPSULE_UNAVAILABLE", build.emptyError);
  }
  const docs = processCapsuleDocs(build.rawDocs, byteBudget);
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
    localRef: build.scopeRef,
  };
  const atoms = docs.map((d) => capsuleDocAtom(d.documentId, d.text, envelopeId));
  return { envelope, atoms };
}

function ingestCapsule(
  source: Extract<QualityIntelligenceInlineSource, { kind: "capsule" }>,
  index: number,
  registeredAt: string,
  resolver: CapsuleResolver,
  byteBudget: number,
): OneSource {
  const label = sanitiseLabel(source.label);
  return buildCapsuleSource(
    {
      label,
      index,
      registeredAt,
      envelopeKey: source.capsuleId,
      scopeRef: stableLocalRef("capsule", source.capsuleId),
      origin: `local-knowledge-capsule:${source.capsuleId}`,
      rawDocs: resolver.capsule(source.capsuleId),
      emptyError: `Capsule "${label}" has no indexed content or could not be opened.`,
    },
    byteBudget,
  );
}

function ingestCapsuleSet(
  source: Extract<QualityIntelligenceInlineSource, { kind: "capsule-set" }>,
  index: number,
  registeredAt: string,
  resolver: CapsuleResolver,
  byteBudget: number,
): OneSource {
  const label = sanitiseLabel(source.label);
  return buildCapsuleSource(
    {
      label,
      index,
      registeredAt,
      envelopeKey: source.capsuleSetId,
      scopeRef: stableLocalRef("capsule-set", source.capsuleSetId),
      origin: `local-knowledge-capsule-set:${source.capsuleSetId}`,
      rawDocs: resolver.capsuleSet(source.capsuleSetId),
      emptyError: `Capsule set "${label}" has no indexed content or could not be opened.`,
    },
    byteBudget,
  );
}

// ─── Figma snapshot source (Epic #750, Issue #754) ───────────────────────────────
//
// A stored Figma Snapshot is ingested into one atom PER SCREEN: the deterministic, model-free
// structural baseline derived from the screen's Screen-IR (#752), optionally enriched by additive
// vision hints (capability-routed via #810; degrades to IR-only). Each atom carries screen
// provenance so a generated test is attributable to its origin screen. The canonical text is
// redacted before the atom is built (defense in depth — the snapshot is already redacted at persist)
// and budget-capped exactly like the capsule path so a large board degrades gracefully.

type MaybePromise<T> = T | Promise<T>;

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

interface FigmaScreenTexts {
  readonly text: string;
  readonly fingerprintText: string;
}

interface IrStats {
  readonly imageFillCount: number;
  readonly textNodeCount: number;
  readonly semanticNodeCount: number;
}

function collectIrStats(node: QualityIntelligenceFigma.IrNode, stats: IrStats): IrStats {
  const next: IrStats = {
    imageFillCount: stats.imageFillCount + node.imageFills.length,
    textNodeCount:
      stats.textNodeCount + (node.text !== undefined && node.text.trim().length > 0 ? 1 : 0),
    semanticNodeCount:
      stats.semanticNodeCount +
      (node.interactionHint === "button" ||
      node.interactionHint === "input" ||
      node.interactionHint === "link"
        ? 1
        : 0),
  };
  return node.children.reduce<IrStats>((acc, child) => collectIrStats(child, acc), next);
}

function screenNeedsVisionAugmentation(
  ir: QualityIntelligenceFigma.ScreenIr,
  baseline: QualityIntelligenceFigma.ScreenTestBaseline,
): boolean {
  const stats = collectIrStats(ir.root, {
    imageFillCount: 0,
    textNodeCount: 0,
    semanticNodeCount: 0,
  });
  const structuralItems = baseline.items.filter((item) => item.category !== "screen-render").length;
  return (
    stats.imageFillCount > 0 ||
    stats.textNodeCount === 0 ||
    stats.semanticNodeCount === 0 ||
    structuralItems === 0
  );
}

function figmaVisionRequest(
  record: FigmaSnapshotRecord,
  screen: FigmaSnapshotRecord["screens"][number],
  baselineText: string,
): Parameters<FigmaVisionHintProvider>[0] {
  return {
    snapshotRunId: record.runId,
    screenId: screen.screenId,
    image: screen.image,
    imageRelativePath: screen.image.relativePath,
    baselineText,
  };
}

function mergeFigmaVisionHints(baselineText: string, hints: readonly string[]): FigmaScreenTexts {
  return {
    text: QualityIntelligenceFigma.mergeVisionHints(baselineText, hints).text,
    fingerprintText: baselineText,
  };
}

/** Vision-augment one screen's baseline text without ever overriding it (additive only). */
function visionAugmentedScreenText(
  baseline: QualityIntelligenceFigma.ScreenTestBaseline,
  ir: QualityIntelligenceFigma.ScreenIr,
  record: FigmaSnapshotRecord,
  screen: ParsedScreen["row"],
  vision: FigmaVisionHintProvider | undefined,
): FigmaScreenTexts {
  const baselineText = QualityIntelligenceFigma.renderBaselineText(baseline);
  if (
    vision === undefined ||
    !isRenderedScreenRow(screen) ||
    !screenNeedsVisionAugmentation(ir, baseline)
  ) {
    return { text: baselineText, fingerprintText: baselineText };
  }
  const hints = vision(figmaVisionRequest(record, screen, baselineText));
  return isPromiseLike(hints)
    ? { text: baselineText, fingerprintText: baselineText }
    : mergeFigmaVisionHints(baselineText, hints);
}

async function visionAugmentedScreenTextAsync(
  baseline: QualityIntelligenceFigma.ScreenTestBaseline,
  ir: QualityIntelligenceFigma.ScreenIr,
  record: FigmaSnapshotRecord,
  screen: ParsedScreen["row"],
  vision: FigmaVisionHintProvider | undefined,
): Promise<FigmaScreenTexts> {
  const baselineText = QualityIntelligenceFigma.renderBaselineText(baseline);
  if (
    vision === undefined ||
    !isRenderedScreenRow(screen) ||
    !screenNeedsVisionAugmentation(ir, baseline)
  ) {
    return { text: baselineText, fingerprintText: baselineText };
  }
  const hints = await vision(figmaVisionRequest(record, screen, baselineText));
  return mergeFigmaVisionHints(baselineText, hints);
}

interface ParsedScreen {
  readonly row:
    | FigmaSnapshotRecord["screens"][number]
    | NonNullable<FigmaSnapshotRecord["structuralScreens"]>[number];
  readonly ir: QualityIntelligenceFigma.ScreenIr;
}

function isRenderedScreenRow(
  row: ParsedScreen["row"],
): row is FigmaSnapshotRecord["screens"][number] {
  return "image" in row;
}

// Parse every screen's opaque irJson once; an unparseable screen is dropped (never crashes the run).
// Rendered screens win if a corrupt record ever duplicates an id; structural-only rows then fill
// the non-rendered/capped coverage gap for QI.
function parseScreens(record: FigmaSnapshotRecord): readonly ParsedScreen[] {
  const parsed: ParsedScreen[] = [];
  const seen = new Set<string>();
  for (const row of record.screens) {
    const ir = QualityIntelligenceFigma.parseScreenIr(row.irJson);
    if (ir !== undefined) {
      parsed.push({ row, ir });
      seen.add(row.screenId);
    }
  }
  for (const row of record.structuralScreens ?? []) {
    if (seen.has(row.screenId)) continue;
    const ir = QualityIntelligenceFigma.parseScreenIr(row.irJson);
    if (ir !== undefined) {
      parsed.push({ row, ir });
      seen.add(row.screenId);
    }
  }
  return parsed;
}

function scopedParsedScreens(
  record: FigmaSnapshotRecord,
  screenIds: readonly string[] | undefined,
): readonly ParsedScreen[] {
  const parsed = parseScreens(record);
  // Absent screenIds → whole snapshot (the contract's "absent = whole"). An explicitly EMPTY scope
  // matches NOTHING — it must NEVER widen to the whole board. The route layer already rejects an empty
  // array; this is the defense-in-depth invariant guaranteeing a scoped request can never silently fall
  // back to every screen even if an internal caller passes an empty list.
  if (screenIds === undefined) return parsed;
  if (screenIds.length === 0) return [];
  const wanted = new Set(screenIds);
  return parsed.filter((screen) => wanted.has(screen.row.screenId));
}

// Canonicalise a scoped screen-id list (trim → drop empties → dedupe → sort) so the derived envelope
// id / provenance ref is stable regardless of the order or duplicates a caller passed. The route layer
// already canonicalises incoming requests; this keeps direct/internal callers consistent too.
function canonicalFigmaScreenIds(screenIds: readonly string[]): readonly string[] {
  return [...new Set(screenIds.map((id) => id.trim()).filter((id) => id.length > 0))].sort();
}

function figmaSnapshotSourceRef(
  source: Extract<QualityIntelligenceInlineSource, { kind: "figma-snapshot" }>,
): string {
  if (source.screenIds === undefined) return source.snapshotRunId;
  const canonical = canonicalFigmaScreenIds(source.screenIds);
  return canonical.length === 0
    ? source.snapshotRunId
    : `${source.snapshotRunId}#${canonical.join(",")}`;
}

function imageSourceRef(
  source: Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
): string {
  return `${source.sourceKind}:${source.snapshotRunId}#${source.screenId}`;
}

function imageDescriptionBaseline(screenId: string, screenName: string): string {
  return (
    "No structural JSON is attached to this source. Describe the visible UI screenshot for " +
    "test generation. Focus on user-visible purpose, controls, form fields, labels, states, " +
    `layout groups, and likely validation affordances.\nScreen id: ${screenId}\nScreen name: ${screenName}`
  );
}

function imageDescriptionText(
  screenId: string,
  screenName: string,
  hints: readonly string[],
): string | undefined {
  const cleaned = hints
    .map((hint) => redactFigmaAtomText(hint).trim())
    .filter((hint) => hint.length > 0);
  if (cleaned.length === 0) return undefined;
  return [
    `Image description for ${screenName} (${screenId})`,
    "",
    ...cleaned.map((hint) => `- ${hint}`),
  ].join("\n");
}

function parsedRenderedScreenForImageSource(
  record: FigmaSnapshotRecord,
  source: Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
  label: string,
): {
  readonly row: FigmaSnapshotRecord["screens"][number];
  readonly ir: QualityIntelligenceFigma.ScreenIr;
} {
  const parsed = parseScreens(record).find((screen) => screen.row.screenId === source.screenId);
  if (parsed === undefined || !isRenderedScreenRow(parsed.row)) {
    throw new QiIngestionError(
      "QI_IMAGE_UNAVAILABLE",
      `Image "${label}" could not be found in the stored Figma snapshot.`,
    );
  }
  return { row: parsed.row, ir: parsed.ir };
}

function imageDescriptionUnavailable(label: string): QiIngestionError {
  return new QiIngestionError(
    "QI_IMAGE_DESCRIPTION_UNAVAILABLE",
    `Image "${label}" could not be described. Configure an image-input capable model for Quality Intelligence image sources.`,
  );
}

function imageDescriptionDocFromHints(
  screenId: string,
  screenName: string,
  hints: readonly string[],
  byteBudget: number,
): CorpusDoc | undefined {
  const text = imageDescriptionText(screenId, screenName, hints);
  if (text === undefined) return undefined;
  const perDocBudget = Math.min(CAPSULE_MAX_BYTES_PER_DOCUMENT, byteBudget);
  const capped = truncateToUtf8Bytes(redactFigmaAtomText(text), perDocBudget);
  if (capped.trim().length === 0) return undefined;
  return {
    documentId: `Image description: ${figmaDocumentId(screenId, screenName)}`,
    text: capped,
    fingerprintText: capped,
  };
}

// Distinguish "the selected screens are not present in this snapshot" from "the snapshot produced no
// usable baseline" so a scoped run surfaces a precise, user-actionable reason (audit: clear
// screen-not-found error) in the streamed skippedSources notice. The code stays QI_SOURCE_EMPTY so the
// N+1-resilience skip and the drift "all orphaned" allowance keep their existing control flow — only
// the message is sharpened.
function figmaSnapshotEmptyError(
  record: FigmaSnapshotRecord,
  source: Extract<QualityIntelligenceInlineSource, { kind: "figma-snapshot" }>,
  label: string,
): QiIngestionError {
  if (source.screenIds !== undefined) {
    const requested = canonicalFigmaScreenIds(source.screenIds);
    const present = new Set(parseScreens(record).map((screen) => screen.row.screenId));
    const missing = requested.filter((id) => !present.has(id));
    if (requested.length > 0 && missing.length === requested.length) {
      return new QiIngestionError(
        "QI_SOURCE_EMPTY",
        `Figma snapshot "${label}": none of the selected screens (${missing.join(", ")}) exist in this snapshot.`,
      );
    }
  }
  return new QiIngestionError(
    "QI_SOURCE_EMPTY",
    `Figma snapshot "${label}" produced no usable screen baseline.`,
  );
}

// Derive the deterministic navigation/flow/coverage test items per screen from the parsed screens +
// the snapshot's raw inter-screen links (#811). Composes into the baseline below through #754's
// `extraItems` seam. When the snapshot carries no `links` (an older record), every screen maps to no
// nav items and the baseline is identical to the IR-only path — purely additive.
function navItemsByScreen(
  parsed: readonly ParsedScreen[],
  links: readonly QualityIntelligenceFigma.InterScreenLink[],
): ReadonlyMap<string, readonly QualityIntelligenceFigma.StructuralTestItem[]> {
  const irResult: QualityIntelligenceFigma.ScreenIrResult = {
    screens: parsed.map((p) => p.ir),
    links,
    tokens: { colors: [], typography: [], spacing: [], radius: [] },
    reduction: { inputNodeCount: 0, keptNodeCount: 0, removedNodeCount: 0, removedRatio: 0 },
  };
  return QualityIntelligenceFigma.deriveNavTestItemsByScreen(
    QualityIntelligenceFigma.deriveNavGraph(irResult),
  );
}

// Derive the deterministic accessibility test items per screen from the parsed screens (#812).
// Composes into the baseline below through #754's `extraItems` seam, ALONGSIDE the navigation items
// (concatenated, never replacing them). Model-free: a screen with no colour/box/interactive nodes of
// interest maps to no a11y items, so the baseline is identical to the IR-only path — purely additive.
function a11yItemsByScreen(
  parsed: readonly ParsedScreen[],
): ReadonlyMap<string, readonly QualityIntelligenceFigma.StructuralTestItem[]> {
  return QualityIntelligenceFigma.deriveA11yTestItemsByScreen(parsed.map((p) => p.ir));
}

function figmaDocumentId(screenId: string, screenName: string): string {
  // Correct order (the #734 strip-before-redact rule): strip format chars first to
  // de-obfuscate any zero-width-split secret, then redact (now catches raw AND ZW-split
  // secrets → emits "[REDACTED]"), then sanitiseLabel for display safety (collapses
  // newlines, URLs, paths). Mirrors redactFigmaAtomText = redact(stripUnsafeFormatChars)
  // below, with sanitiseLabel as the final display-safe step.
  const safeName = sanitiseLabel(redact(stripUnsafeFormatChars(screenName)));
  return `${screenId} (${truncateToUtf8Bytes(safeName, MAX_LABEL_CHARS)})`;
}

// Strip Unicode bidi-override / zero-width / C1 spoofing code points from the untrusted Figma-derived
// atom text BEFORE secret redaction. Two reasons for this order (the #734 strip-before-redact rule):
// stripping first DE-OBFUSCATES a zero-width-split secret so the redactor can still match it, and it
// removes the bidi/zero-width chars that would otherwise ride a Figma screen name or prototype trigger
// verbatim into the QI atom text and every downstream export (bidi-spoofing of generated test titles).
// Symmetric with the candidate-text path (buildRequirementExcerpt) and the source-label path
// (sanitiseLabel / stripUnsafeLabelChars). TAB/LF/CR are preserved so the multi-line baseline structure
// stays intact; clean inputs are byte-identical, so the atom hash and budget accounting are unchanged.
const redactFigmaAtomText = (text: string): string => redact(stripUnsafeFormatChars(text));

function consumeVisionProviderForScreen(
  vision: FigmaVisionHintProvider | undefined,
  remainingVisionScreens: number,
  ir: QualityIntelligenceFigma.ScreenIr,
  baseline: QualityIntelligenceFigma.ScreenTestBaseline,
): { readonly provider: FigmaVisionHintProvider | undefined; readonly remaining: number } {
  if (
    vision === undefined ||
    remainingVisionScreens <= 0 ||
    !screenNeedsVisionAugmentation(ir, baseline)
  ) {
    return { provider: undefined, remaining: remainingVisionScreens };
  }
  return { provider: vision, remaining: remainingVisionScreens - 1 };
}

function corpusDocFromFigmaScreen(
  row: ParsedScreen["row"],
  ir: QualityIntelligenceFigma.ScreenIr,
  augmented: FigmaScreenTexts,
  perDocBudget: number,
): { readonly doc: CorpusDoc; readonly bytes: number } | undefined {
  const capped = truncateToUtf8Bytes(redactFigmaAtomText(augmented.text), perDocBudget);
  if (capped.trim().length === 0) return undefined;
  const fingerprintText = truncateToUtf8Bytes(
    redactFigmaAtomText(augmented.fingerprintText),
    perDocBudget,
  );
  return {
    doc: {
      documentId: figmaDocumentId(row.screenId, ir.name),
      text: capped,
      fingerprintText,
    },
    bytes: utf8ByteLength(capped),
  };
}

function figmaDocFitsBudget(
  docs: readonly CorpusDoc[],
  totalBytes: number,
  nextBytes: number,
  perRunBudget: number,
): boolean {
  return docs.length === 0 || totalBytes + nextBytes <= perRunBudget;
}

// Derive the redacted, budget-capped canonical text for every parseable screen. Each screen's
// deterministic structural baseline (#754) is augmented additively with its navigation/flow test
// items (#811) AND its accessibility test items (#812) — concatenated, neither replacing the other —
// through the `extraItems` seam, then optionally with vision hints. The per-run byte budget bounds
// the cumulative corpus so an oversized board never hard-fails on QI_PROMPT_TOO_LARGE.
// The byteBudget is the caller's fair share of the global evidence pool (Epic #729 N+1 split)
// so a figma-snapshot source never consumes more than its fair slice alongside other sources.
function figmaScreenDocs(
  record: FigmaSnapshotRecord,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
  screenIds?: readonly string[],
): readonly CorpusDoc[] {
  // Mirror processCapsuleDocs (:558-563): the per-run corpus budget is the smaller of the capsule's
  // own ceiling and this source's fair share of the global evidence byte budget (Epic #729 N+1
  // split). The per-document cap is likewise never larger than the per-run budget.
  const perRunBudget = Math.min(CAPSULE_BUDGET_BYTES, byteBudget);
  const perDocBudget = Math.min(CAPSULE_MAX_BYTES_PER_DOCUMENT, perRunBudget);
  const parsed = scopedParsedScreens(record, screenIds);
  const navItems = navItemsByScreen(parsed, record.links ?? []);
  const a11yItems = a11yItemsByScreen(parsed);
  const docs: CorpusDoc[] = [];
  let totalBytes = 0;
  let remainingVisionScreens = MAX_FIGMA_VISION_AUGMENTED_SCREENS;
  for (const { row, ir } of parsed) {
    const extraItems = [...(navItems.get(ir.id) ?? []), ...(a11yItems.get(ir.id) ?? [])];
    const baseline = QualityIntelligenceFigma.deriveScreenTestBaseline(ir, extraItems);
    const visionSlot = isRenderedScreenRow(row)
      ? consumeVisionProviderForScreen(vision, remainingVisionScreens, ir, baseline)
      : { provider: undefined, remaining: remainingVisionScreens };
    remainingVisionScreens = visionSlot.remaining;
    const augmented = visionAugmentedScreenText(baseline, ir, record, row, visionSlot.provider);
    const nextDoc = corpusDocFromFigmaScreen(row, ir, augmented, perDocBudget);
    if (nextDoc === undefined) continue;
    if (!figmaDocFitsBudget(docs, totalBytes, nextDoc.bytes, perRunBudget)) break;
    docs.push(nextDoc.doc);
    totalBytes += nextDoc.bytes;
  }
  return docs;
}

async function figmaScreenDocsAsync(
  record: FigmaSnapshotRecord,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
  screenIds?: readonly string[],
): Promise<readonly CorpusDoc[]> {
  const perRunBudget = Math.min(CAPSULE_BUDGET_BYTES, byteBudget);
  const perDocBudget = Math.min(CAPSULE_MAX_BYTES_PER_DOCUMENT, perRunBudget);
  const parsed = scopedParsedScreens(record, screenIds);
  const navItems = navItemsByScreen(parsed, record.links ?? []);
  const a11yItems = a11yItemsByScreen(parsed);
  const docs: CorpusDoc[] = [];
  let totalBytes = 0;
  let remainingVisionScreens = MAX_FIGMA_VISION_AUGMENTED_SCREENS;
  for (const { row, ir } of parsed) {
    const extraItems = [...(navItems.get(ir.id) ?? []), ...(a11yItems.get(ir.id) ?? [])];
    const baseline = QualityIntelligenceFigma.deriveScreenTestBaseline(ir, extraItems);
    const visionSlot = isRenderedScreenRow(row)
      ? consumeVisionProviderForScreen(vision, remainingVisionScreens, ir, baseline)
      : { provider: undefined, remaining: remainingVisionScreens };
    remainingVisionScreens = visionSlot.remaining;
    const augmented = await visionAugmentedScreenTextAsync(
      baseline,
      ir,
      record,
      row,
      visionSlot.provider,
    );
    const nextDoc = corpusDocFromFigmaScreen(row, ir, augmented, perDocBudget);
    if (nextDoc === undefined) continue;
    if (!figmaDocFitsBudget(docs, totalBytes, nextDoc.bytes, perRunBudget)) break;
    docs.push(nextDoc.doc);
    totalBytes += nextDoc.bytes;
  }
  return docs;
}

function ingestFigmaSnapshot(
  source: Extract<QualityIntelligenceInlineSource, { kind: "figma-snapshot" }>,
  index: number,
  registeredAt: string,
  loader: FigmaSnapshotLoader,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): OneSource {
  const label = sanitiseLabel(source.label);
  const record = loader(source.snapshotRunId);
  if (record === undefined) {
    throw new QiIngestionError(
      "QI_FIGMA_SNAPSHOT_UNAVAILABLE",
      `Figma snapshot "${label}" could not be found or read. Build the snapshot first.`,
    );
  }
  if (record.screens.length === 0 && (record.structuralScreens?.length ?? 0) === 0) {
    throw new QiIngestionError("QI_SOURCE_EMPTY", `Figma snapshot "${label}" has no screens.`);
  }
  const docs = figmaScreenDocs(record, vision, byteBudget, source.screenIds);
  if (docs.length === 0) {
    throw figmaSnapshotEmptyError(record, source, label);
  }
  const joinedFingerprintText = docs.map((d) => d.fingerprintText ?? d.text).join("\n");
  const sourceRef = figmaSnapshotSourceRef(source);
  const envelopeId = envelopeIdFor(index, label, sourceRef);
  // A stored Figma Snapshot is figma evidence, not repository context. Use the dedicated
  // `figma-evidence` envelope kind (#278 AC2 "represented as an explicit connector-backed source"
  // + AC4 citation/audit attribution) so the persisted envelope, source-mix priority, and any
  // kind-grouped audit rollup classify it correctly instead of folding it into repo context.
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "figma-evidence",
    displayLabel: label,
    provenance: {
      origin: `figma-snapshot:${sourceRef}`,
      registeredAt,
      integrityHashSha256Hex: sha256Hex(joinedFingerprintText),
    },
    localRef: stableLocalRef("figma-snapshot", sourceRef),
  };
  const atoms = docs.map((d) =>
    capsuleDocAtom(d.documentId, d.text, envelopeId, d.fingerprintText ?? d.text),
  );
  return { envelope, atoms };
}

async function ingestFigmaSnapshotAsync(
  source: Extract<QualityIntelligenceInlineSource, { kind: "figma-snapshot" }>,
  index: number,
  registeredAt: string,
  loader: FigmaSnapshotLoader,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): Promise<OneSource> {
  const label = sanitiseLabel(source.label);
  const record = loader(source.snapshotRunId);
  if (record === undefined) {
    throw new QiIngestionError(
      "QI_FIGMA_SNAPSHOT_UNAVAILABLE",
      `Figma snapshot "${label}" could not be found or read. Build the snapshot first.`,
    );
  }
  if (record.screens.length === 0 && (record.structuralScreens?.length ?? 0) === 0) {
    throw new QiIngestionError("QI_SOURCE_EMPTY", `Figma snapshot "${label}" has no screens.`);
  }
  const docs = await figmaScreenDocsAsync(record, vision, byteBudget, source.screenIds);
  if (docs.length === 0) {
    throw figmaSnapshotEmptyError(record, source, label);
  }
  const joinedFingerprintText = docs.map((d) => d.fingerprintText ?? d.text).join("\n");
  const sourceRef = figmaSnapshotSourceRef(source);
  const envelopeId = envelopeIdFor(index, label, sourceRef);
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "figma-evidence",
    displayLabel: label,
    provenance: {
      origin: `figma-snapshot:${sourceRef}`,
      registeredAt,
      integrityHashSha256Hex: sha256Hex(joinedFingerprintText),
    },
    localRef: stableLocalRef("figma-snapshot", sourceRef),
  };
  const atoms = docs.map((d) =>
    capsuleDocAtom(d.documentId, d.text, envelopeId, d.fingerprintText ?? d.text),
  );
  return { envelope, atoms };
}

function buildImageSourceEnvelope(
  source: Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
  label: string,
  index: number,
  registeredAt: string,
  doc: CorpusDoc,
): OneSource {
  const sourceRef = imageSourceRef(source);
  const envelopeId = envelopeIdFor(index, label, sourceRef);
  const envelope: QI.QualityIntelligenceSourceEnvelope = {
    id: envelopeId,
    kind: "figma-evidence",
    displayLabel: label,
    provenance: {
      origin: `image:${sourceRef}`,
      registeredAt,
      integrityHashSha256Hex: sha256Hex(doc.fingerprintText ?? doc.text),
    },
    localRef: stableLocalRef("image", sourceRef),
  };
  return {
    envelope,
    atoms: [capsuleDocAtom(doc.documentId, doc.text, envelopeId, doc.fingerprintText ?? doc.text)],
  };
}

function imageDescriptionDoc(
  record: FigmaSnapshotRecord,
  source: Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
  label: string,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): CorpusDoc | undefined {
  if (vision === undefined) return undefined;
  const { row, ir } = parsedRenderedScreenForImageSource(record, source, label);
  const hints = vision(
    figmaVisionRequest(record, row, imageDescriptionBaseline(row.screenId, ir.name)),
  );
  if (isPromiseLike(hints)) return undefined;
  return imageDescriptionDocFromHints(row.screenId, ir.name, hints, byteBudget);
}

async function imageDescriptionDocAsync(
  record: FigmaSnapshotRecord,
  source: Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
  label: string,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): Promise<CorpusDoc | undefined> {
  if (vision === undefined) return undefined;
  const { row, ir } = parsedRenderedScreenForImageSource(record, source, label);
  const hints = await vision(
    figmaVisionRequest(record, row, imageDescriptionBaseline(row.screenId, ir.name)),
  );
  return imageDescriptionDocFromHints(row.screenId, ir.name, hints, byteBudget);
}

function ingestImageSource(
  source: Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
  index: number,
  registeredAt: string,
  loader: FigmaSnapshotLoader,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): OneSource {
  const label = sanitiseLabel(source.label);
  const record = loader(source.snapshotRunId);
  if (record === undefined) {
    throw new QiIngestionError(
      "QI_IMAGE_UNAVAILABLE",
      `Image "${label}" could not be found or read. Build the Figma snapshot first.`,
    );
  }
  const doc = imageDescriptionDoc(record, source, label, vision, byteBudget);
  if (doc === undefined) throw imageDescriptionUnavailable(label);
  return buildImageSourceEnvelope(source, label, index, registeredAt, doc);
}

async function ingestImageSourceAsync(
  source: Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
  index: number,
  registeredAt: string,
  loader: FigmaSnapshotLoader,
  vision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): Promise<OneSource> {
  const label = sanitiseLabel(source.label);
  const record = loader(source.snapshotRunId);
  if (record === undefined) {
    throw new QiIngestionError(
      "QI_IMAGE_UNAVAILABLE",
      `Image "${label}" could not be found or read. Build the Figma snapshot first.`,
    );
  }
  const doc = await imageDescriptionDocAsync(record, source, label, vision, byteBudget);
  if (doc === undefined) throw imageDescriptionUnavailable(label);
  return buildImageSourceEnvelope(source, label, index, registeredAt, doc);
}

function ingestCapsuleSource(
  source:
    | Extract<QualityIntelligenceInlineSource, { kind: "capsule" }>
    | Extract<QualityIntelligenceInlineSource, { kind: "capsule-set" }>,
  index: number,
  registeredAt: string,
  capsuleResolver: CapsuleResolver | undefined,
  byteBudget: number,
): OneSource {
  if (capsuleResolver === undefined) {
    throw new QiIngestionError(
      "QI_CAPSULE_UNAVAILABLE",
      source.kind === "capsule"
        ? "Capsule sources are unavailable: the Local Knowledge store is not configured."
        : "Capsule-set sources are unavailable: the Local Knowledge store is not configured.",
    );
  }
  return source.kind === "capsule"
    ? ingestCapsule(source, index, registeredAt, capsuleResolver, byteBudget)
    : ingestCapsuleSet(source, index, registeredAt, capsuleResolver, byteBudget);
}

function ingestStoredFigmaSource(
  source:
    | Extract<QualityIntelligenceInlineSource, { kind: "figma-snapshot" }>
    | Extract<QualityIntelligenceInlineSource, { kind: "image" }>,
  index: number,
  registeredAt: string,
  figmaSnapshotLoader: FigmaSnapshotLoader | undefined,
  figmaVision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): OneSource {
  if (figmaSnapshotLoader === undefined) {
    throw new QiIngestionError(
      source.kind === "image" ? "QI_IMAGE_UNAVAILABLE" : "QI_FIGMA_SNAPSHOT_UNAVAILABLE",
      source.kind === "image"
        ? "Image sources are unavailable: the evidence directory is not configured."
        : "Figma-snapshot sources are unavailable: the evidence directory is not configured.",
    );
  }
  return source.kind === "image"
    ? ingestImageSource(source, index, registeredAt, figmaSnapshotLoader, figmaVision, byteBudget)
    : ingestFigmaSnapshot(
        source,
        index,
        registeredAt,
        figmaSnapshotLoader,
        figmaVision,
        byteBudget,
      );
}

function ingestOne(
  source: QualityIntelligenceInlineSource,
  index: number,
  registeredAt: string,
  capsuleResolver: CapsuleResolver | undefined,
  figmaSnapshotLoader: FigmaSnapshotLoader | undefined,
  figmaVision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): OneSource {
  switch (source.kind) {
    case "requirements":
      return ingestRequirements(source, index, registeredAt);
    case "workspace":
      return ingestWorkspace(source, index, registeredAt, byteBudget);
    case "file":
      return ingestFile(source, index, registeredAt, byteBudget);
    case "capsule":
    case "capsule-set":
      return ingestCapsuleSource(source, index, registeredAt, capsuleResolver, byteBudget);
    case "figma-snapshot":
    case "image":
      return ingestStoredFigmaSource(
        source,
        index,
        registeredAt,
        figmaSnapshotLoader,
        figmaVision,
        byteBudget,
      );
  }
}

async function ingestOneAsync(
  source: QualityIntelligenceInlineSource,
  index: number,
  registeredAt: string,
  capsuleResolver: CapsuleResolver | undefined,
  figmaSnapshotLoader: FigmaSnapshotLoader | undefined,
  figmaVision: FigmaVisionHintProvider | undefined,
  byteBudget: number,
): Promise<OneSource> {
  if (source.kind !== "figma-snapshot" && source.kind !== "image") {
    return ingestOne(
      source,
      index,
      registeredAt,
      capsuleResolver,
      figmaSnapshotLoader,
      figmaVision,
      byteBudget,
    );
  }
  if (figmaSnapshotLoader === undefined) {
    throw new QiIngestionError(
      source.kind === "image" ? "QI_IMAGE_UNAVAILABLE" : "QI_FIGMA_SNAPSHOT_UNAVAILABLE",
      source.kind === "image"
        ? "Image sources are unavailable: the evidence directory is not configured."
        : "Figma-snapshot sources are unavailable: the evidence directory is not configured.",
    );
  }
  if (source.kind === "image") {
    return ingestImageSourceAsync(
      source,
      index,
      registeredAt,
      figmaSnapshotLoader,
      figmaVision,
      byteBudget,
    );
  }
  return ingestFigmaSnapshotAsync(
    source,
    index,
    registeredAt,
    figmaSnapshotLoader,
    figmaVision,
    byteBudget,
  );
}

export interface IngestInlineSourcesInput {
  readonly request: QualityIntelligenceStartRunRequest;
  readonly runId: string;
  readonly registeredAt: string;
  /**
   * Drift-only mode: an existing run whose current source is now empty must still be comparable so all
   * old candidates classify as orphaned-stale. Initial run creation keeps the strict non-empty guard.
   */
  readonly allowEmpty?: boolean | undefined;
  /** Optional capsule resolver (Epic #710, Issue #717). Absent → capsule sources throw QI_CAPSULE_UNAVAILABLE. */
  readonly capsuleResolver?: CapsuleResolver | undefined;
  /**
   * Optional Figma-snapshot loader (Epic #750, Issue #754). Absent → figma-snapshot sources throw
   * QI_FIGMA_SNAPSHOT_UNAVAILABLE. Reads ONLY the stored snapshot; never contacts Figma.
   */
  readonly figmaSnapshotLoader?: FigmaSnapshotLoader | undefined;
  /**
   * Optional capability-routed image-input provider (Issue #754/#810). For figma-snapshot sources
   * hints are additive and never override the deterministic structural baseline. For pure image
   * sources the same provider must produce the textual image description; absent/empty output makes
   * that image source unavailable instead of pretending a text-only model saw the screenshot.
   */
  readonly figmaVision?: FigmaVisionHintProvider | undefined;
}

/**
 * Ingest the inline sources of a start-run request into content-bearing atoms + browser-safe
 * envelopes. Requirements text is split by the pure domain; workspace folders are read through
 * keiko-workspace traversal + redaction (no independent repository traversal). Throws
 * `QiIngestionError` with a safe, user-actionable code on empty / oversized / unreadable input.
 */
// Mutable accumulator threaded through the per-source ingest loop (keeps ingestInlineSources within
// the function-length limit while preserving the exact loop semantics).
interface IngestAccumulator {
  readonly envelopes: QI.QualityIntelligenceSourceEnvelope[];
  readonly ingestedAtoms: QualityIntelligenceIngestedAtom[];
  readonly sourceSummaries: QiSourceSummary[];
  readonly skippedSources: QiSkippedSource[];
  firstSkipError?: QiIngestionError;
}

interface PerSourceBudgets {
  readonly atomBudget: number;
  readonly byteBudget: number;
}

/**
 * Ingest one source into the accumulator (Epic #729 N+1 resilience). On a per-source QiIngestionError
 * the source is recorded as skipped and ingestion continues with the rest; a genuine (non-coded) bug
 * still throws so it is never silently swallowed. Each successful source takes its fair atom share,
 * bounded by the global cap so the total never exceeds it.
 */
function ingestSourceInto(
  acc: IngestAccumulator,
  source: QualityIntelligenceInlineSource,
  index: number,
  input: IngestInlineSourcesInput,
  budgets: PerSourceBudgets,
): void {
  let ingested: OneSource;
  try {
    ingested = ingestOne(
      source,
      index,
      input.registeredAt,
      input.capsuleResolver,
      input.figmaSnapshotLoader,
      input.figmaVision,
      budgets.byteBudget,
    );
  } catch (error) {
    if (!(error instanceof QiIngestionError)) throw error;
    acc.firstSkipError ??= error;
    acc.skippedSources.push({
      label: sanitiseLabel(source.label),
      kind: source.kind,
      code: error.code,
      message: error.message,
    });
    return;
  }
  const { envelope, atoms } = ingested;
  const take = Math.min(budgets.atomBudget, MAX_TOTAL_ATOMS - acc.ingestedAtoms.length);
  const taken = take <= 0 ? [] : atoms.slice(0, take);
  acc.envelopes.push(envelope);
  acc.ingestedAtoms.push(...taken);
  acc.sourceSummaries.push({
    label: envelope.displayLabel,
    kind: source.kind,
    atomCount: taken.length,
  });
}

async function ingestSourceIntoAsync(
  acc: IngestAccumulator,
  source: QualityIntelligenceInlineSource,
  index: number,
  input: IngestInlineSourcesInput,
  budgets: PerSourceBudgets,
): Promise<void> {
  let ingested: OneSource;
  try {
    ingested = await ingestOneAsync(
      source,
      index,
      input.registeredAt,
      input.capsuleResolver,
      input.figmaSnapshotLoader,
      input.figmaVision,
      budgets.byteBudget,
    );
  } catch (error) {
    if (!(error instanceof QiIngestionError)) throw error;
    acc.firstSkipError ??= error;
    acc.skippedSources.push({
      label: sanitiseLabel(source.label),
      kind: source.kind,
      code: error.code,
      message: error.message,
    });
    return;
  }
  const { envelope, atoms } = ingested;
  const take = Math.min(budgets.atomBudget, MAX_TOTAL_ATOMS - acc.ingestedAtoms.length);
  const taken = take <= 0 ? [] : atoms.slice(0, take);
  acc.envelopes.push(envelope);
  acc.ingestedAtoms.push(...taken);
  acc.sourceSummaries.push({
    label: envelope.displayLabel,
    kind: source.kind,
    atomCount: taken.length,
  });
}

function emptyDriftIngestionResult(
  input: IngestInlineSourcesInput,
  droppedSourceCount: number,
  skippedSources: readonly QiSkippedSource[],
): QiIngestionResult {
  return {
    envelopes: [],
    ingestedAtoms: [],
    provenanceRefs: {
      envelopeIds: [],
      auditSummaryId: auditSummaryIdFor(input.runId),
    },
    sourceSummaries: [],
    droppedSourceCount,
    skippedSources,
  };
}

function allowEmptyDriftIngestion(
  input: IngestInlineSourcesInput,
  acc: IngestAccumulator,
  droppedSourceCount: number,
): QiIngestionResult | undefined {
  if (input.allowEmpty !== true) return undefined;
  const blockingSkip = acc.skippedSources.find((source) => source.code !== "QI_SOURCE_EMPTY");
  if (blockingSkip !== undefined) {
    throw new QiIngestionError(blockingSkip.code, blockingSkip.message);
  }
  return emptyDriftIngestionResult(input, droppedSourceCount, acc.skippedSources);
}

export function ingestInlineSources(input: IngestInlineSourcesInput): QiIngestionResult {
  // Read through the typed property in the loop: `Array.isArray` would widen a local binding of the
  // readonly union array to `any[]`, so the guard checks length on the typed property directly.
  const allSources: readonly QualityIntelligenceInlineSource[] = input.request.sources;
  if (allSources.length === 0) {
    throw new QiIngestionError("QI_NO_SOURCES", "At least one source is required to start a run.");
  }
  // Cap the source count BEFORE ingestion (no partial work for dropped sources), then split BOTH the
  // global atom budget and the global evidence BYTE budget fairly so no single source starves the
  // others and the merged prompt stays under the model ceiling regardless of N (Chat N+1 parity,
  // #730) — preventing one large source from hard-failing the whole run with QI_PROMPT_TOO_LARGE.
  const sources = allSources.slice(0, MAX_QI_SOURCES);
  const droppedSourceCount = allSources.length - sources.length;
  const budgets: PerSourceBudgets = {
    atomBudget: perSourceAtomBudget(MAX_TOTAL_ATOMS, sources.length),
    byteBudget: perSourceByteBudget(sources.length),
  };
  // N+1 resilience (Chat parity): each source is ingested independently; a source that produces
  // nothing usable is skipped + recorded so the healthy ones still produce the run. The run fails only
  // when EVERY source fails — re-raising the FIRST coded error so a single bad source keeps its
  // specific, user-actionable code + message (unchanged single-source UX).
  const acc: IngestAccumulator = {
    envelopes: [],
    ingestedAtoms: [],
    sourceSummaries: [],
    skippedSources: [],
  };
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    if (source === undefined) continue;
    ingestSourceInto(acc, source, i, input, budgets);
  }
  if (acc.ingestedAtoms.length === 0) {
    const emptyDrift = allowEmptyDriftIngestion(input, acc, droppedSourceCount);
    if (emptyDrift !== undefined) return emptyDrift;
    throw (
      acc.firstSkipError ??
      new QiIngestionError("QI_SOURCE_EMPTY", "No usable evidence was produced from the sources.")
    );
  }
  return {
    envelopes: acc.envelopes,
    ingestedAtoms: acc.ingestedAtoms,
    provenanceRefs: {
      envelopeIds: acc.envelopes.map((e) => String(e.id)),
      auditSummaryId: auditSummaryIdFor(input.runId),
    },
    sourceSummaries: acc.sourceSummaries,
    droppedSourceCount,
    skippedSources: acc.skippedSources,
  };
}

export async function ingestInlineSourcesAsync(
  input: IngestInlineSourcesInput,
): Promise<QiIngestionResult> {
  const allSources: readonly QualityIntelligenceInlineSource[] = input.request.sources;
  if (allSources.length === 0) {
    throw new QiIngestionError("QI_NO_SOURCES", "At least one source is required to start a run.");
  }
  const sources = allSources.slice(0, MAX_QI_SOURCES);
  const droppedSourceCount = allSources.length - sources.length;
  const budgets: PerSourceBudgets = {
    atomBudget: perSourceAtomBudget(MAX_TOTAL_ATOMS, sources.length),
    byteBudget: perSourceByteBudget(sources.length),
  };
  const acc: IngestAccumulator = {
    envelopes: [],
    ingestedAtoms: [],
    sourceSummaries: [],
    skippedSources: [],
  };
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    if (source === undefined) continue;
    await ingestSourceIntoAsync(acc, source, i, input, budgets);
  }
  if (acc.ingestedAtoms.length === 0) {
    const emptyDrift = allowEmptyDriftIngestion(input, acc, droppedSourceCount);
    if (emptyDrift !== undefined) return emptyDrift;
    throw (
      acc.firstSkipError ??
      new QiIngestionError("QI_SOURCE_EMPTY", "No usable evidence was produced from the sources.")
    );
  }
  return {
    envelopes: acc.envelopes,
    ingestedAtoms: acc.ingestedAtoms,
    provenanceRefs: {
      envelopeIds: acc.envelopes.map((e) => String(e.id)),
      auditSummaryId: auditSummaryIdFor(input.runId),
    },
    sourceSummaries: acc.sourceSummaries,
    droppedSourceCount,
    skippedSources: acc.skippedSources,
  };
}
