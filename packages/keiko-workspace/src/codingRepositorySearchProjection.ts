import { redact } from "@oscharko-dev/keiko-security";
import type { CodingRepositoryHit } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { RepoSearchInvalidRangeError } from "./errors.js";
import { normalizePhysicalLineBreaks, physicalLineSpans } from "./physicalLines.js";
import { clampToBytes } from "./repoSearch.js";

interface SourceWindow {
  readonly start: number;
  readonly end: number;
  readonly endLine: number;
}

// RAW-source offsets of the requested physical lines; the last line's terminator, "\n" or "\r\n",
// stays outside the window (#4439).
function sourceWindow(raw: string, startLine: number, endLine: number): SourceWindow {
  const spans = physicalLineSpans(raw);
  const actualEnd = Math.min(endLine, spans.length);
  const first = spans[startLine - 1];
  const last = spans[actualEnd - 1];
  if (first === undefined || last === undefined)
    throw new RepoSearchInvalidRangeError("line range is unavailable");
  return { start: first.start, end: last.end, endLine: actualEnd };
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
  const window = sourceWindow(raw, startLine, endLine);
  const safe = redact(raw);
  const projected = safeSourceWindow(raw, safe, window);
  // The snippet carries LF terminators only, so a CRLF file projects exactly like its LF twin.
  const { excerpt: snippet, truncated: snippetTruncated } = clampToBytes(
    normalizePhysicalLineBreaks(projected),
    maxBytes,
  );
  return {
    path,
    startLine,
    endLine: window.endLine,
    snippet,
    redacted: projected !== raw.slice(window.start, window.end),
    snippetTruncated,
  };
}
