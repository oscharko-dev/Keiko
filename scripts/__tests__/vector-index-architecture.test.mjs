import { describe, expect, it } from "vitest";
import { vectorIndexArchitectureFailures } from "../lib/vector-index-architecture.mjs";

const WORKER = "packages/keiko-local-knowledge/src/retrieval/usearch-index-worker.ts";
const LAUNCHER = "packages/keiko-local-knowledge/src/retrieval/usearch-ann-index.ts";
const KNOWLEDGE = "packages/keiko-local-knowledge/src/retrieval/vector-index.ts";
const MEMORY = "packages/keiko-server/src/memory-retrieval-signals.ts";
const REPO = "packages/keiko-server/src/grounded-repo-semantic-search.ts";
const STORE = "packages/keiko-local-knowledge/src/store.ts";

function validSources() {
  return new Map([
    [
      WORKER,
      [
        "interface NativeCompiledIndex {",
        "  readonly add: () => void;",
        "  readonly search: () => void;",
        "  readonly size: () => number;",
        "}",
        "const index = new runtime.CompiledIndex();",
      ].join("\n"),
    ],
    [
      LAUNCHER,
      [
        'const workerUrl = new URL("./usearch-index-worker.js", import.meta.url);',
        "const worker = new Worker(workerUrl);",
      ].join("\n"),
    ],
    [KNOWLEDGE, "searchUsearchAnnIndex(request);"],
    [MEMORY, "searchUsearchAnnIndex(request);"],
    [REPO, "searchVectorsForScope(store, adapter, scope, query);"],
    [STORE, "const db = new DatabaseSync(path);"],
  ]);
}

describe("vector-index architecture", () => {
  it("accepts the single search-only service composition", () => {
    expect(vectorIndexArchitectureFailures(validSources())).toEqual([]);
  });

  it.each([
    ["a second native constructor", WORKER, "new runtime.CompiledIndex();"],
    ["native persistence", WORKER, "index.save(path);"],
    ["SQLite extension authority", STORE, "db.enableLoadExtension(true);"],
    ["retired sqlite-vec", STORE, 'db.exec("CREATE VIRTUAL TABLE x USING vec0(embedding)");'],
    ["retired whole-file embedding", REPO, "requestOpenAIEmbedding(request);"],
  ])("rejects %s", (_label, path, injected) => {
    const sources = validSources();
    sources.set(path, `${sources.get(path) ?? ""}\n${injected}`);
    expect(vectorIndexArchitectureFailures(sources)).not.toEqual([]);
  });

  it("rejects either pillar bypassing the shared service", () => {
    for (const path of [KNOWLEDGE, MEMORY]) {
      const sources = validSources();
      sources.set(path, "");
      expect(vectorIndexArchitectureFailures(sources)).not.toEqual([]);
    }
  });

  it("rejects a second or unreviewed worker launcher", () => {
    const sources = validSources();
    sources.set(LAUNCHER, `${sources.get(LAUNCHER) ?? ""}\nnew Worker(otherUrl);`);
    expect(vectorIndexArchitectureFailures(sources)).not.toEqual([]);
  });
});
