import { describe, expect, it } from "vitest";

import { freshStore } from "../_support.js";
import { memoryFs } from "../discovery/test-support.js";
import { DEFAULT_DISCOVERY_OPTIONS } from "../discovery/types.js";
import {
  gitBlobFingerprint,
  parseGitIndexTrackedPaths,
  repositoryFingerprintSetDigest,
  scanRepositoryFingerprints,
  type RepositoryFileFingerprint,
} from "./repository-fingerprints.js";

const ROOT = "/workspace/repo";

function gitIndexV2(paths: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = paths.map((path) => encoder.encode(path));
  const entryLengths = encoded.map((path) => Math.ceil((62 + path.byteLength + 1) / 8) * 8);
  const bytes = new Uint8Array(12 + entryLengths.reduce((sum, length) => sum + length, 0) + 20);
  bytes.set(encoder.encode("DIRC"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, paths.length);
  let offset = 12;
  for (let index = 0; index < encoded.length; index += 1) {
    const path = encoded[index];
    if (path === undefined) continue;
    view.setUint16(offset + 60, Math.min(path.byteLength, 0x0fff));
    bytes.set(path, offset + 62);
    offset += entryLengths[index] ?? 0;
  }
  return bytes;
}

// Blob ids produced by `git hash-object --stdin` for the exact byte sequences below. Pinning real
// git output — rather than recomputing the hash the way the implementation does — is what makes
// these assertions an oracle: a reimplementation would agree with a wrong implementation, whereas
// these values fail the moment our blob id stops being git's blob id.
const GIT_BLOB_IDS = {
  "export function tracked(): void {}\n": "623b56f16ed03ac1520683107c9452c439bb48a8",
  'const gruesse = "Grüße";\n': "2b0659517a04c2a3ef40f1f361a2ada95926aa0e",
  "": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
} as const;

describe("repository_file_fingerprints ledger table", () => {
  it("exists immediately after opening a fresh store, before any fingerprint read/write runs (Issue #2569 ledger migration)", () => {
    const fresh = freshStore();
    try {
      const row = fresh.store._internal.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'repository_file_fingerprints'",
        )
        .get() as unknown as { readonly n: number };
      expect(row.n).toBe(1);
    } finally {
      fresh.cleanup();
    }
  });
});

describe("repository fingerprints", () => {
  // The whole incremental-skip guarantee rests on this one equality: our blob id must be the blob
  // id git itself records, or the freshness comparison degrades to "always changed" while still
  // reporting success. This is the single owner of that computation — the server's freshness check
  // imports it rather than carrying a second copy that could drift.
  it("computes exactly the blob id `git hash-object` reports, including empty and multibyte input", () => {
    for (const [content, expected] of Object.entries(GIT_BLOB_IDS)) {
      expect(gitBlobFingerprint(new TextEncoder().encode(content))).toBe(expected);
    }
  });

  it("parses bounded Git index v2 entries without launching Git", () => {
    const parsed = parseGitIndexTrackedPaths(gitIndexV2(["src/a.ts", "src/b.py"]));
    expect([...(parsed ?? [])]).toEqual(["src/a.ts", "src/b.py"]);
    expect(parseGitIndexTrackedPaths(new TextEncoder().encode("not an index"))).toBeUndefined();
  });

  it("uses Git blob hashes for tracked files and state identities for untracked files", async () => {
    const tracked = "export function tracked(): void {}\n";
    const fs = memoryFs(ROOT, [
      { relativePath: ".git/index", content: gitIndexV2(["src/tracked.ts"]) },
      { relativePath: "src/tracked.ts", content: tracked },
      { relativePath: "src/untracked.py", content: "def untracked():\n    return True\n" },
    ]);
    const result = await scanRepositoryFingerprints({
      fs,
      scope: { kind: "repository", repositoryRoot: ROOT },
      discovery: { ...DEFAULT_DISCOVERY_OPTIONS, respectGitIgnore: true },
    });
    const byPath = new Map(result.fingerprints.map((item) => [item.relativePath, item]));
    expect(result.usedGitIndex).toBe(true);
    expect(byPath.get("src/tracked.ts")).toMatchObject({
      fingerprintKind: "git-blob-sha1",
      contentFingerprint: GIT_BLOB_IDS[tracked],
    });
    expect(byPath.get("src/untracked.py")?.fingerprintKind).toBe("file-state");
  });

  it("never fingerprints gitignored, denied, or escaping entries", async () => {
    const fs = memoryFs(ROOT, [
      { relativePath: ".gitignore", content: "ignored/\n" },
      { relativePath: "ignored/file.ts", content: "export const ignored = true;" },
      { relativePath: ".env", content: "SECRET=1" },
      {
        relativePath: "src/escape.ts",
        content: "export const escaped = true;",
        realPathOverride: "/outside/escape.ts",
      },
      { relativePath: "src/kept.ts", content: "export const kept = true;" },
    ]);
    const result = await scanRepositoryFingerprints({
      fs,
      scope: { kind: "repository", repositoryRoot: ROOT },
      discovery: { ...DEFAULT_DISCOVERY_OPTIONS, respectGitIgnore: true },
      trackedPaths: new Set(["src/kept.ts"]),
    });
    expect(result.fingerprints.map((item) => item.relativePath)).toEqual([
      ".gitignore",
      "src/kept.ts",
    ]);
    expect(result.rejectedEntries).toBe(1);
  });
});

// The digest is an order-independent identity for a fingerprint SET: the same files with the same
// contents must produce one value no matter which order they arrive in. That property is what makes
// it comparable across runs, and it was never pinned. It also has to hold for path pairs that a
// locale-aware collation treats as equal — `café.ts` in NFC vs NFD is the reachable case, because
// macOS hands back decomposed names from readdir while git's index stores the composed form, so a
// single accented filename puts both spellings in play. With a collation that reports 0 for such a
// pair, the sort is a no-op on it and the digest follows the input order: fingerprints arriving from
// the walk (directory order) and from the ledger read (SQLite BINARY order) then disagree about the
// identity of one identical set.
describe("repositoryFingerprintSetDigest", () => {
  function entry(relativePath: string, contentFingerprint: string): RepositoryFileFingerprint {
    return { relativePath, contentFingerprint, fingerprintKind: "file-state", byteLength: 1 };
  }

  it.each([
    ["NFC vs NFD accented paths", "caf\u00e9.ts", "cafe\u0301.ts"],
    ["a zero-width space", "a\u200bb.ts", "ab.ts"],
    ["a soft hyphen", "file\u00ad1.ts", "file1.ts"],
  ])("is order-independent across %s", (_case, left, right) => {
    const set = [entry(left, "aaa"), entry(right, "bbb")];

    expect(repositoryFingerprintSetDigest(set)).toBe(
      repositoryFingerprintSetDigest([...set].reverse()),
    );
  });

  it("still separates sets that genuinely differ", () => {
    expect(repositoryFingerprintSetDigest([entry("a.ts", "aaa")])).not.toBe(
      repositoryFingerprintSetDigest([entry("a.ts", "bbb")]),
    );
    expect(repositoryFingerprintSetDigest([entry("a.ts", "aaa")])).not.toBe(
      repositoryFingerprintSetDigest([entry("a.ts", "aaa"), entry("b.ts", "bbb")]),
    );
  });
});
