import { describe, expect, it, vi } from "vitest";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import { createDefaultChatCapability } from "./capabilities.js";
import { parseGatewayConfig } from "./config.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type { ModelProviderConfig, NormalizedResponse, ProviderAdapter } from "./types.js";

const MODEL = "prefetch-settlement-proof";
const PROVIDER: ModelProviderConfig = {
  modelId: MODEL,
  baseUrl: "https://prefetch.example.invalid/v1",
  apiKey: "fixture",
  maxRetries: 0,
  timeoutMs: 30_000,
  retryBaseDelayMs: 1,
};
const REQUEST: GatewayCallRequest = {
  modelId: MODEL,
  messages: [{ role: "user", content: "Synthetic settlement question" }],
  maxOutputTokens: 128,
  stream: false,
};
type Reservation = NonNullable<ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>>;

function response(): Response {
  return Response.json({
    choices: [{ message: { content: "Synthetic answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
  });
}

function fixture(
  options: {
    readonly logFailure?: boolean;
    readonly spendFailure?: boolean;
    readonly invalidLimit?: boolean;
    readonly genericAdapter?: boolean;
    readonly stream?: Response;
  } = {},
): {
  readonly gateway: Gateway;
  readonly admission: NonNullable<GatewayCallRequest["attemptAdmission"]>;
  readonly settle: ReturnType<typeof vi.fn<Reservation["settle"]>>;
  readonly spendSettle: ReturnType<typeof vi.fn>;
  readonly reserve: ReturnType<typeof vi.fn>;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly adapterCall: ReturnType<typeof vi.fn<ProviderAdapter["call"]>>;
  readonly failure: Error;
} {
  const failure = new Error("Synthetic local settlement failure");
  const settle = vi.fn<Reservation["settle"]>();
  const spendSettle = vi.fn((): void => {
    if (options.spendFailure === true) throw failure;
  });
  const reserve = vi.fn(() => ({ settle: spendSettle }));
  const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(options.stream ?? response()));
  const adapterCall = vi.fn<ProviderAdapter["call"]>();
  const admission: NonNullable<GatewayCallRequest["attemptAdmission"]> = () => ({
    settle,
    ...(options.invalidLimit === true ? { maxOutputTokens: 129 } : {}),
  });
  const gateway = new Gateway(
    parseGatewayConfig({
      providers: [PROVIDER],
      capabilities: [{ ...createDefaultChatCapability(MODEL), maxOutputTokens: 1024 }],
    }),
    {
      fetchImpl,
      ...(options.genericAdapter === true ? { adapter: { call: adapterCall } } : {}),
      spendBudget: { reserve },
      log: {
        write(event: ModelGatewayLogEvent): void {
          if (options.logFailure === true && event.op === "chat.request.dispatch") throw failure;
        },
      },
    },
  );
  return { gateway, admission, settle, spendSettle, reserve, fetchImpl, adapterCall, failure };
}

function assertUndispatched(proof: ReturnType<typeof fixture>, spendCount: number): void {
  expect(proof.fetchImpl).not.toHaveBeenCalled();
  expect(proof.adapterCall).not.toHaveBeenCalled();
  expect(proof.settle).toHaveBeenCalledExactlyOnceWith(undefined, false, "none");
  expect(proof.reserve).toHaveBeenCalledTimes(spendCount);
  expect(proof.spendSettle).toHaveBeenCalledTimes(spendCount);
  expect(proof.gateway.circuitStatus(MODEL)).toMatchObject({
    consecutiveFailures: 0,
    state: "closed",
  });
}

function partialStream(): { readonly response: Response; readonly cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
      );
    },
    cancel(): void {
      cancelled = true;
    },
  });
  return { response: new Response(body), cancelled: (): boolean => cancelled };
}

describe("physical admission settlement before fetch and despite spend failure", () => {
  it("preserves buffered dispatch when the isolated log sink throws", async () => {
    const proof = fixture({ logFailure: true });
    const answer = await proof.gateway.chat({ ...REQUEST, attemptAdmission: proof.admission });
    expect(answer.content).toBe("Synthetic answer");
    expect(proof.fetchImpl).toHaveBeenCalledTimes(1);
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ promptTokens: 2, completionTokens: 3 }),
      true,
      "observed",
    );
    expect(proof.spendSettle).toHaveBeenCalledTimes(1);
  });

  it("preserves streamed dispatch when the isolated log sink throws", async () => {
    const proof = fixture({ logFailure: true });
    const iterator = proof.gateway.chatStream({
      ...REQUEST,
      stream: true,
      attemptAdmission: proof.admission,
    });
    const chunks = [];
    for await (const chunk of iterator) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: "done" });
    expect(proof.fetchImpl).toHaveBeenCalledTimes(1);
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ promptTokens: 2, completionTokens: 3 }),
      true,
      "observed",
    );
    expect(proof.spendSettle).toHaveBeenCalledTimes(1);
  });

  it("settles a direct transport admission whose cap fails HTTP preparation", async () => {
    const proof = fixture({ invalidLimit: true });
    const adapter = new OpenAiAdapter({
      requestId: "prefetch",
      costClass: "low",
      fetchImpl: proof.fetchImpl,
    });
    await expect(
      adapter.call({ ...REQUEST, attemptAdmission: proof.admission }, PROVIDER),
    ).rejects.toThrow();
    expect(proof.fetchImpl).not.toHaveBeenCalled();
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(undefined, false, "none");
  });

  it("rejects cyclic schemas during canonical token preflight before acquiring admission", async () => {
    const proof = fixture();
    const schema: Record<string, unknown> = {};
    schema.self = schema;
    const admission = vi.fn(proof.admission);
    const adapter = new OpenAiAdapter({
      requestId: "prefetch",
      costClass: "low",
      fetchImpl: proof.fetchImpl,
    });
    await expect(
      adapter.call(
        {
          ...REQUEST,
          responseFormat: { type: "json_schema", schema },
          attemptAdmission: admission,
        },
        PROVIDER,
      ),
    ).rejects.toThrow(TypeError);
    expect(admission).not.toHaveBeenCalled();
    expect(proof.fetchImpl).not.toHaveBeenCalled();
    expect(proof.settle).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "settles caller admission when its cap is invalid (generic: %s)",
    async (genericAdapter) => {
      const proof = fixture({ invalidLimit: true, genericAdapter });
      await expect(
        proof.gateway.chat({ ...REQUEST, attemptAdmission: proof.admission }),
      ).rejects.toThrow();
      assertUndispatched(proof, 0);
    },
  );

  it("settles actual observed caller usage even when durable spend settlement throws", async () => {
    const proof = fixture({ spendFailure: true });
    await expect(
      proof.gateway.chat({ ...REQUEST, attemptAdmission: proof.admission }),
    ).rejects.toThrow(proof.failure);
    expect(proof.fetchImpl).toHaveBeenCalledTimes(1);
    expect(proof.reserve).toHaveBeenCalledTimes(1);
    expect(proof.spendSettle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ promptTokens: 2, completionTokens: 3 }),
    );
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ promptTokens: 2, completionTokens: 3 }),
      true,
      "observed",
    );
  });

  it("retains unknown caller output on early close despite durable spend settlement failure", async () => {
    const stream = partialStream();
    const proof = fixture({ spendFailure: true, stream: stream.response });
    const iterator = proof.gateway.chatStream({
      ...REQUEST,
      stream: true,
      attemptAdmission: proof.admission,
    });
    expect((await iterator.next()).value).toEqual({ type: "delta", token: "partial" });
    await expect(iterator.return(undefined)).rejects.toThrow(proof.failure);
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(undefined, true, "unknown");
    expect(proof.spendSettle).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(stream.cancelled()).toBe(true);
  });

  it("keeps ordinary successful caller and spend settlement exactly once", async () => {
    const proof = fixture();
    const answer: NormalizedResponse = await proof.gateway.chat({
      ...REQUEST,
      attemptAdmission: proof.admission,
    });
    expect(answer.content).toBe("Synthetic answer");
    expect(proof.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        promptTokens: answer.usage.promptTokens,
        completionTokens: answer.usage.completionTokens,
      }),
      true,
      "observed",
    );
    expect(proof.spendSettle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        promptTokens: answer.usage.promptTokens,
        completionTokens: answer.usage.completionTokens,
      }),
    );
    expect(proof.reserve).toHaveBeenCalledTimes(1);
  });
});
