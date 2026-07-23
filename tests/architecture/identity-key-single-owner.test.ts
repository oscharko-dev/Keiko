// ADR-0152 D1: the complete embedding-identity key is ONE canonical pure function owned by
// keiko-contracts, and "a third copy is forbidden".
//
// Convergence is not a state you reach once — it is a state that decays. Before M2 this tuple
// existed twice in keiko-local-knowledge (`embeddingIdentityKey` in retrieval/vector-index.ts and
// `identityKey` in retrieval/scoped-vector-search.ts) as byte-equivalent copies, and nothing noticed.
// A copy that drifts is a silent FAIL-OPEN: vectors from incompatible embedding spaces would be
// compared as if they were comparable, which is exactly the condition the identity guard exists to
// prevent. So the guard has to be structural, not a one-time cleanup.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { embeddingIdentityKey } from "@oscharko-dev/keiko-contracts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CANONICAL_SOURCE = "packages/keiko-contracts/src/vector-index-port.ts";
const SCANNED_ROOTS = ["packages", "src", "scripts"];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "out",
  ".next",
  "coverage",
  "__tests__",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".js"]);

// The identity tuple's fingerprint: the "unverified" fingerprint sentinel, then the dimensionsParam
// element, then the pipe join with nothing between. Matching on shape rather than on a function
// name is what makes the guard resistant to a copy that simply renames itself.
//
// The tail anchor is what separates this from `embeddingProfileKey` in
// local-knowledge-embedding-profiles.ts, which shares the sentinel style but keys a deliberately
// DIFFERENT and richer decision — it continues past dimensionsParam with tokenizer and locality.
// "Are these the same embedding profile" and "may these two vectors be compared" are distinct
// questions, and collapsing them would widen what counts as an identity mismatch.
const SENTINEL_PATTERN = /"unverified",\s*String\([^)]*dimensionsParam[^)]*\),\s*\]\.join\("\|"\)/u;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(entry)) && !/\.test\.[cm]?[jt]sx?$/u.test(entry)) yield full;
  }
}

describe("embedding-identity key has exactly one owner", () => {
  it("defines the identity tuple in keiko-contracts and nowhere else", () => {
    const owners: string[] = [];
    for (const root of SCANNED_ROOTS) {
      const absoluteRoot = join(REPO_ROOT, root);
      for (const file of sourceFiles(absoluteRoot)) {
        if (SENTINEL_PATTERN.test(readFileSync(file, "utf8"))) {
          owners.push(relative(REPO_ROOT, file).split("\\").join("/"));
        }
      }
    }
    expect(owners, `identity-key implementations found in: ${owners.join(", ")}`).toEqual([
      CANONICAL_SOURCE,
    ]);
  });

  it("still produces the key the pre-M2 copies produced, so persisted index state stays readable", () => {
    // `vector_index_state.embedding_identity_key` is PERSISTED. If promoting the function to
    // contracts had changed a single byte of its output, every stored index row would have been
    // silently invalidated on the next read and quietly re-embedded. This pins the exact string the
    // two former copies emitted.
    expect(
      embeddingIdentityKey({
        provider: "openai",
        modelId: "text-embedding-3-small",
        vectorDimensions: 1536,
        vectorMetric: "cosine",
      }),
    ).toBe("openai|text-embedding-3-small|1536|cosine|legacy|legacy|unverified|");
  });
});
