import { redact } from "@oscharko-dev/keiko-security";
import type { CodingRepositoryHit } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { RepoSearchInvalidRangeError } from "./errors.js";
import { clampToBytes } from "./repoSearch.js";
import { normalizeSourceLineEndings } from "./sourceLines.js";

interface SourceWindow {
  readonly start: number;
  readonly end: number;
  readonly endLine: number;
}

/**
 * One file's source, prepared once for every excerpt a search takes from it: line endings folded,
 * the full-context redaction computed and the line offsets indexed. A search can return many hits
 * in one file; redacting the whole file again for each of them cost seconds per search on a large
 * generated file and blocked the event loop for the whole projection.
 */
export interface CodingRepositorySource {
  readonly source: string;
  readonly safe: string;
  /** Offset of each line's first character, plus `source.length + 1` as the end sentinel. */
  readonly lineStarts: readonly number[];
}

export function prepareCodingRepositorySource(raw: string): CodingRepositorySource {
  // Windows line endings fold into LF first (#4439): the window arithmetic below counts one
  // terminator character per line, and a CRLF copy must project exactly like its LF copy.
  const source = normalizeSourceLineEndings(raw);
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  lineStarts.push(source.length + 1);
  return { source, safe: redact(source), lineStarts };
}

function sourceWindow(
  { lineStarts }: CodingRepositorySource,
  startLine: number,
  endLine: number,
): SourceWindow {
  const lineCount = lineStarts.length - 1;
  if (startLine > lineCount) throw new RepoSearchInvalidRangeError("line range is unavailable");
  const actualEnd = Math.min(endLine, lineCount);
  return {
    start: lineStarts[startLine - 1] ?? 0,
    end: (lineStarts[actualEnd] ?? 0) - 1,
    endLine: actualEnd,
  };
}

function changedSourceInterval(raw: string, safe: string): { start: number; end: number } {
  let start = 0;
  while (start < raw.length && start < safe.length && raw[start] === safe[start]) start += 1;
  let suffix = 0;
  while (
    suffix < raw.length - start &&
    suffix < safe.length - start &&
    raw[raw.length - suffix - 1] === safe[safe.length - suffix - 1]
  )
    suffix += 1;
  return { start, end: raw.length - suffix };
}

function safeSourceWindow(raw: string, safe: string, window: SourceWindow): string {
  if (raw === safe) return raw.slice(window.start, window.end);
  const changed = changedSourceInterval(raw, safe);
  if (window.end <= changed.start || window.start >= changed.end) {
    return raw.slice(window.start, window.end);
  }
  // The canonical redactor can collapse multiline secrets. Its unchanged prefix/suffix are safe;
  // withholding the full changed interval also protects ranges beginning inside a secret block.
  return (
    raw.slice(window.start, Math.max(window.start, Math.min(window.end, changed.start))) +
    "[REDACTED]" +
    raw.slice(Math.min(window.end, Math.max(window.start, changed.end)), window.end)
  );
}

// The H1 read/search coordinate contract (Epic #532) needs the window bounds and startLine/endLine
// reported to callers to stay pinned to the RAW source, even when the canonical redact() collapses
// a multiline secret into a single "[REDACTED]" marker. repoSearch.ts's own excerpt path
// (readExcerpt/excerptWindow) redacts a lane's full text (readWorkspaceFile) or not at all
// (readWorkspaceFileForEditing) BEFORE windowing by line index — right for its own callers, but it
// would shift every line after a collapsed secret and break that pin here. sourceWindow/
// changedSourceInterval/safeSourceWindow above compose the RAW-coordinate window with a
// full-source-context redaction diff that repoSearch.ts has no equivalent for; only the final byte
// clamp (clampToBytes) is genuinely the same operation as repoSearch.ts's own excerptWindow clamp,
// so that step is reused directly instead of re-implemented.
export function codingRepositoryExcerpt(
  path: string,
  raw: string,
  startLine: number,
  endLine: number,
  maxBytes: number,
): CodingRepositoryHit {
  return codingRepositorySourceExcerpt(
    path,
    prepareCodingRepositorySource(raw),
    startLine,
    endLine,
    maxBytes,
  );
}

/** The excerpt of one prepared source; equal to `codingRepositoryExcerpt` on the raw text. */
export function codingRepositorySourceExcerpt(
  path: string,
  prepared: CodingRepositorySource,
  startLine: number,
  endLine: number,
  maxBytes: number,
): CodingRepositoryHit {
  const { source, safe } = prepared;
  const window = sourceWindow(prepared, startLine, endLine);
  const projected = safeSourceWindow(source, safe, window);
  const { excerpt: snippet, truncated: snippetTruncated } = clampToBytes(projected, maxBytes);
  return {
    path,
    startLine,
    endLine: window.endLine,
    snippet,
    redacted: projected !== source.slice(window.start, window.end),
    snippetTruncated,
  };
}
