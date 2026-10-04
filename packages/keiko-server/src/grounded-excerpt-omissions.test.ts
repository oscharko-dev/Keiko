import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { type WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  _readKeptExcerptsForTests,
  retrieveConnectedContextPack,
  type ExcerptReadSummary,
} from "./grounded-orchestrator.js";

const roots: string[] = [];

function workspace(): WorkspaceInfo {
  const root = mkdtempSync(join(tmpdir(), "keiko-excerpt-omissions-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  return {
    root,
    selectedRoot: root,
    name: "excerpt fixture",
    version: "0.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
}

function atom(scopePath: string): EvidenceAtom {
  return {
    schemaVersion: "1",
    stableId: scopePath,
    scopePath,
    lineRange: { startLine: 1, endLine: 1 },
    score: 1,
    provenance: { kind: "lexical-search", tool: "repo.searchText", queryFingerprint: "fixture" },
    redactionState: "redacted",
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function read(workspace: WorkspaceInfo, paths: readonly string[]): Promise<ExcerptReadSummary> {
  return _readKeptExcerptsForTests(paths, {
    searchScope: { workspace, scopeId: "fixture", relativePaths: ["src"] },
    fs: nodeWorkspaceFs,
    budget: DEFAULT_EXPLORATION_BUDGET,
    initialUsage: {
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      elapsedMs: 0,
      rerankCalls: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
    },
    atomsByPath: new Map(paths.map((path) => [path, [atom(path)]])),
    nowMs: () => 0,
    deadlineAtMs: Number.POSITIVE_INFINITY,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("excerpt read loss accounting", () => {
  it("aggregates actual clipped windows without per-file uncertainty growth", async () => {
    const info = workspace();
    const paths = Array.from({ length: 32 }, (_, index) => `src/file-${String(index)}.ts`);
    for (const path of paths) writeFileSync(join(info.root, path), "x".repeat(20_000));
    const result = await read(info, paths);
    const clipped = result.uncertainty.filter((entry) => entry.kind === "scope-incomplete");
    expect(result.excerpts.size).toBeGreaterThan(1);
    expect(clipped).toHaveLength(1);
    expect(clipped[0]?.claim).toContain(`${String(result.excerpts.size)} selected range(s)`);
    expect(clipped[0]?.claim).not.toContain("src/");
    expect(result.byteBudgetOmittedPaths?.length).toBeGreaterThan(0);
  });

  it("preserves size and binary refusal reasons beside readable evidence", async () => {
    const info = workspace();
    writeFileSync(join(info.root, "src/large.ts"), "x".repeat(2 * 1024 * 1024 + 1));
    writeFileSync(join(info.root, "src/binary.ts"), Buffer.from([65, 0, 66]));
    writeFileSync(join(info.root, "src/good.ts"), "export const EvidenceProbe = 73;\n");
    const result = await read(info, ["src/large.ts", "src/binary.ts", "src/good.ts"]);
    expect(result.excerpts.has("src/good.ts")).toBe(true);
    expect(result.omitted).toEqual([
      { scopePath: "src/large.ts", reason: "size-exceeded", omittedAtMs: 0 },
      { scopePath: "src/binary.ts", reason: "binary", omittedAtMs: 0 },
    ]);
    expect(result.uncertainty.filter((entry) => entry.kind === "scope-incomplete")).toHaveLength(1);
  });

  it("carries fresh read refusal causes into the actual canonical retrieval pack", async () => {
    const info = workspace();
    const paths = ["src/large.ts", "src/binary.ts", "src/good.ts"];
    for (const path of paths)
      writeFileSync(
        join(info.root, path),
        "export const FixtureMismatch = 'processing behavior';\n",
      );
    let semanticCalls = 0;
    const output = await retrieveConnectedContextPack(
      {
        workspaceRoot: info.root,
        scope: {
          schemaVersion: "1",
          scopeId: "fixture",
          workspaceRoot: info.root,
          kind: "files",
          relativePaths: paths,
          connectedAtMs: 0,
          conversationId: undefined,
        },
        query: {
          kind: "natural-language",
          text: "Investigate FixtureMismatch processing behavior",
          caseSensitive: false,
          maxResults: 20,
          emittedAtMs: 0,
        },
      },
      {
        correlationId: undefined,
        answerer: { answer: () => Promise.resolve("fixture must not call a model") },
        detectWorkspace: () => info,
        nowMs: () => 0,
        semanticSearchProvider: {
          name: "post-search source-change fixture",
          search: () => {
            semanticCalls += 1;
            writeFileSync(join(info.root, "src/large.ts"), "x".repeat(2 * 1024 * 1024 + 1));
            writeFileSync(join(info.root, "src/binary.ts"), Buffer.from([65, 0, 66]));
            return Promise.resolve([]);
          },
        },
      },
    );
    expect(semanticCalls).toBeGreaterThan(0);
    expect(output.pack.files.map((file) => file.scopePath)).toEqual(["src/good.ts"]);
    expect(output.pack.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopePath: "src/large.ts", reason: "size-exceeded" }),
        expect.objectContaining({ scopePath: "src/binary.ts", reason: "binary" }),
      ]),
    );
    expect(validateConnectedContextPack(output.pack)).toEqual({ ok: true });
  });
});
