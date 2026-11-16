// The text a diff addresses in a source file that starts with a UTF-8 byte order mark.
//
// U+FEFF as the first character of a UTF-8 file is its byte order mark: the file's encoding
// signature, not its text. WHATWG UTF-8 decoding drops it, and so does every governed reader of a
// workspace file: the secure workspace read whose digest a model binds a changeset to, and the
// editor's document read. The text a model reads, the digest it declares and the diff the server
// renders from that text therefore carry no mark. The patch engine binds a file to the same decoded
// text, matches such a diff against it and writes the mark back in front of what the diff produced,
// so an edit keeps the file's encoding. A diff that spells the mark at the start of its first old-side
// line (a full-file rewrite of the raw text, or Git's own diff of the file) addresses the raw text
// it spells, as it always did, and so can also remove the mark.

import type { PatchFileChange } from "./types.js";

export const UTF8_BYTE_ORDER_MARK = "﻿";

/**
 * How a diff treats its source file's byte order mark: `none` for a file without one (or absent),
 * `signature` when the diff addresses the text after the mark and the write restores it, and
 * `diff-text` when the diff's own text carries the mark (it spells it, or a create states the file).
 */
export type PatchByteOrderMark = "none" | "signature" | "diff-text";

export interface PatchSourceTextView {
  /** The text the hunks are matched against and produce from; undefined for an absent file. */
  readonly text: string | undefined;
  /** Written in front of a modified file's produced text: the retained mark, or nothing. */
  readonly signature: string;
  readonly byteOrderMark: PatchByteOrderMark;
}

/** The content identity of a file's text: its decoded content without the byte order mark. */
export function decodedSourceText(content: string): string {
  return content.startsWith(UTF8_BYTE_ORDER_MARK)
    ? content.slice(UTF8_BYTE_ORDER_MARK.length)
    : content;
}

export function sourceTextView(
  change: PatchFileChange,
  content: string | undefined,
): PatchSourceTextView {
  if (content?.startsWith(UTF8_BYTE_ORDER_MARK) !== true) {
    return { text: content, signature: "", byteOrderMark: "none" };
  }
  if (change.kind === "create" || firstOldSideLineSpellsMark(change)) {
    return { text: content, signature: "", byteOrderMark: "diff-text" };
  }
  return {
    text: decodedSourceText(content),
    signature: UTF8_BYTE_ORDER_MARK,
    byteOrderMark: "signature",
  };
}

// Only the first hunk can reach the file's first line, and only its first context or removed line
// can be that line. A mark later in a file is ordinary text and never changes the view.
function firstOldSideLineSpellsMark(change: PatchFileChange): boolean {
  const first = change.hunks[0]?.lines.find((line) => line.startsWith(" ") || line.startsWith("-"));
  return first?.slice(1).startsWith(UTF8_BYTE_ORDER_MARK) === true;
}
