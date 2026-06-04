// PURE, bounded runId validation (ADR-0010 D4 iii). The manifest filename is ALWAYS derived from a
// validated runId, so a malicious runId cannot escape the contained base dir or overwrite an
// arbitrary file. We accept only a bounded [A-Za-z0-9._-] character set with a length cap and reject
// a leading dot (no dotfiles, no `..`). NO REGEX is used (D3 no-new-regex rule) — validation is a
// per-character class check, which is also trivially linear-time.

import { InvalidRunIdError } from "./errors/audit.js";

const MAX_RUN_ID_LENGTH = 256;

// Inclusive ASCII code-point ranges for the allowed class, plus the three allowed punctuation
// characters. A leading dot is rejected separately so `.` is allowed only in non-leading position.
function isAllowedChar(code: number): boolean {
  const isDigit = code >= 48 && code <= 57; // 0-9
  const isUpper = code >= 65 && code <= 90; // A-Z
  const isLower = code >= 97 && code <= 122; // a-z
  const isPunct = code === 46 || code === 95 || code === 45; // . _ -
  return isDigit || isUpper || isLower || isPunct;
}

export function assertValidRunId(runId: string): void {
  if (runId.length === 0 || runId.length > MAX_RUN_ID_LENGTH) {
    throw new InvalidRunIdError(`invalid runId length: ${String(runId.length)}`);
  }
  if (runId.startsWith(".")) {
    throw new InvalidRunIdError("runId must not start with a dot");
  }
  for (let i = 0; i < runId.length; i += 1) {
    if (!isAllowedChar(runId.charCodeAt(i))) {
      throw new InvalidRunIdError("runId contains a disallowed character");
    }
  }
}
