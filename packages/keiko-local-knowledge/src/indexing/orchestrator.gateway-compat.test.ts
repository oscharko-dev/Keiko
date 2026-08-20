// End-to-end proof for the second 0.3.13 field incident. The customer's self-hosted gateway
// serves SINGLE embedding inputs and fails the ARRAY, measured against their own endpoint:
//
//   {"model":…,"input":"test"}                        -> HTTP 200 in 0.21s
//   {"model":…,"input":[3 items],"encoding_format":…}  -> HTTP 400 (UnsupportedParamsError)
//   {"model":…,"input":[36 items]}                     -> HTTP 500 in 18.87s
//
// Unlike the adapter-level compat tests, this drives the REAL indexing job — discovery,
// chunking, capsule preflight, batching, vector persistence — through the REAL embedding
// adapter, with only `fetch` replaced. That ordering is the point: the capsule preflight
// embeds its probe batch through the same path, so before the scalar degradation existed the
// run died BEFORE its first document, which is exactly what the operator saw ("0 of 1
// documents, 0 of 36 vectors", no error, until they cancelled).
//
// The gateway also serves a width the capsule did not guess, so the run additionally proves
// the measured identity is adopted rather than the creation-time guess kept.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { standardPodModelUsePolicy } from "@oscharko-dev/keiko-contracts";
import {
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  type OpenAIEmbeddingAdapter,
} from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";

import { createCapsule, getCapsule } from "../capsule-lifecycle.js";
import { createDefaultParserRegistry } from "../parsers/index.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { DEFAULT_EMBEDDING, freshStore, sampleCapsuleInput } from "../_support.js";
import { folderScope, memoryFs } from "../discovery/test-support.js";
import type { KnowledgeStore } from "../store.js";

import { runIndexingJob } from "./orchestrator.js";
import { countVectorsForCapsule } from "./vector-persist.js";
import { deterministicVector } from "./_support.js";
import type { IndexingEvent } from "./types.js";

const ROOT = "/srv/gateway-compat";
const CAPSULE_ID = "cap-gateway-compat" as KnowledgeCapsuleId;
const SOURCE_ID = "src-gateway-compat" as KnowledgeSourceId;
// Deliberately not a real model name: the behaviour under test is the gateway's, and no
// heuristic may be able to shortcut it.
const MODEL_ID = "beliebiges-embedding-modell";
const SERVED_DIMENSIONS = 1024;
// What the capsule is created with. Not the width this gateway serves.
const GUESSED_DIMENSIONS = 1536;

// The strict-shape memo is keyed by endpoint and lives for the process, so each test needs a
// distinct one or it would inherit the previous test's learned behaviour.
let endpointCounter = 0;
function freshEndpoint(): string {
  endpointCounter += 1;
  return `https://siu.llm.intern/v${String(endpointCounter)}`;
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function embeddingResponse(input: string, model: string): Response {
  return jsonResponse(
    {
      data: [{ embedding: Array.from(deterministicVector(input, SERVED_DIMENSIONS)) }],
      model,
    },
    200,
  );
}

// Serves one input, fails an array — the customer's gateway.
function customerGatewayFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    if ("encoding_format" in body) {
      return Promise.resolve(
        jsonResponse({ error: { message: "litellm.UnsupportedParamsError" } }, 400),
      );
    }
    if (Array.isArray(body.input)) {
      return Promise.resolve(jsonResponse({ error: { message: "internal error" } }, 500));
    }
    return Promise.resolve(embeddingResponse(String(body.input), String(body.model)));
  });
}

function adapterOver(fetchImpl: typeof fetch, endpoint: string): OpenAIEmbeddingAdapter {
  return {
    endpoint,
    apiKey: "k",
    request: (request) => requestOpenAIEmbedding({ ...request, fetchImpl }),
    requestBatch: (request) => requestOpenAIEmbeddingBatch({ ...request, fetchImpl }),
  };
}

// No embedding-space fingerprint and no vectors yet: the capsule identity is provisional, so
// the run is allowed to adopt whatever the gateway actually serves.
function provisionalIdentity(): EmbeddingModelIdentity {
  return {
    provider: DEFAULT_EMBEDDING.provider,
    modelId: MODEL_ID,
    vectorDimensions: GUESSED_DIMENSIONS,
    vectorMetric: DEFAULT_EMBEDDING.vectorMetric,
    normalization: DEFAULT_EMBEDDING.normalization ?? "l2",
    instructionVersion: DEFAULT_EMBEDDING.instructionVersion ?? "keiko-embedding-input-v1",
  };
}

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly fs: WorkspaceFs;
}

function buildFixture(): Fixture {
  const { store, cleanup } = freshStore();
  createCapsule(
    store,
    sampleCapsuleInput({
      id: CAPSULE_ID,
      embeddingModelIdentity: provisionalIdentity(),
      modelUsePolicy: standardPodModelUsePolicy(),
    }),
  );
  addSourceToCapsule(store, CAPSULE_ID, {
    id: SOURCE_ID,
    displayName: "gateway-compat",
    tags: [],
    scope: folderScope(ROOT, { recursive: true }),
  });
  const fs = memoryFs(ROOT, [
    {
      relativePath: "fachkonzept.md",
      content: "Girokonto und Zahlungsverkehr, Abschnitt zur Kontofuehrung. ".repeat(400),
    },
  ]);
  return { store, cleanup, fs };
}

async function drain(stream: AsyncIterable<IndexingEvent>): Promise<readonly IndexingEvent[]> {
  const out: IndexingEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

function runAgainst(fixture: Fixture, fetchImpl: typeof fetch): Promise<readonly IndexingEvent[]> {
  return drain(
    runIndexingJob({
      capsuleId: CAPSULE_ID,
      parserRegistry: createDefaultParserRegistry(),
      workspaceFs: fixture.fs,
      embeddingAdapter: adapterOver(fetchImpl, freshEndpoint()),
      store: fixture.store,
    }),
  );
}

function bodiesOf(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown>[] {
  return fetchImpl.mock.calls.map((call) => {
    const init = call[1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  });
}

describe("indexing against a gateway that serves single inputs and fails arrays", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("completes the run and persists vectors", async () => {
    const fetchImpl = customerGatewayFetch();
    const events = await runAgainst(fixture, fetchImpl);

    expect(countVectorsForCapsule(fixture.store._internal.db, CAPSULE_ID)).toBeGreaterThan(0);
    const completed = events.find((evt) => evt.kind === "job-completed");
    expect(completed?.kind).toBe("job-completed");
    if (completed?.kind !== "job-completed") return;
    expect(completed.result.status).toBe("succeeded");
    expect(completed.result.vectorsPersisted).toBeGreaterThan(0);
    expect(completed.result.processedDocuments).toBe(1);
  });

  it("adopts the width the gateway actually serves instead of the creation-time guess", async () => {
    await runAgainst(fixture, customerGatewayFetch());

    const identity = getCapsule(fixture.store, CAPSULE_ID)?.embeddingModelIdentity;
    expect(identity?.vectorDimensions).toBe(SERVED_DIMENSIONS);
    expect(identity?.embeddingSpaceFingerprint).toBeDefined();
  });

  it("stops sending arrays once the gateway has failed one", async () => {
    const fetchImpl = customerGatewayFetch();
    await runAgainst(fixture, fetchImpl);

    const bodies = bodiesOf(fetchImpl);
    const arrayAttempts = bodies.filter((body) => Array.isArray(body.input));
    const scalarCalls = bodies.filter((body) => typeof body.input === "string");
    // The gateway is discovered to be array-hostile once, not re-discovered per batch, and
    // every embedding the run persisted came through a single-input request.
    expect(arrayAttempts.length).toBeLessThanOrEqual(2);
    expect(scalarCalls.length).toBeGreaterThan(0);
  });
});
