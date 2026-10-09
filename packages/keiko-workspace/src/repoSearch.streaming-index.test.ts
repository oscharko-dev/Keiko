import { linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { detectWorkspaceAt } from "./detect.js";
import { nodeWorkspaceFs, type WorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText, type SearchScope } from "./repoSearch.js";
import { createWorkspaceIndex } from "./workspaceIndex.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "Vesper temperature",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};
const LIMITS = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: null, elapsedMsMax: null };

function fixture(): {
  readonly scope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly reads: ReturnType<typeof vi.fn<NonNullable<WorkspaceFs["readFileBytes"]>>>;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-streaming-index-"));
  roots.push(root);
  for (let index = 0; index < 12; index += 1) {
    writeFileSync(
      join(root, `manual-${String(index)}.html`),
      index === 11 ? "<p>Vesper temperature is 73.5 C.</p>\n" : "<p>Navigation and upkeep.</p>\n",
    );
  }
  const reads = vi.fn(nodeWorkspaceFs.readFileBytes);
  return {
    scope: {
      workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
      scopeId: "manuals",
      relativePaths: [],
    },
    fs: { ...nodeWorkspaceFs, readFileBytes: reads },
    reads,
  };
}

describe("unlimited discovery with fresh query-bound workspace index records", () => {
  it("reuses completed matches without repeating unchanged body reads or declaring index coverage", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    const cold = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(reads).toHaveBeenCalledTimes(12);
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(warm.atoms).toEqual(cold.atoms);
    expect(warm.filesScanned).toBe(12);
    expect(warm.coverage).toEqual(cold.coverage);
    expect(reads).not.toHaveBeenCalled();
  });

  it("keeps actual selected evidence reads live after a matching index hit", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(reads).not.toHaveBeenCalled();
    const atom = warm.atoms[0];
    expect(atom?.scopePath).toBe("manual-11.html");
    const excerpt = await readExcerpt(
      scope,
      { scopePath: "manual-11.html", startLine: 1, endLine: 1, maxBytes: 512 },
      { fs },
    );
    expect(excerpt.content).toContain("73.5");
    expect(reads).toHaveBeenCalledOnce();
  });

  it("rereads changed negative records and discovers newly matching files", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    writeFileSync(join(scope.workspace.root, "manual-0.html"), "Vesper temperature is 94.8 C.\n");
    reads.mockClear();
    const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    expect(warm.atoms.map((atom) => atom.scopePath)).toContain("manual-0.html");
    expect(reads).toHaveBeenCalledOnce();
  });

  it.each(["new-query", "result-cap", "interpretation"])("keeps %s scans live", async (change) => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    await searchText(
      scope,
      change === "new-query" ? { ...QUERY, text: "Navigation" } : QUERY,
      change === "result-cap" ? { ...LIMITS, maxMatchesReturned: 2 } : LIMITS,
      {
        fs,
        workspaceIndex,
        ...(change === "interpretation"
          ? { queryInterpretation: { kind: "literal" as const, terms: ["temperature"] } }
          : {}),
      },
    );
    expect(reads).toHaveBeenCalledTimes(12);
  });

  it("preserves active known-fit observation over every live file", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    reads.mockClear();
    const observe = vi.fn(() => true);
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, onEligibleTextFile: observe });
    expect(reads).toHaveBeenCalledTimes(12);
    expect(observe).toHaveBeenCalledTimes(12);
  });

  it.each(["symlink", "hardlink"])(
    "revalidates containment and %s aliases before reuse",
    async (kind) => {
      const { scope, fs, reads } = fixture();
      const workspaceIndex = createWorkspaceIndex();
      await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
      const outside = mkdtempSync(join(tmpdir(), "keiko-streaming-index-outside-"));
      roots.push(outside);
      const secret = join(outside, "manual.html");
      writeFileSync(secret, "Vesper temperature is 211 C.\n");
      const target = join(scope.workspace.root, "manual-11.html");
      unlinkSync(target);
      if (kind === "symlink") symlinkSync(secret, target);
      else linkSync(secret, target);
      reads.mockClear();
      const warm = await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
      expect(warm.atoms).toEqual([]);
      expect(reads.mock.calls.some(([path]) => path === secret || path === target)).toBe(false);
    },
  );

  it("does no index or workspace work for a pre-aborted request", async () => {
    const { scope, fs, reads } = fixture();
    const workspaceIndex = createWorkspaceIndex();
    await searchText(scope, QUERY, LIMITS, { fs, workspaceIndex, nowMs: () => 0 });
    const load = vi.spyOn(workspaceIndex, "loadSnapshot");
    const stat = vi.fn(fs.stat);
    reads.mockClear();
    const controller = new AbortController();
    controller.abort();
    const result = await searchText(scope, QUERY, LIMITS, {
      fs: { ...fs, stat },
      workspaceIndex,
      signal: controller.signal,
    });
    expect(result.coverage.reasons).toContain("aborted");
    expect(load).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });
});
