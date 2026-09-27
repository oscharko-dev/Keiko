// Activity-log coverage for the chat dispatch path. Before this change `AdapterDeps` carried no
// `log`/`logContext` fields at all, so a real chat call never wrote an attempt line and never
// stamped a correlation id onto the transport lines `http.ts` already emits — `http.gateway.fetch.*`
// never fired for a real chat call. Mirrors `openai-embedding-adapter.logging.test.ts`'s scalar
// coverage, one layer up: the chat adapter has no compatibility ladder, so there is exactly one
// attempt line per dispatched call rather than a chain of degradation lines.
//
// Hermetic: `fetchImpl` is injected on every request, so no socket is opened and no DNS resolved.

import { describe, expect, it } from "vitest";
import { gatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { OpenAiAdapter } from "./openai-adapter.js";
import {
  logModelId,
  type ModelGatewayLogEvent,
  type ModelGatewayLogSink,
} from "./observability.js";
import type { GatewayRequest, GatewayStreamChunk, ModelProviderConfig } from "./types.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

interface Recorder {
  readonly sink: ModelGatewayLogSink;
  readonly events: ModelGatewayLogEvent[];
}

function recorder(): Recorder {
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

function eventFor(events: readonly ModelGatewayLogEvent[], op: string): ModelGatewayLogEvent {
  const found = events.find((event) => event.op === op);
  if (found === undefined) {
    const seen = events.map((event) => event.op).join(", ");
    throw new Error(`expected an event with op '${op}', saw: ${seen}`);
  }
  return found;
}

const CONFIG: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "example-secret-token",
  timeoutMs: 12_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
};

const REQUEST: GatewayRequest = {
  modelId: "example-chat-model",
  messages: [
    { role: "system", content: "be terse" },
    { role: "user", content: "some private prompt text" },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function successBody(): unknown {
  return {
    choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  };
}

describe("OpenAiAdapter.call — activity log", () => {
  // FAILS BEFORE / PASSES AFTER: before this change `AdapterDeps` had no `log` field, so this
  // case would not even compile. After the fix, a real (fetch-mocked) chat call emits exactly one
  // `chat.request.dispatch` line, before the transport is entered, naming the endpoint, model,
  // message count, body size and deadline — never the prompt content.
  it("writes chat.request.dispatch with the expected fields before the transport is entered", async () => {
    const log = recorder();
    let opsAtDispatch: readonly string[] = ["<transport never entered>"];
    const fetchImpl: typeof fetch = () => {
      opsAtDispatch = log.events.map((event) => event.op);
      return Promise.resolve(jsonResponse(successBody()));
    };
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "high",
      log: log.sink,
    });
    const result = await adapter.call(REQUEST, CONFIG);
    expect(result.content).toBe("pong");
    // The attempt line is already written by the time the socket work starts — the whole point of
    // an attempt line is that it does not wait for the call to return. `http.ts`'s own pre-flight
    // lines (planning, started) may already have joined it by the time `fetchImpl` itself runs;
    // what matters is that the chat-layer line leads them, not that it is alone.
    expect(opsAtDispatch[0]).toBe("chat.request.dispatch");
    const dispatch = eventFor(log.events, "chat.request.dispatch");
    expect(dispatch.level).toBe("info");
    expect(dispatch.category).toBe("gateway");
    expect(dispatch.extra).toMatchObject({
      modelId: "example-chat-model",
      messageCount: 2,
      timeoutMs: 12_000,
      stream: false,
    });
    expect(dispatch.extra?.endpointDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(typeof dispatch.extra?.bodyBytes).toBe("number");
    // Never the prompt content, and never the api key.
    expect(JSON.stringify(log.events)).not.toContain("some private prompt text");
    expect(JSON.stringify(log.events)).not.toContain(CONFIG.apiKey);

    // Activity Log proof (#3532): the dispatch line as the production file sink would persist it,
    // carrying the sanctioned unknown-correlation fallback since no logContext was supplied.
    const persisted = expectActivityLogProof(
      "chat.request.dispatch.emitted-line",
      formatActivityLogProofLine(dispatch),
    );
    expect(persisted).toMatchObject({
      modelId: "example-chat-model",
      messageCount: 2,
      timeoutMs: 12_000,
      stream: false,
    });
  });

  it("records only a digest of the dispatch endpoint", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });
    await adapter.call(REQUEST, CONFIG);
    const dispatch = eventFor(log.events, "chat.request.dispatch");
    expect(dispatch.extra?.endpointDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(dispatch)).not.toContain("provider.example");
  });

  it("sanitizes a body-bearing model id without replacing a successful response", async () => {
    const log = recorder();
    const modelId = "gpt 4 customer alias";
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });

    await expect(
      adapter.call({ ...REQUEST, modelId }, { ...CONFIG, modelId }),
    ).resolves.toMatchObject({ content: "pong" });

    expect(eventFor(log.events, "chat.request.dispatch").extra?.modelId).toBe(logModelId(modelId));
    expect(JSON.stringify(log.events)).not.toContain(modelId);
  });

  it("marks a streaming dispatch distinctly from a non-streaming one", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of adapter.callStream(REQUEST, CONFIG)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    const dispatch = eventFor(log.events, "chat.request.dispatch");
    expect(dispatch.extra).toMatchObject({ stream: true });
  });

  // CORRELATION, across the module boundary: the transport lines `http.ts` already emits for
  // every outbound call must carry the same correlation id as the attempt line above them, so an
  // operator reading an interleaved log can attribute both to the same chat call.
  it("stamps the caller's correlation id on the dispatch line and the transport lines beneath it", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
      logContext: { correlationId: "pod-run-9" },
    });
    await adapter.call(REQUEST, CONFIG);
    expect(log.events.length).toBeGreaterThan(1);
    expect(log.events.map((event) => event.correlationId)).toEqual(
      log.events.map(() => "pod-run-9"),
    );
    expect(log.events.map((event) => event.category)).toContain("http");
    expect(log.events.map((event) => event.category)).toContain("gateway");
  });

  it("uses the sanctioned fallback on every line when the caller supplies no logContext", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });
    await adapter.call(REQUEST, CONFIG);
    expect(log.events.map((event) => event.correlationId)).toEqual(
      log.events.map(() => "unknown-correlation-id"),
    );
  });

  it("stays silent — and behaviourally identical — when no sink is wired", async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
    });
    const result = await adapter.call(REQUEST, CONFIG);
    expect(result.content).toBe("pong");
  });

  // The gate from the port's side: a sink that declines `info` must never receive the attempt
  // line — `logLevelEnabled` is asked before the event is even built.
  it("skips the dispatch line entirely for a level-gated sink that declines info", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const gated: ModelGatewayLogSink = {
      write: (event): void => {
        events.push(event);
      },
      enabled: (level): boolean => level !== "info",
    };
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: gated,
    });
    await adapter.call(REQUEST, CONFIG);
    expect(events.map((event) => event.op)).not.toContain("chat.request.dispatch");
  });

  // BYTES on the wire, not `String.length`. A chat body is mostly message content, so for a CJK
  // or accented prompt the character count under-reports the request by two to four times.
  it("measures the request body in UTF-8 bytes, not UTF-16 code units", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });
    const request: GatewayRequest = {
      modelId: "example-chat-model",
      messages: [{ role: "user", content: "日本語テキスト" }],
    };
    await adapter.call(request, CONFIG);
    const dispatch = eventFor(log.events, "chat.request.dispatch");
    const bytes = dispatch.extra?.bodyBytes;
    expect(typeof bytes).toBe("number");
    expect(bytes as number).toBeGreaterThan("日本語テキスト".length);
  });

  // #3640: the dispatch line records the reasoning effort actually placed on the wire, so an
  // operator can tell "the provider's own tool-calling requirement replaced the selected effort"
  // apart from every value the product offers a Coding Workbench turn — the same "wire value, not
  // the request field" discipline #3591 already established for maxOutputTokens.
  it("records the tool-calling reasoning_effort override on the dispatch line, not the request's own selection", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });
    const request: GatewayRequest = {
      ...REQUEST,
      reasoningEffort: "medium",
      // This file's adapters use the real wall clock (no fake `now` override, unlike
      // openai-adapter.test.ts's adapterWith) — the offer must be issued against it, or the
      // catalog bridge reads it as expired against the real Date.now() (openai-adapter.compat.test.ts
      // uses the same Date.now() convention for the same reason).
      toolCatalog: gatewayCatalogAdvertisement(Date.now(), ["read_file"]),
    };
    await adapter.call(request, { ...CONFIG, modelId: "gpt-5.6" });
    const dispatch = eventFor(log.events, "chat.request.dispatch");
    expect(dispatch.extra?.reasoningEffort).toBe("none");

    const persisted = expectActivityLogProof(
      "chat.request.dispatch.emitted-line",
      formatActivityLogProofLine(dispatch),
    );
    expect(persisted).toMatchObject({ reasoningEffort: "none" });
  });

  it("records the request's own selected reasoning_effort on the dispatch line when no override applies", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });
    const request: GatewayRequest = { ...REQUEST, reasoningEffort: "medium" };
    await adapter.call(request, { ...CONFIG, modelId: "gpt-5.6" });
    const dispatch = eventFor(log.events, "chat.request.dispatch");
    expect(dispatch.extra?.reasoningEffort).toBe("medium");
  });

  it("omits reasoning_effort from the dispatch line when the request declared none and no override applies", async () => {
    const log = recorder();
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(successBody()));
    const adapter = new OpenAiAdapter({
      fetchImpl,
      requestId: "fixed-id",
      costClass: "low",
      log: log.sink,
    });
    await adapter.call(REQUEST, CONFIG);
    const dispatch = eventFor(log.events, "chat.request.dispatch");
    expect(dispatch.extra).not.toHaveProperty("reasoningEffort");
  });
});
