import { describe, expect, it, vi } from "vitest";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import { createDefaultChatCapability } from "./capabilities.js";
import { parseGatewayConfig } from "./config.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { ModelGatewayLogEvent } from "./observability.js";

const MODEL = "attempt-lifecycle-proof";
const REQUEST: GatewayCallRequest = {
  modelId: MODEL,
  messages: [{ role: "user", content: "Synthetic lifecycle question" }],
  maxOutputTokens: 128,
};
type AttemptReservation = NonNullable<
  ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>
>;

function providerStream(): {
  readonly response: Response;
  readonly finish: () => void;
  readonly cancelled: () => boolean;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const frame = (value: unknown): Uint8Array =>
    new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    start(value): void {
      controller = value;
      value.enqueue(frame({ choices: [{ index: 0, delta: { content: "partial" } }] }));
    },
    cancel(): void {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    finish(): void {
      controller?.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      controller?.enqueue(
        frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }),
      );
      controller?.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller?.close();
    },
    cancelled: (): boolean => cancelled,
  };
}

function fixture(): {
  readonly gateway: Gateway;
  readonly stream: ReturnType<typeof providerStream>;
  readonly admission: NonNullable<GatewayCallRequest["attemptAdmission"]>;
  readonly settle: ReturnType<typeof vi.fn<AttemptReservation["settle"]>>;
  readonly spendSettle: ReturnType<typeof vi.fn>;
  readonly reserve: ReturnType<typeof vi.fn>;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly events: ModelGatewayLogEvent[];
} {
  const stream = providerStream();
  const settle = vi.fn<AttemptReservation["settle"]>();
  const spendSettle = vi.fn();
  const reserve = vi.fn(() => ({ settle: spendSettle }));
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(stream.response));
  const events: ModelGatewayLogEvent[] = [];
  const gateway = new Gateway(
    parseGatewayConfig({
      providers: [
        {
          modelId: MODEL,
          baseUrl: "https://lifecycle.example.invalid/v1",
          apiKey: "fixture",
          timeoutMs: 30_000,
          maxRetries: 0,
          retryBaseDelayMs: 1,
        },
      ],
      capabilities: [{ ...createDefaultChatCapability(MODEL), maxOutputTokens: 1024 }],
    }),
    {
      adapter: new OpenAiAdapter({ fetchImpl, requestId: "lifecycle", costClass: "low" }),
      spendBudget: { reserve },
      log: { write: (event): void => void events.push(event) },
    },
  );
  const admission = vi.fn<NonNullable<GatewayCallRequest["attemptAdmission"]>>(() => ({ settle }));
  return { gateway, stream, admission, settle, spendSettle, reserve, fetchImpl, events };
}

describe("physical-attempt admission across real provider stream termination", () => {
  it("retains unknown output and settles once when the consumer returns before terminal usage", async () => {
    const proof = fixture();
    const iterator = proof.gateway.chatStream({ ...REQUEST, attemptAdmission: proof.admission });
    expect((await iterator.next()).value).toEqual({ type: "delta", token: "partial" });
    await iterator.return(undefined);
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(undefined, true, "unknown");
    expect(proof.spendSettle).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(proof.reserve).toHaveBeenCalledTimes(1);
    expect(proof.stream.cancelled()).toBe(true);
    expect(proof.gateway.circuitStatus(MODEL)).toMatchObject({
      consecutiveFailures: 0,
      state: "closed",
    });
    expect(proof.events.filter((event) => event.op === "gateway.stream.abandoned")).toHaveLength(1);
  });

  it("retains unknown output and settles once when the actual reader is aborted", async () => {
    const proof = fixture();
    const cancellation = new AbortController();
    const iterator = proof.gateway.chatStream({
      ...REQUEST,
      attemptAdmission: proof.admission,
      cancellationSignal: cancellation.signal,
    });
    await iterator.next();
    cancellation.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "GATEWAY_CANCELLED" });
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ promptTokens: 0, completionTokens: 0 }),
      true,
      "unknown",
    );
    expect(proof.spendSettle).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(proof.stream.cancelled()).toBe(true);
    expect(proof.gateway.circuitStatus(MODEL).consecutiveFailures).toBe(0);
    expect(proof.events.filter((event) => event.op === "gateway.stream.failed")).toHaveLength(1);
  });

  it("settles actual terminal usage and preserves healthy circuit and spend completion", async () => {
    const proof = fixture();
    proof.stream.finish();
    const chunks = [];
    for await (const chunk of proof.gateway.chatStream({
      ...REQUEST,
      attemptAdmission: proof.admission,
    }))
      chunks.push(chunk);
    expect(chunks.at(-1)?.type).toBe("done");
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ promptTokens: 2, completionTokens: 3 }),
      true,
      "observed",
    );
    expect(proof.spendSettle).toHaveBeenCalledTimes(1);
    expect(proof.gateway.circuitStatus(MODEL).consecutiveFailures).toBe(0);
    expect(proof.events.filter((event) => event.op === "gateway.stream.completed")).toHaveLength(1);
  });

  it("preserves legacy early-close cleanup when no caller hook exists", async () => {
    const proof = fixture();
    const iterator = proof.gateway.chatStream(REQUEST);
    await iterator.next();
    await iterator.return(undefined);
    expect(proof.admission).not.toHaveBeenCalled();
    expect(proof.spendSettle).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(proof.stream.cancelled()).toBe(true);
    expect(proof.gateway.circuitStatus(MODEL).consecutiveFailures).toBe(0);
  });

  it("does not reserve or dispatch when the real request is already aborted", async () => {
    const proof = fixture();
    const cancellation = new AbortController();
    cancellation.abort();
    const iterator = proof.gateway.chatStream({
      ...REQUEST,
      attemptAdmission: proof.admission,
      cancellationSignal: cancellation.signal,
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: "GATEWAY_CANCELLED" });
    expect(proof.admission).not.toHaveBeenCalled();
    expect(proof.reserve).not.toHaveBeenCalled();
    expect(proof.fetchImpl).not.toHaveBeenCalled();
    expect(proof.gateway.circuitStatus(MODEL).consecutiveFailures).toBe(0);
  });
});
