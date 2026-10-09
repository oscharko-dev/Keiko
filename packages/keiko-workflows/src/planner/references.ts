import {
  LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";
import {
  isDenied,
  isEcosystemSourceFile,
  isGeneratedArtifactPath,
} from "@oscharko-dev/keiko-workspace";
import { parseDiagnosticTraceText } from "../bug-investigation/failure-parse.js";
import { isGeneratedRankingPath } from "../ranking/signals.js";
import { extractAnchors, type AnchorExtractionResult, type SearchAnchor } from "./anchors.js";

export interface SearchReference {
  readonly path: string;
  readonly line?: number;
  readonly origin: "query" | "diagnostic" | "assistant";
}

export interface RetrievalChannels extends AnchorExtractionResult {
  readonly references: readonly SearchReference[];
  readonly questionText: string;
  readonly stackTraceDetected: boolean;
  readonly stackTraceFrameCount: number;
  readonly stackTraceInScopeFrameCount: number;
  readonly stackTraceExternalFrameCount: number;
}

const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  ...LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_DOCUMENT_FILE_EXTENSIONS,
]);
const REFERENCE_CAP = 6;

function filenameReference(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return KNOWN_EXTENSIONS.has(extension) || isEcosystemSourceFile(path);
}

function parsePathReference(term: string): SearchReference {
  const located = /^(.*?):(\d{1,9})(?::\d{1,9})?$/.exec(term);
  const line = Number(located?.[2]);
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

export function extractPathReferences(text: string): readonly SearchReference[] {
  const { anchors } = extractAnchors({ text, maxAnchors: text.length, caseSensitive: true });
  const terms = new Set(
    anchors.filter(referenceAnchor).map((anchor) => anchor.sourceTerm ?? anchor.term),
  );
  for (const token of text.split(/[\s`"'()<>,;!?]+/u)) {
    if (token.startsWith(".") && isDenied(token)) terms.add(token);
  }
  return [...terms].sort((a, b) => text.indexOf(a) - text.indexOf(b)).map(parsePathReference);
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
  const references = uniqueReferences([
    ...candidates.map((frame): SearchReference => ({
      path: frame.file,
      ...(frame.line === undefined ? {} : { line: frame.line }),
      origin: "diagnostic",
    })),
    ...extractPathReferences(trace.questionText),
    ...supplied,
  ]);
  const extraction = extractAnchors({
    text: trace.questionText,
    maxAnchors: trace.questionText.length,
  });
  const userAnchors = extraction.anchors.filter((anchor) => !referenceAnchor(anchor));
  return {
    ...extraction,
    anchors: userAnchors.slice(0, maxAnchors),
    truncated: userAnchors.length > maxAnchors,
    references,
    questionText: trace.questionText,
    stackTraceDetected: trace.detected,
    stackTraceFrameCount: trace.frames.length,
    stackTraceInScopeFrameCount: candidates.length,
    stackTraceExternalFrameCount: trace.frames.length - candidates.length,
  };
}
