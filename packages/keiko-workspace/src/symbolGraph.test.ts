import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import {
  buildSymbolGraph,
  callsToSymbol,
  definitionsForSymbol,
  referencesForSymbol,
  symbolGraphAdapter,
} from "./symbolGraph.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo, WorkspaceLanguage } from "./types.js";

const MEM_ROOT = "/ws";
const FIXED_NOW = (): number => 1_700_000_000_000;

function makeScope(
  files: Readonly<Record<string, string>>,
  languages: readonly WorkspaceLanguage[] = ["typescript", "javascript"],
): {
  readonly scope: SearchScope;
  readonly fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages,
    ignoreLines: [],
  };
  return {
    scope: { workspace, scopeId: "scope-1", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

function exq(text: string): RetrievalQuery {
  return { kind: "exact-symbol", text, caseSensitive: false, maxResults: 100, emittedAtMs: 0 };
}

describe("buildSymbolGraph", () => {
  it("finds a function definition when the filename does not match the symbol", async () => {
    const { scope, fs } = makeScope({
      "src/config.ts":
        "export function parseConfig(raw: string): string {\n  return raw.trim();\n}\n",
      "src/consumer.ts":
        'import { parseConfig } from "./config";\n' +
        "export function run(raw: string): string {\n  return parseConfig(raw);\n}\n",
    });
    const graph = await buildSymbolGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(definitionsForSymbol(graph, "parseConfig")).toEqual([
      expect.objectContaining({
        symbol: "parseConfig",
        scopePath: "src/config.ts",
        kind: "definition",
        definitionKind: "function",
        line: 1,
        confidence: 1,
      }),
    ]);
  });

  it("returns references and callers in deterministic path/line order with confidence", async () => {
    const { scope, fs } = makeScope({
      "src/a.ts": "export function alpha(): number {\n  return beta();\n}\n",
      "src/b.ts": "export function beta(): number {\n  return 1;\n}\nalpha();\nbeta();\n",
    });
    const graph = await buildSymbolGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(callsToSymbol(graph, "beta").map((record) => [record.scopePath, record.line])).toEqual([
      ["src/a.ts", 2],
      ["src/b.ts", 5],
    ]);
    expect(callsToSymbol(graph, "beta").every((record) => record.confidence === 0.86)).toBe(true);
    expect(
      referencesForSymbol(graph, "alpha").map((record) => [record.scopePath, record.line]),
    ).toEqual([["src/b.ts", 4]]);
  });

  it("keeps non-supported languages explicit instead of fabricating records", async () => {
    const { scope, fs } = makeScope(
      {
        "src/main/java/com/acme/PaymentService.java":
          "package com.acme;\nclass PaymentService { void charge() {} }\n",
      },
      ["java"],
    );
    const graph = await buildSymbolGraph(scope, DEFAULT_SEARCH_LIMITS, fs);
    expect(graph.records).toEqual([]);
    expect(graph.diagnostics.unsupportedLanguages).toEqual(["java"]);
  });
});

describe("symbolGraphAdapter", () => {
  it("emits definition, call, and reference atoms for an exact symbol query", async () => {
    const { scope, fs } = makeScope({
      "src/config.ts":
        "export function parseConfig(raw: string): string {\n  return raw.trim();\n}\n",
      "src/consumer.ts":
        'import { parseConfig } from "./config";\n' +
        "export function run(raw: string): string {\n  return parseConfig(raw);\n}\n",
    });
    const atoms = await symbolGraphAdapter.lookup(
      scope,
      exq("parseConfig"),
      DEFAULT_SEARCH_LIMITS,
      fs,
      {
        nowMs: FIXED_NOW,
      },
    );
    expect(
      atoms.map((atom) => [atom.scopePath, atom.lineRange?.startLine, atom.provenance.tool]),
    ).toEqual([
      ["src/config.ts", 1, "symbol-graph"],
      ["src/consumer.ts", 1, "symbol-graph"],
      ["src/consumer.ts", 3, "symbol-graph"],
      ["src/consumer.ts", 3, "symbol-graph"],
    ]);
  });
});
