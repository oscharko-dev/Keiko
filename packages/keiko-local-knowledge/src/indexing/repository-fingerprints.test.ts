import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { memoryFs } from "../discovery/test-support.js";
import { DEFAULT_DISCOVERY_OPTIONS } from "../discovery/types.js";
import {
  parseGitIndexTrackedPaths,
  scanRepositoryFingerprints,
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

function gitBlobHash(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return createHash("sha1")
    .update(`blob ${String(bytes.byteLength)}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

describe("repository fingerprints", () => {
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
      contentFingerprint: gitBlobHash(tracked),
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
