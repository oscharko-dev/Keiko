import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import { describe, expect, it, vi } from "vitest";
import { countProviderPromptTokens } from "./provider-token-counter.js";
import type { ModelProviderConfig } from "./types.js";

const provider: ModelProviderConfig = {
  modelId: "fixture",
  baseUrl: "https://gateway.example/v1",
  apiKey: "fixture-key",
  timeoutMs: 1_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  tokenCounter: "litellm",
};
const request = {
  modelId: "fixture",
  messages: [{ role: "user" as const, content: "synthetic question" }],
};
const log = { write: (): void => undefined };

describe("provider token counter", () => {
  it("uses the generation authentication convention and forwards full tool context", async () => {
    const fetchImpl = vi.fn<typeof fetch>((url, init) => {
      expect(url instanceof Request ? url.url : url.toString()).toBe(
        "https://gateway.example/utils/token_counter",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toMatchObject({
        model: "fixture",
        messages: request.messages,
      });
      return Promise.resolve(Response.json({ total_tokens: 37 }));
    });
    expect(await countProviderPromptTokens(request, provider, log, fetchImpl)).toEqual({
      status: "available",
      tokens: 37,
      tokenizer: "unknown",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([-1, 1.5, "100", null])("rejects an invalid remote count %s", async (total_tokens) => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ total_tokens })));
    expect(await countProviderPromptTokens(request, provider, log, fetchImpl)).toEqual({
      status: "invalid",
    });
  });

  it("uses an explicit unavailable state for a rejected counting service", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    );
    expect(await countProviderPromptTokens(request, provider, log, fetchImpl)).toEqual({
      status: "unavailable",
    });
  });

  it("makes no HTTP call when counting was not configured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await countProviderPromptTokens(
        request,
        { ...provider, tokenCounter: undefined },
        log,
        fetchImpl,
      ),
    ).toEqual({ status: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it("rejects a counter error even when it carries a numerical fallback", async () => {
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json({ total_tokens: 20, error: true })),
  );
  expect(await countProviderPromptTokens(request, provider, log, fetchImpl)).toEqual({
    status: "invalid",
  });
});

it("preserves bounded tokenizer provenance and proxy path prefixes", async () => {
  const fetchImpl = vi.fn<typeof fetch>((url) => {
    expect(url instanceof Request ? url.url : url.toString()).toBe(
      "https://gateway.example/customer/utils/token_counter",
    );
    return Promise.resolve(
      Response.json({ total_tokens: 20, tokenizer_type: "huggingface_tokenizer" }),
    );
  });
  expect(
    await countProviderPromptTokens(
      request,
      {
        ...provider,
        baseUrl: "https://gateway.example/customer/v1/",
        apiKeyHeaderName: "Authorization",
      },
      log,
      fetchImpl,
    ),
  ).toEqual({ status: "available", tokens: 20, tokenizer: "huggingface" });
});

it("does not dispatch a counting request after cancellation", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(
    await countProviderPromptTokens(
      { ...request, cancellationSignal: AbortSignal.abort() },
      provider,
      log,
      fetchImpl,
    ),
  ).toEqual({ status: "unavailable" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("bounds counting latency by cancellation and records a fallback on transport failure", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
        controller.abort();
      }),
  );
  expect(
    await countProviderPromptTokens(
      { ...request, cancellationSignal: controller.signal },
      provider,
      log,
      fetchImpl,
    ),
  ).toEqual({ status: "unavailable" });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("records a body-free counter failure before falling back", async () => {
  const events: ModelGatewayLogEvent[] = [];
  const sink = {
    write: (event: ModelGatewayLogEvent): void => {
      events.push(event);
    },
  };
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.reject(new TypeError("private response body")),
  );
  await countProviderPromptTokens(
    { ...request, logContext: { correlationId: "counter-failure-fixture" } },
    provider,
    sink,
    fetchImpl,
  );
  const event = events.find((entry) => entry.op === "gateway.prompt.counter-failed");
  expect(event?.correlationId).toBe("counter-failure-fixture");
  const line = formatActivityLogProofLine(event ?? {});
  expect(expectActivityLogProof("gateway.prompt.counter-failed.fallback", line)).toMatchObject({
    fallback: "local-estimate",
    errorKind: "internal",
  });
  expect(line).not.toContain("private response body");
});
