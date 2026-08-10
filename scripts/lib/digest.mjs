/**
 * ONE owner for hex SHA-256 digests in the script layer. Before this module, six scripts carried
 * a byte-identical `sha256(path)` and two more carried the string/bytes variant — the exact
 * drift-by-duplication the housekeeping audit measured (2026-08-10). Digest semantics that
 * deliberately differ (for example the LF-normalized source digest in
 * check-version-consistency.mjs) stay with their owner and say why.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Hex SHA-256 of raw bytes or a UTF-8 string. */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Hex SHA-256 of a file's bytes. */
export function sha256File(path) {
  return sha256(readFileSync(path));
}
