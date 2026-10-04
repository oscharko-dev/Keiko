import { afterEach, describe, expect, it, vi } from "vitest";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import * as stream from "./repoSearchStream.js";
import * as scan from "./repoSearchScan.js";
import type { SemanticSearchProvider } from "./repoSearchSemantic.js";

function fixture(files: Readonly<Record<string, string>> = { "manual.txt": "probe evidence\n" }): {
  scope: SearchScope;
  fs: ReturnType<typeof memFs>;
} {
  return {
    scope: {
      scopeId: "stop-fixture",
      relativePaths: [],
      workspace: {
        root: "/ws",
        selectedRoot: "/ws",
        name: "stop-fixture",
        version: "1",
        testFramework: "unknown",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      },
    },
    fs: memFs("/ws", files),
  };
}

const query = {
  kind: "natural-language",
  text: "probe",
  caseSensitive: false,
  maxResults: 100,
  emittedAtMs: 0,
} as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("streamed search stop coverage", () => {
  it("reports complete coverage for a normally completed search", async () => {
    const { scope, fs } = fixture();
    const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS, { fs });
    expect(result.atoms).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.coverage).toMatchObject({ incomplete: false, reasons: [], filesScanned: 1 });
  });

  it("reports genuine retained-match clipping while finishing corpus traversal", async () => {
    const { scope, fs } = fixture({ "a.txt": "probe\n", "b.txt": "probe\n" });
    const result = await searchText(
      scope,
      query,
      { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 1 },
      { fs },
    );
    expect(result.atoms).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.coverage).toMatchObject({
      incomplete: true,
      reasons: ["match-cap"],
      filesScanned: 2,
    });
  });

  it("retains a partially emitted observed match without relabelling the abort as match-cap", async () => {
    const controller = new AbortController();
    const original = scan.emitFileMatches;
    vi.spyOn(scan, "emitFileMatches").mockImplementation((runner, ...args) => {
      let reads = 0;
      original(
        {
          ...runner,
          nowMs: (): number => {
            if (++reads === 2) controller.abort();
            return runner.nowMs();
          },
        },
        ...args,
      );
    });
    const { scope, fs } = fixture({
      "manual.txt": `probe first\n${"padding\n".repeat(50)}probe second\n`,
    });
    const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS, {
      fs,
      signal: controller.signal,
    });
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]?.lineRange?.startLine).toBe(1);
    expect(result.coverage).toMatchObject({ incomplete: true, reasons: ["aborted"] });
  });
  it("marks an abort after traversal before semantic dispatch and retains observed lexical evidence", async () => {
    const controller = new AbortController();
    const original = stream.collectStreamedSearchText;
    vi.spyOn(stream, "collectStreamedSearchText").mockImplementation(async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
    const provider = {
      name: "stop fixture",
      search: vi.fn(() => Promise.resolve([])),
    };
    const { scope, fs } = fixture();
    const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS, {
      fs,
      signal: controller.signal,
      semanticSearchProvider: provider,
    });
    expect(provider.search).not.toHaveBeenCalled();
    expect(result.atoms).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.coverage).toMatchObject({ incomplete: true, reasons: ["aborted"] });
  });

  it("marks a deferred provider abort without admitting its eventual semantic response", async () => {
    const controller = new AbortController();
    const started = deferred();
    const released = deferred();
    const provider: SemanticSearchProvider = {
      name: "stop fixture",
      search: async () => {
        started.resolve();
        await released.promise;
        return [{ scopePath: "manual.txt", score: 1, line: 1 }];
      },
    };
    const { scope, fs } = fixture();
    const pending = searchText(scope, query, DEFAULT_SEARCH_LIMITS, {
      fs,
      signal: controller.signal,
      semanticSearchProvider: provider,
    });
    await started.promise;
    controller.abort();
    released.resolve();
    const result = await pending;
    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0]?.provenance.kind).toBe("lexical-search");
    expect(result.coverage).toMatchObject({ incomplete: true, reasons: ["aborted"] });
    expect(result.truncated).toBe(true);
  });

  it.each(["aborted", "timeout"] as const)(
    "preserves %s between collection and emission instead of inventing match-cap",
    async (reason) => {
      const controller = new AbortController();
      let now = 0;
      const original = scan.emitFileMatches;
      const emission = vi.spyOn(scan, "emitFileMatches").mockImplementation((...args) => {
        if (reason === "aborted") controller.abort();
        else now = 10;
        original(...args);
      });
      const { scope, fs } = fixture();
      const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS, {
        fs,
        signal: controller.signal,
        nowMs: (): number => now,
        deadlineAtMs: 10,
      });
      expect(emission).toHaveBeenCalledOnce();
      expect(result.atoms).toHaveLength(0);
      expect(result.filesScanned).toBe(1);
      expect(result.coverage).toMatchObject({ incomplete: true, reasons: [reason] });
      expect(result.truncated).toBe(true);
    },
  );
});
