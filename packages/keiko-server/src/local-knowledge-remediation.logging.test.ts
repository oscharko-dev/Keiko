// Remediation reindexes every Local Knowledge capsule after a failed upgrade. It runs unattended,
// with no route, no progress stream and no UI — the path an operator is LEAST able to watch, and
// therefore the one where a silent stall reproduces the original field incident inside the tool
// that exists to recover from it. Both of its composition points are asserted through a line the
// package below emits, never through the argument itself.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts";
import {
  addSourceToCapsule,
  createCapsule,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  GatewayConfig,
  OpenAIEmbeddingBatchOutcome,
  OpenAIEmbeddingBatchRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import { createLocalKnowledgeRemediationPort } from "./local-knowledge-remediation.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

const MODEL_ID = "text-embedding-3-small";
const DIMENSIONS = 1536;
const ENDPOINT = "https://gateway.example.test/v1";

const tempDirs: string[] = [];

afterEach(() => {
  localKnowledgeIndexingRegistry.reset();
  resetServerLogger();
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

function config(): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL_ID,
        baseUrl: ENDPOINT,
        apiKey: "redacted",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
      },
    ],
    capabilities: [
      {
        id: MODEL_ID,
        kind: "embedding",
        contextWindow: 8_191,
        maxOutputTokens: 0,
        toolCalling: false,
        structuredOutput: false,
        streaming: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "runtime-configured embedding endpoint",
        knownLimitations: [],
        preferredUseCases: ["Embeddings"],
      },
    ],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

// Deterministic per-input vectors: the capability probe derives an embedding-space fingerprint
// from four probe inputs, so identical vectors for different inputs would be rejected as a
// degenerate space before any indexing could start.
function vectorFor(input: string): Float32Array {
  let seed = 0;
  for (const character of input) seed = (seed * 31 + (character.codePointAt(0) ?? 0)) % 9973;
  return Float32Array.from({ length: DIMENSIONS }, (_, i) => ((seed + i) % 1000) / 1000);
}

function batchRequest(request: OpenAIEmbeddingBatchRequest): Promise<OpenAIEmbeddingBatchOutcome> {
  return Promise.resolve({
    ok: true as const,
    value: request.inputs.map((input) => ({ vector: vectorFor(input), modelId: MODEL_ID })),
  });
}

function seedCapsuleWithSource(runtimeStateDir: string, docsRoot: string): void {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir }),
  });
  const capsuleId = "cap-remediation" as KnowledgeCapsuleId;
  createCapsule(store, {
    id: capsuleId,
    displayName: "Remediation Capsule",
    tags: [],
    retrievalEffort: "default",
    outputMode: "snippets",
    answerGroundingPolicy: "require-citations",
    modelUsePolicy: standardPodModelUsePolicy(),
    embeddingModelIdentity: {
      provider: "openai",
      modelId: MODEL_ID,
      vectorDimensions: DIMENSIONS,
      vectorMetric: "cosine",
    },
    lifecycleState: "ready",
    storageReference: `capsules/${String(capsuleId)}`,
  });
  addSourceToCapsule(store, capsuleId, {
    id: "src-remediation" as KnowledgeSourceId,
    displayName: "Docs",
    tags: [],
    scope: { kind: "folder", rootPath: docsRoot, recursive: true },
  });
  store.close();
}

function seedWorkspace(): { readonly runtimeStateDir: string; readonly docsRoot: string } {
  const runtimeStateDir = mkdtempSync(join(tmpdir(), "keiko-remediation-log-"));
  tempDirs.push(runtimeStateDir);
  const docsRoot = join(runtimeStateDir, "docs");
  mkdirSync(docsRoot, { recursive: true });
  writeFileSync(join(docsRoot, "note.md"), "# Note\n\nOne remediated document.\n", "utf8");
  seedCapsuleWithSource(runtimeStateDir, docsRoot);
  return { runtimeStateDir, docsRoot };
}

function capture(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

describe("local knowledge remediation wires the process activity log", () => {
  it("puts the reindex run's embedding flush on the record", async () => {
    const { runtimeStateDir } = seedWorkspace();
    const port = createLocalKnowledgeRemediationPort({
      runtimeStateDir,
      currentConfig: () => config(),
      embeddingRequest: (request) =>
        Promise.resolve({
          ok: true as const,
          value: { vector: vectorFor(request.input), modelId: MODEL_ID },
        }),
      embeddingBatchRequest: batchRequest,
    });
    const sink = capture();

    const result = await port.reindexAll();

    expect(result.status).toBe("completed");
    // `runIndexingJob` without `logSink` writes nothing at all, so an unattended remediation
    // that stalls mid-flush leaves the same blank window as the original incident.
    const embeddingLines = sink.events.filter((event) => event.category === "embedding");
    expect(embeddingLines.length).toBeGreaterThan(0);
  });

  it("puts a rejected capability probe on the record through the real embedding transport", async () => {
    const { runtimeStateDir } = seedWorkspace();
    // No embedding seams: the port composes the REAL `requestOpenAIEmbedding`/`...Batch` pair and
    // only the transport is replaced, so every line below is written by `keiko-model-gateway`
    // and reaches the sink solely through the adapter's `log` default.
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 503 })));
    const port = createLocalKnowledgeRemediationPort({
      runtimeStateDir,
      currentConfig: () => config(),
    });
    const sink = capture();

    const result = await port.reindexAll();

    expect(result.status).toBe("failed");
    expect(
      sink.events.find((event) => event.category === "embedding" && event.status === 503),
    ).toBeDefined();
  });
});
