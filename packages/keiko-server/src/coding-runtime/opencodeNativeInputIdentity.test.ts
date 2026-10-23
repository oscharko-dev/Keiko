import { describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  createOpenCodePromptInputsRunPort,
  openCodePromptInputs,
  type PromptInputsRun,
} from "./opencodePromptInputs.js";
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
}

function producer(): Producer {
  return { inputs: new Map(), posts: [], loseNextAcknowledgement: false };
}

interface Harness {
  readonly producer: Producer;
  readonly deliver: (requestId: string, revision: number, text?: string) => ReturnType<DeliverFn>;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  readonly controller: AbortController;
  inFlight: boolean;
}

type DeliverFn = NonNullable<
  ReturnType<typeof createProductionRuntimeTaskDispatcher>["deliver"]
>;

function request(requestId: string, revision: number, text: string): CodingRuntimeTaskDispatchRequest {
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
        // A post without an id is stored under an id of the producer's own making, as 2.1.4 does.
        counter += 1;
        const id = inputs?.id ?? `msg_producer_${String(counter)}`;
        if (!fake.inputs.has(id)) fake.inputs.set(id, post);
        if (fake.loseNextAcknowledgement) {
          fake.loseNextAcknowledgement = false;
          return Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve();
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
  const dispatcher = createProductionRuntimeTaskDispatcher(new Map([[RUN_ID, record]]));
  const deliver = dispatcher.deliver;
  if (deliver === undefined) throw new Error("deliver dispatcher is unavailable");
  return {
    producer: fake,
    sink,
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

    const [first, second] = h.producer.posts.map((post) => post.id ?? "");
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
});
