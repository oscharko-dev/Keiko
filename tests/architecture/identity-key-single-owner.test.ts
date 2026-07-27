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

// The identity tuple's versioned namespace. Matching the literal rather than a function name makes
// the guard resistant to a copy that simply renames itself.
//
// The tail anchor is what separates this from `embeddingProfileKey` in
// local-knowledge-embedding-profiles.ts, which keys a deliberately DIFFERENT and richer decision.
// "Are these the same embedding profile" and "may these two vectors be compared" are distinct
// questions, and collapsing them would widen what counts as an identity mismatch.
const IDENTITY_KEY_FORMAT_MARKER = "keiko-embedding-identity:v2:";

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
        if (readFileSync(file, "utf8").includes(IDENTITY_KEY_FORMAT_MARKER)) {
          owners.push(relative(REPO_ROOT, file).split("\\").join("/"));
        }
      }
    }
    expect(owners, `identity-key implementations found in: ${owners.join(", ")}`).toEqual([
      CANONICAL_SOURCE,
    ]);
  });

  it("produces a versioned collision-free persisted key", () => {
    // Migration v31 discards old runtime materialization state, not stored vectors. This exact
    // format pin makes future changes deliberate and prevents an unversioned cache repartition.
    expect(
      embeddingIdentityKey({
        provider: "openai",
        modelId: "text-embedding-3-small",
        vectorDimensions: 1536,
        vectorMetric: "cosine",
      }),
    ).toBe(
      'keiko-embedding-identity:v2:["openai","text-embedding-3-small",1536,"cosine",null,null,null,null]',
    );
  });
});
