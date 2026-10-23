import { describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import {
  createOpenCodePromptInputsRunPort,
  openCodePromptInputs,
  type PromptInputsRun,
} from "./opencodePromptInputs.js";
import {
  OpenCodeV2HttpStatusError,
  OpenCodeV2ReceiptMismatchError,
} from "./opencodeV2HttpClient.js";
import {
  createProductionRuntimeOperationGuard,
  createProductionRuntimeTaskDispatcher,
  type ProductionRuntimeRunRecord,
} from "./productionCodingRuntimePorts.js";
import type { CodingRuntimeTaskDispatchRequest } from "./productionCodingRuntimeHost.js";

/**
 * A native `queue` / `steer` message whose HTTP acknowledgement is lost after the producer accepted it
 * must not become two productive inputs when the human retries the same request (#3897, PR #4064
 * review, ADR-0137 D10). The operator request identity (request id and revision) is bound to the
 * producer's supported `Session.Message.ID`, so a retry resends the SAME id and the producer, which
 * stores one input per id, answers with the receipt it already holds. The fake producer below models
 * exactly that contract: one stored input per id, a lost acknowledgement that arrives after the input
 * was stored, and a status refusal that stores nothing. The real producer proves the same contract in
 * `opencodeNativePromptInputs.real.test.ts`.
 */

const RUN_ID = "run-1";
const SESSION_ID = "ses_identity";

interface Post {
  readonly text: string;
  readonly id: string | undefined;
  readonly delivery: string | undefined;
}

interface Producer {
  /** The inputs the producer holds, one per message id. */
  readonly inputs: Map<string, Post>;
  readonly posts: Post[];
  /** The next post is accepted and stored, then its acknowledgement is lost in transit. */
  loseNextAcknowledgement: boolean;
  /** What the next posts fail with after the producer stored them, one per post. */
  readonly failAfterStoring: Error[];
  /** What the next posts are refused with before the producer stores anything, one per post. */
  readonly refuseBeforeStoring: Error[];
}

function producer(): Producer {
  return {
    inputs: new Map(),
    posts: [],
    loseNextAcknowledgement: false,
    failAfterStoring: [],
    refuseBeforeStoring: [],
  };
}

interface Harness {
  readonly producer: Producer;
  readonly deliver: (requestId: string, revision: number, text?: string) => ReturnType<DeliverFn>;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  /** What the dispatcher recorded for an attempt it refused, as the operator-facing diagnostic. */
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly controller: AbortController;
  inFlight: boolean;
}

type DeliverFn = NonNullable<ReturnType<typeof createProductionRuntimeTaskDispatcher>["deliver"]>;

function request(
  requestId: string,
  revision: number,
  text: string,
): CodingRuntimeTaskDispatchRequest {
  return {
    runId: RUN_ID,
    requestId,
    expectedRevision: revision,
    taskIntent: text,
    delivery: "queue",
    correlationId: "corr-0123456789",
  };
}

function harness(): Harness {
  const fake = producer();
  const state = { inFlight: true };
  const sink = createBufferedServerLogSink();
  let counter = 0;
  const run: PromptInputsRun = {
    runId: RUN_ID,
    workspaceRoot: "/work/space",
    sessionId: SESSION_ID,
    client: {
      prompt: (_sessionId, text, _signal, _display, inputs): Promise<void> => {
        const post: Post = { text, id: inputs?.id, delivery: inputs?.delivery };
        fake.posts.push(post);
        const refusal = fake.refuseBeforeStoring.shift();
        if (refusal !== undefined) return Promise.reject(refusal);
        // A post without an id is stored under an id of the producer's own making, as 2.1.4 does.
        counter += 1;
        const id = inputs?.id ?? `msg_producer_${String(counter)}`;
        if (!fake.inputs.has(id)) fake.inputs.set(id, post);
        if (fake.loseNextAcknowledgement) {
          fake.loseNextAcknowledgement = false;
          return Promise.reject(new TypeError("fetch failed"));
        }
        const failure = fake.failAfterStoring.shift();
        return failure === undefined ? Promise.resolve() : Promise.reject(failure);
      },
    },
    runtimeAdapter: { turnInFlight: (): boolean => state.inFlight },
    ready: true,
  };
  const port = createOpenCodePromptInputsRunPort({
    readyRun: (runId) => (runId === RUN_ID ? run : undefined),
    capabilities: openCodePromptInputs("native"),
    activityLog: sink,
    recordPostFailure: () => undefined,
  });
  const controller = new AbortController();
  const record: ProductionRuntimeRunRecord = {
    turnPort: {
      submitTurn: () => Promise.resolve(false),
      abortTurn: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("succeeded" as const),
      admitPromptInputs: port.admitPromptInputs,
      deliverPrompt: port.deliverPrompt,
    },
    controller,
    operationGuard: createProductionRuntimeOperationGuard(RUN_ID, () => true),
  };
  const diagnostics: ServerDiagnosticRecord[] = [];
  const dispatcher = createProductionRuntimeTaskDispatcher(new Map([[RUN_ID, record]]), {
    record: (diagnostic): void => void diagnostics.push(diagnostic),
  });
  const deliver = dispatcher.deliver;
  if (deliver === undefined) throw new Error("deliver dispatcher is unavailable");
  return {
    producer: fake,
    sink,
    diagnostics,
    controller,
    deliver: (requestId, revision, text = "also cover the empty case") =>
      deliver(request(requestId, revision, text)),
    get inFlight(): boolean {
      return state.inFlight;
    },
    set inFlight(value: boolean) {
      state.inFlight = value;
    },
  };
}

const MESSAGE_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u;

describe("a native delivery whose acknowledgement is lost after the producer accepted it", () => {
  it("is one input when the human retries the same request, never two", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;

    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: true });

    expect(h.producer.inputs.size, "the producer holds exactly one productive input").toBe(1);
    expect(h.diagnostics).toEqual([
      expect.objectContaining({ code: "stage=dispatch:reason=adapter-rejected" }),
    ]);
    expect(h.producer.posts).toHaveLength(2);
    const ids = h.producer.posts.map((post) => post.id);
    expect(ids[0]).toMatch(MESSAGE_ID);
    expect(ids[1], "the retry resends the id the first attempt carried").toBe(ids[0]);
  });

  it("refuses a third replay after the known success without sending anything", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;
    await h.deliver("req-1", 4);
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: true });

    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });
    await expect(h.deliver("req-1", 5)).resolves.toEqual({ ok: false });

    expect(h.producer.posts).toHaveLength(2);
    expect(h.producer.inputs.size).toBe(1);
  });

  it("gives distinct requests distinct, ascending ids and keeps them as distinct inputs", async () => {
    const h = harness();
    await expect(h.deliver("req-1", 4, "first")).resolves.toEqual({ ok: true });
    await expect(h.deliver("req-2", 5, "second")).resolves.toEqual({ ok: true });

    const [first = "", second = ""] = h.producer.posts.map((post) => post.id ?? "");
    expect(first).toMatch(MESSAGE_ID);
    expect(second).toMatch(MESSAGE_ID);
    expect(second > first, "a later request never sorts before an earlier one").toBe(true);
    expect(h.producer.inputs.size).toBe(2);
  });

  it("sends nothing for a retry once the turn was cancelled or settled", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });

    h.inFlight = false;
    // Admission refuses a delivery with no turn to join as the request's own fault.
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false, reason: "inputs-refused" });

    expect(h.producer.posts).toHaveLength(1);
    expect(h.producer.inputs.size).toBe(1);
  });

  it("sends nothing for a retry after the run was stopped", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });

    h.controller.abort();
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });

    expect(h.producer.posts).toHaveLength(1);
  });
  it.each([
    ["a timeout", (): Error => new DOMException("The operation timed out.", "TimeoutError")],
    ["an undeclared HTTP 502", (): Error => new OpenCodeV2HttpStatusError(502)],
    ["an unreadable acknowledgement", (): Error => new Error("opencode-v2-envelope-invalid")],
  ])("is one input when the acknowledgement is lost to %s", async (_label, failure) => {
    const h = harness();
    h.producer.failAfterStoring.push(failure());

    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: true });

    expect(h.producer.inputs.size).toBe(1);
    expect(h.producer.posts.map((post) => post.id)).toEqual(
      Array.from({ length: 2 }, () => h.producer.posts[0]?.id),
    );
  });

  it("frees the request after a refusal that stored nothing, and the retry is a clean new input", async () => {
    const h = harness();
    h.producer.refuseBeforeStoring.push(new OpenCodeV2HttpStatusError(409));

    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });
    expect(h.producer.inputs.size).toBe(0);
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: true });

    expect(h.producer.inputs.size).toBe(1);
    const [refused, retried] = h.producer.posts.map((post) => post.id);
    expect(retried, "nothing was stored under the refused id, so the retry mints its own").not.toBe(
      refused,
    );
  });

  it("keeps the request retryable through a lost acknowledgement that a later refusal followed", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;
    // The first attempt reaches the producer and is stored; the second is refused before storing.
    await h.deliver("req-1", 4);
    h.producer.refuseBeforeStoring.push(new OpenCodeV2HttpStatusError(409));
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: false });
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: true });

    expect(h.producer.inputs.size).toBe(1);
    const ids = new Set(h.producer.posts.map((post) => post.id));
    expect(ids.size, "every attempt carried the id the first one was stored under").toBe(1);
  });

  it("still resolves the retry after the revision moved on and another request was delivered", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;
    await expect(h.deliver("req-1", 4, "first message")).resolves.toEqual({ ok: false });
    // The human sends something else meanwhile; the operation advances the revision past 4.
    await expect(h.deliver("req-2", 4, "second message")).resolves.toEqual({ ok: true });
    // The client re-reads the revision and retries its original request under it.
    await expect(h.deliver("req-1", 5, "first message")).resolves.toEqual({ ok: true });

    expect(h.producer.inputs.size, "two requests, two inputs, and no third").toBe(2);
    expect([...h.producer.inputs.values()].map((post) => post.text).sort()).toEqual([
      "first message",
      "second message",
    ]);
  });

  it("refuses a stale revision and a replay of the delivered request, sending nothing", async () => {
    const h = harness();
    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: true });

    await expect(h.deliver("req-2", 4)).resolves.toEqual({ ok: false });
    await expect(h.deliver("req-2", 3)).resolves.toEqual({ ok: false });
    await expect(h.deliver("req-1", 5)).resolves.toEqual({ ok: false });

    expect(h.producer.posts).toHaveLength(1);
  });

  it("refuses an edited message under the id of an unconfirmed one instead of dropping the edit", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;
    await expect(h.deliver("req-1", 4, "the first text")).resolves.toEqual({ ok: false });

    await expect(h.deliver("req-1", 4, "an edited text")).resolves.toEqual({ ok: false });
    expect(h.producer.posts).toHaveLength(1);

    await expect(h.deliver("req-1", 4, "the first text")).resolves.toEqual({ ok: true });
    expect(h.producer.inputs.size).toBe(1);
    expect([...h.producer.inputs.values()].map((post) => post.text)).toEqual(["the first text"]);
  });

  it("settles a receipt that names another id as delivered and refuses its replay", async () => {
    const h = harness();
    h.producer.failAfterStoring.push(new OpenCodeV2ReceiptMismatchError());

    await expect(h.deliver("req-1", 4)).resolves.toEqual({ ok: true });
    await expect(h.deliver("req-1", 5)).resolves.toEqual({ ok: false });

    expect(h.producer.inputs.size).toBe(1);
  });

  it("leaves a body-free trail that joins the lost acknowledgement to the retry that resolved it", async () => {
    const h = harness();
    h.producer.loseNextAcknowledgement = true;
    await h.deliver("req-1", 4, "PRIVATE-MESSAGE-TEXT");
    await h.deliver("req-1", 4, "PRIVATE-MESSAGE-TEXT");

    const extras = h.sink.events.map((event) => (event as { extra?: unknown }).extra);
    expect(extras).toMatchObject([
      {
        runId: RUN_ID,
        outcome: "refused",
        reason: "delivery-unconfirmed",
        requestId: "req-1",
        inputBinding: "bound",
      },
      { runId: RUN_ID, outcome: "accepted", requestId: "req-1", inputBinding: "reused" },
    ]);
    const serialized = JSON.stringify(h.sink.events);
    expect(serialized).not.toContain("PRIVATE-MESSAGE-TEXT");
    expect(serialized).not.toMatch(/msg_[0-9a-f]{12}/u);
  });
});
