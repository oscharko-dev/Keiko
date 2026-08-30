// The field incident this whole log exists for: a Knowledge Pod indexing run sits at
// "0 of 1 documents, 0 of 36 vectors" for six minutes and is then cancelled. No error, no
// evidence. The instrumentation that would have explained it lives in `keiko-local-knowledge`
// (which embedding transport was chosen, every retry) and in `keiko-model-gateway` (the dispatch
// attempt, the failure kind, the HTTP status) — and both are reached ONLY through an optional
// sink the BFF has to supply. Unsupplied, every one of those lines resolves to a no-op and the
// six minutes stay blank no matter how the operator configures logging.
//
// These tests therefore never assert that an argument was passed. Each drives the real handler or
// the real exported adapter composer and asserts on a line emitted by the package UNDER the
// wiring, so removing the wiring makes them fail.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { KnowledgeCapsuleId, KnowledgeSourceId } from "@oscharko-dev/keiko-contracts";
import {
  addSourceToCapsule,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  type OcrPageResult,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  GatewayConfig,
  ModelProviderConfig,
  OpenAIEmbeddingOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import {
  awaitDetachedCapsuleIndexing,
  handleCancelLocalKnowledgeCapsuleIndexing,
  handleCreateLocalKnowledgeCapsule,
  handleStartLocalKnowledgeCapsuleIndexing,
  localKnowledgeEmbeddingAdapterForProvider,
} from "./local-knowledge-handlers.js";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogEvent,
} from "./observability/index.js";
import { createRunRegistry } from "./runs.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
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

function gatewayConfig(): GatewayConfig {
  return {
    providers: [
      {
        modelId: EMBEDDING_MODEL,
        baseUrl: ENDPOINT,
        apiKey: "redacted",
        timeoutMs: 30_000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
      },
    ],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

function embeddingProvider(): ModelProviderConfig {
  const provider = gatewayConfig().providers[0];
  if (provider === undefined) throw new Error("missing embedding provider");
  return provider;
}

// The production deps, minus the embedding seam. Tests that want a deterministic in-process
// embedding add `localKnowledgeEmbeddingRequest`; the adapter test deliberately leaves it off so
// the REAL `requestOpenAIEmbedding` transport runs.
function depsFor(tmp: string): UiHandlerDeps {
  return {
    config: gatewayConfig(),
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    uiDbPath: join(tmp, "keiko-ui.db"),
  };
}

function scalarEmbeddingDeps(tmp: string): UiHandlerDeps {
  return {
    ...depsFor(tmp),
    localKnowledgeEmbeddingRequest: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          vector: Float32Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 1000),
          modelId: EMBEDDING_MODEL,
        },
      }),
    ),
  };
}

function jsonRequest(body: Record<string, unknown>, method: string): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  req.method = method;
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return req;
}

function ctx(method: string, body: Record<string, unknown> = {}): RouteContext {
  return {
    correlationId: undefined,
    req: jsonRequest(body, method),
    res: {} as never,
    params: {},
    url: new URL("http://127.0.0.1/api/local-knowledge/capsules"),
  };
}

function capture(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

function tempWorkspace(): string {
  const tmp = mkdtempSync(join(tmpdir(), "keiko-lk-log-"));
  tempDirs.push(tmp);
  return tmp;
}

async function createCapsule(deps: UiHandlerDeps): Promise<KnowledgeCapsuleId> {
  const created = await handleCreateLocalKnowledgeCapsule(
    ctx("POST", { displayName: "Logged Pod" }),
    deps,
  );
  return (created.body as { readonly capsule: { readonly id: KnowledgeCapsuleId } }).capsule.id;
}

async function createIndexableCapsule(
  deps: UiHandlerDeps,
  tmp: string,
): Promise<KnowledgeCapsuleId> {
  const docsRoot = join(tmp, "docs");
  mkdirSync(docsRoot, { recursive: true });
  writeFileSync(join(docsRoot, "note.md"), "# Note\n\nOne indexed document.\n", "utf8");
  const capsuleId = await createCapsule(deps);
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: tmp }),
  });
  addSourceToCapsule(store, capsuleId, {
    id: "src-logged" as KnowledgeSourceId,
    displayName: "Docs",
    tags: [],
    scope: { kind: "folder", rootPath: docsRoot, recursive: true },
  });
  store.close();
  return capsuleId;
}

async function startIndexing(deps: UiHandlerDeps, capsuleId: string): Promise<RouteResult> {
  return handleStartLocalKnowledgeCapsuleIndexing({ ...ctx("POST"), params: { capsuleId } }, deps);
}

async function cancelIndexing(deps: UiHandlerDeps, capsuleId: string): Promise<RouteResult> {
  return handleCancelLocalKnowledgeCapsuleIndexing({ ...ctx("POST"), params: { capsuleId } }, deps);
}

function jobIdOf(accepted: RouteResult): string {
  const jobId = (accepted.body as { readonly jobId?: string }).jobId;
  if (jobId === undefined) throw new TypeError("the 202 body did not name a job id");
  return jobId;
}

// The op names the route writes. Named once so a rename cannot leave half the assertions passing
// against a line that no longer exists.
const START_ACCEPTED = "indexing.start.accepted";
const START_REFUSED = "indexing.start.refused";
const RUN_LAUNCHED = "indexing.detached-run.launched";
const CANCEL_REQUESTED = "indexing.cancel.requested";
const CANCEL_REFUSED = "indexing.cancel.refused";
const CANCEL_ACCEPTED = "indexing.cancel.accepted";

function lineFor(sink: BufferedServerLogSink, op: string): ServerLogEvent {
  const event = sink.events.find((candidate) => candidate.op === op);
  if (event === undefined) {
    throw new TypeError(`no activity-log line was written for ${op}`);
  }
  return event;
}

async function indexOneDocument(deps: UiHandlerDeps, tmp: string): Promise<void> {
  const capsuleId = await createIndexableCapsule(deps, tmp);
  const accepted = await startIndexing(deps, String(capsuleId));
  expect(accepted.status).toBe(202);
  await awaitDetachedCapsuleIndexing(String(capsuleId));
}

// ─── Deterministic in-flight runs ─────────────────────────────────────────────
//
// Three of the refusal paths and the interesting cancellation only exist WHILE a run is in
// flight, so the tests below have to hold one there. They do it with a gate rather than a delay:
// `hold()` announces that the run reached the seam and then blocks on a promise the test resolves.
// Awaiting `reached` is a condition, not a duration — nothing here depends on how fast anything
// runs, and no line is asserted while the run could still be somewhere else.

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  if (resolve === undefined) {
    throw new TypeError("the promise executor did not run synchronously");
  }
  return { promise, resolve };
}

interface Gate<T> {
  // Resolves once the run has entered the gated seam.
  readonly reached: Promise<void>;
  readonly release: (value: T) => void;
  readonly hold: () => Promise<T>;
}

function createGate<T>(): Gate<T> {
  const arrival = deferred<undefined>();
  const held = deferred<T>();
  return {
    reached: arrival.promise,
    release: held.resolve,
    hold: (): Promise<T> => {
      arrival.resolve(undefined);
      return held.promise;
    },
  };
}

const SCALAR_EMBEDDING: OpenAIEmbeddingOutcome = {
  ok: true,
  value: {
    vector: Float32Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 1000),
    modelId: EMBEDDING_MODEL,
  },
};

// Blocks the run at the first embedding call — AFTER the orchestrator has persisted the running
// job row, which is what makes the second POST land on `job-already-running`. This is also the
// exact state of the field incident: documents discovered, vectors at zero, nothing moving.
function embeddingGatedDeps(tmp: string, gate: Gate<OpenAIEmbeddingOutcome>): UiHandlerDeps {
  return { ...depsFor(tmp), localKnowledgeEmbeddingRequest: () => gate.hold() };
}

// Blocks the run at the OCR capability probe, which `dispatchCapsuleIndexingJob` awaits BEFORE
// the orchestrator starts the job — so the launch map holds the capsule while no job row exists
// yet, which is the only state that reaches `run-already-starting`.
function ocrGatedDeps(tmp: string, gate: Gate<OcrPageResult>): UiHandlerDeps {
  return {
    ...scalarEmbeddingDeps(tmp),
    localKnowledgeOcrAdapter: { kind: "ocr", ocrPage: () => gate.hold() },
  };
}

describe("indexing options carry the process activity log", () => {
  it("puts the orchestrator's embedding-transport choice on the record", async () => {
    const tmp = tempWorkspace();
    const deps = scalarEmbeddingDeps(tmp);
    const sink = capture();

    await indexOneDocument(deps, tmp);

    // Asserted as "the batcher wrote SOMETHING about this flush", not as one op name: the ops
    // this lane emits are owned by `keiko-local-knowledge` and will keep growing. What must never
    // regress is that the flush produces a record at all — with `logSink` dropped from the
    // options the batcher is mute and the whole embedding lane of a stuck run is unrecoverable.
    const batchLines = sink.events.filter(
      (event) => event.category === "embedding" && event.op.startsWith("embedding.batch."),
    );
    expect(batchLines.length).toBeGreaterThan(0);
  });
});

describe("the composed embedding adapter carries the process activity log", () => {
  it("records the dispatch attempt and the failure of a real gateway embedding call", async () => {
    const tmp = tempWorkspace();
    // No `localKnowledgeEmbeddingRequest`: this exercises the real `requestOpenAIEmbedding`
    // ladder, with only the transport replaced, so every line asserted below is written by
    // `keiko-model-gateway` itself.
    const adapter = localKnowledgeEmbeddingAdapterForProvider(depsFor(tmp), embeddingProvider());
    const sink = capture();

    const outcome = await adapter.request({
      endpoint: ENDPOINT,
      apiKey: "redacted",
      modelId: EMBEDDING_MODEL,
      input: "one chunk",
      fetchImpl: () =>
        Promise.resolve(
          new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
        ),
    });

    expect(outcome.ok).toBe(false);
    // Two packages' worth of lines reached the sink through ONE wired field: the embedding
    // adapter's own outcome line and, underneath it, the HTTP transport line — an operator
    // reading `server.log` sees the answered 500, not a run that merely stopped.
    expect(sink.events.map((event) => event.category)).toContain("http");
    expect(
      sink.events.find((event) => event.category === "embedding" && event.status === 500),
    ).toMatchObject({ level: "warn", errorKind: "http-error" });
  });

  it("keeps the endpoint host on the line and the api key off it", async () => {
    const tmp = tempWorkspace();
    const adapter = localKnowledgeEmbeddingAdapterForProvider(depsFor(tmp), embeddingProvider());
    const sink = capture();

    await adapter.request({
      endpoint: ENDPOINT,
      apiKey: ["sk", "secret", "value"].join("-"),
      modelId: EMBEDDING_MODEL,
      input: "one chunk",
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 500 })),
    });

    const serialised = sink.lines().join("");
    expect(serialised).toContain("https://gateway.example.test");
    expect(serialised).not.toContain(["sk", "secret", "value"].join("-"));
    expect(serialised).not.toContain("one chunk");
  });
});

// The distinction the field incident could not make. A Knowledge Pod run that shows no progress
// has three possible explanations, and until the start route wrote anything at all they looked
// identical in `server.log`: the POST was REFUSED (and which of five ways), the run was ACCEPTED
// and launched, or it was launched and then hung. Every test below drives the real handler and
// asserts on the line it emitted, so deleting the line fails the test.
describe("the start-indexing route is on the record", () => {
  it("names the minted job id and joins the 202 to the orchestrator's own lines", async () => {
    const tmp = tempWorkspace();
    const deps = scalarEmbeddingDeps(tmp);
    const capsuleId = await createIndexableCapsule(deps, tmp);
    const sink = capture();

    const accepted = await startIndexing(deps, String(capsuleId));
    expect(accepted.status).toBe(202);
    await awaitDetachedCapsuleIndexing(String(capsuleId));

    const jobId = jobIdOf(accepted);
    expect(lineFor(sink, START_ACCEPTED)).toMatchObject({
      level: "info",
      category: "indexing",
      status: 202,
      correlationId: jobId,
      extra: { jobIdMinted: true, sourceCount: 1 },
    });
    // The join, asserted against the PRODUCER rather than a restated formula: the capsule digest
    // on the route's line has to be the digest `keiko-local-knowledge` puts on the run's own
    // lines, or an operator holding the 202's job id still cannot reach the six blank minutes.
    const jobStarted = lineFor(sink, "indexing.job.started");
    expect(jobStarted.correlationId).toBe(jobId);
    expect(lineFor(sink, START_ACCEPTED).extra?.capsuleIdDigest).toBe(
      jobStarted.extra?.capsuleIdDigest,
    );
  });

  it("records the launch of the detached run under the same correlation id", async () => {
    const tmp = tempWorkspace();
    const deps = scalarEmbeddingDeps(tmp);
    const capsuleId = await createIndexableCapsule(deps, tmp);
    const sink = capture();

    const accepted = await startIndexing(deps, String(capsuleId));
    await awaitDetachedCapsuleIndexing(String(capsuleId));

    // Everything between the 202 and the orchestrator's first line — the detached store open and
    // its migrations — is only witnessed by this line. Without it a hang there is invisible.
    expect(lineFor(sink, RUN_LAUNCHED)).toMatchObject({
      level: "info",
      category: "indexing",
      correlationId: jobIdOf(accepted),
      extra: { jobIdMinted: true },
    });
    const ops = sink.events.map((event) => event.op);
    expect(ops.indexOf(RUN_LAUNCHED)).toBeGreaterThan(ops.indexOf(START_ACCEPTED));
  });

  it("keeps the raw capsule id off the route's own lines", async () => {
    const tmp = tempWorkspace();
    const deps = scalarEmbeddingDeps(tmp);
    const capsuleId = await createIndexableCapsule(deps, tmp);
    const sink = capture();

    await startIndexing(deps, String(capsuleId));
    await awaitDetachedCapsuleIndexing(String(capsuleId));

    const routeLines = sink.events.filter((event) => event.op.startsWith("indexing.start."));
    expect(routeLines.length).toBeGreaterThan(0);
    for (const line of routeLines) {
      expect(line.extra?.capsuleIdDigest).not.toBe(String(capsuleId));
      expect(line.extra?.capsuleIdDigest).toMatch(/^[0-9a-f]{16}$/u);
    }
  });
});

// Five refusals, three of which answer 409. A status number cannot tell them apart, so each one
// has to name itself — that is the whole of item 2.
describe("every refusal of a start names which refusal it was", () => {
  it("records an unknown capsule as capsule-not-found", async () => {
    const deps = scalarEmbeddingDeps(tempWorkspace());
    const sink = capture();

    const result = await startIndexing(deps, "no-such-capsule");

    expect(result.status).toBe(404);
    expect(lineFor(sink, START_REFUSED)).toMatchObject({
      level: "warn",
      category: "indexing",
      status: 404,
      extra: { reason: "capsule-not-found" },
    });
  });

  it("records a capsule with no sources as capsule-has-no-sources", async () => {
    const deps = scalarEmbeddingDeps(tempWorkspace());
    const capsuleId = await createCapsule(deps);
    const sink = capture();

    const result = await startIndexing(deps, String(capsuleId));

    expect(result.status).toBe(409);
    expect(lineFor(sink, START_REFUSED)).toMatchObject({
      status: 409,
      extra: { reason: "capsule-has-no-sources" },
    });
  });

  it("records a withdrawn embedding model as no-embedding-capable-model", async () => {
    const tmp = tempWorkspace();
    const deps = scalarEmbeddingDeps(tmp);
    const capsuleId = await createIndexableCapsule(deps, tmp);
    const sink = capture();

    // The capsule was created against a configured embedding model; the gateway configuration no
    // longer offers one. This is the refusal an operator most often mistakes for a stuck run.
    const withdrawn: UiHandlerDeps = {
      ...deps,
      config: { ...gatewayConfig(), providers: [] },
    };
    const result = await startIndexing(withdrawn, String(capsuleId));

    expect(result.status).toBe(409);
    expect(lineFor(sink, START_REFUSED)).toMatchObject({
      status: 409,
      extra: { reason: "no-embedding-capable-model" },
    });
  });

  it("records a second start against a running job as job-already-running", async () => {
    const tmp = tempWorkspace();
    const gate = createGate<OpenAIEmbeddingOutcome>();
    const deps = embeddingGatedDeps(tmp, gate);
    const capsuleId = await createIndexableCapsule(deps, tmp);
    const sink = capture();

    const first = await startIndexing(deps, String(capsuleId));
    await gate.reached;
    const second = await startIndexing(deps, String(capsuleId));
    gate.release(SCALAR_EMBEDDING);
    await awaitDetachedCapsuleIndexing(String(capsuleId));

    expect(second.status).toBe(409);
    // Correlated to the job that is BLOCKING the request, which is the operator's next question.
    expect(lineFor(sink, START_REFUSED)).toMatchObject({
      level: "warn",
      status: 409,
      correlationId: jobIdOf(first),
      extra: { reason: "job-already-running" },
    });
  });

  it("records a second start before the job row exists as run-already-starting", async () => {
    const tmp = tempWorkspace();
    const gate = createGate<OcrPageResult>();
    // The capsule is created through UN-gated deps on purpose: capsule creation probes the same
    // OCR adapter, and gating that probe would hold the setup for the probe's own 5s deadline —
    // a real wall-clock wait, in a test whose determinism has to come from the gate alone.
    const capsuleId = await createIndexableCapsule(scalarEmbeddingDeps(tmp), tmp);
    const deps = ocrGatedDeps(tmp, gate);
    const sink = capture();

    await startIndexing(deps, String(capsuleId));
    await gate.reached;
    const second = await startIndexing(deps, String(capsuleId));
    gate.release({ ok: false, reason: "ocr-not-configured" });
    await awaitDetachedCapsuleIndexing(String(capsuleId));

    expect(second.status).toBe(409);
    // The narrow window the launch map exists to close: no persisted job row yet, so this is NOT
    // `job-already-running`, and the two must never be conflated on the record.
    expect(lineFor(sink, START_REFUSED)).toMatchObject({
      status: 409,
      extra: { reason: "run-already-starting" },
    });
  });
});

// The customer in the field incident cancelled after six minutes, and the log would not have shown
// it. `indexing.job.finished` with status cancelled is written by the run when it OBSERVES the
// flag — a run wedged before that observation never writes one, which is exactly the case under
// investigation. The request line is therefore written on arrival, not on the run's reaction.
describe("cancelling an indexing run is on the record", () => {
  it("records the request and the accepted cancellation against the running job", async () => {
    const tmp = tempWorkspace();
    const gate = createGate<OpenAIEmbeddingOutcome>();
    const deps = embeddingGatedDeps(tmp, gate);
    const capsuleId = await createIndexableCapsule(deps, tmp);
    const sink = capture();

    const started = await startIndexing(deps, String(capsuleId));
    await gate.reached;
    const cancelled = await cancelIndexing(deps, String(capsuleId));
    gate.release(SCALAR_EMBEDDING);
    await awaitDetachedCapsuleIndexing(String(capsuleId));

    expect(cancelled.status).toBe(200);
    expect(lineFor(sink, CANCEL_REQUESTED)).toMatchObject({
      level: "info",
      category: "indexing",
    });
    expect(lineFor(sink, CANCEL_ACCEPTED)).toMatchObject({
      level: "warn",
      status: 200,
      correlationId: jobIdOf(started),
      extra: { cancellationRequested: true },
    });
  });

  it("records a cancellation request even when the capsule does not exist", async () => {
    const deps = scalarEmbeddingDeps(tempWorkspace());
    const sink = capture();

    const result = await cancelIndexing(deps, "no-such-capsule");

    expect(result.status).toBe(404);
    expect(lineFor(sink, CANCEL_REQUESTED)).toMatchObject({ level: "info" });
    expect(lineFor(sink, CANCEL_REFUSED)).toMatchObject({
      level: "warn",
      status: 404,
      extra: { reason: "capsule-not-found" },
    });
  });

  it("records a cancellation with nothing running as no-running-job", async () => {
    const deps = scalarEmbeddingDeps(tempWorkspace());
    const capsuleId = await createCapsule(deps);
    const sink = capture();

    const result = await cancelIndexing(deps, String(capsuleId));

    expect(result.status).toBe(409);
    expect(lineFor(sink, CANCEL_REFUSED)).toMatchObject({
      status: 409,
      extra: { reason: "no-running-job" },
    });
  });
});
