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

export function redactDiagnosticMessage(message: string, homePrefix: string): string {
  if (typeof message !== "string") return "";
  // Step 1: strip control characters / NUL-truncate / drive-mask via the contracts helper.
  // Passing the message as a "path" is safe — the helper only TRANSFORMS substrings it
  // recognises and otherwise returns the input unchanged.
  const sanitised = redactPathInDiagnostic(message, { homePrefix });
  // Step 2: rewrite any in-prose occurrence of the home prefix. The contracts helper only
  // home-rewrites when the prefix matches at offset 0; embedded paths slip through, so we
  // do an explicit `replaceAll`. Both forward-slash and backslash variants are normalised
  // by the contracts helper before we get here, but the prefix the caller passes might be
  // in either form — normalise both before replacing.
  const normalisedPrefix = stripTrailingSlash(toForwardSlash(homePrefix));
  const homeRewritten =
    normalisedPrefix.length === 0 ? sanitised : sanitised.split(normalisedPrefix).join("~");
  // Step 3: hard cap. `slice` is O(n) and yields exactly HARD_CAP_CHARS chars on long input.
  if (homeRewritten.length <= HARD_CAP_CHARS) return homeRewritten;
  return homeRewritten.slice(0, HARD_CAP_CHARS);
}

function toForwardSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
