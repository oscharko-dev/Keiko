import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  type GatewayConfig,
  type ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import { probeGatewayToolCalling } from "./gateway-tool-calling-probe.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1",
  apiKey: "not-a-secret-tool-calling-probe-fixture",
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 0,
};

const CONFIG: GatewayConfig = {
  providers: [PROVIDER],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
};

const CAPABILITY = {
  ...createDefaultChatCapability(PROVIDER.modelId),
  maxOutputTokens: 20,
  pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBodyAt(fetchImpl: typeof fetch, index: number): Record<string, unknown> {
  const body = vi.mocked(fetchImpl).mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new TypeError("expected probe request body");
  return JSON.parse(body) as Record<string, unknown>;
}

function streamedToolResponse(argumentsText = '{"status":"ok"}'): Response {
  const events = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "probe-call",
                type: "function",
                function: { name: "report_readiness", arguments: argumentsText.slice(0, 5) },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(5) } }] } },
      ],
    },
    {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

const STREAMING_CONFIG: GatewayConfig = { ...CONFIG, capabilities: [CAPABILITY] };

describe("probeGatewayToolCalling", () => {
  it("proves fragmented native calls on the configured streaming path in one request", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(streamedToolResponse())) as typeof fetch;
    const reportFailure = vi.fn();
    await expect(
      probeGatewayToolCalling(STREAMING_CONFIG, PROVIDER, fetchImpl, reportFailure),
    ).resolves.toBe("verified");
    expect(requestBodyAt(fetchImpl, 0)).toMatchObject({ stream: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["unterminated EOF", ""],
    [
      "failed generation",
      'data: {"error":{"code":"503","message":"synthetic unavailable"}}\n\ndata: [DONE]\n\n',
    ],
  ])("does not verify a valid streamed call followed by %s", async (_label, suffix) => {
    const body = (await streamedToolResponse().text())
      .split("\n\n")
      .filter((frame) => !frame.includes("finish_reason") && !frame.includes("[DONE]"))
      .join("\n\n");
    const reportFailure = vi.fn();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(body + suffix, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    await expect(
      probeGatewayToolCalling(STREAMING_CONFIG, PROVIDER, fetchImpl, reportFailure),
    ).resolves.toBe("unverified");
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it.each(["finish_reason", "[DONE]"])("accepts the actual %s terminal marker", async (marker) => {
    const body = (await streamedToolResponse().text())
      .split("\n\n")
      .filter((frame) =>
        marker === "[DONE]" ? !frame.includes("finish_reason") : !frame.includes("[DONE]"),
      )
      .join("\n\n");
    const reportFailure = vi.fn();
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    await expect(
      probeGatewayToolCalling(STREAMING_CONFIG, PROVIDER, fetchImpl, reportFailure),
    ).resolves.toBe("verified");
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it.each(["{", '{"status":"wrong"}', '{"status":"ok","extra":true}'])(
    "rejects invalid streamed readiness arguments %s without blaming transport",
    async (argumentsText) => {
      const reportFailure = vi.fn();
      const fetchImpl: typeof fetch = () => Promise.resolve(streamedToolResponse(argumentsText));
      await expect(
        probeGatewayToolCalling(STREAMING_CONFIG, PROVIDER, fetchImpl, reportFailure),
      ).resolves.toBe("unsupported");
      expect(reportFailure).not.toHaveBeenCalled();
    },
  );

  it("uses buffering for a model configured without streaming", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "report_readiness", arguments: '{"status":"ok"}' } },
                ],
              },
            },
          ],
        }),
      ),
    ) as typeof fetch;
    await expect(
      probeGatewayToolCalling(
        { ...STREAMING_CONFIG, capabilities: [{ ...CAPABILITY, streaming: false }] },
        PROVIDER,
        fetchImpl,
      ),
    ).resolves.toBe("verified");
    expect(requestBodyAt(fetchImpl, 0).stream).not.toBe(true);
  });

  it("reserves the shared spend ceiling before dispatching the paid probe", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-tool-probe-budget-"));
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ choices: [] }))) as typeof fetch;
    const reportFailure = vi.fn();
    try {
      await expect(
        probeGatewayToolCalling(CONFIG, PROVIDER, fetchImpl, reportFailure, {
          env: {
            [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "0",
            [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(stateDir, "spend.json"),
          },
          capability: CAPABILITY,
          correlationId: "request-correlation-abcdefg",
        }),
      ).resolves.toBe("unverified");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(reportFailure).toHaveBeenCalledOnce();
      expect(reportFailure.mock.calls[0]?.[0]).toMatchObject({
        message: "spend-budget-exceeded",
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "settles provider usage so the next bounded probe is admitted (streamed: %s)",
    async (streamed) => {
      const stateDir = mkdtempSync(join(tmpdir(), "keiko-tool-probe-settlement-"));
      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "report_readiness", arguments: '{"status":"ok"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      const fetchImpl = vi.fn(() =>
        Promise.resolve(streamed ? streamedToolResponse() : jsonResponse(payload)),
      ) as typeof fetch;
      const spend = {
        env: {
          [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "0.0042",
          [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(stateDir, "spend.json"),
        },
        capability: CAPABILITY,
        correlationId: "request-correlation-abcdefg",
      };
      try {
        await expect(
          probeGatewayToolCalling(CONFIG, PROVIDER, fetchImpl, undefined, spend),
        ).resolves.toBe("verified");
        await expect(
          probeGatewayToolCalling(CONFIG, PROVIDER, fetchImpl, undefined, spend),
        ).resolves.toBe("verified");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(requestBodyAt(fetchImpl, 0)).toMatchObject({
          max_tokens: CAPABILITY.maxOutputTokens,
        });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("verifies support only when the forced function call is present", async () => {
    let requestBody = "";
    const fetchImpl: typeof fetch = (_url, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "report_readiness", arguments: '{"status":"ok"}' } },
                ],
              },
            },
          ],
        }),
      );
    };

    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, fetchImpl)).resolves.toBe("verified");
    expect(JSON.parse(requestBody)).toMatchObject({
      tool_choice: { type: "function", function: { name: "report_readiness" } },
    });
  });

  it("marks rejected and malformed successful responses as unsupported", async () => {
    const rejected: typeof fetch = () => Promise.resolve(jsonResponse({}, 400));
    const missingCall: typeof fetch = () => Promise.resolve(jsonResponse({ choices: [] }));

    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, rejected)).resolves.toBe("unsupported");
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, missingCall)).resolves.toBe(
      "unsupported",
    );
  });

  // Review of #3591: an overloaded gateway's 429/503 is no verdict on the model; a 501 is.
  it("reports a transient gateway status without a verdict", async () => {
    for (const status of [408, 429, 502, 503, 504]) {
      const busy: typeof fetch = () => Promise.resolve(jsonResponse({}, status));
      await expect(probeGatewayToolCalling(CONFIG, PROVIDER, busy)).resolves.toBe("transient");
    }
    const notImplemented: typeof fetch = () => Promise.resolve(jsonResponse({}, 501));
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, notImplemented)).resolves.toBe(
      "unsupported",
    );
    const forbidden: typeof fetch = () => Promise.resolve(jsonResponse({}, 403));
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, forbidden)).resolves.toBe("unverified");
  });

  it("rejects malformed, incomplete, or unexpected forced-call arguments", async () => {
    const malformed: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: { tool_calls: [{ function: { name: "report_readiness", arguments: "{" } }] },
            },
          ],
        }),
      );
    const unexpected: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "report_readiness", arguments: '{"status":"no"}' } },
                ],
              },
            },
          ],
        }),
      );
    const emptyArguments: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: "report_readiness", arguments: "{}" } }],
              },
            },
          ],
        }),
      );
    const extraArgument: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "report_readiness",
                      arguments: '{"status":"ok","extra":"value"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      );

    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, malformed)).resolves.toBe("unsupported");
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, unexpected)).resolves.toBe(
      "unsupported",
    );
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, emptyArguments)).resolves.toBe(
      "unsupported",
    );
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, extraArgument)).resolves.toBe(
      "unsupported",
    );
  });

  // The pin: a rate limit is never stored as a verdict. Since the #3591 review it is named for
  // what it is (`transient`) so the caller can retry soon instead of waiting out a long cooldown.
  it("keeps a transient client status out of the verdicts", async () => {
    const rateLimited: typeof fetch = () => Promise.resolve(jsonResponse({}, 429));
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, rateLimited)).resolves.toBe("transient");
  });

  it("fails closed when the gateway is unavailable", async () => {
    const unavailable: typeof fetch = () => Promise.resolve(jsonResponse({}, 503));
    const interrupted: typeof fetch = () => Promise.reject(new TypeError("fixture interruption"));

    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, unavailable)).resolves.toBe("transient");
    await expect(probeGatewayToolCalling(CONFIG, PROVIDER, interrupted)).resolves.toBe(
      "unverified",
    );
  });
});
