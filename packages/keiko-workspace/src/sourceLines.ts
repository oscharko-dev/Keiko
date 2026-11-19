// The one line-terminator rule for source text read by search, excerpts and the workspace index
// (#4439). A line ends at LF or at CRLF; a lone CR is line content. Every reader that numbers,
// windows or projects source lines splits through here, so a file saved with Windows line endings
// yields the same lines, ranges, excerpts and citations as its LF copy. Files on disk are never
// rewritten, and byte caps on the file itself still count its original bytes.

const SOURCE_LINE_TERMINATOR = /\r?\n/u;

export function splitSourceLines(text: string): string[] {
  return text.split(SOURCE_LINE_TERMINATOR);
}

// Folds every CRLF terminator into LF without changing the line count or any line's content, so a
// transform that runs over the whole text (redaction) sees the same input as for the LF copy.
export function normalizeSourceLineEndings(text: string): string {
  return text.includes("\r") ? text.replaceAll("\r\n", "\n") : text;
}
