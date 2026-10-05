import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import type { WorkspaceFs } from "./fs.js";
import { DEFAULT_STREAMED_SEMANTIC_BOUNDS } from "./repoSearchSemantic.js";

function scope(): SearchScope {
  return {
    scopeId: "review-scope",
    relativePaths: [],
    workspace: {
      root: "/ws",
      selectedRoot: "/ws",
      name: "review",
      version: "0.0.0",
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}
function query(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 0 };
}
function delayedFs(files: Record<string, string>, reverse: boolean): WorkspaceFs {
  const fs = memFs("/ws", files);
  const read = fs.readFileBytes;
  if (read === undefined) throw new TypeError("A byte reader is required.");
  return {
    ...fs,
    readFileBytes: async (...args): Promise<Uint8Array> => {
      const path = args[0];
      const index = Number(/file-(\d+)/u.exec(path)?.[1] ?? 0);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, reverse ? Math.max(0, 8 - index) : index),
      );
      return read(...args);
    },
  };
}

describe("shared streamed search review regressions", () => {
  it("keeps a long natural query intact while bounding only semantic excerpt hints", async () => {
    const text = `${"a".repeat(5000)} session renewal`;
    const source = `${"background\n".repeat(1000)}session renewal available`;
    let suppliedQuery = "";
    let suppliedText = "";
    const result = await searchText(scope(), query(text), undefined, {
      fs: memFs("/ws", { "deep/manual/session.txt": source }),
      semanticSearchProvider: {
        name: "long-query-review",
        search: (input) => {
          suppliedQuery = input.query.text;
          suppliedText = input.documents[0]?.text ?? "";
          return Promise.resolve([{ scopePath: "deep/manual/session.txt", score: 1, line: 1001 }]);
        },
      },
    });
    expect(suppliedQuery).toBe(text);
    expect(suppliedText).toContain("session renewal available");
    expect(result.coverage).toMatchObject({ incomplete: false, filesScanned: 1 });
    expect(result.atoms).toContainEqual(
      expect.objectContaining({
        scopePath: "deep/manual/session.txt",
        lineRange: { startLine: 1001, endLine: 1001 },
      }),
    );
  });
  it("keeps ordinary lexical callers free of synthetic source-inspection hits", async () => {
    const fs = memFs("/ws", { "src/unrelated.ts": "export const unrelated = 42;\n" });
    const result = await searchText(
      scope(),
      query("find TypeScript source files that call createQuote"),
      undefined,
      { fs },
    );
    expect(result.atoms).toEqual([]);
  });
  it("selects ranked late semantic candidates rather than the first completed files", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1)
      files[`noise/file-${String(index)}.txt`] = "unrelated inventory";
    files["zzzz/session.ts"] =
      `${"unrelated prefix\n".repeat(1000)}session renewal authentication token session renewal`;
    let supplied: readonly string[] = [];
    let suppliedText = "";
    let suppliedStart = 0;
    const result = await searchText(scope(), query("how does session renewal work?"), undefined, {
      fs: memFs("/ws", files),
      semanticSearchProvider: {
        name: "ranked-review",
        search: ({ documents }) => {
          supplied = documents.map((document) => document.scopePath);
          const target = documents.find((document) => document.scopePath === "zzzz/session.ts");
          suppliedText = target?.text ?? "";
          suppliedStart = target?.startLine ?? 1;
          return Promise.resolve(
            documents.some((document) => document.scopePath === "zzzz/session.ts")
              ? [{ scopePath: "zzzz/session.ts", score: 1, line: 1001 }]
              : [],
          );
        },
      },
    });
    expect(supplied).toContain("zzzz/session.ts");
    expect(supplied.length).toBeLessThanOrEqual(DEFAULT_STREAMED_SEMANTIC_BOUNDS.maxDocuments);
    expect(suppliedText).toContain("session renewal");
    expect(suppliedStart).toBeGreaterThan(1);
    expect(Buffer.byteLength(suppliedText)).toBeLessThanOrEqual(
      DEFAULT_STREAMED_SEMANTIC_BOUNDS.maxDocumentBytes /
        DEFAULT_STREAMED_SEMANTIC_BOUNDS.maxDocuments,
    );
    expect(result.atoms.find((atom) => atom.provenance.kind === "model-rerank")?.lineRange).toEqual(
      { startLine: 1001, endLine: 1001 },
    );
  });
  it("supplies deterministic ranked semantic documents under opposite read completion order", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1)
      files[`file-${String(index)}.txt`] = "session renewal available\n".repeat(300);
    const supplies: string[][] = [];
    const suppliedBytes: number[] = [];
    for (const reverse of [true, false]) {
      await searchText(scope(), query("session renewal"), undefined, {
        fs: delayedFs(files, reverse),
        semanticSearchProvider: {
          name: "deterministic-review",
          search: ({ documents }) => {
            supplies.push(documents.map((document) => document.scopePath));
            suppliedBytes.push(
              documents.reduce((sum, document) => sum + Buffer.byteLength(document.text), 0),
            );
            return Promise.resolve([]);
          },
        },
      });
    }
    expect(supplies[0]).toHaveLength(DEFAULT_STREAMED_SEMANTIC_BOUNDS.maxDocuments);
    expect(supplies[1]).toEqual(supplies[0]);
    expect(suppliedBytes).toHaveLength(2);
    for (const bytes of suppliedBytes) {
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(DEFAULT_STREAMED_SEMANTIC_BOUNDS.maxDocumentBytes);
    }
  });

  it("retains the same bounded omission paths despite opposite completion order", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 8; index += 1)
      files[`file-${String(index)}.txt`] = "header\u0000binary";
    const limits = { ...DEFAULT_SEARCH_LIMITS, maxMatchesReturned: 3 };
    const first = await searchText(scope(), query("missing"), limits, {
      fs: delayedFs(files, false),
    });
    const second = await searchText(scope(), query("missing"), limits, {
      fs: delayedFs(files, true),
    });
    expect(first.candidates.map((candidate) => candidate.scopePath)).toEqual([
      "file-0.txt",
      "file-1.txt",
      "file-2.txt",
    ]);
    expect(second.candidates).toEqual(first.candidates);
    expect(first.coverage.filesSkipped).toBe(8);
    expect(second.coverage.filesSkipped).toBe(8);
  });
});
