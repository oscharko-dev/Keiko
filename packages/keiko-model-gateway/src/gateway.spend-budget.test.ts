import { describe, expect, it, vi } from "vitest";
import { ConfigInvalidError, TransportError } from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway, type GatewaySpendReservation } from "./gateway.js";
import type {
  GatewayConfig,
  GatewayStreamChunk,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";

const config: GatewayConfig = {
  providers: [
    {
      modelId: "example-chat-model",
      baseUrl: "https://provider.example/v1",
      apiKey: "fixture",
      timeoutMs: 1000,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    },
  ],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 1000, halfOpenProbes: 1 },
};
const request = {
  modelId: "example-chat-model",
  messages: [{ role: "user" as const, content: "private prompt" }],
};
const response: NormalizedResponse = {
  modelId: request.modelId,
  content: "private reply",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: {
    requestId: "fixture",
    promptTokens: 12,
    completionTokens: 8,
    latencyMs: 1,
    costClass: "low",
  },
};

function deniedBudget(): { reserve: ReturnType<typeof vi.fn> } {
  return {
    reserve: vi.fn(() => {
      throw new ConfigInvalidError("spend-budget-exceeded");
    }),
  };
}

async function consume(stream: AsyncIterable<GatewayStreamChunk>): Promise<void> {
  for await (const chunk of stream) {
    expect(chunk.type).toBeDefined();
  }
}

describe("Gateway attempt spend admission", () => {
  it.each(["chat", "stream", "buffered-stream"])(
    "denies %s before the provider sees content",
    async (mode) => {
      const call = vi.fn(() => Promise.resolve(response));
      const callStream = vi.fn(async function* (): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        yield { type: "done" as const, response };
      });
      const adapter: ProviderAdapter = mode === "buffered-stream" ? { call } : { call, callStream };
      const spendBudget = deniedBudget();
      const gateway = new Gateway(config, { adapter, spendBudget });
      const operation =
        mode === "chat" ? gateway.chat(request) : consume(gateway.chatStream(request));
      await expect(operation).rejects.toThrow("spend-budget-exceeded");
      expect(call).not.toHaveBeenCalled();
      expect(callStream).not.toHaveBeenCalled();
      expect(spendBudget.reserve).toHaveBeenCalledOnce();
    },
  );

  it("requires another reservation before a retry can reach the provider", async () => {
    const settle = vi.fn();
    const spendBudget = {
      reserve: vi
        .fn()
        .mockReturnValueOnce({ settle })
        .mockImplementation(() => {
          throw new ConfigInvalidError("spend-budget-exceeded");
        }),
    };
    const call = vi.fn(() => Promise.reject(new TransportError("uncertain attempt")));
    const gateway = new Gateway(config, { adapter: { call }, spendBudget });
    await expect(gateway.chat(request)).rejects.toThrow("spend-budget-exceeded");
    expect(call).toHaveBeenCalledOnce();
    expect(spendBudget.reserve).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledWith(undefined);
  });

  it("settles measured successful usage exactly once", async () => {
    const settle = vi.fn();
    const gateway = new Gateway(config, {
      adapter: { call: (): Promise<NormalizedResponse> => Promise.resolve(response) },
      spendBudget: { reserve: (): GatewaySpendReservation => ({ settle }) },
    });
    await gateway.chat(request);
    expect(settle).toHaveBeenCalledExactlyOnceWith(response.usage);
  });

  it("retains the upper reservation when a stream consumer disconnects", async () => {
    const settle = vi.fn();
    const adapter: ProviderAdapter = {
      call: (): Promise<NormalizedResponse> => Promise.resolve(response),
      callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
        await Promise.resolve();
        yield { type: "delta", token: "first" };
        yield { type: "done", response };
      },
    };
    const gateway = new Gateway(config, {
      adapter,
      spendBudget: { reserve: (): GatewaySpendReservation => ({ settle }) },
    });
    const iterator = gateway.chatStream(request);
    await iterator.next();
    await iterator.return(undefined);
    expect(settle).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
