import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { buildCodeIntelligenceIndexFromCandidates } from "./codeIntelligence.js";
import {
  endpointSourceFileSetFromCandidates,
  endpointSourcePreferences,
} from "./endpointContractSource.js";
import { buildImportGraphFromCandidates } from "./importGraphEdges.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import { gatherCandidates, limitCandidateSetForStructuralBuild } from "./repoSearchScan.js";
import { createStructuralAdapterRequestContext } from "./structuralAdapterRequestContext.js";
import { buildSymbolGraphFromCandidates } from "./symbolGraphBuild.js";
import { testSourcePairingAdapter } from "./testSourcePairing.js";

const ROOT = "/workspace";
const LATE = "src/zz-product.ts";
const NOW = (): number => 1_784_653_600_000;

function fixture(): Record<string, string> {
  return {
    "src/a-entry.ts":
      'import { lateProduct } from "./b-index.js";\nexport function enter() { return lateProduct(); }',
    "src/b-index.ts": 'export * from "./zz-product.js";',
    ...Object.fromEntries(
      Array.from({ length: 2056 }, (_, index) => [
        `src/filler-${index.toString().padStart(4, "0")}.ts`,
        "export {};",
      ]),
    ),
    "src/zz-product.test.ts": 'import { lateProduct } from "./zz-product.js";',
    [LATE]: 'import "./a-entry";\nexport function lateProduct() { return 37; }',
  };
}

function scope(): SearchScope {
  return {
    scopeId: "null-intake",
    relativePaths: [],
    workspace: {
      root: ROOT,
      selectedRoot: ROOT,
      name: "null-intake",
      version: "1.0.0",
      testFramework: "vitest",
      sourceDirs: ["src"],
      testDirs: [],
      languages: ["typescript"],
      ignoreLines: [],
    },
  };
}

function inputs(): {
  readonly files: Record<string, string>;
  readonly selected: SearchScope;
  readonly fs: ReturnType<typeof memFs>;
  readonly candidates: ReturnType<typeof gatherCandidates>;
} {
  const files = fixture();
  const selected = scope();
  const fs = memFs(ROOT, files);
  const candidates = gatherCandidates(selected, DEFAULT_SEARCH_LIMITS, fs);
  expect(candidates.files.map((file) => file.relativePath)).toContain(LATE);
  expect(candidates.truncated).toBe(false);
  return { files, selected, fs, candidates };
}

describe("structural intake without a caller file ceiling", () => {
  it("keeps the complete admitted eligible inventory without inventing truncation", () => {
    const { candidates } = inputs();
    const bounded = limitCandidateSetForStructuralBuild(candidates, DEFAULT_SEARCH_LIMITS, (file) =>
      file.relativePath.endsWith(".ts"),
    );
    expect(bounded.files).toEqual(candidates.files);
    expect(bounded.truncated).toBe(false);
  });

  it("certifies the actual imported barrel target beyond the former default cutoff", () => {
    const { selected, fs, candidates } = inputs();
    const index = buildCodeIntelligenceIndexFromCandidates(
      selected,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
      { disableCache: true, nowMs: NOW },
    );
    const target = index.symbols.find((symbol) => symbol.scopePath === LATE);
    expect(target?.name).toBe("lateProduct");
    expect(index.calls.find((call) => call.callerPath === "src/a-entry.ts")).toMatchObject({
      binding: "lexical",
      targetPath: LATE,
      targetName: "lateProduct",
      targetDeclarationSpan: target?.declarationSpan,
    });
    expect(index.filesIndexed).toBe(candidates.files.length);
    expect(index.candidateLimitReached).toBe(false);
  });

  it("retains a current late source witness independently of complete-body cache retention", async () => {
    const { files, selected, fs, candidates } = inputs();
    let allowed = true;
    const context = createStructuralAdapterRequestContext(selected, DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: NOW,
      isCandidateAllowed: (path) => path !== LATE || allowed,
    });
    const promise = context.codeIntelligenceIndex();
    expect(context.codeIntelligenceIndex()).toBe(promise);
    const index = await promise;
    expect(context.isCodeIntelligenceSourceCurrent(LATE)).toBe(true);
    expect(index.filesIndexed).toBe(candidates.files.length);
    allowed = false;
    expect(context.isCodeIntelligenceSourceCurrent(LATE)).toBe(false);
    allowed = true;
    files[LATE] = "export function lateProduct() { return 99; }";
    expect(context.isCodeIntelligenceSourceCurrent(LATE)).toBe(false);
    expect(context.isCodeIntelligenceSourceCurrent("outside.ts")).toBe(false);
    expect(context.diagnostics().codeIndexBuildCount).toBe(1);
  });

  it("reads the actual late import source under the same null policy", async () => {
    const { selected, fs, candidates } = inputs();
    const graph = await buildImportGraphFromCandidates(
      selected,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(graph.edges.find((edge) => edge.importerPath === LATE)).toMatchObject({
      targetPath: "src/a-entry.ts",
    });
    expect(graph.diagnostics.filesScanned).toBe(candidates.files.length);
  });

  it("locates the actual late symbol graph definition under the same null policy", async () => {
    const { selected, fs, candidates } = inputs();
    const symbols = await buildSymbolGraphFromCandidates(
      selected,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(symbols.definitions.get("lateproduct")?.[0]?.scopePath).toBe(LATE);
    expect(symbols.diagnostics.filesScanned).toBe(candidates.files.length);
  });

  it("keeps late endpoint preferences and excludes paths absent from inventory", () => {
    const { candidates } = inputs();
    const paths = candidates.files.map((file) => file.relativePath);
    expect(
      endpointSourcePreferences(candidates, DEFAULT_SEARCH_LIMITS, ["missing.ts", ...paths]),
    ).toEqual(paths);
  });

  it("reads the late endpoint source only from existing admitted candidates", async () => {
    const { selected, fs, candidates } = inputs();
    const sources = await endpointSourceFileSetFromCandidates(
      selected,
      DEFAULT_SEARCH_LIMITS,
      fs,
      candidates,
    );
    expect(sources.files.some((file) => file.scopePath === LATE)).toBe(true);
    expect(sources.candidateLimitReached).toBe(false);
  });

  it("pairs the actual late source and test inside the admitted inventory", async () => {
    const { selected, fs } = inputs();
    const query: RetrievalQuery = {
      kind: "natural-language",
      text: LATE,
      caseSensitive: true,
      maxResults: 10,
      emittedAtMs: NOW(),
    };
    const atoms = await testSourcePairingAdapter.lookup(
      selected,
      query,
      DEFAULT_SEARCH_LIMITS,
      fs,
      { nowMs: NOW },
    );
    expect(atoms.map((atom) => atom.scopePath)).toContain("src/zz-product.test.ts");
  });

  it.each([0, 8])("preserves an explicit %i-file index ceiling", (maxFilesScanned) => {
    const { selected, fs, candidates } = inputs();
    const limited = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned };
    const index = buildCodeIntelligenceIndexFromCandidates(selected, limited, fs, candidates, {
      disableCache: true,
      nowMs: NOW,
    });
    expect(index.filesIndexed).toBe(maxFilesScanned);
    expect(index.symbols.some((symbol) => symbol.scopePath === LATE)).toBe(false);
    expect(index.calls.some((call) => call.binding === "lexical" && call.targetPath === LATE)).toBe(
      false,
    );
    expect(index.candidateLimitReached).toBe(true);
    expect(endpointSourcePreferences(candidates, limited, [LATE])).toHaveLength(
      maxFilesScanned === 0 ? 0 : 1,
    );
  });
});
