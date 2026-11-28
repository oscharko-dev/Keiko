// O-11: a model turn that ends without text or a tool call must say what the provider's own usage
// record reported, so "the provider generated output that never arrived" (a tool call its parser
// buffered and dropped) is told apart from "the model generated nothing". The usage rides on the
// final `include_usage` chunk of the stream; absent means the provider sent none, never zero.
import { describe, expect, it } from "vitest";
import { ProviderEmptyAnswerError } from "@oscharko-dev/keiko-security/errors/gateway";
import { GATEWAY_EMPTY_ANSWER_EVIDENCE } from "@oscharko-dev/keiko-contracts/runtime/gateway";
import { ACTIVITY_LOG_OPERATION_REGISTRY } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import type {
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  StreamReadBounds,
} from "./types.js";

const CONFIG: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture",
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
const reasoning = (text: string): string =>
  data({ choices: [{ index: 0, delta: { reasoning_content: text } }] });
const delta = (content: string): string => data({ choices: [{ index: 0, delta: { content } }] });
const finish = (reason: string): string =>
  data({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = (usage: Record<string, unknown>): string => data({ choices: [], usage });
const DONE = "data: [DONE]\n\n";

function sse(lines: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
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

async function readAll(lines: readonly string[], log: ModelGatewayLogSink): Promise<unknown> {
  const adapter = new OpenAiAdapter({
    fetchImpl: (): Promise<Response> => Promise.resolve(sse(lines)),
    requestId: "fixed-id",
    costClass: "high",
    now: (): number => 0,
    log,
  });
  try {
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of adapter.callStream(REQUEST, CONFIG, BOUNDS)) chunks.push(chunk);
    return undefined;
  } catch (error) {
    return error;
  }
}

function streamedExtra(events: readonly ModelGatewayLogEvent[]): Record<string, unknown> {
  return events.find((event) => event.op === "chat.response.streamed")?.extra ?? {};
}

describe("OpenAiAdapter streamed empty answer: provider usage evidence (O-11)", () => {
  it("names provider-reported output when the usage chunk counts tokens the stream never carried", async () => {
    const log = recorder();

    const failure = await readAll(
      [
        reasoning("thinking about a very long tool call"),
        finish("stop"),
        usageChunk({
          prompt_tokens: 9000,
          completion_tokens: 1800,
          completion_tokens_details: { reasoning_tokens: 1700 },
        }),
        DONE,
      ],
      log.sink,
    );

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect(failure).toMatchObject({
      emptyAnswerEvidence: "provider-reported-output",
      providerUsage: { completionTokens: 1800, reasoningTokens: 1700 },
    });
    expect(streamedExtra(log.events)).toMatchObject({
      outcome: "failed",
      providerCompletionTokens: 1800,
      providerReasoningTokens: 1700,
      emptyAnswerEvidence: "provider-reported-output",
    });
  });

  it("names usage-unavailable, and records no provider count, when the stream carried no usage", async () => {
    const log = recorder();

    const failure = await readAll([reasoning("thinking"), finish("stop"), DONE], log.sink);

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect(failure).toMatchObject({ emptyAnswerEvidence: "usage-unavailable" });
    const extra = streamedExtra(log.events);
    expect(extra).toMatchObject({ outcome: "failed", emptyAnswerEvidence: "usage-unavailable" });
    expect(extra).not.toHaveProperty("providerCompletionTokens");
    expect(extra).not.toHaveProperty("providerReasoningTokens");
  });

  it("names no-provider-output when the provider itself reported zero completion tokens", async () => {
    const log = recorder();

    await readAll(
      [finish("stop"), usageChunk({ prompt_tokens: 12, completion_tokens: 0 }), DONE],
      log.sink,
    );

    expect(streamedExtra(log.events)).toMatchObject({
      providerCompletionTokens: 0,
      emptyAnswerEvidence: "no-provider-output",
    });
    expect(streamedExtra(log.events)).not.toHaveProperty("providerReasoningTokens");
  });

  it("records the provider usage of a completed read and classifies nothing", async () => {
    const log = recorder();

    const failure = await readAll(
      [delta("done"), finish("stop"), usageChunk({ prompt_tokens: 5, completion_tokens: 3 }), DONE],
      log.sink,
    );

    expect(failure).toBeUndefined();
    const extra = streamedExtra(log.events);
    expect(extra).toMatchObject({ outcome: "completed", providerCompletionTokens: 3 });
    expect(extra).not.toHaveProperty("emptyAnswerEvidence");
  });

  it("keeps a good provider usage when a later chunk carries an empty usage record", async () => {
    const log = recorder();

    await readAll(
      [
        reasoning("thinking"),
        finish("stop"),
        usageChunk({ prompt_tokens: 9, completion_tokens: 1800 }),
        usageChunk({}),
        DONE,
      ],
      log.sink,
    );

    expect(streamedExtra(log.events)).toMatchObject({
      providerCompletionTokens: 1800,
      emptyAnswerEvidence: "provider-reported-output",
    });
  });

  it("pins every registered emptyAnswerEvidence vocabulary to the contract's", () => {
    const registered = ACTIVITY_LOG_OPERATION_REGISTRY.filter(
      (registration) => "emptyAnswerEvidence" in registration.fields,
    );
    expect(registered.map((registration) => registration.op).sort()).toEqual([
      "chat.response.streamed",
      "coding-sidecar.gateway.turn-failed",
      "gateway.stream.failed",
    ]);
    for (const registration of registered) {
      const fields = registration.fields as unknown as Readonly<
        Record<string, { readonly values?: readonly string[] }>
      >;
      expect(fields.emptyAnswerEvidence?.values).toEqual([...GATEWAY_EMPTY_ANSWER_EVIDENCE]);
    }
  });

  it("keeps the registered classification vocabulary equal to the contract's", () => {
    expect([...GATEWAY_EMPTY_ANSWER_EVIDENCE]).toEqual([
      "provider-reported-output",
      "no-provider-output",
      "usage-unavailable",
    ]);
  });
});
