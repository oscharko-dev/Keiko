// A buffered answer read over the provider's stream (ADR-0003, coding run 30). The provider's
// silence and the read's budget bound it instead of one wall-clock `timeoutMs`, and the answer runs
// through the same normalization as a whole body. The LiteLLM frames are the proxy's own shapes
// (litellm/proxy/common_request_processing.py): `: ping` comments while it waits for its upstream,
// and an error frame whose `code` is the upstream HTTP status as a string, followed by `[DONE]`.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextOverflowError,
  ModelRefusalError,
  ProviderError,
  RateLimitError,
  TimeoutError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { gatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import type {
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  NormalizedResponse,
  StreamReadBounds,
} from "./types.js";

const CONFIG: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: ["example-test-token-", "1234567890abcd"].join(""),
  timeoutMs: 30_000,
  maxRetries: 2,
  retryBaseDelayMs: 500,
};
const REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [{ role: "user", content: "hi" }],
};
const BOUNDS: StreamReadBounds = { silenceMs: 1_000, budgetMs: 10_000 };

const encoder = new TextEncoder();
const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const delta = (content: string): string => data({ choices: [{ index: 0, delta: { content } }] });
const finish = (reason: string): string =>
  data({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const DONE = "data: [DONE]\n\n";
const PING = ": ping\n\n";

interface DrivenStream {
  readonly response: Response;
  readonly push: (line: string) => void;
  readonly end: () => void;
  readonly cancelled: () => boolean;
}

// A provider stream the test drives: it stays open and silent until the test pushes a line.
function drivenStream(): DrivenStream {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(started): void {
      controller = started;
    },
    cancel(): void {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    push: (line): void => {
      controller?.enqueue(encoder.encode(line));
    },
    end: (): void => {
      controller?.close();
    },
    cancelled: (): boolean => cancelled,
  };
}

function sse(lines: readonly string[]): Response {
  const stream = drivenStream();
  for (const line of lines) stream.push(line);
  stream.end();
  return stream.response;
}

function recorder(): {
  readonly events: ModelGatewayLogEvent[];
  readonly sink: ModelGatewayLogSink;
} {
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

function adapterWith(fetchImpl: typeof fetch, log?: ModelGatewayLogSink): OpenAiAdapter {
  let tick = 0;
  return new OpenAiAdapter({
    fetchImpl,
    requestId: "fixed-id",
    costClass: "high",
    now: (): number => (tick += 10),
    ...(log === undefined ? {} : { log }),
  });
}

async function answerOf(stream: AsyncIterable<GatewayStreamChunk>): Promise<NormalizedResponse> {
  let answer: NormalizedResponse | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "done") answer = chunk.response;
  }
  if (answer === undefined) throw new TypeError("the stream ended without a done chunk");
  return answer;
}

function streamedLine(events: readonly ModelGatewayLogEvent[]): ModelGatewayLogEvent | undefined {
  return events.find((event) => event.op === "chat.response.streamed");
}

describe("OpenAiAdapter.callStream with read bounds: silence and budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes a live generation that outlasts its silence bound", async () => {
    vi.useFakeTimers();
    const provider = drivenStream();
    const log = recorder();
    const reading = answerOf(
      adapterWith(() => Promise.resolve(provider.response), log.sink).callStream(
        REQUEST,
        CONFIG,
        BOUNDS,
      ),
    );
    for (let part = 0; part < 5; part += 1) {
      await vi.advanceTimersByTimeAsync(BOUNDS.silenceMs - 1);
      provider.push(delta(`part-${String(part)} `));
    }
    provider.push(finish("stop"));
    provider.push(DONE);
    provider.end();

    await expect(reading).resolves.toMatchObject({
      content: "part-0 part-1 part-2 part-3 part-4 ",
      finishReason: "stop",
    });
    expect(streamedLine(log.events)).toMatchObject({
      level: "info",
      extra: { outcome: "completed", dataEvents: 6, silenceMs: 1_000, readBudgetMs: 10_000 },
    });
  });

  it("ends a stream whose provider falls silent, and releases its body", async () => {
    vi.useFakeTimers();
    const provider = drivenStream();
    const log = recorder();
    let settled = false;
    const reading = answerOf(
      adapterWith(() => Promise.resolve(provider.response), log.sink).callStream(
        REQUEST,
        CONFIG,
        BOUNDS,
      ),
    ).finally(() => {
      settled = true;
    });
    const rejected = expect(reading).rejects.toBeInstanceOf(TimeoutError);
    provider.push(delta("partial"));
    await vi.advanceTimersByTimeAsync(BOUNDS.silenceMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;

    expect(provider.cancelled()).toBe(true);
    expect(streamedLine(log.events)).toMatchObject({
      level: "warn",
      errorKind: "GATEWAY_TIMEOUT",
      extra: { outcome: "stalled", dataEvents: 1 },
    });
  });

  // LiteLLM keeps a streamed response alive with `: ping` comments while it waits for its upstream
  // model; the pings prove the proxy is alive, not that the model answers.
  it("does not count a proxy's keep-alive comments as data", async () => {
    vi.useFakeTimers();
    const provider = drivenStream();
    const reading = answerOf(
      adapterWith(() => Promise.resolve(provider.response)).callStream(REQUEST, CONFIG, BOUNDS),
    );
    const rejected = expect(reading).rejects.toBeInstanceOf(TimeoutError);
    for (let ping = 0; ping < 3; ping += 1) {
      provider.push(PING);
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(BOUNDS.silenceMs - 900);
    await rejected;
    expect(provider.cancelled()).toBe(true);
  });

  it("ends a response that does not start within its silence bound", async () => {
    vi.useFakeTimers();
    const neverStarts: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        });
      });
    const reading = answerOf(adapterWith(neverStarts).callStream(REQUEST, CONFIG, BOUNDS));
    const rejected = expect(reading).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(BOUNDS.silenceMs);
    await rejected;
  });

  it("ends a live read at its budget", async () => {
    vi.useFakeTimers();
    const provider = drivenStream();
    const bounds: StreamReadBounds = { silenceMs: 1_000, budgetMs: 3_000 };
    const reading = answerOf(
      adapterWith(() => Promise.resolve(provider.response)).callStream(REQUEST, CONFIG, bounds),
    );
    const rejected = expect(reading).rejects.toBeInstanceOf(TimeoutError);
    for (let part = 0; part < 4; part += 1) {
      provider.push(delta("x"));
      await vi.advanceTimersByTimeAsync(900);
    }
    await rejected;
    expect(provider.cancelled()).toBe(true);
  });

  it("says in its dispatch line which bounds the read runs under", async () => {
    const log = recorder();
    await answerOf(
      adapterWith(
        () => Promise.resolve(sse([delta("ok"), finish("stop"), DONE])),
        log.sink,
      ).callStream(REQUEST, CONFIG, BOUNDS),
    );
    expect(log.events.find((event) => event.op === "chat.request.dispatch")).toMatchObject({
      extra: { stream: true, timeoutMs: 1_000, readBudgetMs: 10_000 },
    });
  });
});

describe("OpenAiAdapter.callStream with read bounds: the answer matches a whole body", () => {
  const TOOL_CALL = {
    id: "call_1",
    type: "function",
    function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
  };

  it("assembles content, tool calls, finish reason and usage exactly like call()", async () => {
    const usage = { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 };
    const streamed = sse([
      data({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
      data({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: TOOL_CALL.id,
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      }),
      data({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
          },
        ],
      }),
      finish("tool_calls"),
      data({ choices: [], usage }),
      DONE,
    ]);
    const whole = new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "", tool_calls: [TOOL_CALL] },
            finish_reason: "tool_calls",
          },
        ],
        usage,
      }),
      { headers: { "content-type": "application/json" } },
    );
    const request = { ...REQUEST, toolCatalog: gatewayCatalogAdvertisement(0, ["read_file"]) };

    const overStream = await answerOf(
      adapterWith(() => Promise.resolve(streamed)).callStream(request, CONFIG, BOUNDS),
    );
    const buffered = await adapterWith(() => Promise.resolve(whole)).call(request, CONFIG);

    expect(overStream).toEqual(buffered);
    expect(overStream.toolCalls).toHaveLength(1);
  });

  it("parses structured output from the streamed content", async () => {
    const answer = await answerOf(
      adapterWith(() =>
        Promise.resolve(sse([delta('{"answer":'), delta("42}"), finish("stop"), DONE])),
      ).callStream(
        { ...REQUEST, responseFormat: { type: "json_schema", schema: { type: "object" } } },
        CONFIG,
        BOUNDS,
      ),
    );
    expect(answer.structuredOutput).toEqual({ answer: 42 });
  });

  it.each([
    ["a streamed refusal", [data({ choices: [{ index: 0, delta: { refusal: "I can't." } }] })]],
    ["a content filter", [delta("partial"), finish("content_filter")]],
  ])("refuses %s like a whole body", async (_case, lines) => {
    const reading = answerOf(
      adapterWith(() => Promise.resolve(sse([...lines, DONE]))).callStream(REQUEST, CONFIG, BOUNDS),
    );
    await expect(reading).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it("reads a whole body that answers a streamed request", async () => {
    const whole = new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "whole" }, finish_reason: "stop" }],
      }),
      { headers: { "content-type": "application/json" } },
    );
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of adapterWith(() => Promise.resolve(whole)).callStream(
      REQUEST,
      CONFIG,
      BOUNDS,
    )) {
      chunks.push(chunk);
    }
    expect(chunks[0]).toEqual({ type: "delta", token: "whole" });
    expect(chunks[1]).toMatchObject({ type: "done", response: { content: "whole" } });
  });
});

describe("OpenAiAdapter.callStream through a LiteLLM proxy", () => {
  it("reads the proxy's chunk shapes, keep-alive comments and trailing usage chunk", async () => {
    const frame = (choices: readonly unknown[], extra: Record<string, unknown> = {}): string =>
      data({
        id: "chatcmpl-litellm-1",
        created: 1_757_592_000,
        model: "gpt-5.4",
        object: "chat.completion.chunk",
        system_fingerprint: "fp_litellm",
        choices,
        ...extra,
      });
    const answer = await answerOf(
      adapterWith(() =>
        Promise.resolve(
          sse([
            PING,
            frame([{ index: 0, delta: { role: "assistant", content: "" } }]),
            frame([{ index: 0, delta: { content: "Hello" } }]),
            PING,
            frame([{ index: 0, delta: {}, finish_reason: "stop" }]),
            frame([], { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
            DONE,
          ]),
        ),
      ).callStream(REQUEST, CONFIG, BOUNDS),
    );
    expect(answer).toMatchObject({
      content: "Hello",
      finishReason: "stop",
      usage: { promptTokens: 12, completionTokens: 3 },
    });
  });

  it.each([
    [
      "an upstream rate limit",
      { message: "Rate limit reached", type: "None", param: "None", code: "429" },
      RateLimitError,
    ],
    [
      "an OpenAI-style rate limit",
      { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" },
      RateLimitError,
    ],
    [
      "an upstream context overflow",
      { message: "This model's maximum context length is 128000 tokens", code: "400" },
      ContextOverflowError,
    ],
    [
      "an upstream server error",
      { message: "upstream failed", type: "None", param: "None", code: "500" },
      ProviderError,
    ],
    ["a failure without a status", { message: "upstream connection reset" }, ProviderError],
  ])("maps %s reported mid-stream like the same HTTP failure", async (_case, error, expected) => {
    const reading = answerOf(
      adapterWith(() =>
        Promise.resolve(sse([delta("partial "), data({ error }), DONE])),
      ).callStream(REQUEST, CONFIG, BOUNDS),
    );
    await expect(reading).rejects.toBeInstanceOf(expected);
  });

  it("keeps a mid-stream server failure retryable and names it as reported in the stream", async () => {
    const reading = answerOf(
      adapterWith(() =>
        Promise.resolve(sse([data({ error: { message: "upstream connection reset" } }), DONE])),
      ).callStream(REQUEST, CONFIG, BOUNDS),
    );
    await expect(reading).rejects.toMatchObject({ retryable: true, httpStatus: 502 });
    await expect(reading).rejects.toThrow(/mid-stream/u);
  });
});
