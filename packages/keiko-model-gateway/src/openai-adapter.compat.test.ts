import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiAdapter, resetChatCompatibilityMemoForTests } from "./openai-adapter.js";
import { gatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type { GatewayStreamChunk, ModelProviderConfig } from "./types.js";
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

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("expected JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

function streamedAnswer(): Response {
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}',
    ": ping",
    'data: {"choices":[{"index":0,"delta":{"content":"Synthetic answer."},"finish_reason":null}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ];
  return new Response(frames.join("\n\n"), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAI-compatible chat compatibility", () => {
  beforeEach(resetChatCompatibilityMemoForTests);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not retry a context overflow after the provider has rejected the turn", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = new OpenAiAdapter({
      requestId: "context-overflow",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        bodies.push(requestBody(init));
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "context length exceeded" } }), {
            status: 400,
          }),
        );
      },
    });

    const consume = async (): Promise<void> => {
      for await (const _chunk of adapter.callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        CONFIG,
      )) {
        // No chunk can be emitted after a rejected request.
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "GATEWAY_CONTEXT_OVERFLOW" });
    expect(bodies).toHaveLength(1);
  });

  it("retries optional stream metadata rejected by a proxy policy", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = new OpenAiAdapter({
      requestId: "proxy-policy",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        const body = requestBody(init);
        bodies.push(body);
        return Promise.resolve(
          "stream_options" in body
            ? new Response(
                JSON.stringify({ error: { message: "stream_options disabled by policy" } }),
                {
                  status: 400,
                },
              )
            : streamedAnswer(),
        );
      },
    });
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of adapter.callStream(
      { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
      CONFIG,
    )) {
      chunks.push(chunk);
    }
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      response: { content: "Synthetic answer." },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("stream_options");
  });

  it("does not retry a provider policy refusal as a request-shape error", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = new OpenAiAdapter({
      requestId: "policy-refusal",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        bodies.push(requestBody(init));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "policy_violation", message: "Request blocked by policy" },
            }),
            { status: 400 },
          ),
        );
      },
    });
    const consume = async (): Promise<void> => {
      for await (const _chunk of adapter.callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        CONFIG,
      )) {
        // A refused turn cannot produce a response chunk.
      }
    };

    await expect(consume()).rejects.toMatchObject({ code: "GATEWAY_MODEL_REFUSAL" });
    expect(bodies).toHaveLength(1);
  });

  it.each(["policy_violation", "POLICY_VIOLATION", "ResponsibleAIPolicyViolation"])(
    "keeps a structured %s refusal terminal when its text mentions stream_options",
    async (code) => {
      const bodies: Record<string, unknown>[] = [];
      const adapter = new OpenAiAdapter({
        requestId: `structured-policy-refusal-${code}`,
        costClass: "low",
        fetchImpl: (_url, init): Promise<Response> => {
          bodies.push(requestBody(init));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code,
                  param: "messages",
                  message: "Prompt text containing stream_options violates policy",
                },
              }),
              { status: 400 },
            ),
          );
        },
      });
      const consume = async (): Promise<void> => {
        for await (const _chunk of adapter.callStream(
          { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
          CONFIG,
        )) {
          // A refusal does not produce a response chunk.
        }
      };
      await expect(consume()).rejects.toMatchObject({ code: "GATEWAY_MODEL_REFUSAL" });
      expect(bodies).toHaveLength(1);
    },
  );

  it("keeps a prompt-parameter policy refusal terminal without a structured code", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = new OpenAiAdapter({
      requestId: "prompt-parameter-refusal",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        bodies.push(requestBody(init));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                param: "messages",
                message: "Prompt text containing stream_options violates policy",
              },
            }),
            { status: 400 },
          ),
        );
      },
    });
    const consume = async (): Promise<void> => {
      for await (const _chunk of adapter.callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        CONFIG,
      )) {
        // A refused turn cannot produce a response chunk.
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "GATEWAY_MODEL_REFUSAL" });
    expect(bodies).toHaveLength(1);
  });

  it("stops after one compatibility retry when the minimal request also fails", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = new OpenAiAdapter({
      requestId: "minimal-rejected",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        bodies.push(requestBody(init));
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "bad_request" } }), {
            status: 400,
          }),
        );
      },
    });
    const consume = async (): Promise<void> => {
      for await (const _chunk of adapter.callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        CONFIG,
      )) {
        // A rejected request cannot produce a response chunk.
      }
    };

    await expect(consume()).rejects.toMatchObject({ code: "GATEWAY_PROVIDER_ERROR" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("stream_options");
  });

  it("keeps the original read budget across the optional-field retry", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const adapter = new OpenAiAdapter({
      requestId: "shared-budget",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        calls += 1;
        const first = calls === 1;
        const response = first
          ? new Response(JSON.stringify({ error: { code: "unsupported_parameter" } }), {
              status: 400,
            })
          : streamedAnswer();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              resolve(response);
            },
            first ? 70 : 40,
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error(String(init.signal?.reason)));
            },
            { once: true },
          );
        });
      },
    });
    const consume = async (): Promise<void> => {
      for await (const _chunk of adapter.callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        CONFIG,
        { silenceMs: 100, budgetMs: 100 },
      )) {
        // The fallback cannot complete outside the original budget.
      }
    };
    const pending = consume();
    const rejected = expect(pending).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(110);
    await rejected;
    expect(calls).toBe(2);
  });

  it("keeps the provider timeout across both attempts without explicit read bounds", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException("timeout", "TimeoutError"));
      }, ms);
      return controller.signal;
    });
    let calls = 0;
    const adapter = new OpenAiAdapter({
      requestId: "shared-provider-timeout",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        calls += 1;
        const first = calls === 1;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              resolve(first ? new Response("{}", { status: 400 }) : streamedAnswer());
            },
            first ? 70 : 40,
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error(String(init.signal?.reason)));
            },
            { once: true },
          );
        });
      },
    });
    const consume = async (): Promise<void> => {
      for await (const _chunk of adapter.callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        { ...CONFIG, timeoutMs: 100 },
      )) {
        // The fallback cannot complete outside the original provider timeout.
      }
    };
    const rejected = expect(consume()).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(110);
    await rejected;
    expect(calls).toBe(2);
  });

  it("retries a strict proxy without optional streaming usage and remembers the accepted shape", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: ModelGatewayLogEvent[] = [];
    const fetchImpl: typeof fetch = (_url, init) => {
      const body = requestBody(init);
      bodies.push(body);
      return Promise.resolve(
        "stream_options" in body
          ? new Response(JSON.stringify({ error: { code: "unsupported_parameter" } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            })
          : streamedAnswer(),
      );
    };
    const adapter = new OpenAiAdapter({
      requestId: "compat",
      costClass: "low",
      fetchImpl,
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      logContext: { correlationId: "run-compat" },
    });

    for (let turn = 0; turn < 2; turn += 1) {
      const chunks: GatewayStreamChunk[] = [];
      for await (const chunk of adapter.callStream(
        {
          modelId: CONFIG.modelId,
          messages: [{ role: "user", content: "Synthetic prompt" }],
          toolCatalog: gatewayCatalogAdvertisement(Date.now(), ["read_file"]),
        },
        CONFIG,
      )) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1)).toMatchObject({
        type: "done",
        response: { content: "Synthetic answer." },
      });
    }

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveProperty("stream_options.include_usage", true);
    expect(bodies[1]).not.toHaveProperty("stream_options");
    expect(bodies[2]).not.toHaveProperty("stream_options");
    expect(bodies[0]?.tools).toEqual(bodies[1]?.tools);
    expect(bodies[0]?.messages).toEqual(bodies[1]?.messages);
    const retries = events.filter((event) => event.op === "chat.request.compatibility-retry");
    expect(retries).toHaveLength(1);
    const retry = retries[0];
    if (retry === undefined) throw new TypeError("compatibility retry evidence missing");
    expect(retry).toMatchObject({
      correlationId: "run-compat",
      status: 400,
      extra: { omittedField: "stream_options" },
    });
    expectActivityLogProof(
      "chat.request.compatibility-retry.emitted-line",
      formatActivityLogProofLine(retry),
    );
    expect(JSON.stringify(events)).not.toContain(CONFIG.apiKey);
  });

  it("does not share the strict-proxy memo across credentials at one endpoint", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = new OpenAiAdapter({
      requestId: "credential-scoped",
      costClass: "low",
      fetchImpl: (_url, init): Promise<Response> => {
        const body = requestBody(init);
        bodies.push(body);
        return Promise.resolve(
          "stream_options" in body
            ? new Response(JSON.stringify({ error: { code: "unsupported_parameter" } }), {
                status: 400,
              })
            : streamedAnswer(),
        );
      },
    });
    for (const apiKey of ["tenant-a", "tenant-b"]) {
      for await (const _chunk of adapter.callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        { ...CONFIG, apiKey },
      )) {
        // Drain each accepted stream before changing tenant identity.
      }
    }
    expect(bodies).toHaveLength(4);
    expect(bodies[2]).toHaveProperty("stream_options.include_usage", true);
  });

  it("reprobes optional usage metadata after the compatibility memo expires", async () => {
    let now = 0;
    const bodies: Record<string, unknown>[] = [];
    const deps = {
      requestId: "memo-expiry",
      costClass: "low" as const,
      now: (): number => now,
      fetchImpl: (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const body = requestBody(init);
        bodies.push(body);
        return Promise.resolve(
          "stream_options" in body
            ? new Response(JSON.stringify({ error: { code: "unsupported_parameter" } }), {
                status: 400,
              })
            : streamedAnswer(),
        );
      },
    };
    for (let turn = 0; turn < 2; turn += 1) {
      for await (const _chunk of new OpenAiAdapter(deps).callStream(
        { modelId: CONFIG.modelId, messages: [{ role: "user", content: "Synthetic prompt" }] },
        CONFIG,
      )) {
        // Drain each accepted stream before advancing the injected clock.
      }
      now += 24 * 60 * 60 * 1_000;
    }
    expect(bodies).toHaveLength(4);
    expect(bodies[2]).toHaveProperty("stream_options.include_usage", true);
  });
});
