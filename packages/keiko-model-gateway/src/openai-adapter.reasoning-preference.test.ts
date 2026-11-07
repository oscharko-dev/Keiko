// reasoningPreference "off": a server-chosen request for no reasoning on a mechanical call. The
// wire value "none" stays out of the user-selectable ModelReasoningEffort union (#3640); a provider
// that rejects the parameter is answered once without it and the deployment remembers.

import { afterEach, describe, expect, it } from "vitest";
import { gatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { OpenAiAdapter, resetChatCompatibilityMemoForTests } from "./openai-adapter.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type { GatewayRequest, ModelProviderConfig, NormalizedResponse } from "./types.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const CONFIG: ModelProviderConfig = {
  modelId: "gemma-4-31b-it",
  baseUrl: "https://gateway.example/v1",
  apiKey: "fixture-key",
  timeoutMs: 10_000,
  maxRetries: 0,
  retryBaseDelayMs: 0,
};

const REQUEST: GatewayRequest = {
  modelId: CONFIG.modelId,
  messages: [{ role: "user", content: "Synthetic prompt" }],
  reasoningPreference: "off",
};

afterEach(() => {
  resetChatCompatibilityMemoForTests();
});

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("expected JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function answer(streamed = false): Response {
  if (streamed) {
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ];
    return new Response(frames.join("\n\n"), { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json({
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  });
}

function rejection(message: string, param?: string): Response {
  return Response.json(
    {
      error: { message, ...(param === undefined ? {} : { param }), code: "unsupported_parameter" },
    },
    { status: 400 },
  );
}

interface Harness {
  readonly bodies: Record<string, unknown>[];
  readonly events: ModelGatewayLogEvent[];
  readonly adapter: OpenAiAdapter;
}

function harness(respond: (body: Record<string, unknown>) => Response): Harness {
  const bodies: Record<string, unknown>[] = [];
  const events: ModelGatewayLogEvent[] = [];
  const adapter = new OpenAiAdapter({
    requestId: "reasoning-preference",
    costClass: "low",
    fetchImpl: (_url, init): Promise<Response> => {
      const body = bodyOf(init);
      bodies.push(body);
      return Promise.resolve(respond(body));
    },
    log: {
      write: (event): void => {
        events.push(event);
      },
    },
    logContext: { correlationId: "run-reasoning-preference" },
  });
  return { bodies, events, adapter };
}

function ask(h: Harness, request: GatewayRequest = REQUEST): Promise<NormalizedResponse> {
  return h.adapter.call(request, CONFIG);
}

describe("OpenAiAdapter reasoningPreference", () => {
  it("sends the wire-only reasoning_effort none and records it on the dispatch line", async () => {
    const h = harness(() => answer());
    await ask(h);
    expect(h.bodies[0]?.reasoning_effort).toBe("none");
    const dispatch = h.events.find((event) => event.op === "chat.request.dispatch");
    expect(dispatch?.extra?.reasoningEffort).toBe("none");
  });

  it("sends nothing without the preference", async () => {
    const h = harness(() => answer());
    await ask(h, { ...REQUEST, reasoningPreference: undefined });
    expect(h.bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("lets an explicit reasoningEffort win", async () => {
    const h = harness(() => answer());
    await ask(h, { ...REQUEST, reasoningEffort: "high" });
    expect(h.bodies[0]?.reasoning_effort).toBe("high");
  });

  it("keeps the GPT-5.6 tool override, and never retries it as a preference", async () => {
    const h = harness(() => answer());
    await h.adapter.call(
      {
        ...REQUEST,
        modelId: "gpt-5.6",
        toolCatalog: gatewayCatalogAdvertisement(Date.now(), ["read_file"]),
      },
      { ...CONFIG, modelId: "gpt-5.6" },
    );
    expect(h.bodies[0]?.reasoning_effort).toBe("none");
  });

  it("retries once without the field when the provider rejects it, and remembers", async () => {
    const h = harness((body) =>
      "reasoning_effort" in body
        ? rejection("hosted_vllm does not support parameters: ['reasoning_effort']")
        : answer(),
    );
    await expect(ask(h)).resolves.toMatchObject({ content: "ok" });
    await expect(ask(h)).resolves.toMatchObject({ content: "ok" });
    expect(h.bodies.map((body) => "reasoning_effort" in body)).toEqual([true, false, false]);
    const retries = h.events.filter((event) => event.op === "chat.request.compatibility-retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      correlationId: "run-reasoning-preference",
      status: 400,
      extra: { omittedField: "reasoning_effort" },
    });
    const retry = retries[0];
    if (retry === undefined) throw new TypeError("retry evidence missing");
    expectActivityLogProof(
      "chat.request.compatibility-retry.emitted-line",
      formatActivityLogProofLine(retry),
    );
    expect(JSON.stringify(h.events)).not.toContain(CONFIG.apiKey);
  });

  it("retries a streamed call too", async () => {
    const h = harness((body) =>
      "reasoning_effort" in body
        ? rejection("Unknown parameter", "reasoning_effort")
        : answer(body.stream === true),
    );
    const chunks: unknown[] = [];
    for await (const chunk of h.adapter.callStream(REQUEST, CONFIG)) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: "done", response: { content: "ok" } });
    expect(h.bodies.map((body) => "reasoning_effort" in body)).toEqual([true, false]);
  });

  it("does not retry a rejection that does not name reasoning_effort", async () => {
    const h = harness(() => rejection("Unsupported parameter: 'max_tokens'", "max_tokens"));
    await expect(ask(h)).rejects.toThrow();
    expect(h.bodies).toHaveLength(1);
    expect(h.events.some((event) => event.op === "chat.request.compatibility-retry")).toBe(false);
  });

  it("does not retry an explicit reasoningEffort the provider rejects", async () => {
    const h = harness(() => rejection("Unsupported parameter", "reasoning_effort"));
    await expect(ask(h, { ...REQUEST, reasoningEffort: "high" })).rejects.toThrow();
    expect(h.bodies).toHaveLength(1);
  });

  it("forgets the omission when the retry fails too", async () => {
    let calls = 0;
    const h = harness((body) => {
      calls += 1;
      if ("reasoning_effort" in body) return rejection("Unknown parameter", "reasoning_effort");
      return calls <= 2 ? Response.json({ error: { message: "boom" } }, { status: 400 }) : answer();
    });
    await expect(ask(h)).rejects.toThrow();
    await ask(h);
    expect(h.bodies.map((body) => "reasoning_effort" in body)).toEqual([true, false, true, false]);
  });
});
