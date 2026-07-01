// Retrieval seam (ADR-0005 D5). `RetrievalStrategy` is the typed extension point a future
// embedding ranker (e.g. `example-embedding-model`) plugs into. Wave-1 ships ONLY the seam and
// a deterministic lexical default — no embeddings, no vector DB, no new dependency. The
// default ranker is pure and clock/RNG-free so context packs are reproducible.

import { lexicalPathSignals, queryRankingTerms } from "./repoSearchRanking.js";
import { SELECTION_REASON_PRIORITY, type DiscoveredFile, type SelectionReason } from "./types.js";

export interface RankedFile {
  readonly file: DiscoveredFile;
  readonly selectionReason: SelectionReason;
}

export interface RetrievalStrategy {
  // Returns the candidates in deterministic priority order. `task` is an optional natural-
  // language hint a future ranker may use; the lexical default tolerates it being undefined.
  readonly rank: (
    files: readonly DiscoveredFile[],
    task: string | undefined,
  ) => readonly RankedFile[];
}

const ENTRYPOINT_BASENAMES: ReadonlySet<string> = new Set([
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "cli.ts",
  "cli.js",
]);

// Primary build/dependency manifests across ecosystems. Kept deliberately NARROW (no JS/TS tool
// configs such as eslint.config.js — those remain "config" in this taxonomy, see the config test)
// and therefore distinct from repoSearchPolicy's broader "canonical-metadata" bucket. This lexical
// strategy feeds the secondary context-pack assemblers (bug-investigation, unit-test generation,
// CLI, QI ingestion); the grounded chat path is governed by repoSearchPolicy + the orchestrator.
const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  // Java / Kotlin / Scala / Groovy
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "build.sbt",
  // Go
  "go.mod",
  "go.work",
  // Rust
  "Cargo.toml",
  "rust-toolchain.toml",
  // Python
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  // .NET
  "global.json",
  // C/C++
  "CMakeLists.txt",
  "Makefile",
  "conanfile.txt",
  "vcpkg.json",
  "meson.build",
  // Swift / Ruby / PHP
  "Package.swift",
  "Gemfile",
  "composer.json",
  // Deno / Bun
  "deno.json",
  "bunfig.toml",
]);

const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".rst", ".txt"]);

const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".yml", ".yaml", ".toml"]);

const CONFIG_BASENAME_HINTS: readonly string[] = [".config.", "eslint", "prettier", "vitest"];
const IMPLEMENTATION_INTENT_TERMS: ReadonlySet<string> = new Set([
  "define",
  "defined",
  "definition",
  "implement",
  "implemented",
  "implementation",
  "source",
]);

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function extension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx <= 0 ? "" : name.slice(idx);
}

function isTest(name: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

function isConfig(name: string): boolean {
  return (
    CONFIG_EXTENSIONS.has(extension(name)) || CONFIG_BASENAME_HINTS.some((h) => name.includes(h))
  );
}

function classify(path: string): SelectionReason {
  const name = basename(path);
  if (isTest(name) || path.startsWith("tests/") || path.startsWith("test/")) {
    return "test";
  }
  if (ENTRYPOINT_BASENAMES.has(name)) {
    return "entrypoint";
  }
  if (MANIFEST_BASENAMES.has(name)) {
    return "manifest";
  }
  if (DOC_EXTENSIONS.has(extension(name))) {
    return "documentation";
  }
  if (isConfig(name)) {
    return "config";
  }
  return "source";
}

function priorityIndex(reason: SelectionReason): number {
  return SELECTION_REASON_PRIORITY.indexOf(reason);
}

function queryIntentBoost(reason: SelectionReason, queryTerms: readonly string[]): number {
  if (!queryTerms.some((term) => IMPLEMENTATION_INTENT_TERMS.has(term))) {
    return 0;
  }
  if (reason === "source" || reason === "entrypoint") {
    return 24;
  }
  if (reason === "test" || reason === "documentation") {
    return -12;
  }
  return 0;
}

// Deterministic lexical ranking: query-aware path/identifier overlap first, then the historical
// selection-reason priority, then path (ascending). When no task terms are available, behavior
// falls back to the old selection-reason ordering byte-for-byte.
export const lexicalRetrievalStrategy: RetrievalStrategy = {
  rank: (files: readonly DiscoveredFile[], task: string | undefined): readonly RankedFile[] => {
    const queryTerms = queryRankingTerms(task);
    const ranked = files.map((file) => ({
      file,
      selectionReason: classify(file.relativePath),
      queryScore: 0,
    }));
    for (const item of ranked) {
      item.queryScore =
        lexicalPathSignals(item.file.relativePath, queryTerms).score +
        queryIntentBoost(item.selectionReason, queryTerms);
    }
    return [...ranked].sort((a, b) => {
      const queryDelta = b.queryScore - a.queryScore;
      if (queryDelta !== 0) {
        return queryDelta;
      }
      const byReason = priorityIndex(a.selectionReason) - priorityIndex(b.selectionReason);
      if (byReason !== 0) {
        return byReason;
      }
      if (a.file.relativePath < b.file.relativePath) return -1;
      if (a.file.relativePath > b.file.relativePath) return 1;
      return 0;
    });
  },
};
