// A tool call whose arguments the provider cut off at `finish_reason: "length"` (a large file
// written in one call) is an exhausted output budget, not a malformed model answer: it must take the
// existing output-exhausted path so the one steered repair applies. The same call with any other
// finish reason stays malformed. Both the buffered and the streamed normalization are covered.
import { describe, expect, it } from "vitest";
import {
  MalformedToolCallError,
  ProviderOutputExhaustedError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { openCodeGatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import { steeredAnswerRepair } from "./resilience.js";
import type { ModelGatewayLogTransport } from "./observability.js";
import type { GatewayRequest, GatewayStreamChunk, ModelProviderConfig } from "./types.js";

const NOW = Date.parse("2026-10-28T00:00:00Z");
const PROVIDER: ModelProviderConfig = {
  modelId: "fixture-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "fixture-key",
  timeoutMs: 30_000,
  maxRetries: 1,
  retryBaseDelayMs: 1,
};
const REQUEST: GatewayRequest = {
  modelId: PROVIDER.modelId,
  messages: [{ role: "user", content: "Write the file." }],
};
const CUT_ARGUMENTS = '{"filePath":"a.ts","content":"const x = ';

function adapterFor(
  response: () => Response,
  events: ModelGatewayLogTransport[] = [],
): OpenAiAdapter {
  return new OpenAiAdapter({
    log: { write: (event): void => void events.push(event) },
    fetchImpl: (): Promise<Response> => Promise.resolve(response()),
    now: (): number => NOW,
    requestId: "truncated-fixture",
    costClass: "low",
  });
}

function buffered(finishReason: string, argumentsText: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "write", arguments: argumentsText } },
            ],
          },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 4096 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function sse(frames: readonly unknown[]): Response {
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function streamedToolCall(finishReason: string, argumentsText: string, index?: number): Response {
  const fragment = {
    ...(index === undefined ? {} : { index }),
    id: "c1",
    type: "function",
    function: { name: "write", arguments: argumentsText },
  };
  return sse([
    { choices: [{ delta: { tool_calls: [fragment] } }] },
    { choices: [{ delta: {}, finish_reason: finishReason }] },
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4096 } },
  ]);
}

async function drain(stream: AsyncIterable<GatewayStreamChunk>): Promise<GatewayStreamChunk[]> {
  const chunks: GatewayStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("a tool call cut off by the output budget", () => {
  it("is an exhausted output budget on the buffered path, eligible for the steered repair", async () => {
    const adapter = adapterFor(() => buffered("length", CUT_ARGUMENTS));
    const failure = await failureOf(() => adapter.call(REQUEST, PROVIDER));
    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(failure).not.toBeInstanceOf(MalformedToolCallError);
    expect(steeredAnswerRepair(failure as Error)).toBe("output-exhausted-repair");
  });

  it("is an exhausted output budget on the streamed path, eligible for the steered repair", async () => {
    const adapter = adapterFor(() => streamedToolCall("length", CUT_ARGUMENTS, 0));
    const failure = await failureOf(() => drain(adapter.callStream(REQUEST, PROVIDER)));
    expect(failure).toBeInstanceOf(ProviderOutputExhaustedError);
    expect(steeredAnswerRepair(failure as Error)).toBe("output-exhausted-repair");
  });

  it("stays a malformed tool call when the provider did not stop on the output budget", async () => {
    const adapter = adapterFor(() => buffered("tool_calls", CUT_ARGUMENTS));
    const failure = await failureOf(() => adapter.call(REQUEST, PROVIDER));
    expect(failure).toBeInstanceOf(MalformedToolCallError);
    expect(failure).not.toBeInstanceOf(ProviderOutputExhaustedError);
    const streamed = adapterFor(() => streamedToolCall("tool_calls", CUT_ARGUMENTS, 0));
    const streamFailure = await failureOf(() => drain(streamed.callStream(REQUEST, PROVIDER)));
    expect(streamFailure).toBeInstanceOf(MalformedToolCallError);
  });
});

const CATALOG_REQUEST: GatewayRequest = {
  ...REQUEST,
  toolCatalog: openCodeGatewayCatalogAdvertisement(NOW),
};
const DISCOVER = "keiko_workspace_discover";

function discoverArguments(query: string): string {
  return JSON.stringify({ mode: "keywords", directory: "", query, maxResults: 10 });
}

function parsedDiscover(query: string): Record<string, unknown> {
  return JSON.parse(discoverArguments(query)) as Record<string, unknown>;
}

describe("streamed tool-call fragments without a numeric index", () => {
  async function finalAnswer(
    adapter: OpenAiAdapter,
  ): Promise<Extract<GatewayStreamChunk, { type: "done" }>["response"]> {
    const chunks = await drain(adapter.callStream(CATALOG_REQUEST, PROVIDER));
    const done = chunks.find((chunk) => chunk.type === "done");
    if (done?.type !== "done") throw new Error("expected a done chunk");
    return done.response;
  }

  it("places an unindexed fragment by its array position instead of dropping it", async () => {
    const events: ModelGatewayLogTransport[] = [];
    const adapter = adapterFor(
      () =>
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { id: "c1", function: { name: DISCOVER, arguments: discoverArguments("a") } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      events,
    );
    const answer = await finalAnswer(adapter);
    expect(answer.toolCalls).toMatchObject([
      { id: "c1", name: DISCOVER, arguments: parsedDiscover("a") },
    ]);
    const line = events.find((event) => event.op === "chat.response.streamed");
    expect(line?.extra).toMatchObject({
      toolCallFragmentsPositional: 1,
      toolCallFragmentsDropped: 0,
    });
  });

  it("keeps two unindexed calls in one delta apart and merges later argument fragments", async () => {
    const first = discoverArguments("a");
    const second = discoverArguments("b");
    const adapter = adapterFor(() =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "a", function: { name: DISCOVER, arguments: first.slice(0, 10) } },
                  { id: "b", function: { name: DISCOVER, arguments: second.slice(0, 10) } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { function: { arguments: first.slice(10) } },
                  { function: { arguments: second.slice(10) } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    );
    const answer = await finalAnswer(adapter);
    expect(answer.toolCalls).toMatchObject([
      { id: "a", arguments: parsedDiscover("a") },
      { id: "b", arguments: parsedDiscover("b") },
    ]);
  });

  it("starts the next call when an unindexed fragment announces a different id", async () => {
    const adapter = adapterFor(() =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "a", function: { name: DISCOVER, arguments: discoverArguments("a") } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "b", function: { name: DISCOVER, arguments: discoverArguments("b") } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    );
    const answer = await finalAnswer(adapter);
    expect(answer.toolCalls.map((call) => call.id)).toEqual(["a", "b"]);
  });

  it("counts a fragment that is not an object as dropped instead of losing it silently", async () => {
    const events: ModelGatewayLogTransport[] = [];
    const adapter = adapterFor(
      () =>
        sse([
          {
            choices: [
              { delta: { content: "done", tool_calls: ["not-a-fragment"] }, finish_reason: "stop" },
            ],
          },
        ]),
      events,
    );
    await finalAnswer(adapter);
    const line = events.find((event) => event.op === "chat.response.streamed");
    expect(line?.extra).toMatchObject({ toolCallFragmentsDropped: 1 });
  });
});
