import {
  supportIncidentPrivateProjection,
  activityLogLossCounters,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  checkActivityLogReadiness,
  persistActivityLogLossSummary,
  recordUserReportedIncident,
  supportIncidentSegmentFiles,
} from "@oscharko-dev/keiko-activity-log";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  buildSupportReport,
  serializeSupportReport,
  analyzeSupportReport,
} from "@oscharko-dev/keiko-activity-log/reader";
import { resolveSupportIncident } from "../../packages/keiko-cli/src/support-incident.js";
import {
  executeSupportQuery,
  resolveSupportSelection,
} from "../../packages/keiko-cli/src/support-query-cli.js";
import { resetServerLogger } from "../support/activity-log-test-support.js";
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
import { DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/documentation-manual-proposal";
import {
  htmlManualSourceKindTag,
  htmlManualSourceFingerprintTag,
} from "@oscharko-dev/keiko-contracts/runtime/html-manual-source";
import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-model-use-policy";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";

import { buildKnowledgePodSummary } from "../../packages/keiko-local-knowledge/src/knowledge-pods.js";
import { computeManualRefreshChangeSummary } from "../../packages/keiko-local-knowledge/src/manual-refresh-change-summary.js";
import {
  persistHtmlManualSourceMetadata,
  updateHtmlManualRefreshState,
} from "../../packages/keiko-local-knowledge/src/manual-source-metadata.js";
import {
  expectActivityLogProof,
  expectRegisteredActivityLogLine,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../support/activity-log-proof.js";
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

function seedRejectedManualSummary(store: KnowledgeStore): ReturnType<typeof createCapsule> {
  const capsule = createCapsule(store, {
    id: "manual-summary-scenario" as KnowledgeCapsuleId,
    displayName: "Fixture manual",
    tags: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: "require-citations",
    modelUsePolicy: standardPodModelUsePolicy(),
    embeddingModelIdentity: SCENARIO_EMBEDDING_IDENTITY,
    lifecycleState: "draft",
    storageReference: "fixture/manual",
  });
  const sourceId = "manual-summary-source" as KnowledgeSourceId;
  addSourceToCapsule(store, capsule.id, {
    id: sourceId,
    displayName: "Fixture source",
    tags: [
      htmlManualSourceKindTag("html-manual-http"),
      htmlManualSourceFingerprintTag("fp-summary"),
    ],
    scope: folderScope("/fixture/manual", { recursive: true }),
  });
  persistHtmlManualSourceMetadata(store, capsule.id, sourceId, {
    schemaVersion: "1",
    scope: { kind: "html-manual-http", origin: "https://manual.example.invalid", pathPrefix: null },
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
    sourceFingerprint: "fp-summary",
    proposedPodName: "Fixture manual",
  });
  const healthy = computeManualRefreshChangeSummary({
    priorFingerprints: new Map(),
    newPages: [],
    indexing: undefined,
    crawl: {
      status: "empty",
      pages: [],
      denied: [],
      stats: { discovered: 0, fetched: 0, accepted: 0, deniedCount: 0, bytesFetched: 0 },
    },
    sourceKind: "html-manual-http",
    applied: false,
    refreshedAt: 4242,
  });
  updateHtmlManualRefreshState(store, capsule.id, sourceId, {
    lastRefreshedAt: 4242,
    lastCrawlRunId: "manual-summary-run",
    changeSummaryJson: JSON.stringify(healthy),
  });
  // Explicit legacy corruption: current public writers refuse these bytes.
  store._internal.db
    .prepare("UPDATE html_manual_sources SET last_change_summary_json = :bytes")
    .run({ bytes: "{private-fixture-body" });
  return capsule;
}

async function proveManualSummaryTransportLoss(stateDir: string): Promise<void> {
  // A dropped primary has no retained registered-failure record. The human report uses the
  // existing unattributed incident path and honestly retains loss and the missing primary.
  const creation = recordUserReportedIncident(stateDir);
  if (creation.status === "rejected" || creation.record === undefined)
    throw new TypeError("Expected real selective-loss incident");
  const selection = await resolveSupportSelection(
    { incidentId: creation.incidentId, filter: {} },
    stateDir,
  );
  const query = executeSupportQuery(stateDir, selection, DEFAULT_SUPPORT_QUERY_LIMITS, {
    trigger: "query",
  }).result;
  const incident = supportIncidentPrivateProjection(
    resolveSupportIncident(
      creation.record,
      supportIncidentSegmentFiles(stateDir, creation.record),
      stateDir,
    ),
  );
  const report = buildSupportReport(incident, query);
  const analyzed = analyzeSupportReport(serializeSupportReport(report));
  expect(report.evidence.recordCount).toBe(query.events.length);
  expect(analyzed.analysis.evidence.classification).toBe("supported");
  expect(analyzed.analysis.sufficiency.status).toBe("degraded");
  expect(analyzed.analysis.sufficiency.classes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        failureClass: "activity-log-sink",
        status: "degraded",
        reasons: ["activity-log-loss"],
      }),
    ]),
  );
  expect(query.diagnosticSufficiency).toMatchObject({
    status: "insufficient",
    reasons: ["no-registered-failure", "evidence-not-retained"],
  });
  expect(query.events.map((event) => event.parsed.view.op)).toEqual(
    expect.arrayContaining([
      "knowledge.log.sink-failed",
      "activity-log.loss",
      "activity-log.readiness",
    ]),
  );
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
  it("retains rejected persisted manual summaries through the physical writer and complete incident analysis", async () => {
    const store = openScenarioStore(stateDir, "manual-summary-rejection");
    try {
      const capsule = seedRejectedManualSummary(store);
      const startedAtMs = Date.now();
      const summary = buildKnowledgePodSummary(store, capsule, {
        logSink: processServerLogSink(),
        correlationId: "manual-summary-rejection-request",
      });
      expect(summary.manualRefresh).toBeUndefined();
      const trace = await expectActivityLogScenario("memory-knowledge.rejection", {
        stateDir,
        startedAtMs,
        expectedOps: ["knowledge.manual-refresh-summary.rejected"],
      });
      expect(trace.failureClasses).toContain("knowledge-manual-summary-validation");
      const selection = await resolveSupportSelection(
        { correlationId: "manual-summary-rejection-request", filter: {} },
        stateDir,
      );
      const queried = executeSupportQuery(
        stateDir,
        selection,
        { ...DEFAULT_SUPPORT_QUERY_LIMITS, contextMs: 0, maxContextEvents: 0 },
        { trigger: "query" },
      ).result;
      expect(
        queried.events.some(
          (event) => event.parsed.view.op === "knowledge.manual-refresh-summary.rejected",
        ),
      ).toBe(true);
      expect(queried.metrics.contextEventCount).toBe(0);
      expect(queried.diagnosticSufficiency).toMatchObject({ status: "complete", reasons: [] });

      const raw = readPersistedActivityLog(stateDir);
      const lines = persistedActivityLogLines(raw, "knowledge.manual-refresh-summary.rejected");
      expect(lines).toHaveLength(1);
      expect(
        expectActivityLogProof(
          "knowledge.manual-refresh-summary.rejected.omission",
          lines[0] ?? "",
        ),
      ).toMatchObject({
        correlationId: "manual-summary-rejection-request",
        errorKind: "validation-failed",
        invalidJsonCount: 1,
        invalidSummaryCount: 0,
        reason: "invalid-json",
        summaryReturned: false,
      });
      expect(raw).not.toContain("private-fixture-body");
    } finally {
      store.close();
    }
  });

  it("retains selective manual-summary transport loss through the physical fallback and incident analyzer", async () => {
    const store = openScenarioStore(stateDir, "manual-summary-transport-loss");
    try {
      const capsule = seedRejectedManualSummary(store);
      const before = activityLogLossCounters()["port-sink-failed"];
      const summary = buildKnowledgePodSummary(store, capsule, {
        correlationId: "manual-summary-loss-request",
        logSink: {
          write: (event) => {
            if (event.op === "knowledge.manual-refresh-summary.rejected")
              throw new TypeError("private-selective-transport-fixture");
            processServerLogSink().write(event);
          },
        },
      });
      expect(summary.manualRefresh).toBeUndefined();
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(before + 1);
      expect(persistActivityLogLossSummary("heartbeat")).toBe("persisted");
      expect(checkActivityLogReadiness({ stateDir })).toMatchObject({
        readiness: "ready",
        writer: "production-file",
        reasons: [],
      });
      await proveManualSummaryTransportLoss(stateDir);
      const raw = readPersistedActivityLog(stateDir);
      expect(
        persistedActivityLogLines(raw, "knowledge.manual-refresh-summary.rejected"),
      ).toHaveLength(0);
      const fallback = persistedActivityLogLines(raw, "knowledge.log.sink-failed");
      expect(fallback).toHaveLength(1);
      expect(
        expectRegisteredActivityLogLine("knowledge.log.sink-failed", fallback[0] ?? ""),
      ).toMatchObject({
        errorKind: "unavailable",
        failureKind: "TypeError",
      });
      const loss = persistedActivityLogLines(raw, "activity-log.loss");
      expect(loss).toHaveLength(1);
      expect(expectRegisteredActivityLogLine("activity-log.loss", loss[0] ?? "")).toMatchObject({
        portSinkFailed: before + 1,
        completeness: "partial",
        loss: "event-dropped",
      });
      expect(raw).not.toContain("private-selective-transport-fixture");
      expect(raw).not.toContain("private-fixture-body");
    } finally {
      store.close();
    }
  });
});
