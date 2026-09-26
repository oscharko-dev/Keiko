// Activity Log scenario matrix (#3532): the memory/knowledge surface (keiko-local-knowledge's
// indexing orchestrator, embedding batcher and discovery layer, plus the keiko-server
// connected-context bridge). Each scenario drives a real production entry point with fault
// injection under a temporary `KEIKO_STATE_DIR` and reconstructs the persisted log through
// `keiko support analyze` to a complete report (tests/support/activity-log-scenario.ts).

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChunkId,
  DocumentId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type EvidenceAtom,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-model-use-policy";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";

import { createCapsule } from "../../packages/keiko-local-knowledge/src/capsule-lifecycle.js";
import {
  folderScope,
  memoryFs,
} from "../../packages/keiko-local-knowledge/src/discovery/test-support.js";
import { embedChunkBatch } from "../../packages/keiko-local-knowledge/src/indexing/embedding-batcher.js";
import { runIndexingJob } from "../../packages/keiko-local-knowledge/src/indexing/orchestrator.js";
import type {
  ChunkToEmbed,
  IndexingEvent,
  IndexingOptions,
} from "../../packages/keiko-local-knowledge/src/indexing/types.js";
import { createDefaultParserRegistry } from "../../packages/keiko-local-knowledge/src/parsers/index.js";
import { addSourceToCapsule } from "../../packages/keiko-local-knowledge/src/source-lifecycle.js";
import {
  openKnowledgeStore,
  type KnowledgeStore,
} from "../../packages/keiko-local-knowledge/src/store.js";
import {
  retrieveConnectedContextPack,
  type GroundedAnswerer,
  type OrchestratorDeps,
  type OrchestratorInput,
} from "../../packages/keiko-server/src/grounded-orchestrator.js";
import {
  createFileServerLogSink,
  resetServerLogger,
  type ServerLogSink,
} from "../../packages/keiko-server/src/observability/index.js";
import { processServerLogSink } from "../../packages/keiko-server/src/process-log-sink.js";
import { expectActivityLogScenario } from "../support/activity-log-scenario.js";

function digest16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const SCENARIO_EMBEDDING_IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-3-small",
  vectorDimensions: 1536,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "keiko-embedding-input-v1",
  embeddingSpaceFingerprint: "keiko-embedding-space-fingerprint-v1:memory-knowledge-scenario",
};

function scenarioAdapterBase(): Pick<OpenAIEmbeddingAdapter, "endpoint" | "apiKey"> {
  return { endpoint: "https://embeddings.example.test/v1", apiKey: "scenario-fixture-key" };
}

function scenarioChunk(id: string): ChunkToEmbed {
  return {
    id: `${id}-chunk` as ChunkId,
    capsuleId: "memory-knowledge-scenario-capsule" as KnowledgeCapsuleId,
    sourceId: "memory-knowledge-scenario-source" as KnowledgeSourceId,
    documentId: `doc:${id}` as DocumentId,
    text: "Fault-injection fixture text for the memory-knowledge scenario suite.",
  };
}

function openScenarioStore(stateDir: string, name: string): KnowledgeStore {
  return openKnowledgeStore({ dbPath: join(stateDir, "knowledge-store", `${name}.db`) });
}

// ─── memory-knowledge.crash: an in-flight embedding batch is cancelled via AbortSignal ────────
// `embedChunkBatch` checks the signal BEFORE ever invoking the adapter, so a pre-aborted signal
// deterministically reaches `embedding.batch.cancelled` with no timers and no adapter call.

function abortedEmbeddingAdapter(): OpenAIEmbeddingAdapter {
  return {
    ...scenarioAdapterBase(),
    request: (): Promise<OpenAIEmbeddingOutcome> =>
      Promise.reject(new Error("the adapter must not be called once the signal is aborted")),
  };
}

async function runCrashFixture(stateDir: string): Promise<{ readonly startedAtMs: number }> {
  const store = openScenarioStore(stateDir, "crash");
  const controller = new AbortController();
  controller.abort();
  try {
    const startedAtMs = Date.now();
    const result = await embedChunkBatch([scenarioChunk("crash")], {
      adapter: abortedEmbeddingAdapter(),
      store,
      pinnedIdentity: SCENARIO_EMBEDDING_IDENTITY,
      concurrency: 1,
      signal: controller.signal,
      now: Date.now,
      idSource: () => "memory-knowledge-crash-vector",
      logSink: processServerLogSink(),
      logContext: {
        jobId: "memory-knowledge-crash-job",
        capsuleIdDigest: digest16("memory-knowledge-crash-capsule"),
      },
    });
    expect(result.vectors).toEqual([]);
    return { startedAtMs };
  } finally {
    store.close();
  }
}

// ─── memory-knowledge.rejection: a batch response fails the pinned embedding-identity gate ────
// The fake adapter answers successfully but with the wrong vector dimensionality, so the real
// compatibility gate (#192's load-bearing invariant) rejects it fail-closed — no chunk persists.

function mismatchedEmbeddingAdapter(identity: EmbeddingModelIdentity): OpenAIEmbeddingAdapter {
  return {
    ...scenarioAdapterBase(),
    request: (): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({
        ok: true,
        value: { vector: new Float32Array(3), modelId: identity.modelId },
      }),
  };
}

async function runRejectionFixture(stateDir: string): Promise<{ readonly startedAtMs: number }> {
  const store = openScenarioStore(stateDir, "rejection");
  try {
    const startedAtMs = Date.now();
    const result = await embedChunkBatch([scenarioChunk("rejection")], {
      adapter: mismatchedEmbeddingAdapter(SCENARIO_EMBEDDING_IDENTITY),
      store,
      pinnedIdentity: SCENARIO_EMBEDDING_IDENTITY,
      concurrency: 1,
      now: Date.now,
      idSource: () => "memory-knowledge-rejection-vector",
      logSink: processServerLogSink(),
      logContext: {
        jobId: "memory-knowledge-rejection-job",
        capsuleIdDigest: digest16("memory-knowledge-rejection-capsule"),
      },
    });
    expect(result.vectors).toEqual([]);
    expect(result.errors).toHaveLength(1);
    return { startedAtMs };
  } finally {
    store.close();
  }
}

// ─── memory-knowledge.loss: discovery truncates a corpus at its configured file bound ─────────
// A bounded discovery is a self-evidencing loss (its own `indexing.discovery.limit-reached` line
// carries the loss), so a real orchestrator run over more files than `maxFiles` allows reaches a
// complete trace while the run itself still succeeds — exactly the field incident this closed.

const LOSS_CAPSULE_ID = "memory-knowledge-loss-capsule" as KnowledgeCapsuleId;
const LOSS_SOURCE_ID = "memory-knowledge-loss-source" as KnowledgeSourceId;
const LOSS_ROOT = "/private/memory-knowledge-scenario/loss";

function lossFixtureFiles(): Readonly<Record<string, string>> {
  return {
    "top.txt": "Top level document. ".repeat(8),
    "a/nested-one.txt": "Nested document one. ".repeat(8),
    "a/b/nested-two.txt": "Nested document two. ".repeat(8),
    "a/b/c/nested-three.txt": "Nested document three. ".repeat(8),
  };
}

function happyEmbeddingAdapter(identity: EmbeddingModelIdentity): OpenAIEmbeddingAdapter {
  return {
    ...scenarioAdapterBase(),
    request: (): Promise<OpenAIEmbeddingOutcome> =>
      Promise.resolve({
        ok: true,
        value: {
          vector: new Float32Array(identity.vectorDimensions).fill(0.01),
          modelId: identity.modelId,
        },
      }),
  };
}

function openLossStore(stateDir: string): KnowledgeStore {
  const store = openScenarioStore(stateDir, "loss");
  createCapsule(store, {
    id: LOSS_CAPSULE_ID,
    displayName: "Memory Knowledge Loss Scenario",
    tags: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    modelUsePolicy: standardPodModelUsePolicy(),
    embeddingModelIdentity: SCENARIO_EMBEDDING_IDENTITY,
    lifecycleState: "draft",
    storageReference: "memory-knowledge/loss-scenario",
  });
  addSourceToCapsule(store, LOSS_CAPSULE_ID, {
    id: LOSS_SOURCE_ID,
    displayName: "Loss Scenario Source",
    tags: [],
    scope: folderScope(LOSS_ROOT, { recursive: true }),
  });
  return store;
}

function lossIndexingOptions(store: KnowledgeStore): IndexingOptions {
  const files = Object.entries(lossFixtureFiles()).map(([relativePath, content]) => ({
    relativePath,
    content,
  }));
  return {
    capsuleId: LOSS_CAPSULE_ID,
    parserRegistry: createDefaultParserRegistry(),
    workspaceFs: memoryFs(LOSS_ROOT, files),
    embeddingAdapter: happyEmbeddingAdapter(SCENARIO_EMBEDDING_IDENTITY),
    store,
    discoveryOptions: { maxFiles: 1, maxDepth: 12 },
    logSink: processServerLogSink(),
    now: Date.now,
    idSource: () => "memory-knowledge-loss-job",
  };
}

async function runLossFixture(stateDir: string): Promise<{ readonly startedAtMs: number }> {
  const store = openLossStore(stateDir);
  try {
    const startedAtMs = Date.now();
    const events: IndexingEvent[] = [];
    for await (const event of runIndexingJob(lossIndexingOptions(store))) {
      events.push(event);
    }
    expect(events.some((event) => event.kind === "job-completed")).toBe(true);
    return { startedAtMs };
  } finally {
    store.close();
  }
}

// ─── memory-knowledge.dependency-failure: connected-context retrieval fails mid-request ───────
// Mirrors the real-sink pattern in grounded-orchestrator.activity-log.test.ts: an injected
// `detectWorkspace` throws, and the real producer writes the started/failed lifecycle pair to
// the production file sink.

const CONNECTED_CONTEXT_ROOT = "/private/memory-knowledge-scenario/connected-context";
const CONNECTED_CONTEXT_FILE = "docs/handler.ts";
const CONNECTED_CONTEXT_CORRELATION_ID = "memory-knowledge-dependency-failure-0001";
const CONNECTED_CONTEXT_FIXTURE_NOW_MS = 1_700_000_000_000;

const ANSWERER_NOT_USED: GroundedAnswerer = {
  answer: (): Promise<string> => Promise.resolve("answerer must not run"),
};

function connectedContextInput(): OrchestratorInput {
  const scope: SelectedScope = {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "memory-knowledge-dependency-failure-scope",
    workspaceRoot: CONNECTED_CONTEXT_ROOT,
    kind: "files",
    relativePaths: [CONNECTED_CONTEXT_FILE],
    conversationId: undefined,
    connectedAtMs: CONNECTED_CONTEXT_FIXTURE_NOW_MS,
    explicitConnection: false,
  };
  const query: RetrievalQuery = {
    kind: "natural-language",
    text: "Trace ScenarioFixtureHandler implementation",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: CONNECTED_CONTEXT_FIXTURE_NOW_MS,
  };
  return { scope, query, workspaceRoot: CONNECTED_CONTEXT_ROOT };
}

function connectedContextDeps(activityLog: ServerLogSink, failure: Error): OrchestratorDeps {
  return {
    answerer: ANSWERER_NOT_USED,
    correlationId: CONNECTED_CONTEXT_CORRELATION_ID,
    activityLog,
    nowMs: () => CONNECTED_CONTEXT_FIXTURE_NOW_MS,
    fs: memFs(CONNECTED_CONTEXT_ROOT, {
      [CONNECTED_CONTEXT_FILE]: "export function handler(): string { return 'ok'; }\n",
    }),
    detectWorkspace: (): never => {
      throw failure;
    },
    gitFileHistoryEvidence: (): Promise<readonly EvidenceAtom[]> => Promise.resolve([]),
  };
}

async function runDependencyFailureFixture(
  stateDir: string,
): Promise<{ readonly startedAtMs: number }> {
  const activityLog = createFileServerLogSink(stateDir, { level: "debug" });
  const failure = new TypeError(
    "memory-knowledge dependency-failure fixture: workspace detection failed",
  );
  try {
    const startedAtMs = Date.now();
    await expect(
      retrieveConnectedContextPack(
        connectedContextInput(),
        connectedContextDeps(activityLog, failure),
      ),
    ).rejects.toBe(failure);
    return { startedAtMs };
  } finally {
    activityLog.close?.();
  }
}

describe("Activity Log scenario: memory-knowledge", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-scenario-memory-knowledge-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    resetServerLogger();
  });

  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("cancels an in-flight embedding batch and reaches a complete crash trace", async () => {
    const { startedAtMs } = await runCrashFixture(stateDir);
    const trace = await expectActivityLogScenario("memory-knowledge.crash", {
      stateDir,
      startedAtMs,
      expectedOps: ["embedding.batch.transport-selected", "embedding.batch.cancelled"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["embedding-cancelled"]));
  }, 60_000);

  it("fails connected-context retrieval and reaches a complete dependency-failure trace", async () => {
    const { startedAtMs } = await runDependencyFailureFixture(stateDir);
    const trace = await expectActivityLogScenario("memory-knowledge.dependency-failure", {
      stateDir,
      startedAtMs,
      expectedOps: ["search.connected-context.started", "search.connected-context.failed"],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["connected-context-retrieval"]));
  });

  it("truncates discovery at its configured bound and reaches a complete loss trace", async () => {
    const { startedAtMs } = await runLossFixture(stateDir);
    const trace = await expectActivityLogScenario("memory-knowledge.loss", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "indexing.job.received",
        "indexing.job.started",
        "indexing.discovery.limit-reached",
      ],
    });
    expect(trace.failureClasses).toEqual(expect.arrayContaining(["discovery-truncated"]));
  });

  it("rejects a mismatched embedding identity and reaches a complete rejection trace", async () => {
    const { startedAtMs } = await runRejectionFixture(stateDir);
    const trace = await expectActivityLogScenario("memory-knowledge.rejection", {
      stateDir,
      startedAtMs,
      expectedOps: [
        "embedding.batch.transport-selected",
        "embedding.identity.rejected",
        "embedding.batch.rejected",
      ],
    });
    expect(trace.failureClasses).toEqual(
      expect.arrayContaining(["embedding-identity-mismatch", "embedding-identity-rejection"]),
    );
  });
});
