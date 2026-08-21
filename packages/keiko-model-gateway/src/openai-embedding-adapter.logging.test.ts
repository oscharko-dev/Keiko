// Activity-log coverage for the embedding compatibility ladder. Every rung here is a SILENT
// degradation in production — the caller sees a success or a generic failure either way — so the
// line naming the rung is the only operator-visible evidence that the fast path was abandoned.
//
// Hermetic: `fetchImpl` is injected on every request, so no socket is opened, no DNS is resolved
// and no proxy is consulted. The two module-level memos are process-global, so each case uses a
// UNIQUE endpoint host and `resetStrictGatewayMemoForTests` runs in afterEach.

import { afterEach, describe, expect, it } from "vitest";
import {
  requestOpenAIEmbedding,
  requestOpenAIEmbeddingBatch,
  resetStrictGatewayMemoForTests,
} from "./openai-embedding-adapter.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";

interface Recorder {
  readonly sink: ModelGatewayLogSink;
  readonly events: ModelGatewayLogEvent[];
}

function recorder(): Recorder {
  const events: ModelGatewayLogEvent[] = [];
  return {
    events,
    sink: {
      write(event: ModelGatewayLogEvent): void {
        events.push(event);
      },
    },
  };
}

function ops(events: readonly ModelGatewayLogEvent[]): readonly string[] {
  return events.map((event) => event.op);
}

function embeddingOps(events: readonly ModelGatewayLogEvent[]): readonly string[] {
  return events.filter((event) => event.category === "embedding").map((event) => event.op);
}

function eventFor(events: readonly ModelGatewayLogEvent[], op: string): ModelGatewayLogEvent {
  const found = events.find((event) => event.op === op);
  if (found === undefined) {
    throw new Error(`expected an event with op '${op}', saw: ${ops(events).join(", ")}`);
  }
  return found;
}

let hostCounter = 0;
function uniqueEndpoint(): string {
  hostCounter += 1;
  return `https://gw-${String(hostCounter)}.example/v1`;
}

function scalarBody(): string {
  return JSON.stringify({ model: "embed-1", data: [{ index: 0, embedding: [0.1, 0.2] }] });
}

function batchBody(count: number): string {
  return JSON.stringify({
    model: "embed-1",
    data: Array.from({ length: count }, (_unused, index) => ({
      index,
      embedding: [0.1, 0.2],
    })),
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

// A transport that answers each successive call from a scripted queue, so a whole ladder run is
// deterministic without any timing dependence. Exhaustion THROWS rather than repeating the last
// response: a fixture that repeats would let an unintended extra round-trip on the compatibility
// ladder pass unnoticed, which is precisely what these cases exist to pin.
function scriptedFetch(responses: readonly (() => Response)[]): {
  readonly fetchImpl: typeof fetch;
  readonly calls: () => number;
} {
  let index = 0;
  return {
    calls: (): number => index,
    fetchImpl: (): Promise<Response> => {
      const next = responses[index];
      index += 1;
      if (next === undefined) {
        throw new Error(`scripted transport exhausted after ${String(responses.length)} calls`);
      }
      return Promise.resolve(next());
    },
  };
}

// A transport that ACCEPTS a request and never answers it — the wedge the whole attempt-line
// change exists for. `entered` settles the moment the request is in flight, so a case can assert
// on the log at exactly that point without polling, sleeping, or depending on turn ordering;
// `answer` releases it so nothing is left pending when the case ends. `precedingResponses` are
// served in order first, for the rungs that must run before the wedge is reached.
function wedgedTransport(precedingResponses: readonly (() => Response)[] = []): {
  readonly fetchImpl: typeof fetch;
  readonly entered: Promise<void>;
  answer: (response: Response) => void;
} {
  let served = 0;
  let release: (response: Response) => void = () => undefined;
  let signalEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const handle: {
    readonly fetchImpl: typeof fetch;
    readonly entered: Promise<void>;
    answer: (response: Response) => void;
  } = {
    entered,
    answer: (response): void => {
      release(response);
    },
    fetchImpl: (): Promise<Response> => {
      const preceding = precedingResponses[served];
      served += 1;
      if (preceding !== undefined) {
        return Promise.resolve(preceding());
      }
      return new Promise<Response>((resolve) => {
        release = resolve;
        signalEntered();
      });
    },
  };
  return handle;
}

const BASE = { apiKey: "test-key", modelId: "embed-1" } as const;

afterEach(() => {
  resetStrictGatewayMemoForTests();
});

describe("scalar embedding — activity log", () => {
  it("names the minimal-shape retry and the memo it installs", async () => {
    const log = recorder();
    const endpoint = uniqueEndpoint();
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 400),
      (): Response => jsonResponse(scalarBody()),
    ]);
    const outcome = await requestOpenAIEmbedding({
      ...BASE,
      endpoint,
      input: "some private document text",
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(true);
    // One attempt line per outbound call, each ahead of the outcome it belongs to: the first
    // attempt, its rejection, the retry's attempt, and the memo the retry installed.
    expect(embeddingOps(log.events)).toEqual([
      "embedding.request.dispatch",
      "embedding.request.minimal-shape-retry",
      "embedding.request.dispatch",
      "embedding.endpoint.strict-shape-memoized",
    ]);
    const retry = eventFor(log.events, "embedding.request.minimal-shape-retry");
    expect(retry.level).toBe("warn");
    expect(retry.status).toBe(400);
    expect(retry.extra).toMatchObject({ reason: "strict-gateway-rejection" });
    // The endpoint is reduced to scheme://host — never the /embeddings path, never the input.
    expect(retry.extra?.endpoint).toBe(new URL(endpoint).origin);
    expect(JSON.stringify(log.events)).not.toContain("some private document text");
  });

  it("labels an answered HTTP failure with its status and classified kind", async () => {
    const log = recorder();
    const transport = scriptedFetch([(): Response => jsonResponse("{}", 401)]);
    const outcome = await requestOpenAIEmbedding({
      ...BASE,
      endpoint: uniqueEndpoint(),
      input: "x",
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(false);
    const failed = eventFor(log.events, "embedding.request.failed");
    expect(failed.status).toBe(401);
    expect(failed.errorKind).toBe("wrong-header");
    expect(failed.extra).toMatchObject({ minimalShape: false });
  });

  // THE INCIDENT, at scalar scale. Before the attempt line, a clean success wrote nothing and a
  // request that never returned ALSO wrote nothing — the two were indistinguishable in the log,
  // which is precisely why a six-minute wall produced no evidence. A success now leaves exactly
  // one line, and it is written before the call rather than after it.
  it("writes the attempt line on a clean first-try success, and only that", async () => {
    const log = recorder();
    const endpoint = uniqueEndpoint();
    const transport = scriptedFetch([(): Response => jsonResponse(scalarBody())]);
    await requestOpenAIEmbedding({
      ...BASE,
      endpoint,
      input: "some private document text",
      timeoutMs: 12_000,
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(embeddingOps(log.events)).toEqual(["embedding.request.dispatch"]);
    const dispatch = eventFor(log.events, "embedding.request.dispatch");
    expect(dispatch.level).toBe("info");
    expect(dispatch.extra).toMatchObject({
      endpoint: new URL(endpoint).origin,
      modelId: "embed-1",
      inputCount: 1,
      timeoutMs: 12_000,
      minimalShape: false,
    });
    expect(typeof dispatch.extra?.bodyBytes).toBe("number");
    expect(JSON.stringify(log.events)).not.toContain("some private document text");
  });

  // The ordering proof. A line written after the call returns cannot describe a call that never
  // returns, so "before" is the entire property — assert it from INSIDE the transport, where the
  // request is in flight and no outcome exists yet.
  it("has already written the attempt line by the time the transport is entered", async () => {
    const log = recorder();
    let opsAtDispatch: readonly string[] = ["<transport never entered>"];
    const observing: typeof fetch = (): Promise<Response> => {
      opsAtDispatch = embeddingOps(log.events);
      return Promise.resolve(jsonResponse(scalarBody()));
    };
    await requestOpenAIEmbedding({
      ...BASE,
      endpoint: uniqueEndpoint(),
      input: "x",
      fetchImpl: observing,
      log: log.sink,
    });
    expect(opsAtDispatch).toEqual(["embedding.request.dispatch"]);
  });

  // The wedge itself: a gateway that accepts the request and never answers. The attempt line must
  // be readable WHILE the call is still in flight — that is the whole difference between a
  // diagnosable hang and six minutes of nothing. Hermetic: the transport is settled by hand at
  // the end of the case, so nothing sleeps and nothing is left pending.
  it("leaves the attempt line readable while a request that never returns is in flight", async () => {
    const log = recorder();
    const wedge = wedgedTransport();
    const pending = requestOpenAIEmbedding({
      ...BASE,
      endpoint: uniqueEndpoint(),
      input: "x",
      fetchImpl: wedge.fetchImpl,
      log: log.sink,
    });
    await wedge.entered;
    expect(embeddingOps(log.events)).toEqual(["embedding.request.dispatch"]);
    wedge.answer(jsonResponse(scalarBody()));
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});

describe("batch embedding — activity log", () => {
  it("records the array-shape degradation, the scalar probe, and the memo it installs", async () => {
    const log = recorder();
    const endpoint = uniqueEndpoint();
    // The 0.3.13 field shape: the array answers 500, each item answers 200 on its own.
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
    ]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint,
      inputs: ["chunk one text", "chunk two text"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(true);
    const seen = embeddingOps(log.events);
    expect(seen).toContain("embedding.batch.degrading-to-scalar");
    expect(seen).toContain("embedding.scalar-ladder.completed");
    expect(seen).toContain("embedding.batch.degraded-to-scalar");

    const degrading = eventFor(log.events, "embedding.batch.degrading-to-scalar");
    expect(degrading.level).toBe("warn");
    expect(degrading.status).toBe(500);
    expect(degrading.errorKind).toBe("http-error");
    expect(degrading.extra).toMatchObject({ inputCount: 2 });

    const degraded = eventFor(log.events, "embedding.batch.degraded-to-scalar");
    expect(degraded.extra).toMatchObject({ inputCount: 2, memoized: true, embedded: 2 });
    expect(JSON.stringify(log.events)).not.toContain("chunk one text");
  });

  it("reports the memo hit on the next batch, so the throughput cliff is attributable", async () => {
    const endpoint = uniqueEndpoint();
    const first = recorder();
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint,
      inputs: ["a", "b"],
      fetchImpl: scriptedFetch([
        (): Response => jsonResponse("{}", 500),
        (): Response => jsonResponse(scalarBody()),
        (): Response => jsonResponse(scalarBody()),
      ]).fetchImpl,
      log: first.sink,
    });
    const second = recorder();
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint,
      inputs: ["c", "d"],
      // The memo hit IS the throughput cliff: two inputs now cost two round-trips, so the script
      // lists both. One entry would only have passed while the transport repeated its last answer.
      fetchImpl: scriptedFetch([
        (): Response => jsonResponse(scalarBody()),
        (): Response => jsonResponse(scalarBody()),
      ]).fetchImpl,
      log: second.sink,
    });
    const memo = eventFor(second.events, "embedding.batch.scalar-memo-hit");
    expect(memo.level).toBe("info");
    expect(memo.extra).toMatchObject({ inputCount: 2 });
    expect(embeddingOps(second.events)).not.toContain("embedding.batch.dispatch");
  });

  it("does NOT memoize a throttled batch and says so on the line", async () => {
    const log = recorder();
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 429),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
    ]);
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    const degraded = eventFor(log.events, "embedding.batch.degraded-to-scalar");
    expect(degraded.errorKind).toBe("rate-limited");
    expect(degraded.extra).toMatchObject({ memoized: false });
  });

  it("names why the scalar probe was skipped for a single-item batch", async () => {
    const log = recorder();
    const transport = scriptedFetch([(): Response => jsonResponse("{}", 500)]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["only one"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(false);
    const skipped = eventFor(log.events, "embedding.batch.degrade-skipped");
    expect(skipped.level).toBe("warn");
    expect(skipped.status).toBe(500);
    expect(skipped.extra).toMatchObject({ reason: "single-item-batch", inputCount: 1 });
    expect(embeddingOps(log.events)).not.toContain("embedding.batch.degrading-to-scalar");
  });

  it("reports a caller-aborted batch as such rather than probing N more times", async () => {
    const log = recorder();
    const controller = new AbortController();
    const transport = scriptedFetch([
      (): Response => {
        controller.abort();
        return jsonResponse("{}", 500);
      },
    ]);
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b", "c"],
      signal: controller.signal,
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(eventFor(log.events, "embedding.batch.degrade-skipped").extra).toMatchObject({
      reason: "caller-aborted",
    });
  });

  it("keeps the degradation inconclusive — and says so — when the scalar probe fails too", async () => {
    const log = recorder();
    // Both round-trips are scripted: the array attempt AND the single-item scalar probe that
    // follows it, so the probe fails on an ANSWERED 500 rather than on an exhausted transport.
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse("{}", 500),
    ]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(false);
    const inconclusive = eventFor(log.events, "embedding.batch.degrade-inconclusive");
    expect(inconclusive.extra).toMatchObject({ reason: "scalar-probe-also-failed" });
    expect(embeddingOps(log.events)).not.toContain("embedding.batch.degraded-to-scalar");
  });

  // BOTH strict-rejection rungs reach the same decision — "this endpoint rejects the ARRAY shape
  // itself" — and both must report it identically: the memo key, the reason label and the event
  // fields are one fail-safe rule, and an operator reading `embedding.batch.array-unsupported`
  // must not have to know which rung produced it. This pins the two against each other so a change
  // applied to only one of them fails here instead of shipping two dialects of the same line.
  it("reports the array-unsupported decision identically from both strict-rejection rungs", async () => {
    const endpoint = uniqueEndpoint();
    // Rung one, on a not-yet-classified endpoint: extras rejected, minimal array rejected too.
    const viaMinimalRetry = recorder();
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint,
      inputs: ["a"],
      fetchImpl: scriptedFetch([
        (): Response => jsonResponse("{}", 400),
        (): Response => jsonResponse("{}", 400),
        (): Response => jsonResponse(scalarBody()),
      ]).fetchImpl,
      log: viaMinimalRetry.sink,
    });

    // Rung two, on an endpoint already known to need the minimal shape: the array it sends first
    // is already minimal, so the rejection lands on the other branch.
    resetStrictGatewayMemoForTests();
    const strictEndpoint = uniqueEndpoint();
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: strictEndpoint,
      inputs: ["a"],
      fetchImpl: scriptedFetch([
        (): Response => jsonResponse("{}", 400),
        (): Response => jsonResponse(batchBody(1)),
      ]).fetchImpl,
      log: recorder().sink,
    });
    const viaStrictMemo = recorder();
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: strictEndpoint,
      inputs: ["a"],
      fetchImpl: scriptedFetch([
        (): Response => jsonResponse("{}", 400),
        (): Response => jsonResponse(scalarBody()),
      ]).fetchImpl,
      log: viaStrictMemo.sink,
    });

    const fromRetry = eventFor(viaMinimalRetry.events, "embedding.batch.array-unsupported");
    const fromMemo = eventFor(viaStrictMemo.events, "embedding.batch.array-unsupported");
    expect(fromRetry.extra).toMatchObject({
      inputCount: 1,
      memoized: true,
      reason: "minimal-array-rejected",
    });
    expect(fromMemo.level).toBe(fromRetry.level);
    expect(fromMemo.status).toBe(fromRetry.status);
    expect(Object.keys(fromMemo.extra ?? {}).sort()).toEqual(
      Object.keys(fromRetry.extra ?? {}).sort(),
    );
    expect({ ...fromMemo.extra, endpoint: undefined }).toEqual({
      ...fromRetry.extra,
      endpoint: undefined,
    });
    // The host is the one field that legitimately differs — and it is a HOST, never the path.
    expect(fromMemo.extra?.endpoint).toBe(new URL(strictEndpoint).origin);
    expect(fromRetry.extra?.endpoint).toBe(new URL(endpoint).origin);
  });

  it("names which structural check rejected a malformed body", async () => {
    const log = recorder();
    const transport = scriptedFetch([(): Response => jsonResponse(batchBody(1))]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(false);
    expect(eventFor(log.events, "embedding.batch.invalid-response").extra).toMatchObject({
      reason: "item-count-mismatch",
      inputCount: 2,
    });
  });

  it("carries the completed prefix on a mid-ladder item failure", async () => {
    const log = recorder();
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse("{}", 503),
      (): Response => jsonResponse("{}", 503),
    ]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(false);
    const stop = eventFor(log.events, "embedding.scalar-ladder.item-failed");
    expect(stop.level).toBe("warn");
    expect(stop.extra).toMatchObject({ completed: 1, total: 2 });
  });

  it("writes only the attempt line on a clean batch — no degradation noise", async () => {
    const log = recorder();
    const transport = scriptedFetch([(): Response => jsonResponse(batchBody(2))]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      timeoutMs: 9_000,
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(true);
    expect(embeddingOps(log.events)).toEqual(["embedding.batch.dispatch"]);
    const dispatch = eventFor(log.events, "embedding.batch.dispatch");
    // `info`, not `debug`: the default threshold is `info`, so a `debug` attempt line is dropped
    // by the sink and the log is empty for exactly the window the operator is looking at.
    expect(dispatch.level).toBe("info");
    expect(dispatch.extra).toMatchObject({
      inputCount: 2,
      minimalShape: false,
      modelId: "embed-1",
      timeoutMs: 9_000,
    });
    expect(typeof dispatch.extra?.bodyBytes).toBe("number");
  });

  // The 0.3.13 shape: one array request, 36 inputs, nineteen seconds, no answer yet. The attempt
  // line names the endpoint, the item count and the deadline while the call is still running.
  it("names the array attempt — count, size and deadline — before the call is answered", async () => {
    const log = recorder();
    let opsAtDispatch: readonly string[] = ["<transport never entered>"];
    const observing: typeof fetch = (): Promise<Response> => {
      opsAtDispatch = embeddingOps(log.events);
      return Promise.resolve(jsonResponse(batchBody(3)));
    };
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b", "c"],
      fetchImpl: observing,
      log: log.sink,
    });
    expect(opsAtDispatch).toEqual(["embedding.batch.dispatch"]);
    expect(eventFor(log.events, "embedding.batch.dispatch").extra).toMatchObject({ inputCount: 3 });
  });

  // PER-ITEM PROGRESS. The ladder used to write only when it STOPPED, so the slowest path in the
  // package — N sequential round-trips against an already-degraded gateway — was silent for N
  // items, and "0 of 36 vectors" could not be told apart from a wedge. Each completed item now
  // reports its index, its size and its own duration.
  it("reports progress per item through the scalar ladder, not only at the stop", async () => {
    const log = recorder();
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
    ]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["aaa", "bbbbbb", "c"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(outcome.ok).toBe(true);
    const items = log.events.filter(
      (event) => event.op === "embedding.scalar-ladder.item-completed",
    );
    expect(items).toHaveLength(3);
    expect(items.map((event) => event.level)).toEqual(["info", "info", "info"]);
    expect(items.map((event) => event.extra?.index)).toEqual([0, 1, 2]);
    // The size is a COUNT of characters — never the item's text.
    expect(items.map((event) => event.extra?.inputChars)).toEqual([3, 6, 1]);
    expect(items.map((event) => event.extra?.total)).toEqual([3, 3, 3]);
    for (const item of items) {
      expect(typeof item.durationMs).toBe("number");
      expect(item.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(log.events)).not.toContain("bbbbbb");
  });

  // The stall case the progress lines exist for: the ladder is mid-flight on item 2 and has
  // already reported items 0 and 1, so an operator can see WHERE it stopped rather than only
  // that it did. Hermetic — the wedged item is settled by hand before the case ends.
  it("has already reported the completed items while a later item is still in flight", async () => {
    const log = recorder();
    // The array attempt fails, items 0 and 1 succeed one at a time, and item 2 wedges.
    const wedge = wedgedTransport([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
    ]);
    const pending = requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b", "c"],
      fetchImpl: wedge.fetchImpl,
      log: log.sink,
    });
    await wedge.entered;
    const reported = log.events
      .filter((event) => event.op === "embedding.scalar-ladder.item-completed")
      .map((event) => event.extra?.index);
    expect(reported).toEqual([0, 1]);
    expect(embeddingOps(log.events)).not.toContain("embedding.scalar-ladder.completed");
    wedge.answer(jsonResponse(scalarBody()));
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  // The gate from the port's side: a sink that declines `debug` must never be handed one, and
  // must still receive every `info` attempt line and `warn` degradation.
  it("skips below-threshold events entirely for a level-gated sink", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const gated: ModelGatewayLogSink = {
      write: (event): void => {
        events.push(event);
      },
      enabled: (level): boolean => level !== "debug",
    };
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
    ]);
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      fetchImpl: transport.fetchImpl,
      log: gated,
    });
    expect(events.map((event) => event.level)).not.toContain("debug");
    expect(ops(events)).toContain("embedding.batch.dispatch");
    expect(ops(events)).toContain("embedding.batch.degraded-to-scalar");
  });

  // CORRELATION, across the WHOLE ladder and across the module boundary. A batch that degrades
  // fans one caller request out into a batch attempt, a scalar probe and N per-item calls, each of
  // which also produces transport lines from `http.ts`. Without one id on all of them, an operator
  // reading a file that interleaves several concurrent batches cannot tell which sequence belongs
  // to the run that is stuck — the entire question the field incident turned on.
  it("stamps the caller's correlation id on every line of a degrading batch", async () => {
    const log = recorder();
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
    ]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
      logContext: { correlationId: "pod-run-7" },
    });
    expect(outcome.ok).toBe(true);
    // Both categories are present, and not one line of either is unattributable.
    expect(log.events.map((event) => event.category)).toContain("http");
    expect(log.events.map((event) => event.category)).toContain("embedding");
    expect(log.events.map((event) => event.correlationId)).toEqual(
      log.events.map(() => "pod-run-7"),
    );
    expect(ops(log.events)).toContain("embedding.scalar-ladder.item-completed");
  });

  it("stamps it on a scalar request and on the minimal-shape rung it retries into", async () => {
    const log = recorder();
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 400),
      (): Response => jsonResponse(scalarBody()),
    ]);
    await requestOpenAIEmbedding({
      ...BASE,
      endpoint: uniqueEndpoint(),
      input: "x",
      fetchImpl: transport.fetchImpl,
      log: log.sink,
      logContext: { correlationId: "pod-run-8" },
    });
    expect(embeddingOps(log.events)).toContain("embedding.request.minimal-shape-retry");
    expect(embeddingOps(log.events)).toContain("embedding.endpoint.strict-shape-memoized");
    expect(log.events.map((event) => event.correlationId)).toEqual(
      log.events.map(() => "pod-run-8"),
    );
  });

  it("leaves every line uncorrelated when the caller supplies no context", async () => {
    const log = recorder();
    const transport = scriptedFetch([(): Response => jsonResponse(scalarBody())]);
    await requestOpenAIEmbedding({
      ...BASE,
      endpoint: uniqueEndpoint(),
      input: "x",
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    expect(log.events.map((event) => event.correlationId)).toEqual(log.events.map(() => undefined));
  });

  // BYTES on the wire, not `String.length`. An embedding body is document text, so for a CJK or
  // accented corpus the character count under-reports the request by two to four times — and this
  // field exists to be compared against the gateway's request-size limit.
  it("measures the request body in UTF-8 bytes, not UTF-16 code units", async () => {
    const log = recorder();
    const transport = scriptedFetch([(): Response => jsonResponse(batchBody(2))]);
    const inputs = ["日本語テキスト", "Grüße"] as const;
    await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: [...inputs],
      fetchImpl: transport.fetchImpl,
      log: log.sink,
    });
    const expectedBody = JSON.stringify({
      model: "embed-1",
      input: inputs,
      encoding_format: "float",
    });
    const bytes = Buffer.byteLength(expectedBody, "utf8");
    expect(expectedBody.length).toBeLessThan(bytes);
    expect(eventFor(log.events, "embedding.batch.dispatch").extra).toMatchObject({
      bodyBytes: bytes,
    });
  });

  it("stays silent — and behaviourally identical — when no sink is wired", async () => {
    const transport = scriptedFetch([
      (): Response => jsonResponse("{}", 500),
      (): Response => jsonResponse(scalarBody()),
      (): Response => jsonResponse(scalarBody()),
    ]);
    const outcome = await requestOpenAIEmbeddingBatch({
      ...BASE,
      endpoint: uniqueEndpoint(),
      inputs: ["a", "b"],
      fetchImpl: transport.fetchImpl,
    });
    expect(outcome.ok).toBe(true);
  });
});
