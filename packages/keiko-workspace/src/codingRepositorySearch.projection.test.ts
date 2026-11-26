// The projection's per-file contract under a ranked order that interleaves files. A literal scan
// ranks one file's hits together; a ranked merge (semantic atoms, scores) does not, and the
// projection must still read, redact and index each file once. Isolated in its own file because it
// wraps repoSearch's searchText to reorder its atoms.
import { describe, expect, it, vi } from "vitest";
import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { executeCodingRepositoryRequest } from "./codingRepositorySearch.js";
import type { WorkspaceInfo } from "./types.js";

vi.mock("./repoSearch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./repoSearch.js")>();
  return {
    ...actual,
    searchText: async (
      ...args: Parameters<typeof actual.searchText>
    ): ReturnType<typeof actual.searchText> => {
      const result = await actual.searchText(...args);
      return { ...result, atoms: interleaved(result.atoms) };
    },
  };
});

// Every file's first hit, then every file's second hit: A1 B1 C1 … A2 B2 C2 ….
function interleaved(atoms: readonly EvidenceAtom[]): readonly EvidenceAtom[] {
  return [...atoms].sort(
    (left, right) =>
      (left.lineRange?.startLine ?? 0) - (right.lineRange?.startLine ?? 0) ||
      left.scopePath.localeCompare(right.scopePath),
  );
}

const ROOT = "/coding-projection";
const workspace: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "coding-projection",
  version: "1",
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};
const request = {
  kind: "search" as const,
  mode: "literal" as const,
  query: "CodingProjectionProbe",
  caseSensitive: true,
  includeGlobs: [],
  excludeGlobs: [],
  maxResults: 50,
};

describe("coding repository search projection", () => {
  it("reads each file once and keeps the ranked order when hits of many files interleave", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `file-${String(index)}.html`,
        `CodingProjectionProbe ${String(index)}\nfiller\nCodingProjectionProbe again`,
      ]),
    );
    const base = memFs(ROOT, files);
    const read = base.readFileBytes;
    if (read === undefined) throw new Error("fixture bounded reader missing");
    const reads = new Map<string, number>();
    const result = await executeCodingRepositoryRequest(workspace, request, {
      fs: {
        ...base,
        readFileBytes: (path, ...args): Promise<Uint8Array> => {
          reads.set(path, (reads.get(path) ?? 0) + 1);
          return read(path, ...args);
        },
      },
    });
    if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
    const order = Array.from({ length: 6 }, (_, index) => `file-${String(index)}.html`);
    expect(result.hits.map((hit) => `${hit.path}:${String(hit.startLine)}`)).toEqual([
      ...order.map((path) => `${path}:1`),
      ...order.map((path) => `${path}:3`),
    ]);
    // One read by the scan and one by the projection for every file.
    expect([...reads.values()]).toEqual(Array.from({ length: 6 }, () => 2));
  });
  it("keeps a strict ranked prefix when the deadline fires while a later file is projected", async () => {
    const files = {
      "a.html": "CodingProjectionProbe a1\nfiller\nCodingProjectionProbe a2",
      "b.html": "CodingProjectionProbe b1\nfiller\nCodingProjectionProbe b2",
      "c.html": "CodingProjectionProbe c1",
    };
    const full = await executeCodingRepositoryRequest(workspace, request, {
      fs: memFs(ROOT, files),
    });
    if (!full.ok || full.kind !== "search") throw new Error("search result unavailable");
    // The ranked order interleaves the files: a1 b1 c1 a2 b2. Projection goes a, b, c.
    const ranked = full.hits.map((hit) => `${hit.path}:${String(hit.startLine)}`);
    expect(ranked.slice(0, 2)).toEqual(["a.html:1", "b.html:1"]);

    let now = 0;
    const base = memFs(ROOT, files);
    const read = base.readFileBytes;
    if (read === undefined) throw new Error("fixture bounded reader missing");
    const reads = new Map<string, number>();
    const result = await executeCodingRepositoryRequest(workspace, request, {
      fs: {
        ...base,
        readFileBytes: async (path, ...args): Promise<Uint8Array> => {
          const count = (reads.get(path) ?? 0) + 1;
          reads.set(path, count);
          // The second read of b.html is its projection: the soft deadline passes during it.
          if (path.endsWith("/b.html") && count === 2) now = 80;
          return read(path, ...args);
        },
      },
      nowMs: () => now,
      deadlineAtMs: 100,
      scanDeadlineAtMs: 50,
      projectionDeadlineAtMs: 75,
    });
    if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
    // Only the hits ranked before the best hit of the unfinished file b.html remain: a later hit
    // of a.html must not survive without the higher-ranked b.html hit.
    expect(result.hits.map((hit) => `${hit.path}:${String(hit.startLine)}`)).toEqual(
      ranked.slice(0, 1),
    );
    expect(result.truncationReasons).toContain("time-limit");
    expect(result.diagnostics?.coverageIncomplete).toBe(true);
  });
});
