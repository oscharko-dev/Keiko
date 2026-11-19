/**
 * ONE owner for hex SHA-256 digests in the script layer. Before this module, six scripts carried
 * a byte-identical `sha256(path)` and two more carried the string/bytes variant — the exact
 * drift-by-duplication the housekeeping audit measured (2026-08-10). Digest semantics that
 * deliberately differ (for example the LF-normalized source digest in
 * check-version-consistency.mjs) stay with their owner and say why.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";

/** Hex SHA-256 of raw bytes or a UTF-8 string. */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Hex SHA-256 of a file's bytes. */
export function sha256File(path) {
  return sha256(readFileSync(path));
}

/**
 * Hex SHA-256 of a file read in 1 MiB chunks, for release archives too large to hold at once. With
 * `maxBytes`, it reads at most one byte more than that and returns undefined for a longer file, so
 * a file that grew after its size was checked is never read to its end.
 */
export function sha256FileChunked(path, maxBytes = Number.POSITIVE_INFINITY) {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let total = 0;
  try {
    for (;;) {
      const wanted = Math.min(buffer.length, maxBytes + 1 - total);
      const bytesRead = readSync(fd, buffer, 0, wanted, null);
      if (bytesRead === 0) return hash.digest("hex");
      total += bytesRead;
      if (total > maxBytes) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
}
