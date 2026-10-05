import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLogEventRegistration } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { createFileServerLogSink, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  resetStrictGatewayMemoForTests,
} from "../packages/keiko-model-gateway/src/openai-embedding-adapter.js";
import type { ModelGatewayLogEvent } from "../packages/keiko-model-gateway/src/observability.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  runSupportQuery,
  type SupportQueryResult,
} from "../packages/keiko-activity-log/src/reader/support-query.js";
import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
} from "../packages/keiko-activity-log/src/reader/support-segment-scan.js";

const CONFIG = {
  endpoint: "https://embedding-query.example/v1",
  apiKey: "synthetic-query-key",
  modelId: "embedding-query-model",
};
const ITEM = "embedding.scalar-ladder.item-completed";

function response(status: number, count = 1): Response {
  return new Response(
    JSON.stringify({
      model: CONFIG.modelId,
      data: Array.from({ length: count }, (_, index) => ({ index, embedding: [0.1, 0.2] })),
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function scriptedFetch(replies: readonly (() => Response)[]): typeof fetch {
  let next = 0;
  return (): Promise<Response> => {
    const reply = replies[next];
    next += 1;
    if (reply === undefined) throw new RangeError("Embedding query fixture transport exhausted");
    return Promise.resolve(reply());
  };
}

async function batch(
  inputs: readonly string[],
  replies: readonly (() => Response)[],
): Promise<{
  readonly events: readonly ModelGatewayLogEvent[];
  readonly outcome: Awaited<ReturnType<typeof requestOpenAIEmbeddingBatch>>;
}> {
  const events: ModelGatewayLogEvent[] = [];
  const outcome = await requestOpenAIEmbeddingBatch({
    ...CONFIG,
    inputs,
    fetchImpl: scriptedFetch(replies),
    log: {
      write: (event): void => {
        events.push(event);
      },
    },
    logContext: { correlationId: "embedding-query-fixture" },
  });
  return { events, outcome };
}

async function shortenedItems(): ReturnType<typeof batch> {
  await batch(
    ["x".repeat(3000)],
    [
      (): Response => response(500),
      (): Response => response(500),
      (): Response => response(200),
      (): Response => response(500),
    ],
  );
  return await batch(
    ["y".repeat(3000), "z"],
    [(): Response => response(500), (): Response => response(200), (): Response => response(200)],
  );
}

function query(stateDir: string): SupportQueryResult {
  const files = listActivityLogStoreFiles(stateDir);
  const scanner = new ActivityLogScanner(stateDir);
  const pass = ensureSegmentManifests(stateDir, files, scanner, {
    trigger: "query",
    persist: false,
    rebuild: false,
  });
  return runSupportQuery({
    files,
    scanner,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    selection: {
      kind: "closure",
      queryClass: "incident",
      roots: [],
      windows: [{ fromMs: 0, toMs: Date.now() + 1000 }],
      requiredClasses: { kind: "observed-failures" },
      unresolved: false,
    },
    limits: { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxContextEvents: 0 },
  });
}

describe("manual support selection of actual embedding compatibility producers", () => {
  let stateDir: string;
  let sink: ServerLogSink;
  beforeEach(async () => {
    resetStrictGatewayMemoForTests();
    stateDir = mkdtempSync(join(tmpdir(), "keiko-support-embedding-selection-"));
    sink = createFileServerLogSink(stateDir, { level: "debug" });
    // Initialize the real writer without attributing its readiness to the later request.
    await requestOpenAIEmbedding({
      ...CONFIG,
      input: "writer bootstrap",
      fetchImpl: scriptedFetch([(): Response => response(200)]),
      log: sink,
    });
  });
  afterEach(() => {
    sink.close?.();
    rmSync(stateDir, { recursive: true, force: true });
    resetStrictGatewayMemoForTests();
  });

  function selected(events: readonly ModelGatewayLogEvent[]): SupportQueryResult["events"] {
    for (const event of events) sink.write(event);
    sink.flush?.();
    return query(stateDir).events;
  }

  it("declares actual learned-limit shortening without changing successful unshortened items", async () => {
    const { events, outcome } = await shortenedItems();
    expect(outcome.ok).toBe(true);
    const items = events.filter((event) => event.op === ITEM);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      level: "info",
      extra: {
        inputChars: 3000,
        sentChars: 1500,
        truncated: true,
        completeness: "complete",
        loss: "none",
      },
    });
    expect(items[0]?.errorKind).toBeUndefined();
    expect(items[1]?.extra).toMatchObject({ inputChars: 1, sentChars: 1 });
    expect(items[1]?.extra?.truncated).toBeUndefined();
    expect(activityLogEventRegistration(items[0] ?? {})).toMatchObject({
      causal: "none",
      diagnosticWhen: [{ field: "truncated", values: [true] }],
    });
  });

  it("retains only the actually shortened noncausal item when optional context is exhausted", async () => {
    const { events } = await shortenedItems();
    const items = selected(events).filter((event) => event.parsed.view.op === ITEM);
    expect(items).toHaveLength(1);
    expect(items[0]?.parsed.view.extra).toMatchObject({
      inputChars: 3000,
      sentChars: 1500,
      truncated: true,
    });
  });

  it("keeps actual full-input ladder successes optional while retaining existing degradation warnings", async () => {
    const { events, outcome } = await batch(
      ["one", "two"],
      [(): Response => response(500), (): Response => response(200), (): Response => response(200)],
    );
    expect(outcome.ok).toBe(true);
    const items = events.filter((event) => event.op === ITEM);
    expect(items).toHaveLength(2);
    expect(items.every((event) => event.extra?.truncated === undefined)).toBe(true);
    const ops = selected(events).map((event) => event.parsed.view.op);
    expect(ops).toContain("embedding.batch.degrading-to-scalar");
    expect(ops).toContain("embedding.batch.degraded-to-scalar");
    expect(ops).not.toContain(ITEM);
    expect(ops).not.toContain("embedding.scalar-ladder.completed");
    expect(ops).not.toContain("embedding.batch.dispatch");
    expect(ops).not.toContain("embedding.request.dispatch");
  });

  it("treats an already known scalar mode as recovery metadata rather than a new failure", async () => {
    await batch(
      ["one", "two"],
      [(): Response => response(500), (): Response => response(200), (): Response => response(200)],
    );
    const { events, outcome } = await batch(
      ["three", "four"],
      [(): Response => response(200), (): Response => response(200)],
    );
    expect(outcome.ok).toBe(true);
    expect(events.some((event) => event.op === "embedding.batch.scalar-memo-hit")).toBe(true);
    expect(selected(events).some((event) => event.parsed.view.category === "embedding")).toBe(
      false,
    );
  });

  it("retains the actual scalar shape refusal and leaves successful dispatch metadata optional", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const outcome = await requestOpenAIEmbedding({
      ...CONFIG,
      input: "scalar document",
      fetchImpl: scriptedFetch([(): Response => response(400), (): Response => response(200)]),
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
    });
    expect(outcome.ok).toBe(true);
    const ops = selected(events).map((event) => event.parsed.view.op);
    expect(ops).toContain("embedding.request.minimal-shape-retry");
    expect(ops).not.toContain("embedding.request.dispatch");
    expect(ops).not.toContain("embedding.endpoint.strict-shape-memoized");
  });

  it("retains the actual batch shape refusal without promoting healthy batch counts", async () => {
    const { events, outcome } = await batch(
      ["one", "two"],
      [(): Response => response(400), (): Response => response(200, 2)],
    );
    expect(outcome.ok).toBe(true);
    const ops = selected(events).map((event) => event.parsed.view.op);
    expect(ops).toContain("embedding.batch.minimal-shape-retry");
    expect(ops).not.toContain("embedding.batch.dispatch");
  });

  it("retains actual mid-ladder failure evidence with its completed-prefix count", async () => {
    const { events, outcome } = await batch(
      ["one", "two"],
      [(): Response => response(500), (): Response => response(200), (): Response => response(401)],
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new TypeError("Expected a failed second ladder item");
    expect(outcome.partial).toHaveLength(1);
    const result = selected(events);
    const failure = result.find(
      (event) => event.parsed.view.op === "embedding.scalar-ladder.item-failed",
    );
    expect(failure?.parsed.view.extra).toMatchObject({ total: 2, completed: 1 });
    expect(result.some((event) => event.parsed.view.op === ITEM)).toBe(false);
  });
});
