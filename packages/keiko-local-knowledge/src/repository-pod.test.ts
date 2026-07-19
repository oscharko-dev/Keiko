import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingOutcome } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EMBEDDING, freshStore } from "./_support.js";
import { documentIdFor } from "./discovery/types.js";
import {
  listRepositoryChunkLineRanges,
  resolveRepositoryChunkLineRange,
} from "./indexing/repository-chunk-lines.js";
import { readRepositoryFileFingerprints } from "./indexing/repository-fingerprints.js";
import { isCodeSymbolDefinitionLine } from "./parsers/code-parser.js";
import { createDefaultParserRegistry } from "./parsers/index.js";
import {
  createRepositoryPodShell,
  listRepositoryPodRuns,
  refreshRepositoryPod,
  type RepositoryPodIndexingDeps,
} from "./repository-pod.js";
import { runLocalKnowledgeRetrieval } from "./retrieval/index.js";
import type { KnowledgeStore } from "./store.js";
import { scriptedAdapter } from "./testing.js";

const CAPSULE_ID = "cap-repository" as KnowledgeCapsuleId;
const SOURCE_ID = "src-repository" as KnowledgeSourceId;
const TRACKED_PATHS = new Set(["src/app.ts", "src/service.py", "src/worker.go"]);
const VECTOR = new Float32Array(DEFAULT_EMBEDDING.vectorDimensions).fill(1);

let store: KnowledgeStore;
let cleanupStore: () => void;
let fixtureRoot: string;
let repositoryRoot: string;

interface CountingAdapter {
  readonly adapter: ReturnType<typeof scriptedAdapter>;
  readonly calls: () => number;
}

function countingAdapter(): CountingAdapter {
  let calls = 0;
  const adapter = scriptedAdapter({
    identity: DEFAULT_EMBEDDING,
    responder: (): OpenAIEmbeddingOutcome => {
      calls += 1;
      return { ok: true, value: { vector: VECTOR, modelId: DEFAULT_EMBEDDING.modelId } };
    },
  });
  return { adapter, calls: () => calls };
}

function writeFixture(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), "keiko-repository-pod-"));
  repositoryRoot = join(fixtureRoot, "repo");
  mkdirSync(join(repositoryRoot, "src"), { recursive: true });
  mkdirSync(join(repositoryRoot, "node_modules", "ignored"), { recursive: true });
  writeFileSync(join(repositoryRoot, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(
    join(repositoryRoot, "src", "app.ts"),
    [
      "export interface Request {}",
      "",
      "export function execute(): string {",
      '  return "ok";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(repositoryRoot, "src", "service.py"),
    ["class Service:", "    pass", "", "def load():", "    return Service()", ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(repositoryRoot, "src", "worker.go"),
    [
      "package worker",
      "",
      "type Worker struct{}",
      "",
      "func Run() string {",
      '  return "ok"',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(repositoryRoot, "node_modules", "ignored", "secret.ts"), "secret", "utf8");
  writeFileSync(join(repositoryRoot, ".env"), "TOKEN=secret\n", "utf8");
  writeFileSync(join(fixtureRoot, "outside.ts"), "export const outside = true;\n", "utf8");
  symlinkSync(join(fixtureRoot, "outside.ts"), join(repositoryRoot, "escape-link.ts"));
}

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanupStore = fresh.cleanup;
  writeFixture();
});

afterEach(() => {
  cleanupStore();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function createShell(): void {
  createRepositoryPodShell(
    { store, capsuleId: CAPSULE_ID, sourceId: SOURCE_ID },
    {
      displayName: "Repository knowledge",
      repositoryRoot,
      embeddingModelIdentity: DEFAULT_EMBEDDING,
    },
  );
}

function indexingDeps(
  adapter: CountingAdapter,
  overrides: Partial<RepositoryPodIndexingDeps> = {},
): RepositoryPodIndexingDeps {
  return {
    store,
    capsuleId: CAPSULE_ID,
    sourceId: SOURCE_ID,
    parserRegistry: createDefaultParserRegistry(),
    embeddingAdapter: adapter.adapter,
    workspaceFs: nodeWorkspaceFs,
    trackedPaths: TRACKED_PATHS,
    ...overrides,
  };
}

interface DocumentRow {
  readonly id: string;
  readonly document_path: string;
}

function documentRows(): readonly DocumentRow[] {
  return store._internal.db
    .prepare("SELECT id, document_path FROM documents WHERE capsule_id = :c ORDER BY document_path")
    .all({ c: CAPSULE_ID }) as unknown as readonly DocumentRow[];
}

function documentId(relativePath: string): DocumentId {
  return documentIdFor({ capsuleId: CAPSULE_ID, sourceId: SOURCE_ID, relativePath });
}

function vectorIds(relativePath: string): readonly string[] {
  const rows = store._internal.db
    .prepare("SELECT id FROM vectors WHERE capsule_id = :c AND document_id = :d ORDER BY id ASC")
    .all({ c: CAPSULE_ID, d: documentId(relativePath) }) as unknown as readonly {
    readonly id: string;
  }[];
  return rows.map((row) => row.id);
}

interface ChunkSpanRow {
  readonly id: string;
  readonly document_id: string;
  readonly character_start: number;
  readonly character_end: number;
}

function chunkSpans(): ReadonlyMap<string, ChunkSpanRow> {
  const rows = store._internal.db
    .prepare(
      `SELECT id, document_id, character_start, character_end FROM chunks
       WHERE capsule_id = :c ORDER BY document_id ASC, character_start ASC`,
    )
    .all({ c: CAPSULE_ID }) as unknown as readonly ChunkSpanRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

function relativeSource(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function firstSymbolLine(text: string, start: number, end: number): number | undefined {
  const before = text.slice(0, start).split("\n").length;
  const lines = text.slice(start, end).split("\n");
  const index = lines.findIndex(isCodeSymbolDefinitionLine);
  return index < 0 ? undefined : before + index;
}

describe("repository pod executable journey", () => {
  it("indexes, resolves path:line, refreshes incrementally, survives cancellation, and removes", async () => {
    createShell();
    const adapter = countingAdapter();
    const initialEvents: import("./indexing/index.js").IndexingEvent[] = [];
    const initial = await refreshRepositoryPod(
      indexingDeps(adapter, { onIndexEvent: (event) => initialEvents.push(event) }),
      { runId: "repository-initial" },
    );

    expect(initial.run.outcome).toBe("partial");
    expect(initial.run.applied).toBe(true);
    expect(initial.run.counts).toMatchObject({ addedFiles: 4, rejectedEntries: 1 });
    expect(initial.run.fingerprintSetDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(documentRows().map((row) => row.document_path)).toEqual([
      ".gitignore",
      "escape-link.ts",
      "src/app.ts",
      "src/service.py",
      "src/worker.go",
    ]);
    expect(vectorIds("escape-link.ts")).toEqual([]);
    const containmentFailure = initialEvents.find(
      (event) => event.kind === "document-failed" && event.relativePath === "escape-link.ts",
    );
    expect(containmentFailure?.kind).toBe("document-failed");
    if (containmentFailure?.kind === "document-failed") {
      expect(containmentFailure.error.code).toBe("DISCOVERY_FAILED:PATH_ESCAPE");
    }

    const mappings = listRepositoryChunkLineRanges(store, CAPSULE_ID);
    const spans = chunkSpans();
    expect(mappings.length).toBeGreaterThanOrEqual(6);
    for (const mapping of mappings) {
      const span = spans.get(String(mapping.chunkId));
      expect(span).toBeDefined();
      if (span === undefined) continue;
      const source = relativeSource(mapping.relativePath);
      expect(mapping.startLine).toBeGreaterThanOrEqual(1);
      expect(mapping.endLine).toBeGreaterThanOrEqual(mapping.startLine);
      expect(mapping.endLine).toBeLessThanOrEqual(mapping.documentLineCount);
      const symbolLine = firstSymbolLine(source, span.character_start, span.character_end);
      if (symbolLine !== undefined) {
        expect(symbolLine).toBeGreaterThanOrEqual(mapping.startLine);
        expect(symbolLine).toBeLessThanOrEqual(mapping.endLine);
      }
    }

    const retrieval = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: adapter.adapter },
      { text: "execute load worker", capsuleId: CAPSULE_ID, topK: 12 },
    );
    expect(retrieval.references.length).toBeGreaterThan(0);
    for (const reference of retrieval.references) {
      const location = resolveRepositoryChunkLineRange(store, CAPSULE_ID, reference.chunkId);
      expect(location?.relativePath).toMatch(/^src\//u);
      expect(typeof location?.startLine).toBe("number");
    }

    const appVectors = vectorIds("src/app.ts");
    const goVectors = vectorIds("src/worker.go");
    writeFileSync(
      join(repositoryRoot, "src", "service.py"),
      ["class Service:", "    pass", "", "def load():", '    return "changed"', ""].join("\n"),
      "utf8",
    );
    const refreshEvents: import("./indexing/index.js").IndexingEvent[] = [];
    const refreshed = await refreshRepositoryPod(
      indexingDeps(adapter, { onIndexEvent: (event) => refreshEvents.push(event) }),
      { runId: "repository-refresh" },
    );
    expect(refreshed.run.counts).toMatchObject({ changedFiles: 1, unchangedFiles: 3 });
    expect(refreshEvents.filter((event) => event.kind === "document-embedded")).toHaveLength(1);
    expect(
      refreshEvents.filter(
        (event) => event.kind === "document-skipped" && event.reason === "unchanged",
      ).length,
    ).toBeGreaterThanOrEqual(3);
    expect(vectorIds("src/app.ts")).toEqual(appVectors);
    expect(vectorIds("src/worker.go")).toEqual(goVectors);

    const baselineBeforeCancel = [
      ...readRepositoryFileFingerprints(store, CAPSULE_ID, SOURCE_ID).entries(),
    ];
    const appLinesBeforeCancel = listRepositoryChunkLineRanges(
      store,
      CAPSULE_ID,
      documentId("src/app.ts"),
    );
    writeFileSync(
      join(repositoryRoot, "src", "app.ts"),
      [
        "export interface Request {}",
        "",
        "export function execute(): string {",
        '  return "cancelled";',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const controller = new AbortController();
    const cancelled = await refreshRepositoryPod(
      indexingDeps(adapter, {
        signal: controller.signal,
        onIndexEvent: (event) => {
          if (event.kind === "document-chunked" && event.documentId === documentId("src/app.ts")) {
            controller.abort();
          }
        },
      }),
      { runId: "repository-cancelled" },
    );
    expect(cancelled.run).toMatchObject({ outcome: "cancelled", applied: false });
    expect([...readRepositoryFileFingerprints(store, CAPSULE_ID, SOURCE_ID).entries()]).toEqual(
      baselineBeforeCancel,
    );
    expect(listRepositoryChunkLineRanges(store, CAPSULE_ID, documentId("src/app.ts"))).toEqual(
      appLinesBeforeCancel,
    );
    expect(vectorIds("src/app.ts")).toEqual(appVectors);
    expect(listRepositoryPodRuns(store, CAPSULE_ID, SOURCE_ID).at(-1)).toMatchObject({
      runId: "repository-cancelled",
      applied: false,
    });

    await refreshRepositoryPod(indexingDeps(adapter), { runId: "repository-retry" });
    unlinkSync(join(repositoryRoot, "src", "worker.go"));
    const removed = await refreshRepositoryPod(indexingDeps(adapter), {
      runId: "repository-remove",
    });
    expect(removed.run.counts.removedFiles).toBe(1);
    expect(documentRows().map((row) => row.document_path)).not.toContain("src/worker.go");
  });
});
