// Changed-path identity for the review diff package (ADR-0182 D6, Issue #4134).
//
// Git stores a path as bytes. The package keeps those bytes as the identity of a changed file (two
// names that differ only in invalid UTF-8 bytes stay two files), reports a valid UTF-8 name exactly
// as stored (no Unicode normalization, newlines and leading dashes included), and adds the exact
// bytes for a name that is not UTF-8. The prompt never shows a raw name: `quoteReviewPath` escapes
// every character that could end a line or forge a file header.

import { isUtf8 } from "node:buffer";

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

export interface ReviewDiffPathText {
  readonly path: string;
  /** Present only when the bytes are not valid UTF-8. */
  readonly pathBytesBase64?: string;
}

/** The reported form of one stored path. */
export function reviewDiffPathText(bytes: Uint8Array): ReviewDiffPathText {
  const path = UTF8.decode(bytes);
  if (isUtf8(bytes)) return { path };
  // Not UTF-8: a display form for people, and the exact bytes for identity and verbatim reports.
  return { path, pathBytesBase64: Buffer.from(bytes).toString("base64") };
}

/** A stable, platform- and locale-independent order: the stored bytes, compared unsigned. */
export function compareReviewPathBytes(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(left, right);
}

/** Identity key of a stored path (its exact bytes). */
export function reviewPathKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// Characters that may never appear raw in a prompt header: C0/C1 controls, the quote and
// backslash, Unicode line and paragraph separators, and the bidirectional and zero-width format
// characters that could make one name look like another.
/* eslint-disable no-control-regex -- intentionally matches control characters to escape them */
const UNSAFE_PATH_CHARACTER =
  /[\u0000-\u001f\u007f-\u009f'\\\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu;
/* eslint-enable no-control-regex */

const BACKSLASH = String.fromCodePoint(0x5c);

function escapeCharacter(character: string): string {
  if (character === "'") return String.raw`\'`;
  if (character === "\\") return String.raw`\\`;
  if (character === "\n") return String.raw`\n`;
  if (character === "\t") return String.raw`\t`;
  if (character === "\r") return String.raw`\r`;
  const code = character.codePointAt(0) ?? 0;
  return `${BACKSLASH}u${code.toString(16).padStart(4, "0")}`;
}

/** A single-quoted, single-line rendering of a path for the reviewer prompt. */
export function quoteReviewPath(path: string): string {
  return `'${path.replace(UNSAFE_PATH_CHARACTER, escapeCharacter)}'`;
}

/** The final path segment, for language and filter decisions. */
export function reviewPathBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
