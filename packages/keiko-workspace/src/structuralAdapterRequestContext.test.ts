import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import {
  buildCodeIntelligenceIndex,
  buildCodeIntelligenceIndexFromCandidates,
} from "./codeIntelligence.js";
import { endpointContractAdapter } from "./endpointContractAdapter.js";
import { PathEscapeError } from "./errors.js";
import type { WorkspaceFs } from "./fs.js";
import { importGraphAdapter } from "./importGraph.js";
import {
  DEFAULT_SEARCH_LIMITS,
  searchText,
  type SearchLimits,
  type SearchScope,
} from "./repoSearch.js";
import { candidateInventoryFileLimit, gatherCandidates } from "./repoSearchScan.js";
import {
  createStructuralAdapterRequestContext,
  type StructuralAdapterRequestContext,
} from "./structuralAdapterRequestContext.js";
import { symbolGraphAdapter } from "./symbolGraph.js";
import {
  createDefaultStructuralRegistry,
  runStructuralAdapters,
  type RunAllResult,
  type StructuralAdapter,
} from "./structuralAdapters.js";
import type { WorkspaceInfo } from "./types.js";
import { testSourcePairingAdapter } from "./testSourcePairing.js";
import { createWorkspaceIndex, type WorkspaceIndex } from "./workspaceIndex.js";

const ROOT = "/workspace";
const FIXED_NOW = (): number => 1_700_000_000_000;
const FILES: Readonly<Record<string, string>> = {
  "src/math.ts": [
    "export function calculate(value: number): number {",
    "  return value * 2;",
    "}",
  ].join("\n"),
  "src/api/client.ts": 'export const loadUsers = (): Promise<Response> => fetch("/api/users");',
  "src/api/routes.ts": 'app.get("/api/users", (_request, response) => response.json([]));',
  "tests/math.test.ts": [
    'import { calculate } from "../src/math.js";',
    'it("calculates", () => expect(calculate(2)).toBe(4));',
  ].join("\n"),
};

function scope(relativePaths: readonly string[] = []): SearchScope {
  const workspace: WorkspaceInfo = {
    root: ROOT,
    name: "request-context-fixture",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
  return { workspace, scopeId: "request-context", relativePaths };
}

function query(text = "calculate", caseSensitive = false): RetrievalQuery {
  return {
    kind: "exact-symbol",
    text,
    caseSensitive,
    maxResults: 100,
    emittedAtMs: FIXED_NOW(),
  };
}

function filePattern(text = "**/*.ts"): RetrievalQuery {
  return {
    kind: "file-pattern",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: FIXED_NOW(),
  };
}

function naturalLanguage(text: string): RetrievalQuery {
  return {
    kind: "natural-language",
    text,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: FIXED_NOW(),
  };
}

function limits(maxFilesScanned: number): SearchLimits {
  return { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned };
}

function manySourceFiles(count: number): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `src/file-${index.toString().padStart(3, "0")}.ts`,
      `export const value${index.toString()} = ${index.toString()};`,
    ]),
  );
}

function countingFs(files: Readonly<Record<string, string>> = FILES): {
  readonly fs: WorkspaceFs;
  readonly readDirCount: () => number;
  readonly readFileBytesCount: () => number;
  readonly readFileUtf8Count: () => number;
  readonly realPathCount: () => number;
  readonly statCount: () => number;
} {
  const base = memFs(ROOT, files);
  let readDirCalls = 0;
  let readFileBytesCalls = 0;
  let readFileUtf8Calls = 0;
  let realPathCalls = 0;
  let statCalls = 0;
  return {
    fs: {
      ...base,
      readFileUtf8SameDescriptor: (
        absolutePath,
        maxBytes,
        hardLinkPolicy,
        expected,
      ): ReturnType<NonNullable<WorkspaceFs["readFileUtf8SameDescriptor"]>> => {
        readFileUtf8Calls += 1;
        return (
          base.readFileUtf8SameDescriptor?.(absolutePath, maxBytes, hardLinkPolicy, expected) ?? {
            rawText: base.readFileUtf8(absolutePath),
            sizeBytes: base.stat(absolutePath).size,
            stat: base.stat(absolutePath),
          }
        );
      },
      readFileUtf8: (absolutePath): string => {
        readFileUtf8Calls += 1;
        return base.readFileUtf8(absolutePath);
      },
      readFileBytes: async (
        absolutePath,
        maxBytes,
        hardLinkPolicy,
        expected,
      ): Promise<Uint8Array> => {
        readFileBytesCalls += 1;
        return (
          (await base.readFileBytes?.(absolutePath, maxBytes, hardLinkPolicy, expected)) ??
          new Uint8Array()
        );
      },
      readDir: (absolutePath, maxEntries): ReturnType<WorkspaceFs["readDir"]> => {
        readDirCalls += 1;
        return base.readDir(absolutePath, maxEntries);
      },
      realPath: (absolutePath): string => {
        realPathCalls += 1;
        return base.realPath(absolutePath);
      },
      stat: (absolutePath): ReturnType<WorkspaceFs["stat"]> => {
        statCalls += 1;
        return base.stat(absolutePath);
      },
    },
    readDirCount: () => readDirCalls,
    readFileBytesCount: () => readFileBytesCalls,
    readFileUtf8Count: () => readFileUtf8Calls,
    realPathCount: () => realPathCalls,
    statCount: () => statCalls,
  };
}

async function repeatedSearchValidationIo(
  fileCount: number,
  queryCount: number,
): Promise<{ readonly realPath: number; readonly stat: number; readonly readDir: number }> {
  const measured = countingFs(manySourceFiles(fileCount));
  const capped = limits(1);
  const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs, {
    nowMs: FIXED_NOW,
  });
  await context.searchText(query("value0"), capped);
  const before = {
    realPath: measured.realPathCount(),
    stat: measured.statCount(),
    readDir: measured.readDirCount(),
  };
  for (let index = 0; index < queryCount; index += 1) {
    await context.searchText(query(`absent${index.toString()}`), capped);
  }
  return {
    realPath: measured.realPathCount() - before.realPath,
    stat: measured.statCount() - before.stat,
    readDir: measured.readDirCount() - before.readDir,
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function rejectionReason(result: PromiseSettledResult<unknown>): unknown {
  if (result.status === "fulfilled") {
    throw new Error("expected candidate discovery to reject");
  }
  return result.reason as unknown;
}

function firstRejectionReason(results: readonly PromiseSettledResult<unknown>[]): unknown {
  const first = results[0];
  if (first === undefined) {
    throw new Error("expected at least one settled product");
  }
  return rejectionReason(first);
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected candidate discovery to throw");
}

async function runAdapters(useContext: boolean): Promise<RunAllResult> {
  const fs = memFs(ROOT, FILES);
  const searchScope = scope();
  const requestContext = createStructuralAdapterRequestContext(
    searchScope,
    DEFAULT_SEARCH_LIMITS,
    fs,
  );
  return runStructuralAdapters(
    createDefaultStructuralRegistry({ ecosystems: [] }),
    searchScope,
    query(),
    DEFAULT_SEARCH_LIMITS,
    fs,
    {
      nowMs: FIXED_NOW,
      ...(useContext ? { requestContext } : {}),
    },
  );
}

describe("StructuralAdapterRequestContext", () => {
  it("shares one promise per structural product and one candidate inventory across products", async () => {
    const searchScope = scope();
    const baseline = countingFs();
    const expectedCandidates = gatherCandidates(searchScope, DEFAULT_SEARCH_LIMITS, baseline.fs);
    const measured = countingFs();
    const context = createStructuralAdapterRequestContext(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
    );

    const firstCodeIndex = context.codeIntelligenceIndex();
    const firstSymbolGraph = context.symbolGraph();
    const firstImportGraph = context.importGraph();
    const firstEndpointGraph = context.endpointContractGraph();
    expect(context.codeIntelligenceIndex()).toBe(firstCodeIndex);
    expect(context.symbolGraph()).toBe(firstSymbolGraph);
    expect(context.importGraph()).toBe(firstImportGraph);
    expect(context.endpointContractGraph()).toBe(firstEndpointGraph);

    await Promise.all([firstCodeIndex, firstSymbolGraph, firstImportGraph, firstEndpointGraph]);
    const firstPaths = context.candidatePaths();
    expect(context.candidatePaths()).toBe(firstPaths);
    expect(firstPaths).toEqual(expectedCandidates.files.map((file) => file.relativePath));
    expect(baseline.readDirCount()).toBeGreaterThan(0);
    expect(measured.readDirCount()).toBe(baseline.readDirCount());
  });

  it("avoids process-cache fingerprint walks for its request-local code index", async () => {
    const searchScope = scope();
    const direct = countingFs();
    const candidates = gatherCandidates(searchScope, DEFAULT_SEARCH_LIMITS, direct.fs);
    const directRealPathBefore = direct.realPathCount();
    const directStatBefore = direct.statCount();
    buildCodeIntelligenceIndexFromCandidates(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      direct.fs,
      candidates,
      { disableCache: true },
    );

    const measured = countingFs();
    const context = createStructuralAdapterRequestContext(
      searchScope,
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
    );
    context.candidatePaths();
    const measuredRealPathBefore = measured.realPathCount();
    const measuredStatBefore = measured.statCount();
    await context.codeIntelligenceIndex();

    expect(measured.realPathCount() - measuredRealPathBefore).toBe(
      direct.realPathCount() - directRealPathBefore,
    );
    expect(measured.statCount() - measuredStatBefore).toBe(direct.statCount() - directStatBefore);
  });

  it("shares a sticky candidate-discovery rejection without retrying filesystem traversal", async () => {
    const failure = new Error("candidate discovery failed");
    const base = memFs(ROOT, FILES);
    let statCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      stat: (): never => {
        statCalls += 1;
        throw failure;
      },
    };
    const context = createStructuralAdapterRequestContext(
      scope(["src/math.ts"]),
      DEFAULT_SEARCH_LIMITS,
      fs,
    );
    const products = [
      context.codeIntelligenceIndex(),
      context.symbolGraph(),
      context.importGraph(),
      context.endpointContractGraph(),
    ];

    expect(context.codeIntelligenceIndex()).toBe(products[0]);
    expect(context.symbolGraph()).toBe(products[1]);
    expect(context.importGraph()).toBe(products[2]);
    expect(context.endpointContractGraph()).toBe(products[3]);
    const settled = await Promise.allSettled(products);
    const sharedReason = firstRejectionReason(settled);
    for (const result of settled) {
      expect(rejectionReason(result)).toBe(sharedReason);
    }
    expect(thrownBy(() => context.candidatePaths())).toBe(sharedReason);
    expect(thrownBy(() => context.candidatePaths())).toBe(sharedReason);
    expect(statCalls).toBe(1);
  });

  it("preserves adapter output when the request-local context replaces direct builders", async () => {
    const direct = await runAdapters(false);
    const requestLocal = await runAdapters(true);

    expect(requestLocal).toEqual(direct);
  });

  it("rejects request-context scope, filesystem, and limit mismatches at the runner boundary", async () => {
    const boundScope = scope();
    const boundFs = memFs(ROOT, FILES);
    const context = createStructuralAdapterRequestContext(
      boundScope,
      DEFAULT_SEARCH_LIMITS,
      boundFs,
    );
    const registry = { adapters: [] };
    const deps = { nowMs: FIXED_NOW, requestContext: context };

    await expect(
      runStructuralAdapters(registry, scope(), query(), DEFAULT_SEARCH_LIMITS, boundFs, deps),
    ).rejects.toThrow("structural request context binding mismatch");
    await expect(
      runStructuralAdapters(registry, boundScope, query(), limits(1), boundFs, deps),
    ).rejects.toThrow("structural request context binding mismatch");
    await expect(
      runStructuralAdapters(
        registry,
        boundScope,
        query(),
        DEFAULT_SEARCH_LIMITS,
        memFs(ROOT, FILES),
        deps,
      ),
    ).rejects.toThrow("structural request context binding mismatch");
  });

  it("rechecks runner binding after asynchronous availability and coverage work", async () => {
    const mutableScope = scope();
    const boundFs = memFs(ROOT, FILES);
    const context = createStructuralAdapterRequestContext(
      mutableScope,
      DEFAULT_SEARCH_LIMITS,
      boundFs,
    );
    const adapter: StructuralAdapter = {
      name: "binding-probe",
      isAvailable: async (): Promise<boolean> => {
        await Promise.resolve();
        return true;
      },
      lookup: (): Promise<readonly never[]> => Promise.resolve([]),
      coverage: async (): Promise<undefined> => {
        await Promise.resolve();
        (mutableScope.relativePaths as string[]).push("src/math.ts");
        throw new Error("coverage unavailable");
      },
    };

    await expect(
      runStructuralAdapters(
        { adapters: [adapter] },
        mutableScope,
        query(),
        DEFAULT_SEARCH_LIMITS,
        boundFs,
        { nowMs: FIXED_NOW, requestContext: context },
      ),
    ).rejects.toThrow("structural request context binding mismatch");
  });

  it("rejects binding mismatches on every directly callable context-aware adapter", async () => {
    const boundScope = scope();
    const boundFs = memFs(ROOT, FILES);
    const context = createStructuralAdapterRequestContext(
      boundScope,
      DEFAULT_SEARCH_LIMITS,
      boundFs,
    );
    const deps = { nowMs: FIXED_NOW, requestContext: context };
    const adapters = [
      testSourcePairingAdapter,
      symbolGraphAdapter,
      importGraphAdapter,
      endpointContractAdapter,
    ];

    for (const adapter of adapters) {
      await expect(
        adapter.lookup(scope(), query(), DEFAULT_SEARCH_LIMITS, boundFs, deps),
      ).rejects.toThrow("structural request context binding mismatch");
      if (adapter.coverage !== undefined) {
        await expect(
          adapter.coverage(scope(), DEFAULT_SEARCH_LIMITS, boundFs, deps),
        ).rejects.toThrow("structural request context binding mismatch");
      }
    }
  });

  it("rejects scope mutation while every context-aware adapter is awaiting its graph", async () => {
    const adapters = [
      testSourcePairingAdapter,
      symbolGraphAdapter,
      importGraphAdapter,
      endpointContractAdapter,
    ];

    for (const adapter of adapters) {
      const mutableScope = scope(["src/math.ts"]);
      const boundFs = memFs(ROOT, FILES);
      const context = createStructuralAdapterRequestContext(
        mutableScope,
        DEFAULT_SEARCH_LIMITS,
        boundFs,
      );
      const pending = adapter.lookup(mutableScope, query(), DEFAULT_SEARCH_LIMITS, boundFs, {
        nowMs: FIXED_NOW,
        requestContext: context,
      });
      (mutableScope.relativePaths as string[])[0] = "src/api/client.ts";

      await expect(pending).rejects.toThrow("structural request context binding mismatch");

      const coverage = adapter.coverage;
      if (coverage !== undefined) {
        const coverageScope = scope(["src/math.ts"]);
        const coverageFs = memFs(ROOT, FILES);
        const coverageContext = createStructuralAdapterRequestContext(
          coverageScope,
          DEFAULT_SEARCH_LIMITS,
          coverageFs,
        );
        const pendingCoverage = coverage(coverageScope, DEFAULT_SEARCH_LIMITS, coverageFs, {
          nowMs: FIXED_NOW,
          requestContext: coverageContext,
        });
        (coverageScope.relativePaths as string[])[0] = "src/api/client.ts";

        await expect(pendingCoverage).rejects.toThrow(
          "structural request context binding mismatch",
        );
      }
    }
  });

  it("rejects search-limit mutation while every context-aware adapter is awaiting its graph", async () => {
    const adapters = [
      testSourcePairingAdapter,
      symbolGraphAdapter,
      importGraphAdapter,
      endpointContractAdapter,
    ];

    for (const adapter of adapters) {
      const boundScope = scope();
      const mutableLimits = { ...DEFAULT_SEARCH_LIMITS };
      const boundFs = memFs(ROOT, FILES);
      const context = createStructuralAdapterRequestContext(boundScope, mutableLimits, boundFs);
      const pending = adapter.lookup(boundScope, query(), mutableLimits, boundFs, {
        nowMs: FIXED_NOW,
        requestContext: context,
      });
      mutableLimits.maxMatchesReturned = 1;

      await expect(pending).rejects.toThrow("structural request context binding mismatch");
    }
  });

  it("rejects bound scope and limit objects mutated after context creation", async () => {
    const boundScope = scope(["src/math.ts"]);
    const boundLimits = { ...DEFAULT_SEARCH_LIMITS };
    const boundFs = memFs(ROOT, FILES);
    const context = createStructuralAdapterRequestContext(boundScope, boundLimits, boundFs);
    await context.symbolGraph();

    (boundScope.relativePaths as string[])[0] = "src/api/client.ts";
    expect(() => {
      context.assertGraphBinding(boundScope, boundLimits, boundFs);
    }).toThrow("structural request context binding mismatch");

    const limitScope = scope();
    const mutableLimits = { ...DEFAULT_SEARCH_LIMITS };
    const limitContext = createStructuralAdapterRequestContext(limitScope, mutableLimits, boundFs);
    mutableLimits.maxFilesScanned = 1;
    expect(() => {
      limitContext.assertGraphBinding(limitScope, mutableLimits, boundFs);
    }).toThrow("structural request context binding mismatch");
  });

  it("applies the structural file ceiling after source eligibility filtering", async () => {
    const mixedFiles = {
      "package.json": '{"name":"fixture"}',
      "README.md": "fixture",
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;",
    };
    const capped = limits(1);
    const directFs = memFs(ROOT, mixedFiles);
    const direct = buildCodeIntelligenceIndex(scope(), capped, directFs, { disableCache: true });
    const contextFs = memFs(ROOT, mixedFiles);
    const context = createStructuralAdapterRequestContext(scope(), capped, contextFs);
    const requestLocal = await context.codeIntelligenceIndex();

    expect(direct.filesIndexed).toBe(1);
    expect(requestLocal.filesIndexed).toBe(1);
  });

  it("reuses the exact policy and file ceiling with byte-identical findFiles output", async () => {
    const measured = countingFs();
    const context = createStructuralAdapterRequestContext(
      scope(),
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
      { nowMs: FIXED_NOW },
    );
    const searchHints = {
      retrievalIntent: "targeted-code-search" as const,
      recentPaths: ["src/math.ts"],
    };
    const first = await context.findFiles(filePattern(), DEFAULT_SEARCH_LIMITS, {
      searchHints,
    });
    const afterFirst = measured.readDirCount();
    const second = await context.findFiles(filePattern(), DEFAULT_SEARCH_LIMITS, {
      searchHints: { ...searchHints, recentPaths: [...searchHints.recentPaths] },
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(afterFirst).toBeGreaterThan(0);
    expect(measured.readDirCount()).toBe(afterFirst);
    expect(context.diagnostics()).toMatchObject({
      candidateInventoryBuildCount: 1,
      fileSearchCount: 2,
    });
  });

  it("reads each redacted ranking preview at most once across request anchors", async () => {
    const measured = countingFs(manySourceFiles(20));
    const capped = limits(2);
    const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs);

    await context.searchText(naturalLanguage("value1"), capped);
    const afterFirst = measured.readFileUtf8Count();
    await context.searchText(naturalLanguage("value2"), capped);
    const secondQueryReads = measured.readFileUtf8Count() - afterFirst;

    expect(afterFirst).toBeGreaterThan(10);
    expect(secondQueryReads).toBe(0);
  });

  it("keeps unchanged oversized previews warm and detects a later size transition", async () => {
    const files: Record<string, string> = {
      "src/large.ts": `export const largeNeedle = 1;\n${" x".repeat(35_000)}`,
    };
    const measured = countingFs(files);
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs, {
      nowMs: FIXED_NOW,
    });

    const cold = await context.searchText(query("largeNeedle"), capped);
    const afterCold = measured.readFileBytesCount();
    const warm = await context.searchText(query("largeNeedle"), capped);

    expect(cold.atoms.map((atom) => atom.scopePath)).toEqual(["src/large.ts"]);
    expect(measured.readFileBytesCount()).toBe(afterCold);
    expect(warm.workspaceIndex).toMatchObject({ reusedRecords: 1, staleRecords: 0 });

    files["src/large.ts"] = "export const freshNeedle = 2;";
    const resized = await context.searchText(query("freshNeedle"), capped);
    expect(resized.atoms.map((atom) => atom.scopePath)).toEqual(["src/large.ts"]);
    expect(resized.workspaceIndex).toMatchObject({ reusedRecords: 0, staleRecords: 1 });
  });

  it("fails closed when a cached preview path escapes before revalidation", async () => {
    const base = memFs(ROOT, {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const freshZ = 2;",
    });
    let escape = false;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath): string =>
        escape && absolutePath.endsWith("/src/z.ts")
          ? "/outside/z.ts"
          : base.realPath(absolutePath),
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, fs, {
      nowMs: FIXED_NOW,
    });

    await context.searchText(query("alpha"), capped);
    escape = true;

    await expect(context.searchText(query("freshZ"), capped)).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it("requires a fresh request context after cached preview validation fails", async () => {
    const files: Record<string, string> = {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const oldZ = 2;",
    };
    const base = memFs(ROOT, files);
    let escapeZ = false;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (absolutePath): string =>
        escapeZ && absolutePath.endsWith("/src/z.ts")
          ? "/outside/z.ts"
          : base.realPath(absolutePath),
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, fs, {
      nowMs: FIXED_NOW,
    });

    await context.searchText(query("alpha"), capped);
    files["src/a.ts"] = "export const freshA = 2;";
    escapeZ = true;
    await expect(context.searchText(query("freshA"), capped)).rejects.toBeInstanceOf(
      PathEscapeError,
    );

    escapeZ = false;
    const recovered = await createStructuralAdapterRequestContext(scope(), capped, fs, {
      nowMs: FIXED_NOW,
    }).searchText(query("freshA"), capped);
    expect(recovered.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts"]);
  });

  it("poisons queued index searches after a fatal partial-session failure", async () => {
    const base = memFs(ROOT, {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const beta = 2;",
    });
    let ioCalls = 0;
    let aByteReads = 0;
    let ioCallsAtFailure = 0;
    let escapeOnce = true;
    const fs: WorkspaceFs = {
      ...base,
      stat: (path) => {
        ioCalls += 1;
        return base.stat(path);
      },
      readDir: (path, maxEntries) => {
        ioCalls += 1;
        return base.readDir(path, maxEntries);
      },
      realPath: (path): string => {
        ioCalls += 1;
        if (escapeOnce && aByteReads >= 2 && path.endsWith("/src/z.ts")) {
          escapeOnce = false;
          ioCallsAtFailure = ioCalls;
          return "/outside/z.ts";
        }
        return base.realPath(path);
      },
      exists: (path): boolean => {
        ioCalls += 1;
        return base.exists(path);
      },
      readFileUtf8SameDescriptor: (path, maxBytes, hardLinkPolicy, expected) => {
        ioCalls += 1;
        return (
          base.readFileUtf8SameDescriptor?.(path, maxBytes, hardLinkPolicy, expected) ?? {
            rawText: base.readFileUtf8(path),
            sizeBytes: base.stat(path).size,
            stat: base.stat(path),
          }
        );
      },
      readFileBytes: async (path, maxBytes, hardLinkPolicy, expected): Promise<Uint8Array> => {
        ioCalls += 1;
        if (path.endsWith("/src/a.ts")) aByteReads += 1;
        return (
          (await base.readFileBytes?.(path, maxBytes, hardLinkPolicy, expected)) ?? new Uint8Array()
        );
      },
    };
    let saveCount = 0;
    const workspaceIndex: WorkspaceIndex = {
      loadSnapshot: (): Promise<undefined> => Promise.resolve(undefined),
      saveSnapshot: (): Promise<void> => {
        saveCount += 1;
        return Promise.resolve();
      },
    };
    const capped = limits(2);
    const context = createStructuralAdapterRequestContext(scope(), capped, fs, {
      nowMs: FIXED_NOW,
    });

    const results = await Promise.allSettled([
      context.searchText(query("alpha"), capped, { workspaceIndex }),
      context.searchText(query("beta"), capped, { workspaceIndex }),
    ]);
    const firstError = rejectionReason(results[0]);
    const secondError = rejectionReason(results[1]);

    expect(firstError).toBeInstanceOf(PathEscapeError);
    expect(secondError).toBe(firstError);
    expect(aByteReads).toBeGreaterThanOrEqual(2);
    expect(ioCallsAtFailure).toBeGreaterThan(0);
    expect(ioCalls).toBe(ioCallsAtFailure);
    expect(saveCount).toBe(0);

    const bypassed = await Promise.allSettled([
      context.searchText(query("beta"), capped, {
        searchHints: { recentPaths: ["src/z.ts"] },
        workspaceIndex,
      }),
      context.searchText(query("beta"), limits(1), { workspaceIndex }),
    ]);
    expect(rejectionReason(bypassed[0])).toBe(firstError);
    expect(rejectionReason(bypassed[1])).toBe(firstError);
    expect(ioCalls).toBe(ioCallsAtFailure);
    expect(saveCount).toBe(0);
  });

  it("poisons the request-local pool when a standalone search fails fatally", async () => {
    const base = memFs(ROOT, {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const freshZ = 2;",
    });
    let escapeZ = false;
    let realPathCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      realPath: (path): string => {
        realPathCalls += 1;
        return escapeZ && path.endsWith("/src/z.ts") ? "/outside/z.ts" : base.realPath(path);
      },
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, fs, {
      nowMs: FIXED_NOW,
    });
    await context.searchText(query("alpha"), capped);
    escapeZ = true;
    const failed = await Promise.allSettled([
      context.searchText(query("freshZ"), capped, {
        searchHints: { recentPaths: ["src/z.ts"] },
      }),
    ]);
    const fatalError = rejectionReason(failed[0]);
    const callsAtFailure = realPathCalls;

    escapeZ = false;
    const retried = await Promise.allSettled([context.searchText(query("freshZ"), capped)]);
    expect(fatalError).toBeInstanceOf(PathEscapeError);
    expect(rejectionReason(retried[0])).toBe(fatalError);
    expect(realPathCalls).toBe(callsAtFailure);
  });

  it("drains stale preview metadata when the validating search is aborted", async () => {
    const files: Record<string, string> = {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const oldZ = 2;",
    };
    const base = memFs(ROOT, files);
    const callAbort = new AbortController();
    let abortOnAStat = false;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath): ReturnType<WorkspaceFs["stat"]> => {
        const stat = base.stat(absolutePath);
        if (abortOnAStat && absolutePath.endsWith("/src/a.ts")) {
          abortOnAStat = false;
          callAbort.abort();
        }
        return stat;
      },
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, fs, {
      nowMs: FIXED_NOW,
    });

    await context.searchText(query("alpha"), capped);
    files["src/a.ts"] = "export const freshA = 2;";
    abortOnAStat = true;
    const aborted = await context.searchText(query("freshA"), capped, {
      signal: callAbort.signal,
    });
    expect(aborted.coverage.reasons).toContain("aborted");

    const recovered = await context.searchText(query("freshA"), capped);
    expect(recovered.atoms.map((atom) => atom.scopePath)).toEqual(["src/a.ts"]);
  });

  it("preserves cold content ranking under a narrow cap with the ephemeral index", async () => {
    const files = {
      ...Object.fromEntries(
        Array.from({ length: 19 }, (_, index) => [
          `src/a-decoy-${index.toString().padStart(2, "0")}.ts`,
          `export const decoy${index.toString()} = "unrelated";`,
        ]),
      ),
      "src/z-target.ts": 'export const target = "needle";',
    };
    const capped = limits(2);
    const directFs = memFs(ROOT, files);
    const direct = await searchText(scope(), naturalLanguage("needle"), capped, {
      fs: directFs,
      nowMs: FIXED_NOW,
    });
    const contextFs = memFs(ROOT, files);
    const context = createStructuralAdapterRequestContext(scope(), capped, contextFs, {
      nowMs: FIXED_NOW,
    });
    const requestLocal = await context.searchText(naturalLanguage("needle"), capped);

    expect(direct.atoms.map((atom) => atom.scopePath)).toEqual(["src/z-target.ts"]);
    expect(requestLocal.atoms.map((atom) => atom.scopePath)).toEqual(
      direct.atoms.map((atom) => atom.scopePath),
    );
  });

  it("shares one serialized workspace-index session across exact-symbol anchors", async () => {
    const measured = countingFs();
    const backingIndex = createWorkspaceIndex();
    let loadCount = 0;
    let saveCount = 0;
    const workspaceIndex: WorkspaceIndex = {
      loadSnapshot: async (scopeKey) => {
        loadCount += 1;
        return backingIndex.loadSnapshot(scopeKey);
      },
      saveSnapshot: async (scopeKey, snapshot) => {
        saveCount += 1;
        await backingIndex.saveSnapshot(scopeKey, snapshot);
      },
    };
    const context = createStructuralAdapterRequestContext(
      scope(),
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
      { nowMs: FIXED_NOW },
    );

    const [calculate, loadUsers] = await Promise.all([
      context.searchText(query("calculate"), DEFAULT_SEARCH_LIMITS, {
        workspaceIndex,
      }),
      context.searchText(query("loadUsers"), DEFAULT_SEARCH_LIMITS, {
        workspaceIndex,
      }),
    ]);

    expect(loadCount).toBe(1);
    expect(saveCount).toBeGreaterThan(0);
    expect(calculate.atoms.some((atom) => atom.scopePath === "src/math.ts")).toBe(true);
    expect(loadUsers.atoms.some((atom) => atom.scopePath === "src/api/client.ts")).toBe(true);
    expect(context.diagnostics().textSearchCount).toBe(2);
  });

  it("reuses lexical records across absent anchors without a persistent workspace index", async () => {
    const measured = countingFs(manySourceFiles(20));
    const capped = limits(20);
    const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs, {
      nowMs: FIXED_NOW,
    });

    const first = await context.searchText(query("absentFirst"), capped);
    const afterFirst = measured.readFileBytesCount();
    const second = await context.searchText(query("absentSecond"), capped);
    const secondQueryReads = measured.readFileBytesCount() - afterFirst;

    expect(afterFirst).toBeGreaterThanOrEqual(20);
    expect(secondQueryReads).toBe(0);
    expect(first.workspaceIndex).toMatchObject({ reusedRecords: 0, staleRecords: 0 });
    expect(second.workspaceIndex).toMatchObject({ reusedRecords: 20, staleRecords: 0 });
    expect(context.diagnostics()).toMatchObject({
      candidateInventoryBuildCount: 1,
      textSearchCount: 2,
    });
  });

  it("bounds strong preview revalidation by the capped inventory rather than workspace size", async () => {
    const queryCount = 8;
    const small = await repeatedSearchValidationIo(20, queryCount);
    const large = await repeatedSearchValidationIo(200, queryCount);
    const capped = limits(1);
    const inventoryCap = candidateInventoryFileLimit(scope(), query(), capped);
    const addedCachedPreviews = inventoryCap - Math.min(20, inventoryCap);

    expect(small.realPath).toBeGreaterThan(0);
    expect(large.realPath).toBeLessThanOrEqual(queryCount * (2 * inventoryCap + 8));
    expect(large.stat).toBeLessThanOrEqual(queryCount * (inventoryCap + 4));
    expect(large.readDir).toBeLessThanOrEqual(queryCount * 2);
    expect(large.realPath - small.realPath).toBeLessThanOrEqual(
      queryCount * (2 * addedCachedPreviews + 8),
    );
    expect(large.stat - small.stat).toBeLessThanOrEqual(queryCount * (addedCachedPreviews + 4));
  });

  it("revalidates a cached record when the changed candidate is scanned", async () => {
    const files: Record<string, string> = {
      "src/a.ts": "export const oldA = 1;",
      "src/z.ts": "export const oldB = 2;",
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, memFs(ROOT, files), {
      nowMs: FIXED_NOW,
    });

    await context.searchText(query("oldA"), capped);
    await context.searchText(query("oldB"), capped);
    files["src/z.ts"] = "export const fresh = 3;";
    const stale = await context.searchText(query("oldB"), capped);
    const result = await context.searchText(query("fresh"), capped);

    expect(stale.atoms).toEqual([]);
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
    expect(stale.workspaceIndex).toMatchObject({ staleRecords: 1 });
  });

  it("revalidates fully warm previews before ranking a direct post-mutation query", async () => {
    const files: Record<string, string> = {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const oldZ = 2;",
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, memFs(ROOT, files), {
      nowMs: FIXED_NOW,
    });

    await context.searchText(query("alpha"), capped);
    await context.searchText(query("oldZ"), capped);
    files["src/z.ts"] = "export const freshZ = 3;";
    const result = await context.searchText(query("freshZ"), capped);
    const reused = await context.searchText(query("freshZ"), capped);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
    expect(result.workspaceIndex).toMatchObject({ staleRecords: 1 });
    expect(reused.workspaceIndex).toMatchObject({ reusedRecords: 2, staleRecords: 0 });
  });

  it("live-ranks truncated cached records before applying a narrow scan cap", async () => {
    const longLine = `${Array.from({ length: 32 }, (_, index) => `term${index.toString()}`).join(
      " ",
    )} needle`;
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(
      scope(),
      capped,
      memFs(ROOT, {
        "src/a.ts": "export const alpha = 1;",
        "src/z.ts": `export const warmZ = "${longLine}";`,
      }),
      { nowMs: FIXED_NOW },
    );

    await context.searchText(query("alpha"), capped);
    await context.searchText(query("warmZ"), capped);
    const result = await context.searchText(query("needle"), capped);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
  });

  it("live-ranks case-sensitive queries that cached hashes cannot represent", async () => {
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(
      scope(),
      capped,
      memFs(ROOT, {
        "src/a.ts": "export const alpha = 1;",
        "src/z.ts": "export const NeedleCase = 2;",
      }),
      { nowMs: FIXED_NOW },
    );

    await context.searchText(query("alpha"), capped);
    await context.searchText(query("needlecase"), capped);
    const result = await context.searchText(query("NeedleCase", true), capped);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
  });

  it("live-ranks substring queries that whole-token cache hashes cannot represent", async () => {
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(
      scope(),
      capped,
      memFs(ROOT, {
        "src/a.ts": "export const alpha = 1;",
        "src/z.ts": "export const superneedlevalue = 2;",
      }),
      { nowMs: FIXED_NOW },
    );

    await context.searchText(query("alpha"), capped);
    await context.searchText(query("superneedlevalue"), capped);
    const result = await context.searchText(query("needle"), capped);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
  });

  it("keeps warm-cache line evidence complete for mixed exact and substring hits", async () => {
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(
      scope(),
      capped,
      memFs(ROOT, {
        "src/mixed.ts": ["export const needle = 1;", "export const superneedlevalue = 2;"].join(
          "\n",
        ),
      }),
      { nowMs: FIXED_NOW },
    );

    const cold = await context.searchText(query("needle"), capped);
    const warm = await context.searchText(query("needle"), capped);

    expect(cold.atoms.map(({ lineRange }) => lineRange)).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(warm.atoms.map(({ lineRange }) => lineRange)).toEqual(
      cold.atoms.map(({ lineRange }) => lineRange),
    );
  });

  it("live-ranks punctuation-sensitive queries after lexical records are warm", async () => {
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(
      scope(),
      capped,
      memFs(ROOT, {
        "src/a.ts": "export const alpha = 1;",
        "src/z.ts": "export const foo+bar = 2;",
      }),
      { nowMs: FIXED_NOW },
    );

    await context.searchText(query("alpha"), capped);
    await context.searchText(query("z"), capped);
    const result = await context.searchText(query("foo+bar"), capped);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
  });

  it("does not reuse a file-pattern inventory for a wider explicit-scope text search", async () => {
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(
      scope(["pkg"]),
      capped,
      memFs(ROOT, {
        "pkg/a.ts": "export const alpha = 1;",
        "pkg/z.ts": "export const targetNeedle = 2;",
      }),
      { nowMs: FIXED_NOW },
    );

    const files = await context.findFiles(filePattern("**/*.ts"), capped);
    const result = await context.searchText(query("targetNeedle"), capped);

    expect(files.atoms.map((atom) => atom.scopePath)).toEqual(["pkg/a.ts"]);
    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["pkg/z.ts"]);
    expect(context.diagnostics()).toMatchObject({ candidateInventoryBuildCount: 2 });
  });

  it("persists later searches with their own live signal", async () => {
    const capped = limits(1);
    const backingIndex = createWorkspaceIndex();
    let saveCount = 0;
    let savedPaths: readonly string[] = [];
    const workspaceIndex: WorkspaceIndex = {
      loadSnapshot: (scopeKey) => backingIndex.loadSnapshot(scopeKey),
      saveSnapshot: async (scopeKey, snapshot): Promise<void> => {
        saveCount += 1;
        savedPaths = snapshot.records.map((record) => record.scopePath);
        await backingIndex.saveSnapshot(scopeKey, snapshot);
      },
    };
    const firstAbort = new AbortController();
    const context = createStructuralAdapterRequestContext(
      scope(),
      capped,
      memFs(ROOT, {
        "src/a.ts": "export const oldA = 1;",
        "src/z.ts": "export const oldB = 2;",
      }),
      { nowMs: FIXED_NOW },
    );

    await context.searchText(query("oldA"), capped, {
      signal: firstAbort.signal,
      workspaceIndex,
    });
    firstAbort.abort();
    const result = await context.searchText(query("oldB"), capped, {
      signal: new AbortController().signal,
      workspaceIndex,
    });

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
    expect(saveCount).toBe(2);
    expect(savedPaths).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("refreshes an unselected cached preview before direct ranking after mutation", async () => {
    const files: Record<string, string> = {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const oldZ = 2;",
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, memFs(ROOT, files), {
      nowMs: FIXED_NOW,
    });

    await context.searchText(query("alpha"), capped);
    files["src/z.ts"] = "export const freshZ = 3;";
    const result = await context.searchText(query("freshZ"), capped);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
    expect(result.coverage.reasons).toContain("file-cap");
  });

  it("re-admits a recreated request-snapshot path once it is selected", async () => {
    const files: Record<string, string> = {
      "src/a.ts": "export const alpha = 1;",
      "src/z.ts": "export const oldZ = 2;",
    };
    const capped = limits(1);
    const context = createStructuralAdapterRequestContext(scope(), capped, memFs(ROOT, files), {
      nowMs: FIXED_NOW,
    });

    await context.searchText(query("alpha"), capped);
    await context.searchText(query("oldZ"), capped);
    delete files["src/z.ts"];
    files["src/z.ts"] = "export const freshZ = 3;";
    await context.searchText(query("oldZ"), capped);
    const result = await context.searchText(query("freshZ"), capped);

    expect(result.atoms.map((atom) => atom.scopePath)).toEqual(["src/z.ts"]);
    expect(result.coverage.reasons).toContain("file-cap");
  });

  it("routes cold generic workspace-index discovery through the request inventory", async () => {
    const measured = countingFs();
    const context = createStructuralAdapterRequestContext(
      scope(),
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
      { nowMs: FIXED_NOW },
    );

    await context.searchText(naturalLanguage("calculate"), DEFAULT_SEARCH_LIMITS, {
      workspaceIndex: createWorkspaceIndex(),
    });

    expect(context.diagnostics()).toMatchObject({
      candidateInventoryBuildCount: 1,
      textSearchCount: 1,
    });
  });

  it("stops every structural builder at the shared absolute request deadline", async () => {
    const builders: readonly ((context: StructuralAdapterRequestContext) => Promise<boolean>)[] = [
      async (context): Promise<boolean> =>
        (await context.codeIntelligenceIndex()).candidateLimitReached === true,
      async (context): Promise<boolean> => (await context.symbolGraph()).diagnostics.truncated,
      async (context): Promise<boolean> => (await context.importGraph()).diagnostics.truncated,
      async (context): Promise<boolean> =>
        (await context.endpointContractGraph()).diagnostics.candidateLimitReached,
    ];

    for (const buildIsTruncated of builders) {
      const base = memFs(ROOT, {
        "src/a.ts": "export const a = 1;",
        "src/b.ts": "export const b = 2;",
      });
      let currentMs = 0;
      let contentReads = 0;
      const fs: WorkspaceFs = {
        ...base,
        readFileUtf8: (absolutePath): string => {
          contentReads += 1;
          const content = base.readFileUtf8(absolutePath);
          currentMs = 2;
          return content;
        },
      };
      const capped = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 1 };
      const context = createStructuralAdapterRequestContext(scope(), capped, fs, {
        nowMs: () => currentMs,
      });

      await expect(buildIsTruncated(context)).resolves.toBe(true);
      expect(contentReads).toBeGreaterThan(0);
      expect(contentReads).toBeLessThanOrEqual(1);
    }
  });

  it("stops candidate discovery at the same absolute request deadline", () => {
    const base = memFs(ROOT, {
      "a.ts": "export const a = 1;",
      "b.ts": "export const b = 2;",
      "c.ts": "export const c = 3;",
    });
    let currentMs = 0;
    let statCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath): ReturnType<WorkspaceFs["stat"]> => {
        statCalls += 1;
        const stat = base.stat(absolutePath);
        currentMs = 2;
        return stat;
      },
    };
    const capped = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 1 };
    const context = createStructuralAdapterRequestContext(scope(), capped, fs, {
      nowMs: () => currentMs,
    });

    expect(context.candidatePaths()).toEqual(["a.ts"]);
    expect(context.candidateLimitReached()).toBe(true);
    expect(statCalls).toBe(1);
  });

  it("enforces a smaller per-call deadline while reusing a wider request context", async () => {
    const base = memFs(ROOT, manySourceFiles(8));
    let currentMs = 0;
    let statCalls = 0;
    const fs: WorkspaceFs = {
      ...base,
      stat: (absolutePath): ReturnType<WorkspaceFs["stat"]> => {
        statCalls += 1;
        const stat = base.stat(absolutePath);
        currentMs = 2;
        return stat;
      },
    };
    const context = createStructuralAdapterRequestContext(scope(), DEFAULT_SEARCH_LIMITS, fs, {
      nowMs: () => currentMs,
    });
    const narrow = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 1 };

    const result = await context.findFiles(filePattern(), narrow);

    expect(result.coverage.incomplete).toBe(true);
    expect(result.coverage.reasons).toContain("timeout");
    expect(result.filesScanned).toBe(0);
    expect(statCalls).toBeLessThanOrEqual(2);
  });

  it("does not let a per-call deadline outlive the shared request deadline", async () => {
    const measured = countingFs(manySourceFiles(8));
    let currentMs = 0;
    const capped = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 1 };
    const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs, {
      nowMs: () => currentMs,
    });
    currentMs = 2;

    const result = await context.findFiles(filePattern(), capped);

    expect(result.coverage.incomplete).toBe(true);
    expect(measured.readDirCount()).toBe(0);
    expect(measured.realPathCount()).toBe(0);
    expect(measured.statCount()).toBe(0);
  });

  it("inherits an earlier orchestration deadline instead of starting a fresh search window", async () => {
    const measured = countingFs(manySourceFiles(8));
    let currentMs = 50;
    const wide = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 1_000 };
    const context = createStructuralAdapterRequestContext(scope(), wide, measured.fs, {
      nowMs: () => currentMs,
      deadlineAtMs: 75,
    });
    currentMs = 75;

    const result = await context.searchText(query("value1"), wide);

    expect(result.coverage.reasons).toContain("timeout");
    expect(result.filesScanned).toBe(0);
    expect(measured.readDirCount()).toBe(0);
    expect(measured.readFileUtf8Count()).toBe(0);
    expect(measured.realPathCount()).toBe(0);
    expect(measured.statCount()).toBe(0);
  });

  it("does not reset the shared deadline after warming file and text candidate inventories", async () => {
    const measured = countingFs(manySourceFiles(4));
    let currentMs = 0;
    const capped = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 10 };
    const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs, {
      nowMs: () => currentMs,
    });

    await context.findFiles(filePattern(), capped);
    await context.searchText(query("value0"), capped);
    currentMs = 10;
    const [files, text] = await Promise.all([
      context.findFiles(filePattern(), capped),
      context.searchText(query("value1"), capped),
    ]);

    for (const result of [files, text]) {
      expect(result.atoms).toEqual([]);
      expect(result.filesScanned).toBe(0);
      expect(result.coverage.reasons).toContain("timeout");
    }
  });

  it("does not reset the shared deadline for a warm serialized workspace-index session", async () => {
    const measured = countingFs(manySourceFiles(4));
    let currentMs = 0;
    const capped = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 10 };
    const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs, {
      nowMs: () => currentMs,
    });
    const workspaceIndex = createWorkspaceIndex();

    await context.searchText(query("value0"), capped, { workspaceIndex });
    currentMs = 10;
    const result = await context.searchText(query("value1"), capped, { workspaceIndex });

    expect(result.atoms).toEqual([]);
    expect(result.filesScanned).toBe(0);
    expect(result.coverage.reasons).toContain("timeout");
  });

  it("expires every queued workspace-index search at the original request deadline", async () => {
    const measured = countingFs(manySourceFiles(4));
    const loadStarted = deferred();
    const releaseLoad = deferred();
    let currentMs = 0;
    let loadCount = 0;
    const capped = { ...DEFAULT_SEARCH_LIMITS, elapsedMsMax: 1_000 };
    const workspaceIndex: WorkspaceIndex = {
      loadSnapshot: async () => {
        loadCount += 1;
        loadStarted.resolve();
        await releaseLoad.promise;
        return undefined;
      },
      saveSnapshot: (): Promise<void> => Promise.resolve(),
    };
    const context = createStructuralAdapterRequestContext(scope(), capped, measured.fs, {
      nowMs: () => currentMs,
    });

    const first = context.searchText(query("value0"), capped, { workspaceIndex });
    const second = context.searchText(query("value1"), capped, { workspaceIndex });
    await loadStarted.promise;
    currentMs = capped.elapsedMsMax;
    releaseLoad.resolve();
    const results = await Promise.all([first, second]);

    expect(loadCount).toBe(1);
    for (const result of results) {
      expect(result.atoms).toEqual([]);
      expect(result.filesScanned).toBe(0);
      expect(result.coverage.reasons).toContain("timeout");
    }
    expect(measured.readDirCount()).toBe(0);
    expect(measured.readFileUtf8Count()).toBe(0);
  });

  it("honors the shared request signal when a call supplies its own signal", async () => {
    const measured = countingFs(manySourceFiles(8));
    const requestAbort = new AbortController();
    const callAbort = new AbortController();
    const context = createStructuralAdapterRequestContext(
      scope(),
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
      { signal: requestAbort.signal },
    );
    requestAbort.abort();

    const result = await context.findFiles(filePattern(), DEFAULT_SEARCH_LIMITS, {
      signal: callAbort.signal,
    });

    expect(result.coverage.reasons).toContain("aborted");
    expect(measured.readDirCount()).toBe(0);
  });

  it("honors a call signal while the shared request signal remains live", async () => {
    const measured = countingFs(manySourceFiles(8));
    const requestAbort = new AbortController();
    const callAbort = new AbortController();
    const context = createStructuralAdapterRequestContext(
      scope(),
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
      { signal: requestAbort.signal },
    );
    callAbort.abort();

    const result = await context.searchText(query(), DEFAULT_SEARCH_LIMITS, {
      signal: callAbort.signal,
    });

    expect(requestAbort.signal.aborted).toBe(false);
    expect(result.atoms).toEqual([]);
    expect(result.filesScanned).toBe(0);
    expect(result.coverage.reasons).toContain("aborted");
    expect(measured.readDirCount()).toBe(0);
    expect(measured.readFileUtf8Count()).toBe(0);
  });

  it("reuses discovery for ranking-only policy changes and isolates discovery filters", async () => {
    const measured = countingFs();
    const context = createStructuralAdapterRequestContext(
      scope(),
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
      { nowMs: FIXED_NOW },
    );
    const common = {
      lowValuePathAllowlist: ["dist/one.ts"],
      recentPaths: ["src/math.ts"],
    };
    await context.findFiles(filePattern(), DEFAULT_SEARCH_LIMITS, {
      searchHints: { ...common, retrievalIntent: "targeted-code-search" },
    });
    const afterFirst = measured.readDirCount();
    await context.findFiles(filePattern(), DEFAULT_SEARCH_LIMITS, {
      searchHints: { ...common, retrievalIntent: "diagnostic-search" },
    });
    await context.findFiles(filePattern(), DEFAULT_SEARCH_LIMITS, {
      searchHints: {
        ...common,
        retrievalIntent: "targeted-code-search",
        recentPaths: ["src/api/client.ts"],
      },
    });
    expect(measured.readDirCount()).toBe(afterFirst);

    await context.findFiles(filePattern(), DEFAULT_SEARCH_LIMITS, {
      searchHints: {
        ...common,
        retrievalIntent: "targeted-code-search",
        lowValuePathAllowlist: ["dist/two.ts"],
      },
    });
    expect(measured.readDirCount()).toBeGreaterThan(afterFirst);
    expect(context.diagnostics().candidateInventoryBuildCount).toBe(2);
  });

  it("isolates file ceilings so a small inventory cannot cut off a later larger search", async () => {
    const files = manySourceFiles(40);
    const measured = countingFs(files);
    const context = createStructuralAdapterRequestContext(
      scope(),
      DEFAULT_SEARCH_LIMITS,
      measured.fs,
      { nowMs: FIXED_NOW },
    );
    const low = await context.findFiles(filePattern(), limits(1));
    const afterLow = measured.readDirCount();
    const high = await context.findFiles(filePattern(), limits(30));

    expect(low.atoms).toHaveLength(1);
    expect(high.atoms).toHaveLength(30);
    expect(high.filesScanned).toBe(30);
    expect(measured.readDirCount()).toBeGreaterThan(afterLow);
    expect(context.diagnostics().candidateInventoryBuildCount).toBe(2);
  });
});
