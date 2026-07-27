import {
  existsSync,
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

import {
  SHARED_POD_REFRESH_TERMINALS,
  type DocumentId,
  type KnowledgeCapsuleId,
  type KnowledgeSourceId,
  type ManualRefreshOutcome,
  type SharedPodRefreshTerminal,
} from "@oscharko-dev/keiko-contracts";
import type {
  GatewayRequest,
  NormalizedResponse,
  OpenAIEmbeddingOutcome,
} from "@oscharko-dev/keiko-model-gateway";
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
  const index = lines.findIndex((line): boolean => isCodeSymbolDefinitionLine(line));
  return index < 0 ? undefined : before + index;
}

describe("repository_pod_runs ledger table", () => {
  it("exists immediately after opening a fresh store, before any pod call runs (Issue #2569 ledger migration)", () => {
    const row = store._internal.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'repository_pod_runs'",
      )
      .get() as unknown as { readonly n: number };
    expect(row.n).toBe(1);
  });
});

describe("repository pod prune", () => {
  it("deletes documents for a file that was genuinely removed from disk", async () => {
    createShell();
    const adapter = countingAdapter();
    await refreshRepositoryPod(indexingDeps(adapter), { runId: "remove-initial" });
    expect(documentRows().map((row) => row.document_path)).toContain("src/worker.go");

    unlinkSync(join(repositoryRoot, "src", "worker.go"));
    await refreshRepositoryPod(indexingDeps(adapter), { runId: "remove-refresh" });

    expect(documentRows().map((row) => row.document_path)).not.toContain("src/worker.go");
  });

  it("preserves the prior baseline and refuses prune when enumeration hits maxFiles", async () => {
    createShell();
    const adapter = countingAdapter();
    await refreshRepositoryPod(indexingDeps(adapter), { runId: "bounded-initial" });
    const prior = [...readRepositoryFileFingerprints(store, CAPSULE_ID, SOURCE_ID).entries()];

    unlinkSync(join(repositoryRoot, "src", "worker.go"));
    const incomplete = await refreshRepositoryPod(
      indexingDeps(adapter, { discoveryOptions: { maxDepth: 12, maxFiles: 1 } }),
      { runId: "bounded-incomplete" },
    );

    expect(incomplete.run).toMatchObject({
      applied: false,
      counts: { removedFiles: 0, rejectedEntries: 1 },
    });
    expect([...readRepositoryFileFingerprints(store, CAPSULE_ID, SOURCE_ID).entries()]).toEqual(
      prior,
    );
    expect(documentRows().map((row) => row.document_path)).toContain("src/worker.go");
  });

  it("preserves the prior baseline and refuses prune after a transient readdir failure", async () => {
    createShell();
    const adapter = countingAdapter();
    await refreshRepositoryPod(indexingDeps(adapter), { runId: "readdir-initial" });
    const prior = [...readRepositoryFileFingerprints(store, CAPSULE_ID, SOURCE_ID).entries()];
    const failingFs: typeof nodeWorkspaceFs = {
      ...nodeWorkspaceFs,
      readDir: (absolutePath: string) => {
        if (absolutePath === join(repositoryRoot, "src")) throw new Error("transient");
        return nodeWorkspaceFs.readDir(absolutePath);
      },
    };

    const incomplete = await refreshRepositoryPod(
      indexingDeps(adapter, { workspaceFs: failingFs }),
      {
        runId: "readdir-incomplete",
      },
    );

    expect(incomplete.run.applied).toBe(false);
    expect(incomplete.run.counts.removedFiles).toBe(0);
    expect(incomplete.run.counts.rejectedEntries).toBeGreaterThan(0);
    expect([...readRepositoryFileFingerprints(store, CAPSULE_ID, SOURCE_ID).entries()]).toEqual(
      prior,
    );
    expect(documentRows().map((row) => row.document_path)).toContain("src/worker.go");
  });
});

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

    // The sensitive-path denial is asserted for its own reason, not merely as an absence from the
    // list above. The fixture writes a real `.env` holding a secret and its `.gitignore` covers
    // only `node_modules/`, so the workspace deny-list is the sole thing keeping it out — and it
    // is refused during the walk rather than failed during indexing, which is why it produces no
    // event at all. Pin both halves: gitignore did not do this, and nothing about it was indexed.
    expect(existsSync(join(repositoryRoot, ".env"))).toBe(true);
    expect(readFileSync(join(repositoryRoot, ".gitignore"), "utf8")).not.toContain(".env");
    expect(documentRows().map((row) => row.document_path)).not.toContain(".env");
    expect(
      initialEvents.filter((event) => "relativePath" in event && event.relativePath === ".env"),
    ).toEqual([]);

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

// ─── M2.12 — capsule setting parity: contextual retrieval ────────────────────
// Outcome 2 says every capsule setting a folder pod honours either applies to a repository pod
// with the same semantics, or is explicitly refused with a reason. `contextualRetrieval` is the
// only capsule-level setting that affects INDEXING (the others — retrievalEffort, outputMode,
// answerGroundingPolicy — shape retrieval, not the refresh), and before Issue #2633 it was
// silently dropped for repository pods: accepted at the PATCH layer, reported by
// `contextualRetrievalHealth` at the diagnostics surface, and then thrown away at the refresh.
// The observable effect is the persisted `chunks.contextual_retrieval_key`: with the option
// honoured the value starts with `indexed-text=contextual-v1|…`; without it the value stays
// `indexed-text=raw-v1|…`.
function contextualRetrievalKeys(): readonly string[] {
  const rows = store._internal.db
    .prepare(
      "SELECT contextual_retrieval_key FROM chunks WHERE capsule_id = :c AND contextual_retrieval_key IS NOT NULL",
    )
    .all({ c: CAPSULE_ID }) as unknown as readonly {
    readonly contextual_retrieval_key: string;
  }[];
  return rows.map((row) => row.contextual_retrieval_key);
}

function stubChatGateway(): {
  readonly chat: (request: GatewayRequest) => Promise<NormalizedResponse>;
  readonly calls: readonly GatewayRequest[];
} {
  const calls: GatewayRequest[] = [];
  return {
    calls,
    chat: (request: GatewayRequest): Promise<NormalizedResponse> => {
      calls.push(request);
      return Promise.resolve({
        modelId: request.modelId,
        content: "context stub for repository pod",
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "repo-ctx-test",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "low",
        },
      });
    },
  };
}

describe("repository pod capsule setting parity (M2.12)", () => {
  it("honours contextualRetrieval when threaded through refreshRepositoryPod", async (): Promise<void> => {
    createShell();
    const adapter = countingAdapter();
    const gateway = stubChatGateway();
    const result = await refreshRepositoryPod(
      indexingDeps(adapter, {
        contextualRetrieval: {
          enabled: true,
          chatGateway: gateway,
          modelId: "context-model",
        },
      }),
      { runId: "context-enabled" },
    );

    expect(result.run.outcome).not.toBe("failed");
    expect(gateway.calls.length).toBeGreaterThan(0);
    const keys = contextualRetrievalKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("indexed-text=contextual-v1|")).toBe(true);
    }
  });

  it("falls back to the raw strategy key when contextualRetrieval is not provided", async (): Promise<void> => {
    createShell();
    const adapter = countingAdapter();
    const result = await refreshRepositoryPod(indexingDeps(adapter), {
      runId: "context-omitted",
    });

    expect(result.run.outcome).not.toBe("failed");
    const keys = contextualRetrievalKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("indexed-text=raw-v1|")).toBe(true);
    }
  });
});

// ─── M2.12 — evidence vocabulary parity ─────────────────────────────────────
// Outcome 2 says an operator reading pod evidence should not need to learn a second dialect. The
// repository pod persists its own run record (`repository_pod_runs`) with an `outcome` enum that
// runs alongside the HTML-manual `ManualRefreshOutcome` enum. Neither is a superset of the other,
// but for OPERATOR-facing vocabulary the interrupt/failure terminals must match — otherwise a
// script or dashboard that surfaces one has to translate the other. The shared floor lives in
// `SHARED_POD_REFRESH_TERMINALS` (contracts, Issue #2633); the assertions below prove BOTH outcome
// unions accept every shared terminal at COMPILE time (so a future PR that drops one from either
// side breaks tsc), and one healthy-terminal runtime case anchors the vocabulary against the
// actual persisted enum. That is deliberately narrower than inducing every terminal via forced
// failure/cancellation — the failure modes are exercised end-to-end by the existing "indexes,
// resolves path:line, refreshes incrementally, survives cancellation, and removes" journey test.
type RepositoryPodOutcome = Awaited<ReturnType<typeof refreshRepositoryPod>>["run"]["outcome"];
// `KNOWN_REPOSITORY_OUTCOMES` is the RUNTIME anchor: it exists at the value level so the test
// below can assert against it, but its typed shape (`readonly RepositoryPodOutcome[]`) is what
// gives the compile-time proof — a future PR that drops one of the shared terminals from the
// repository outcome union fails tsc here before it can regress the runtime assertion. The same
// technique is applied against `ManualRefreshOutcome` inside the second test below without
// synthesising a throwaway binding that ESLint's no-unused-vars rule would reject.
const KNOWN_REPOSITORY_OUTCOMES: readonly RepositoryPodOutcome[] = [
  "succeeded",
  ...SHARED_POD_REFRESH_TERMINALS,
];

describe("repository pod evidence vocabulary parity (M2.12)", () => {
  it("emits outcomes drawn from the shared refresh vocabulary", async (): Promise<void> => {
    createShell();
    const adapter = countingAdapter();
    const result = await refreshRepositoryPod(indexingDeps(adapter), { runId: "vocabulary-run" });
    expect(KNOWN_REPOSITORY_OUTCOMES).toContain(result.run.outcome);
  });

  it("keeps every SHARED_POD_REFRESH_TERMINALS entry in both pod outcome vocabularies", (): void => {
    // Companion runtime + type-level proof: the shared terminals are members of both outcome
    // unions. The `manualOutcomeProof` binding is typed `readonly ManualRefreshOutcome[]`, so tsc
    // rejects any future PR that drops one of the shared terminals from the manual enum; the
    // runtime `expect` assertions then anchor the same claim against the repository union via
    // `KNOWN_REPOSITORY_OUTCOMES`.
    const manualOutcomeProof: readonly ManualRefreshOutcome[] = SHARED_POD_REFRESH_TERMINALS;
    for (const terminal of SHARED_POD_REFRESH_TERMINALS) {
      const asShared: SharedPodRefreshTerminal = terminal;
      expect(KNOWN_REPOSITORY_OUTCOMES).toContain(asShared);
      expect(manualOutcomeProof).toContain(asShared);
    }
  });
});
