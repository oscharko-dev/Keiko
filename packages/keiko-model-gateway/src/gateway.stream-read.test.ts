// A buffered call to a route whose provider streams reads each attempt's answer over the stream
// (ADR-0003, coding run 30): the attempt's `timeoutMs` bounds the provider's silence and what is
// left of the call's budget bounds the read, so a long live generation is not cut off at
// `timeoutMs` and generated a second time.
import { describe, expect, it, vi } from "vitest";
import { TimeoutError } from "@oscharko-dev/keiko-security/errors/gateway";
import { Gateway } from "./gateway.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import { createScriptedGatewayClock } from "./replay.js";
import { providerRequestBudgetMs } from "./resilience.js";
import type {
  GatewayConfig,
  GatewayRequest,
  GatewayStreamChunk,
  ModelCapability,
  ModelProviderConfig,
  NormalizedResponse,
  ProviderAdapter,
  StreamReadBounds,
} from "./types.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture",
  timeoutMs: 30_000,
  maxRetries: 2,
  retryBaseDelayMs: 1,
};

function capability(streaming: boolean): ModelCapability {
  return {
    id: "example-chat-model",
    kind: "chat",
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "fixture",
    preferredUseCases: [],
    knownLimitations: [],
  };
}

function config(streaming: boolean): GatewayConfig {
  return {
    capabilities: [capability(streaming)],
    providers: [PROVIDER],
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1000, halfOpenProbes: 1 },
  };
}

const REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "q" }],
};

const ANSWER: NormalizedResponse = {
  modelId: "example-chat-model",
  content: "answer",
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: { requestId: "x", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
};

interface StreamingFake {
  readonly adapter: ProviderAdapter;
  readonly call: ReturnType<typeof vi.fn>;
  readonly bounds: (StreamReadBounds | undefined)[];
}

function streamingFake(failures: readonly Error[] = []): StreamingFake {
  const bounds: (StreamReadBounds | undefined)[] = [];
  const call = vi.fn(() => Promise.resolve(ANSWER));
  const pending = [...failures];
  return {
    call,
    bounds,
    adapter: {
      call,
      callStream: async function* (
        _request: GatewayRequest,
        _config: ModelProviderConfig,
        read?: StreamReadBounds,
      ): AsyncGenerator<GatewayStreamChunk> {
        bounds.push(read);
        await Promise.resolve();
        const failure = pending.shift();
        if (failure !== undefined) throw failure;
        yield { type: "delta", token: "answer" };
        yield { type: "done", response: ANSWER };
      },
    },
  };
}

function recorder(): {
  readonly events: ModelGatewayLogEvent[];
  readonly write: (event: ModelGatewayLogEvent) => void;
} {
  const events: ModelGatewayLogEvent[] = [];
  return {
    events,
    write: (event: ModelGatewayLogEvent): void => {
      events.push(event);
    },
  };
}

describe("Gateway.chat reads over the provider's stream (provider stalls, coding run 30)", () => {
  it("reads a streaming route's answer over the stream, bounded by silence and the budget", async () => {
    const fake = streamingFake();
    const log = recorder();
    const gateway = new Gateway(config(true), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock(),
      log,
    });

    const answer = await gateway.chat(REQUEST);

    expect(answer.content).toBe("answer");
    expect(fake.call).not.toHaveBeenCalled();
    expect(fake.bounds).toEqual([
      { silenceMs: PROVIDER.timeoutMs, budgetMs: providerRequestBudgetMs(PROVIDER) },
    ]);
    expect(log.events.find((event) => event.op === "gateway.chat.started")).toMatchObject({
      extra: { streaming: false, upstreamStreaming: true },
    });
  });

  it("retries a stalled read, bounded by what is left of the budget", async () => {
    const fake = streamingFake([new TimeoutError("the provider fell silent")]);
    const gateway = new Gateway(config(true), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock(),
    });

    await expect(gateway.chat(REQUEST)).resolves.toMatchObject({ content: "answer" });

    expect(fake.bounds).toHaveLength(2);
    const [first, retry] = fake.bounds;
    expect(retry?.silenceMs).toBe(PROVIDER.timeoutMs);
    expect(retry?.budgetMs).toBeLessThan(first?.budgetMs ?? 0);
    expect(retry?.budgetMs).toBeGreaterThanOrEqual(PROVIDER.timeoutMs);
  });

  it("reads a whole body when the route does not stream", async () => {
    const fake = streamingFake();
    const log = recorder();
    const gateway = new Gateway(config(false), {
      adapter: fake.adapter,
      clock: createScriptedGatewayClock(),
      log,
    });

    await gateway.chat(REQUEST);

    expect(fake.call).toHaveBeenCalledOnce();
    expect(fake.bounds).toEqual([]);
    expect(log.events.find((event) => event.op === "gateway.chat.started")).toMatchObject({
      extra: { upstreamStreaming: false },
    });
  });

  it("reads a whole body when the adapter cannot read a stream", async () => {
    const call = vi.fn(() => Promise.resolve(ANSWER));
    const gateway = new Gateway(config(true), {
      adapter: { call },
      clock: createScriptedGatewayClock(),
    });

    await gateway.chat(REQUEST);

    expect(call).toHaveBeenCalledOnce();
  });
});
