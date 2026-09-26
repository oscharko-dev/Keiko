// Shared JSON file reading for the script toolchain (housekeeping wave 4, follow-up to the
// digest consolidation in scripts/lib/digest.mjs).
//
// This is the ONE home of the plain "parse this JSON file" read that a dozen gate scripts each
// carried as an identical local copy. Deliberately out of scope: readers with their own error
// contract (a `fail(label)` wrapper, a failure-collector, an existence pre-check), root-relative
// resolvers, async variants, and the hardened lstat-guarded readers in the release qualification
// scripts — each of those encodes gate-specific semantics that must not silently change.

import { readFileSync } from "node:fs";

/**
 * Parse the UTF-8 JSON file at `path`. Errors (missing file, invalid JSON) propagate to the
 * caller unchanged — exactly the behaviour of the inline copies this replaces.
 */
export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
