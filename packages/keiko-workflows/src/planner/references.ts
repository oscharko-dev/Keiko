import {
  LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import {
  isDenied,
  isEcosystemSourceFile,
  isGeneratedArtifactPath,
} from "@oscharko-dev/keiko-workspace";
import { parseDiagnosticTraceText } from "../bug-investigation/failure-parse.js";
import { isGeneratedRankingPath } from "../ranking/signals.js";
import {
  extractAnchors,
  normalizeUnquotedFilePathToken,
  type AnchorExtractionResult,
  type SearchAnchor,
} from "./anchors.js";

export interface SearchReference {
  readonly path: string;
  readonly line?: number;
  readonly origin: "query" | "diagnostic" | "assistant";
}

export interface RetrievalChannels extends AnchorExtractionResult {
  readonly references: readonly SearchReference[];
  readonly diagnosticFrames: readonly SearchReference[];
  readonly questionText: string;
  readonly stackTraceDetected: boolean;
  readonly stackTraceFrameCount: number;
  readonly stackTraceInScopeFrameCount: number;
  readonly stackTraceExternalFrameCount: number;
}

const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  ...LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS,
]);
const REFERENCE_CAP = 6;
const REFERENCE_TOKEN_RE = /[^\s`"'<>,;!?]+/gu;
const PATH_QUOTE_CHARACTERS = new Set(["`", '"', "'"]);

function filenameReference(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  const extension = basename.slice(dot + 1).toLowerCase();
  return (dot > 0 && KNOWN_EXTENSIONS.has(extension)) || isEcosystemSourceFile(path);
}

function parsePathReference(term: string): SearchReference {
  const located = /^(.*?):(\d{1,9})(?::\d{1,9}|-(\d{1,9}))?$/.exec(term);
  const line = Number(located?.[2]);
  const end = located?.[3] === undefined ? line : Number(located[3]);
  if (end < line || end < 1) return { path: term, origin: "query" };
  return {
    path: located?.[1] ?? term,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    origin: "query",
  };
}

function referenceAnchor(anchor: SearchAnchor): boolean {
  const path = parsePathReference(anchor.term).path;
  return (
    (anchor.kind === "path" && path.split("/").at(-1)?.includes(".") === true) ||
    filenameReference(path)
  );
}

function bracketReferenceTerm(raw: string): string {
  const token = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (token.startsWith("[") && token.endsWith("]")) {
    const inner = token.slice(1, -1);
    if (filenameReference(parsePathReference(inner).path)) return inner;
  }
  return token.startsWith("(") && token.endsWith(")") ? token.slice(1, -1) : token;
}

function bracketPath(term: string): boolean {
  const path = parsePathReference(term).path;
  if (!path.includes("/") || (!path.includes("[") && !path.includes("]"))) return false;
  return filenameReference(path);
}

function bracketReferenceAnchorText(text: string): string {
  return text.replace(REFERENCE_TOKEN_RE, (raw: string, offset: number) => {
    const term = bracketReferenceTerm(raw);
    const located = parsePathReference(term);
    const locatedPath = located.line !== undefined && filenameReference(located.path);
    if (!filenameReference(located.path)) return raw;
    const quote = text.charAt(offset - 1);
    if (PATH_QUOTE_CHARACTERS.has(quote) && quote === text.charAt(offset + raw.length)) return raw;
    const canonical = locatedPath ? `${located.path}:${String(located.line)}` : term;
    return `\`${normalizeUnquotedFilePathToken(canonical)}\`${raw.endsWith(".") ? "." : ""}`;
  });
}

function pathReferenceExtraction(text: string): {
  readonly references: readonly SearchReference[];
  readonly anchorText: string;
} {
  const anchorText = bracketReferenceAnchorText(text);
  const { anchors } = extractAnchors({
    text: anchorText,
    maxAnchors: text.length,
    caseSensitive: true,
  });
  const terms = new Set([
    ...anchors.filter(referenceAnchor).map((anchor) => anchor.sourceTerm ?? anchor.term),
  ]);
  for (const token of text.split(/[\s`"'()<>,;!?]+/u)) {
    if (token.startsWith(".") && isDenied(token)) terms.add(token);
    const located = parsePathReference(token);
    if (
      located.line !== undefined &&
      (terms.has(located.path) || terms.has(token)) &&
      filenameReference(located.path) &&
      !bracketPath(token)
    ) {
      terms.delete(located.path);
      terms.add(token);
    }
  }
  return {
    references: [...terms]
      .sort((a, b) => text.indexOf(a) - text.indexOf(b))
      .map(parsePathReference),
    anchorText,
  };
}

export function extractPathReferences(text: string): readonly SearchReference[] {
  return pathReferenceExtraction(text).references;
}

function externalFrame(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith("node:") ||
    lower.startsWith("http:") ||
    lower.startsWith("https:") ||
    lower.startsWith("webpack:") ||
    lower.includes("node_modules/") ||
    isGeneratedArtifactPath(path) ||
    isGeneratedRankingPath(path)
  );
}

function uniqueReferences(references: readonly SearchReference[]): readonly SearchReference[] {
  const seen = new Set<string>();
  return references
    .filter((reference) => {
      const key = `${reference.path}:${String(reference.line ?? "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, REFERENCE_CAP);
}

export function searchReferenceAnchors(
  references: readonly SearchReference[],
): readonly SearchAnchor[] {
  return references.map((reference) => ({
    term: reference.path.toLowerCase(),
    sourceTerm: reference.path,
    kind: "path",
    weight: 0.95,
  }));
}

export function extractRetrievalChannels(
  text: string,
  maxAnchors: number,
  supplied: readonly SearchReference[] = [],
): RetrievalChannels {
  const trace = parseDiagnosticTraceText(text);
  const candidates = trace.frames.filter((frame) => !externalFrame(frame.file));
  const diagnosticFrames = candidates.map((frame): SearchReference => ({
    path: frame.file,
    ...(frame.line === undefined ? {} : { line: frame.line }),
    origin: "diagnostic",
  }));
  const paths = pathReferenceExtraction(trace.questionText);
  const references = uniqueReferences([...diagnosticFrames, ...paths.references, ...supplied]);
  const extraction = extractAnchors({
    text: paths.anchorText,
    maxAnchors: trace.questionText.length,
  });
  const userAnchors = extraction.anchors.filter((anchor) => !referenceAnchor(anchor));
  return {
    ...extraction,
    anchors: userAnchors.slice(0, maxAnchors),
    truncated: userAnchors.length > maxAnchors,
    references,
    diagnosticFrames,
    questionText: trace.questionText,
    stackTraceDetected: trace.detected,
    stackTraceFrameCount: trace.frames.length,
    stackTraceInScopeFrameCount: candidates.length,
    stackTraceExternalFrameCount: trace.frames.length - candidates.length,
  };
}
