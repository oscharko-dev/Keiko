// redactDiagnosticMessage — privacy-aware redactor for parser diagnostic messages before
// they reach a `parser_diagnostics` row. Defense-in-depth around the existing #265
// `redactPathInDiagnostic` helper: that helper is path-shaped (it home-rewrites a full
// path string), but a diagnostic message often embeds a path inside prose
// ("failed to parse /Users/foo/secret.pdf at offset 42"). This module:
//
//   1. Replaces any in-message occurrence of `homePrefix` with `~` so the raw home path
//      cannot leak even when wrapped in surrounding text.
//   2. Defers to `redactPathInDiagnostic` for control-char stripping, NUL truncation, and
//      drive-letter masking. That helper's tests in keiko-contracts already pin each step.
//   3. Hard-caps the output at 1024 chars (structural backstop in case a misbehaving parser
//      hands us 5 KB of raw extracted text in the message field — the parser SHOULD cap
//      already, but we cannot trust an unbounded message into the audit ledger).
//
// The cap is plain slice (no trailing ellipsis) so the result length is `<= 1024`, not the
// `<= 1025` you would get from "…"-suffix on a 1024-char prefix.

import { redactPathInDiagnostic } from "@oscharko-dev/keiko-contracts";

const HARD_CAP_CHARS = 1024;
const PATH_BREAK_CHARS = new Set([" ", "\n", "\r", "\t", '"', "'", "<", ">", "|"]);
const PATH_BOUNDARY_CHARS = new Set([
  " ",
  "\n",
  "\r",
  "\t",
  '"',
  "'",
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "=",
]);
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]"]);

export function redactDiagnosticMessage(message: string, homePrefix: string): string {
  if (typeof message !== "string") return "";
  // Step 1: strip control characters / NUL-truncate / drive-mask via the contracts helper.
  // Passing the message as a "path" is safe — the helper only TRANSFORMS substrings it
  // recognises and otherwise returns the input unchanged.
  const sanitised = redactPathInDiagnostic(message, { homePrefix });
  // Step 2: rewrite any in-prose occurrence of the home prefix. The contracts helper only
  // home-rewrites when the prefix matches at offset 0; embedded paths slip through, so we
  // additionally redact path-shaped prose tokens.
  const normalisedPrefix = stripTrailingSlash(toForwardSlash(homePrefix));
  const homeRewritten = redactPathCandidates(sanitised, normalisedPrefix);
  // Step 3: hard cap. `slice` is O(n) and yields exactly HARD_CAP_CHARS chars on long input.
  if (homeRewritten.length <= HARD_CAP_CHARS) return homeRewritten;
  return homeRewritten.slice(0, HARD_CAP_CHARS);
}

function redactPathCandidates(message: string, homePrefix: string): string {
  const parts: string[] = [];
  let index = 0;
  while (index < message.length) {
    const start = pathCandidateStart(message, index);
    if (start === -1) {
      parts.push(message.slice(index));
      break;
    }
    parts.push(message.slice(index, start));
    const end = pathCandidateEnd(message, start);
    const raw = message.slice(start, end);
    parts.push(redactCandidate(raw, homePrefix));
    index = end;
  }
  return parts.join("");
}

function pathCandidateStart(message: string, from: number): number {
  for (let index = from; index < message.length; index += 1) {
    const current = message[index];
    const next = message[index + 1];
    if (current === "/" && hasPathBoundary(message, index)) return index;
    if (current === "\\" && next === "\\" && hasPathBoundary(message, index)) return index;
    if (isDriveLetterPrefix(current, next, message[index + 2]) && hasPathBoundary(message, index)) {
      return index;
    }
  }
  return -1;
}

function pathCandidateEnd(message: string, start: number): number {
  let end = start;
  while (end < message.length) {
    const current = message[end];
    if (current !== undefined && PATH_BREAK_CHARS.has(current)) break;
    end += 1;
  }
  while (end > start) {
    const trailing = message[end - 1];
    if (trailing === undefined || !TRAILING_PUNCTUATION.has(trailing)) break;
    end -= 1;
  }
  return end;
}

function redactCandidate(candidate: string, homePrefix: string): string {
  const normalised = toForwardSlash(candidate);
  const leadingSlash = normalised.startsWith("//");
  const homeRedacted =
    homePrefix.length > 0 && isPrefixedPath(normalised, homePrefix)
      ? `~${normalised.slice(homePrefix.length)}`
      : normalised;
  if (homeRedacted.startsWith("~")) {
    return homeRedacted;
  }
  if (leadingSlash) {
    return `<unc>/${basenameOf(normalised)}`;
  }
  if (/^[A-Za-z]:\//.test(normalised)) {
    return `<drive>/${basenameOf(normalised)}`;
  }
  if (normalised.startsWith("/")) {
    return `<path>/${basenameOf(normalised)}`;
  }
  return normalised;
}

function toForwardSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

function basenameOf(value: string): string {
  const trimmed = stripTrailingSlash(value);
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

function isDriveLetterPrefix(
  current: string | undefined,
  next: string | undefined,
  afterColon: string | undefined,
): boolean {
  return (
    current !== undefined &&
    next === ":" &&
    afterColon !== undefined &&
    ((current >= "A" && current <= "Z") || (current >= "a" && current <= "z")) &&
    (afterColon === "/" || afterColon === "\\")
  );
}

function isPrefixedPath(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false;
  const next = value[prefix.length];
  return next === undefined || next === "/";
}

function hasPathBoundary(message: string, index: number): boolean {
  if (index === 0) return true;
  const previous = message[index - 1];
  return previous !== undefined && PATH_BOUNDARY_CHARS.has(previous);
}

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
