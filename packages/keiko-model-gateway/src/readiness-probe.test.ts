import { describe, expect, it, vi } from "vitest";
import { requestGatewayReadinessChatCompletion } from "./readiness-probe.js";
import type { ModelGatewayLogEvent } from "./observability.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1/",
  // Deliberately low-entropy and self-describing: the split-string form this replaced still
  // matched gitleaks' generic-api-key rule, failing the required Secret scan (#3042).
  apiKey: "not-a-secret-readiness-probe-fixture",
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
};

const CONFIG: GatewayConfig = {
  providers: [PROVIDER],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Azure's answer to a GPT-5 deployment that is sent max_tokens (#3639).
function unsupportedField(field: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `Unsupported parameter: '${field}' is not supported with this model.`,
        param: field,
        code: "unsupported_parameter",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function probeBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("expected a JSON probe body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("requestGatewayReadinessChatCompletion", () => {
  it("overrides raw body defaults with the admitted provider-specific output bound", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = (_url, init) => {
      if (typeof init?.body === "string") {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [], max_tokens: 128_000, max_completion_tokens: 128_000 },
      maxOutputTokens: 17,
      fetchImpl,
    });
    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, outputTokenParameter: "max_completion_tokens" },
      body: { messages: [], max_tokens: 128_000, max_completion_tokens: 128_000 },
      maxOutputTokens: 19,
      fetchImpl,
    });

    expect(bodies).toEqual([
      { model: PROVIDER.modelId, messages: [], max_tokens: 17 },
      { model: PROVIDER.modelId, messages: [], max_completion_tokens: 19 },
    ]);
  });

  it("trims a trailing slash from the base URL before joining /chat/completions", async () => {
    // LiteLLM production audit: a file/env-authored 'https://litellm.example.com/v1/' produced
    // '/v1//chat/completions', which LiteLLM answers with a 404 — the probe must trim exactly
    // like the sibling adapters (embedding, tts, stt, rerank, realtime) do.
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      if (typeof url === "string") seenUrl = url;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "Reply with exactly: OK" }] },
      fetchImpl,
    });

    expect(seenUrl).toBe("https://provider.example/v1/chat/completions");
  });

  it("keeps a base URL without a trailing slash unchanged", async () => {
    // The other half of the conditional trim: exercising only the slash-bearing branch would
    // let an unconditional slice(0, -1) pass, which would eat the last path character and
    // produce '/v/chat/completions' (review finding on #3042).
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      if (typeof url === "string") seenUrl = url;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, baseUrl: "https://provider.example/v1" },
      body: { messages: [{ role: "user", content: "Reply with exactly: OK" }] },
      fetchImpl,
    });

    expect(seenUrl).toBe("https://provider.example/v1/chat/completions");
  });

  it("uses the Azure deployment protocol for readiness probes", async () => {
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      seenUrl = url instanceof Request ? url.url : url.toString();
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: {
        ...PROVIDER,
        baseUrl: "https://provider.example",
        modelId: "deployment/name",
        endpointStyle: "azure-openai-deployment",
        apiVersion: "2025-03-01-preview",
      },
      body: { messages: [] },
      fetchImpl,
    });

    expect(seenUrl).toBe(
      "https://provider.example/openai/deployments/deployment%2Fname/chat/completions?api-version=2025-03-01-preview",
    );
  });

  // User finding #3643: a base URL that already ends in "/openai" — a shape Gateway Setup
  // accepts and persists (gateway-setup.test.ts's "https://example.openai.azure.com/openai"
  // case) — was sent to "/openai/openai/deployments/...", mirroring the same defect
  // openai-adapter.test.ts pins for the production adapter (both share
  // trimTrailingAzureOpenAiSegment in config.ts).
  it("does not duplicate the /openai segment when the base URL already ends in it (#3643)", async () => {
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      seenUrl = url instanceof Request ? url.url : url.toString();
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: {
        ...PROVIDER,
        baseUrl: "https://provider.example/openai",
        modelId: "deployment/name",
        endpointStyle: "azure-openai-deployment",
        apiVersion: "2025-03-01-preview",
      },
      body: { messages: [] },
      fetchImpl,
    });

    expect(seenUrl).toBe(
      "https://provider.example/openai/deployments/deployment%2Fname/chat/completions?api-version=2025-03-01-preview",
    );
  });

  it("sends the provider model id and credential header", async () => {
    let seenAuth: string | null = null;
    let seenBody = "";
    const fetchImpl: typeof fetch = (_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      seenBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [] },
      fetchImpl,
    });

    expect(seenAuth).toBe(`Bearer ${PROVIDER.apiKey}`);
    expect(JSON.parse(seenBody)).toMatchObject({ model: "example-chat-model" });
  });

  // User finding #3641: a strict OpenAI-compatible gateway that streams successfully but rejects
  // the optional stream_options field was recorded as "streaming unsupported" — this probe always
  // sent stream_options and returned the first (rejected) response as the verdict, although the
  // production adapter (OpenAiAdapter.dispatchCompatibleStream) already retries this exact
  // rejection without stream_options and succeeds on the same gateway.
  it("retries a streamed probe without stream_options after a rejection naming that field (#3641)", async () => {
    const seenBodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = (_url, init) => {
      call += 1;
      if (typeof init?.body === "string") {
        seenBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (call === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { param: "stream_options", code: "unsupported_parameter" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "probe" }] },
      stream: true,
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(call).toBe(2);
    expect(seenBodies).toEqual([
      {
        model: PROVIDER.modelId,
        messages: [{ role: "user", content: "probe" }],
        stream: true,
        stream_options: { include_usage: true },
      },
      { model: PROVIDER.modelId, messages: [{ role: "user", content: "probe" }], stream: true },
    ]);
  });

  // A rejection for another reason is rejected again without the field, so its verdict stands; the
  // probe never parses the untrusted error body to tell the two apart.
  it("keeps the verdict of a streamed probe rejected for an unrelated reason (#3641)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { param: "messages", message: "invalid" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "probe" }] },
      stream: true,
      fetchImpl,
    });

    expect(response.status).toBe(400);
    expect(call).toBe(2);
  });

  it("does not retry a streamed probe that failed with a non-shape status (#3641)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "probe" }] },
      stream: true,
      fetchImpl,
    });

    expect(response.status).toBe(503);
    expect(call).toBe(1);
  });

  it("does not retry a non-streamed probe (no stream_options is ever sent)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { param: "stream_options" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [] },
      fetchImpl,
    });

    expect(response.status).toBe(400);
    expect(call).toBe(1);
  });

  // User finding #3639: a deployment alias hides its model family, so a GPT-5 deployment named
  // "prod-chat" is probed with max_tokens and rejects it; the probe retries with the other field.
  it("retries a rejected probe once with the other output-token field (#3639)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = (_url, init) => {
      const body = probeBody(init);
      bodies.push(body);
      return Promise.resolve(
        "max_tokens" in body ? unsupportedField("max_tokens") : jsonResponse({ choices: [] }),
      );
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "prod-chat" },
      body: { messages: [] },
      maxOutputTokens: 17,
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(bodies).toEqual([
      { model: "prod-chat", messages: [], max_tokens: 17 },
      { model: "prod-chat", messages: [], max_completion_tokens: 17 },
    ]);
  });

  it("keeps an operator's explicit output-token field and its verdict (#3639)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { param: "max_tokens" } }), { status: 400 }),
      );
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, outputTokenParameter: "max_tokens" },
      body: { messages: [] },
      maxOutputTokens: 17,
      fetchImpl,
    });

    expect(response.status).toBe(400);
    expect(call).toBe(1);
  });

  // PR #3625 review: a rejection of another field is no reason to switch output-token fields — that
  // would cost a second paid request and misstate the cause in the log.
  it("does not switch output-token fields when the rejection names another cause", async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: ModelGatewayLogEvent[] = [];
    const errorEvidence = vi.fn(() => ({ frames: [], causeChain: [] }));
    const fetchImpl: typeof fetch = (_url, init) => {
      bodies.push(probeBody(init));
      return Promise.resolve(
        new Response(JSON.stringify({ error: { param: "messages" } }), { status: 400 }),
      );
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [] },
      stream: true,
      maxOutputTokens: 17,
      fetchImpl,
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      correlationId: "probe-corr-0005",
      errorEvidence,
    });

    expect(response.status).toBe(400);
    expect(
      bodies.map((body) => [
        Object.keys(body).find((key) => key.startsWith("max_")),
        "stream_options" in body,
      ]),
    ).toEqual([
      ["max_tokens", true],
      ["max_tokens", false],
    ]);
    const skipped = events.find(
      (event) => event.op === "gateway.readiness.compatibility-retry.skipped",
    );
    if (skipped === undefined) throw new TypeError("skipped retry evidence missing");
    expect(skipped).toMatchObject({
      correlationId: "probe-corr-0005",
      level: "info",
      extra: { sentField: "max_tokens", reason: "other-cause", rejectedStatus: 400 },
    });
    // A readable rejection is no failure: no error kind and no trace fields.
    expect(skipped).not.toHaveProperty("errorKind");
    expect(skipped.extra).not.toHaveProperty("frames");
    expect(skipped.extra).not.toHaveProperty("causeChain");
    expect(errorEvidence).not.toHaveBeenCalled();
    expectActivityLogProof(
      "gateway.readiness.compatibility-retry.skipped.line",
      formatActivityLogProofLine(skipped),
    );
  });

  // PR #3625 review: the caller handles the bare 400 and never reaches its own failure path, so the
  // skipped line itself carries the read error's frames and cause chain from the server's port.
  const streamFailure = new TypeError("terminated", { cause: new Error("other side closed") });
  it.each([
    {
      name: "a malformed body",
      body: (): BodyInit => "<html>bad gateway</html>",
      expectRead: (error: unknown): void => {
        expect(error).toBeInstanceOf(SyntaxError);
      },
    },
    {
      name: "a body stream that fails",
      body: (): BodyInit =>
        new ReadableStream<Uint8Array>({
          start: (controller): void => {
            controller.error(streamFailure);
          },
        }),
      expectRead: (error: unknown): void => {
        expect(error).toBe(streamFailure);
      },
    },
  ])(
    "does not switch output-token fields when the rejection is $name",
    async ({ body, expectRead }) => {
      const bodies: Record<string, unknown>[] = [];
      const events: ModelGatewayLogEvent[] = [];
      const readErrors: unknown[] = [];
      const evidence = {
        frames: ["packages/keiko-model-gateway/dist/readiness-probe.js:280:12"],
        causeChain: ["Error"],
      };
      const fetchImpl: typeof fetch = (_url, init) => {
        bodies.push(probeBody(init));
        return Promise.resolve(
          new Response(body(), { status: 400, headers: { "content-type": "text/html" } }),
        );
      };

      const response = await requestGatewayReadinessChatCompletion({
        config: CONFIG,
        provider: PROVIDER,
        body: { messages: [] },
        maxOutputTokens: 17,
        fetchImpl,
        log: {
          write: (event): void => {
            events.push(event);
          },
        },
        errorEvidence: (error) => {
          readErrors.push(error);
          return evidence;
        },
      });

      expect(response.status).toBe(400);
      expect(bodies).toHaveLength(1);
      expect(readErrors).toHaveLength(1);
      expectRead(readErrors[0]);
      const skipped = events.filter(
        (event) => event.op === "gateway.readiness.compatibility-retry.skipped",
      );
      expect(skipped).toMatchObject([
        {
          level: "warn",
          extra: {
            reason: "unreadable-rejection",
            sentField: "max_tokens",
            frames: evidence.frames,
            causeChain: evidence.causeChain,
          },
        },
      ]);
      expect(skipped[0]?.errorKind).toBeDefined();
      expectActivityLogProof(
        "gateway.readiness.compatibility-retry.skipped.line",
        formatActivityLogProofLine(skipped[0] ?? {}),
      );
    },
  );

  // PR #3625 review: the rejection is read once from the answer itself. Read from a clone, a body
  // over the cap cancelled only the clone's tee branch, whose cancellation waits for the untouched
  // original — the probe never settled.
  it("settles a rejection whose body exceeds the read cap instead of stalling", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("x".repeat(70 * 1024), { status: 400 }));

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [] },
      maxOutputTokens: 17,
      fetchImpl,
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
    });

    expect(response.status).toBe(400);
    expect(
      events.filter((event) => event.op === "gateway.readiness.compatibility-retry.skipped"),
    ).toMatchObject([{ extra: { reason: "unreadable-rejection" } }]);
  }, 5_000);

  // PR #3625 review: the probe's attempts and its compatibility retry are recorded under the probe's
  // correlation id, and the retry line says which field was rejected and how the retry answered.
  it("records an output-token field retry under the probe's correlation id", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const fetchImpl: typeof fetch = (_url, init) =>
      Promise.resolve(
        "max_tokens" in probeBody(init)
          ? unsupportedField("max_tokens")
          : jsonResponse({ choices: [] }),
      );

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "prod-chat" },
      body: { messages: [] },
      maxOutputTokens: 17,
      fetchImpl,
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      correlationId: "probe-corr-0001",
    });

    const retry = events.find((event) => event.op === "gateway.readiness.compatibility-retry");
    if (retry === undefined) throw new TypeError("readiness retry evidence missing");
    expect(retry).toMatchObject({
      correlationId: "probe-corr-0001",
      extra: { omittedField: "max_tokens", rejectedStatus: 400 },
    });
    expectActivityLogProof(
      "gateway.readiness.compatibility-retry.line",
      formatActivityLogProofLine(retry),
    );
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event) => event.correlationId === "probe-corr-0001")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(PROVIDER.apiKey);
  });

  // PR #3625 review: the retry is recorded before it is sent, so a retry that then throws still says
  // which field it left out, and its failure is a structured line of its own.
  it("records a compatibility retry that throws with its field and error kind", async () => {
    const events: ModelGatewayLogEvent[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(unsupportedField("max_tokens"));
      }
      return Promise.reject(new TypeError("synthetic transport failure"));
    };

    await expect(
      requestGatewayReadinessChatCompletion({
        config: CONFIG,
        provider: { ...PROVIDER, modelId: "prod-chat" },
        body: { messages: [] },
        maxOutputTokens: 17,
        fetchImpl,
        log: {
          write: (event): void => {
            events.push(event);
          },
        },
        correlationId: "probe-corr-0003",
      }),
    ).rejects.toThrow();

    const attempt = events.find((event) => event.op === "gateway.readiness.compatibility-retry");
    const failed = events.find(
      (event) => event.op === "gateway.readiness.compatibility-retry.failed",
    );
    if (attempt === undefined || failed === undefined) {
      throw new TypeError("readiness retry evidence missing");
    }
    expect(attempt).toMatchObject({
      correlationId: "probe-corr-0003",
      extra: { omittedField: "max_tokens", rejectedStatus: 400 },
    });
    expect(failed).toMatchObject({
      correlationId: "probe-corr-0003",
      extra: { omittedField: "max_tokens" },
    });
    expect(failed.errorKind).toBeDefined();
    expect(events.indexOf(attempt)).toBeLessThan(events.indexOf(failed));
    expectActivityLogProof(
      "gateway.readiness.compatibility-retry.failed.line",
      formatActivityLogProofLine(failed),
    );
  });

  it("records a compatibility retry the gateway rejects again as a failure", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const fetchImpl: typeof fetch = (_url, init) =>
      Promise.resolve(
        unsupportedField("max_tokens" in probeBody(init) ? "max_tokens" : "max_completion_tokens"),
      );

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "prod-chat" },
      body: { messages: [] },
      maxOutputTokens: 17,
      fetchImpl,
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      correlationId: "probe-corr-0004",
    });

    expect(response.status).toBe(400);
    const failed = events.find(
      (event) => event.op === "gateway.readiness.compatibility-retry.failed",
    );
    expect(failed).toMatchObject({
      correlationId: "probe-corr-0004",
      level: "warn",
      status: 400,
      errorKind: "invalid-request",
      extra: { omittedField: "max_tokens" },
    });
  });

  it("records a stream-options retry of a streamed probe", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const fetchImpl: typeof fetch = (_url, init) =>
      Promise.resolve(
        "stream_options" in probeBody(init)
          ? new Response(JSON.stringify({ error: { param: "stream_options" } }), { status: 400 })
          : jsonResponse({ choices: [] }),
      );

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [] },
      stream: true,
      fetchImpl,
      log: {
        write: (event): void => {
          events.push(event);
        },
      },
      correlationId: "probe-corr-0002",
    });

    expect(
      events.filter((event) => event.op === "gateway.readiness.compatibility-retry"),
    ).toMatchObject([{ extra: { omittedField: "stream_options", rejectedStatus: 400 } }]);
  });

  // User finding #3640: Azure GPT-5.6 tool calls cannot pass Coding Workbench readiness. The
  // forced tool-calling probe (packages/keiko-server's gateway-tool-calling-probe.ts) sends
  // `tools`/`tool_choice` with no reasoning_effort at all; Azure requires exactly "none" for a
  // reasoning-model-family deployment once tools are attached, and the model's own default effort
  // is not "none", so the probe was rejected and the deployment recorded as not supporting tool
  // calling.
  it("forces reasoning_effort 'none' for a reasoning-model-family deployment once the probe body attaches tools (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "gpt-5.6" },
      body: {
        messages: [{ role: "user", content: "Call the report_readiness tool with status ok." }],
        tools: [{ type: "function", function: { name: "report_readiness" } }],
        tool_choice: { type: "function", function: { name: "report_readiness" } },
      },
      fetchImpl,
    });

    expect(seenBody.reasoning_effort).toBe("none");
  });

  it("does not force reasoning_effort for a reasoning-model-family deployment when the probe body has no tools (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "gpt-5.6" },
      body: { messages: [{ role: "user", content: "Reply with exactly: OK" }] },
      fetchImpl,
    });

    expect(seenBody).not.toHaveProperty("reasoning_effort");
  });

  it("does not force reasoning_effort for a non-reasoning-family deployment even with tools attached (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: {
        messages: [{ role: "user", content: "Call the report_readiness tool with status ok." }],
        tools: [{ type: "function", function: { name: "report_readiness" } }],
        tool_choice: { type: "function", function: { name: "report_readiness" } },
      },
      fetchImpl,
    });

    expect(seenBody).not.toHaveProperty("reasoning_effort");
  });

  // Only GPT-5.6 carries that contract: a gpt-5.4 deployment is probed as before.
  it("does not force reasoning_effort for a gpt-5.4 deployment with tools attached (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "gpt-5.4" },
      body: {
        messages: [{ role: "user", content: "Call the report_readiness tool with status ok." }],
        tools: [{ type: "function", function: { name: "report_readiness" } }],
        tool_choice: { type: "function", function: { name: "report_readiness" } },
      },
      fetchImpl,
    });

    expect(seenBody).not.toHaveProperty("reasoning_effort");
  });
});
