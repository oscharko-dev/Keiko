import { describe, expect, it } from "vitest";
import { CODING_REPOSITORY_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { memFs } from "./_memfs.js";
import { executeCodingRepositoryRequest } from "./codingRepositorySearch.js";
import type { WorkspaceFs } from "./fs.js";
import type { WorkspaceInfo } from "./types.js";

const ROOT = "/coding-coverage";
const workspace: WorkspaceInfo = {
  root: ROOT,
  selectedRoot: ROOT,
  name: "coding-coverage",
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
  query: "CodingCoverageProbe",
  caseSensitive: true,
  includeGlobs: [],
  excludeGlobs: [],
  maxResults: 50,
};

function unavailableFs(code: string, matchingFile: boolean): WorkspaceFs {
  const base = memFs(ROOT, {
    "unreadable.html": "CodingCoverageProbe unreadable",
    ...(matchingFile ? { "valid.html": "CodingCoverageProbe valid" } : {}),
  });
  const read = base.readFileBytes;
  if (read === undefined) throw new Error("fixture bounded reader missing");
  return {
    ...base,
    readFileBytes: (path, maximum, hardLinkPolicy, expected): Promise<Uint8Array> => {
      if (path.endsWith("/unreadable.html"))
        return Promise.reject(Object.assign(new Error("fixture read unavailable"), { code }));
      return read(path, maximum, hardLinkPolicy, expected);
    },
  };
}

describe("coding repository search completeness", () => {
  it.each(["EACCES", "EIO", "ENOENT"])(
    "does not certify an empty search when eligible text cannot be read: %s",
    async (code) => {
      const result = await executeCodingRepositoryRequest(workspace, request, {
        fs: unavailableFs(code, false),
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
      expect(result.hits).toEqual([]);
      expect(result.truncationReasons).toContain("io-error");
    },
  );

  it("retains a valid hit while disclosing the unreadable part of the same scope", async () => {
    const result = await executeCodingRepositoryRequest(workspace, request, {
      fs: unavailableFs("EACCES", true),
    });
    if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
    expect(result.hits.map((hit) => hit.path)).toEqual(["valid.html"]);
    expect(result.truncationReasons).toContain("io-error");
  });

  it("reports size eligibility independently of the bounded omitted-path sample", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`a-${String(index)}.png`, "image"]),
    );
    const base = memFs(ROOT, { ...files, "z-large.ts": "CodingCoverageProbe" });
    const fs: WorkspaceFs = {
      ...base,
      stat: (path) => ({
        ...base.stat(path),
        ...(path.endsWith("/z-large.ts") ? { size: CODING_REPOSITORY_LIMITS.fileBytes + 1 } : {}),
      }),
    };
    const result = await executeCodingRepositoryRequest(workspace, request, { fs });
    if (!result.ok || result.kind !== "search") throw new Error("search result unavailable");
    expect(result.hits).toEqual([]);
    expect(result.metrics.skippedFiles).toBe(61);
    expect(result.truncationReasons).toContain("file-too-large");
  });
});
