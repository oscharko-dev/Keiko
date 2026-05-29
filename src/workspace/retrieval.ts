// Retrieval seam (ADR-0005 D5). `RetrievalStrategy` is the typed extension point a future
// embedding ranker (e.g. `multilingual-e5-large`) plugs into. Wave-1 ships ONLY the seam and
// a deterministic lexical default — no embeddings, no vector DB, no new dependency. The
// default ranker is pure and clock/RNG-free so context packs are reproducible.

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

const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
]);

const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".rst", ".txt"]);

const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".yml", ".yaml", ".toml"]);

const CONFIG_BASENAME_HINTS: readonly string[] = [".config.", "eslint", "prettier", "vitest"];

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

// Deterministic lexical ranking: by selection-reason priority, then by path (ascending).
export const lexicalRetrievalStrategy: RetrievalStrategy = {
  rank: (files: readonly DiscoveredFile[]): readonly RankedFile[] => {
    const ranked = files.map((file) => ({ file, selectionReason: classify(file.relativePath) }));
    return [...ranked].sort((a, b) => {
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
