// #3878: LiteLLM normalises a provider's reasoning as `reasoning_content` on chat-completion deltas
// and messages (vLLM or Gemma behind a reasoning parser, Anthropic thinking blocks). The adapter
// used to discard it. It now reads it into its own chunk kind and response field, never into the
// answer, and records it on its stream line as counts only: reasoning is a body and never reaches
// the Activity Log.
import { describe, expect, it } from "vitest";
import {
  ProviderEmptyAnswerError,
  ProviderOutputExhaustedError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { OpenAiAdapter } from "./openai-adapter.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import type {
  GatewayRequest,
  GatewayStreamChunk,
  ModelProviderConfig,
  StreamReadBounds,
} from "./types.js";

const CONFIG: ModelProviderConfig = {
  modelId: "reasoning-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-secret-key",
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const REQUEST: GatewayRequest = {
  modelId: "reasoning-model",
  messages: [{ role: "user", content: "fix the bug" }],
};
const BOUNDS: StreamReadBounds = { silenceMs: 1_000, budgetMs: 10_000 };
const REASONING_TEXT = "private-chain-of-thought";

const encoder = new TextEncoder();
const data = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const streamDelta = (delta: Readonly<Record<string, unknown>>): string =>
  data({ choices: [{ index: 0, delta }] });
const finish = (reason: string): string =>
  data({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
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

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function recorder(): {
  readonly events: ModelGatewayLogEvent[];
  readonly sink: ModelGatewayLogSink;
} {
  const events: ModelGatewayLogEvent[] = [];
  return { events, sink: { write: (event): void => void events.push(event) } };
}

function adapterAnswering(response: () => Response, log?: ModelGatewayLogSink): OpenAiAdapter {
  return new OpenAiAdapter({
    fetchImpl: () => Promise.resolve(response()),
    requestId: "fixed-id",
    costClass: "medium",
    ...(log === undefined ? {} : { log }),
  });
}

async function chunksOf(stream: AsyncIterable<GatewayStreamChunk>): Promise<GatewayStreamChunk[]> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

// Every chunk but the terminal one, in arrival order, as `kind:token`.
function sequence(chunks: readonly GatewayStreamChunk[]): string[] {
  return chunks.flatMap((chunk) => (chunk.type === "done" ? [] : [`${chunk.type}:${chunk.token}`]));
}

function doneOf(
  chunks: readonly GatewayStreamChunk[],
): Extract<GatewayStreamChunk, { type: "done" }> {
  const done = chunks.at(-1);
  if (done?.type !== "done") throw new TypeError("the stream ended without a done chunk");
  return done;
}

describe("OpenAiAdapter reasoning (#3878)", () => {
  it("streams reasoning deltas as reasoning chunks and never inside the answer", async () => {
    const adapter = adapterAnswering(() =>
      sse([
        streamDelta({ role: "assistant", content: null, reasoning_content: "Look at " }),
        streamDelta({ reasoning_content: "the parser." }),
        streamDelta({ content: "Fixed " }),
        streamDelta({ content: "it." }),
        finish("stop"),
        DONE,
      ]),
    );

    const chunks = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    expect(sequence(chunks)).toEqual([
      "reasoning:Look at ",
      "reasoning:the parser.",
      "delta:Fixed ",
      "delta:it.",
    ]);
    const { response } = doneOf(chunks);
    expect(response.content).toBe("Fixed it.");
    expect(response.reasoning).toBe("Look at the parser.");
  });

  // No delta here ends in a prefix of a configured secret ("h" of the base URL, "f" of the key), so
  // no lane holds back a suffix and every token surfaces with the event that carried it.
  it("keeps interleaved reasoning and text apart, in arrival order", async () => {
    const adapter = adapterAnswering(() =>
      sse([
        streamDelta({ reasoning_content: "first idea" }),
        // One provider event may carry both: the reasoning comes before the answer it led to.
        streamDelta({ reasoning_content: " last idea", content: "Answer" }),
        streamDelta({ content: " text" }),
        streamDelta({ reasoning_content: " late note" }),
        finish("stop"),
        DONE,
      ]),
    );

    const chunks = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    expect(sequence(chunks)).toEqual([
      "reasoning:first idea",
      "reasoning: last idea",
      "delta:Answer",
      "delta: text",
      "reasoning: late note",
    ]);
    const { response } = doneOf(chunks);
    expect(response.content).toBe("Answer text");
    expect(response.reasoning).toBe("first idea last idea late note");
  });

  it("reads a reasoning parser's `reasoning` field when `reasoning_content` is absent", async () => {
    const adapter = adapterAnswering(() =>
      sse([
        streamDelta({ reasoning: "newer field" }),
        // `reasoning_content` wins when a provider sends both names for the same text.
        streamDelta({ reasoning_content: " named", reasoning: " named" }),
        streamDelta({ content: "done" }),
        finish("stop"),
        DONE,
      ]),
    );

    const chunks = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    expect(sequence(chunks)).toEqual(["reasoning:newer field", "reasoning: named", "delta:done"]);
    expect(doneOf(chunks).response.reasoning).toBe("newer field named");
  });

  it("answers without a reasoning field when the provider sent none", async () => {
    const adapter = adapterAnswering(() =>
      sse([streamDelta({ content: "plain" }), finish("stop"), DONE]),
    );

    const chunks = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    expect(sequence(chunks)).toEqual(["delta:plain"]);
    expect(doneOf(chunks).response).not.toHaveProperty("reasoning");
  });

  it("yields the reasoning of a reasoning-only turn and still fails it as output-exhausted", async () => {
    const log = recorder();
    const adapter = adapterAnswering(
      () =>
        sse([
          streamDelta({ reasoning_content: "spent the whole " }),
          streamDelta({ reasoning_content: "budget thinking" }),
          finish("length"),
          DONE,
        ]),
      log.sink,
    );
    const seen: string[] = [];

    await expect(
      (async (): Promise<void> => {
        for await (const chunk of adapter.callStream(REQUEST, CONFIG, BOUNDS)) {
          if (chunk.type !== "done") seen.push(`${chunk.type}:${chunk.token}`);
        }
      })(),
    ).rejects.toBeInstanceOf(ProviderOutputExhaustedError);

    expect(seen).toEqual(["reasoning:spent the whole ", "reasoning:budget thinking"]);
    const line = log.events.find((event) => event.op === "chat.response.streamed");
    expect(line?.extra).toMatchObject({
      outcome: "failed",
      outputExhausted: true,
      reasoningEvents: 2,
      reasoningBytes: "spent the whole budget thinking".length,
    });
  });

  it("fails a reasoning-only turn that stopped without an answer as an empty answer", async () => {
    const adapter = adapterAnswering(() =>
      sse([streamDelta({ reasoning_content: "thinking only" }), finish("stop"), DONE]),
    );

    await expect(chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS))).rejects.toBeInstanceOf(
      ProviderEmptyAnswerError,
    );
  });

  // #3873 (F23): the gateway steers one repair for an answer that ended after reasoning without text
  // or a tool call, so the empty-answer error says whether reasoning preceded it — a flag, never the
  // reasoning itself.
  it("marks the empty answer of a reasoning-only streamed turn as ended after reasoning", async () => {
    const adapter = adapterAnswering(() =>
      sse([streamDelta({ reasoning_content: "thinking only" }), finish("stop"), DONE]),
    );

    const failure = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect(failure).toMatchObject({ afterReasoning: true });
    expect(JSON.stringify(failure)).not.toContain("thinking only");
    expect((failure as Error).message).not.toContain("thinking only");
  });

  it("does not mark an empty streamed answer that carried no reasoning", async () => {
    const adapter = adapterAnswering(() =>
      sse([streamDelta({ role: "assistant", content: "" }), finish("stop"), DONE]),
    );

    const failure = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
    expect(failure).toMatchObject({ afterReasoning: false });
  });

  it.each([
    ["message.reasoning_content", { reasoning_content: REASONING_TEXT }, true],
    ["message.reasoning", { reasoning: REASONING_TEXT }, true],
    ["no reasoning", {}, false],
  ] as const)(
    "marks a buffered empty answer by whether reasoning preceded it (%s)",
    async (_label, reasoningFields, afterReasoning) => {
      const adapter = adapterAnswering(() =>
        json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "", ...reasoningFields },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );

      const failure = await adapter.call(REQUEST, CONFIG).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ProviderEmptyAnswerError);
      expect(failure).toMatchObject({ afterReasoning });
    },
  );

  // #3873 review: the provider answered and reported its usage, so the failure carries it as counts
  // — the gateway adds it to the call's discarded usage when it steers a repair of this answer.
  it.each([
    ["an exhausted", "length", ProviderOutputExhaustedError],
    ["an empty", "stop", ProviderEmptyAnswerError],
  ] as const)(
    "carries the provider-reported usage of %s buffered answer on the failure",
    async (_label, finishReason, failureClass) => {
      const adapter = adapterAnswering(() =>
        json({
          choices: [
            {
              finish_reason: finishReason,
              message: { role: "assistant", content: "", reasoning_content: REASONING_TEXT },
            },
          ],
          usage: { prompt_tokens: 1_200, completion_tokens: 8_192 },
        }),
      );

      const failure = await adapter.call(REQUEST, CONFIG).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(failureClass);
      expect(failure).toMatchObject({
        partialUsage: { promptTokens: 1_200, completionTokens: 8_192, streamedChars: 0 },
      });
      expect(JSON.stringify(failure)).not.toContain(REASONING_TEXT);
    },
  );

  it("keeps a reasoning-only answer that spent its budget an exhausted-output failure, not an empty one", async () => {
    const adapter = adapterAnswering(() =>
      sse([streamDelta({ reasoning_content: "thinking only" }), finish("length"), DONE]),
    );

    const failure = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(failure).not.toBeInstanceOf(ProviderEmptyAnswerError);
  });

  it("reads message.reasoning_content of a buffered answer apart from its content", async () => {
    const adapter = adapterAnswering(() =>
      json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Fixed.", reasoning_content: REASONING_TEXT },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    );

    const response = await adapter.call(REQUEST, CONFIG);

    expect(response.content).toBe("Fixed.");
    expect(response.reasoning).toBe(REASONING_TEXT);
  });

  it("emits the reasoning of a whole-body answer to a streamed request before its text", async () => {
    const log = recorder();
    const adapter = adapterAnswering(
      () =>
        json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Fixed.", reasoning_content: REASONING_TEXT },
            },
          ],
        }),
      log.sink,
    );

    const chunks = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    expect(sequence(chunks)).toEqual([`reasoning:${REASONING_TEXT}`, "delta:Fixed."]);
    expect(doneOf(chunks).response.reasoning).toBe(REASONING_TEXT);
    expect(log.events.find((event) => event.op === "chat.response.streamed")?.extra).toMatchObject({
      outcome: "whole-body",
      reasoningEvents: 1,
      reasoningBytes: REASONING_TEXT.length,
    });
  });

  it("redacts a configured secret inside reasoning, also when it is split across deltas", async () => {
    const adapter = adapterAnswering(() =>
      sse([
        streamDelta({ reasoning_content: "the key is fixture-sec" }),
        streamDelta({ reasoning_content: "ret-key, so" }),
        streamDelta({ content: "ok" }),
        finish("stop"),
        DONE,
      ]),
    );

    const chunks = await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    const streamed = chunks.flatMap((chunk) => (chunk.type === "reasoning" ? [chunk.token] : []));
    expect(streamed.join("")).not.toContain(CONFIG.apiKey);
    expect(doneOf(chunks).response.reasoning).not.toContain(CONFIG.apiKey);
  });

  it("records reasoning on chat.response.streamed as counts and never as text", async () => {
    const log = recorder();
    const adapter = adapterAnswering(
      () =>
        sse([
          streamDelta({ reasoning_content: REASONING_TEXT }),
          streamDelta({ reasoning_content: REASONING_TEXT }),
          streamDelta({ content: "answer" }),
          finish("stop"),
          DONE,
        ]),
      log.sink,
    );

    await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    const line = log.events.find((event) => event.op === "chat.response.streamed");
    expect(line?.extra).toMatchObject({
      outcome: "completed",
      dataEvents: 4,
      reasoningEvents: 2,
      reasoningBytes: REASONING_TEXT.length * 2,
    });
    expect(JSON.stringify(log.events)).not.toContain(REASONING_TEXT);
  });

  it("records zero reasoning on a stream that carried none", async () => {
    const log = recorder();
    const adapter = adapterAnswering(
      () => sse([streamDelta({ content: "answer" }), finish("stop"), DONE]),
      log.sink,
    );

    await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS));

    expect(log.events.find((event) => event.op === "chat.response.streamed")?.extra).toMatchObject({
      reasoningEvents: 0,
      reasoningBytes: 0,
    });
  });

  // The reasoning share of a turn: the provider's own reasoning-token count when it reports one
  // (never estimated), and the UTF-8 size of the reasoning it returned, also where a surface later
  // discards the reasoning itself.
  it("puts the provider's reasoning-token count and the reasoning's UTF-8 size on usage", async () => {
    const multibyte = "Überlegung ✓";
    const adapter = adapterAnswering(() =>
      sse([
        streamDelta({ reasoning_content: multibyte }),
        streamDelta({ content: "ok" }),
        finish("stop"),
        data({
          choices: [],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 21 },
          },
        }),
        DONE,
      ]),
    );

    const { usage } = doneOf(await chunksOf(adapter.callStream(REQUEST, CONFIG, BOUNDS))).response;

    expect(usage).toMatchObject({ completionTokens: 30, reasoningTokens: 21 });
    expect(usage.reasoningBytes).toBe(new TextEncoder().encode(multibyte).byteLength);
    expect(usage.reasoningBytes).toBeGreaterThan(multibyte.length);
  });

  it.each([
    ["no details", { prompt_tokens: 7, completion_tokens: 30 }],
    ["a fractional count", { completion_tokens_details: { reasoning_tokens: 2.5 } }],
    ["a negative count", { completion_tokens_details: { reasoning_tokens: -1 } }],
    ["a string count", { completion_tokens_details: { reasoning_tokens: "21" } }],
  ])("leaves reasoningTokens absent for %s", async (_label, usage) => {
    const adapter = adapterAnswering(() =>
      json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage }),
    );

    const response = await adapter.call(REQUEST, CONFIG);

    expect(response.usage).not.toHaveProperty("reasoningTokens");
    expect(response.usage).not.toHaveProperty("reasoningBytes");
  });
});
