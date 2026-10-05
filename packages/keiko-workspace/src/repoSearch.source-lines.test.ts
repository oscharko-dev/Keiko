import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redact } from "@oscharko-dev/keiko-security";
import { detectWorkspaceAt } from "./detect.js";
import { readWorkspaceFileForEditing } from "./discovery.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import { nodeWorkspaceFs } from "./fs.js";
import { resolveWorkspaceSearchPolicy } from "./repoSearchPolicy.js";
import {
  buildWorkspaceIndexLexicalRecord,
  buildWorkspaceIndexSnapshot,
  createWorkspaceIndex,
  workspaceIndexFileMetadata,
  type WorkspaceIndex,
} from "./workspaceIndex.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function sourceFixture(newline: string): SearchScope {
  const root = mkdtempSync(join(tmpdir(), "keiko-source-lines-"));
  roots.push(root);
  mkdirSync(join(root, "nested"));
  const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const end = ["-----END ", "PRIVATE KEY-----"].join("");
  writeFileSync(
    join(root, "nested/source.txt"),
    [
      "preamble",
      begin,
      "first-private-body",
      end,
      "PhysicalCoordinateProbe VERIFIED_MIDDLE",
      begin,
      "second-private-body",
      end,
      "PhysicalCoordinateProbe VERIFIED_LAST",
    ].join(newline),
  );
  return {
    workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
    scopeId: "source-lines",
    relativePaths: [],
  };
}

const query = {
  kind: "exact-symbol" as const,
  text: "PhysicalCoordinateProbe",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};
const indexLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 10 };

function legacyCoordinateIndex(scope: SearchScope): WorkspaceIndex {
  const path = "nested/source.txt";
  const metadata = workspaceIndexFileMetadata(
    path,
    nodeWorkspaceFs.stat(join(scope.workspace.root, path)),
  );
  const raw = readWorkspaceFileForEditing(scope.workspace, path).rawText;
  const policy = resolveWorkspaceSearchPolicy(scope, nodeWorkspaceFs, undefined);
  const snapshot = buildWorkspaceIndexSnapshot({
    scope,
    policy: {
      policyMode: policy.mode,
      applyGitignore: policy.applyGitignore,
      omitLowValueWorkspaceFiles: policy.omitLowValueWorkspaceFiles,
    },
    maxBytesPerFileScanned: indexLimits.maxBytesPerFileScanned,
    maxFilesScanned: indexLimits.maxFilesScanned,
    discovery: {
      files: [metadata],
      directories: [],
      filesDiscovered: 1,
      ignoredByDiscovery: 0,
      deniedByDiscovery: 0,
      depthPrunedByDiscovery: 0,
      truncated: false,
    },
    records: [
      { ...metadata, kind: "text", lexical: buildWorkspaceIndexLexicalRecord(redact(raw)) },
    ],
  });
  return createWorkspaceIndex({
    loadSnapshot: () => ({ ...snapshot, version: 6 }),
    saveSnapshot: () => undefined,
  });
}

describe("physical source coordinates after evidence redaction", () => {
  it("rejects persisted collapsed-coordinate records from version six", async () => {
    const scope = { ...sourceFixture("\n"), relativePaths: ["nested/source.txt"] };
    const result = await searchText(scope, query, indexLimits, {
      workspaceIndex: legacyCoordinateIndex(scope),
    });
    expect(result.atoms.map((atom) => atom.lineRange?.startLine)).toEqual([5, 9]);
  });
  it("reuses current-version records with the same physical source coordinates", async () => {
    const scope = sourceFixture("\n");
    const index = createWorkspaceIndex();
    const cold = await searchText(scope, query, indexLimits, { workspaceIndex: index });
    const warm = await searchText(scope, query, indexLimits, { workspaceIndex: index });
    expect(cold.atoms.map((atom) => atom.lineRange?.startLine)).toEqual([5, 9]);
    expect(warm.atoms.map((atom) => atom.lineRange?.startLine)).toEqual([5, 9]);
    expect(warm.workspaceIndex?.reusedRecords).toBe(1);
  });
  it.each(["\n", "\r\n"])(
    "keeps actual lexical, excerpt and source-open line coordinates (%j)",
    async (newline) => {
      const scope = sourceFixture(newline);
      const search = await searchText(scope, {
        kind: "exact-symbol",
        text: "PhysicalCoordinateProbe",
        caseSensitive: true,
        maxResults: 20,
        emittedAtMs: 0,
      });
      expect(search.atoms.map((atom) => atom.lineRange?.startLine)).toEqual([5, 9]);
      const excerpt = await readExcerpt(scope, {
        scopePath: "nested/source.txt",
        startLine: 1,
        endLine: 9,
        maxBytes: 2048,
      });
      expect(excerpt.content.split("\n")[4]).toContain("PhysicalCoordinateProbe VERIFIED_MIDDLE");
      expect(excerpt.content.split("\n")[8]).toContain("PhysicalCoordinateProbe VERIFIED_LAST");
      expect(excerpt.content).not.toContain("private-body");
      const opened = readWorkspaceFileForEditing(scope.workspace, "nested/source.txt").rawText;
      expect(opened.split("\n")[8]).toContain("PhysicalCoordinateProbe VERIFIED_LAST");
      const clicked = await readExcerpt(scope, {
        scopePath: "nested/source.txt",
        startLine: 9,
        endLine: 9,
        maxBytes: 2048,
      });
      expect(clicked.content).toContain("PhysicalCoordinateProbe VERIFIED_LAST");
    },
  );
  it("does not expose a body when the excerpt starts inside a multiline secret", async () => {
    const scope = sourceFixture("\n");
    const excerpt = await readExcerpt(scope, {
      scopePath: "nested/source.txt",
      startLine: 3,
      endLine: 4,
      maxBytes: 2048,
    });
    expect(excerpt.content).toBe("\n");
    expect(excerpt.atom.lineRange).toEqual({ startLine: 3, endLine: 4 });
  });
});
