import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  type GatewayConfig,
  type ModelProviderConfig,
} from "@oscharko-dev/keiko-model-gateway";
import {
  probeGatewayToolCalling,
  probeGatewayToolCallingVerdict,
} from "./gateway-tool-calling-probe.js";
import * as spendBudget from "./gateway-spend-budget.js";
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

  it("verifies support only when the offered function is actually called", async () => {
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
    // Production offers tools without forcing one, and the check runs the same way first (#4351).
    expect(JSON.parse(requestBody)).not.toHaveProperty("tool_choice");
  });

  // #4351 (owner decisions 2026-11-13): the check first runs exactly as production does, with the
  // tool offered and no forced tool_choice; only a model that called none is asked with the forced call.
  describe("two-step tool-calling check", () => {
    const CALL = {
      choices: [
        {
          message: {
            tool_calls: [{ function: { name: "report_readiness", arguments: '{"status":"ok"}' } }],
          },
        },
      ],
    };
    const PLAIN = { choices: [{ message: { content: "I will not call a tool." } }] };

    function scripted(
      unforced: () => Response,
      forced: () => Response,
    ): { readonly fetchImpl: typeof fetch; readonly bodies: Record<string, unknown>[] } {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof fetch = (_url, init) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
          string,
          unknown
        >;
        bodies.push(body);
        return Promise.resolve(body.tool_choice === undefined ? unforced() : forced());
      };
      return { fetchImpl, bodies };
    }

    it("a model that calls the tool unforced is verified in one request, without tool_choice", async () => {
      const { fetchImpl, bodies } = scripted(
        () => jsonResponse(CALL),
        () => {
          throw new Error("a forced call must not be needed");
        },
      );
      await expect(probeGatewayToolCallingVerdict(CONFIG, PROVIDER, fetchImpl)).resolves.toEqual({
        status: "verified",
        outcome: "called-unforced",
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toHaveProperty("tool_choice");
      expect(bodies[0]).toHaveProperty("tools");
    });

    it("a model that calls the tool only when forced is asked a second time, forced", async () => {
      const { fetchImpl, bodies } = scripted(
        () => jsonResponse(PLAIN),
        () => jsonResponse(CALL),
      );
      await expect(probeGatewayToolCallingVerdict(CONFIG, PROVIDER, fetchImpl)).resolves.toEqual({
        status: "verified",
        outcome: "called-only-forced",
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toMatchObject({
        tool_choice: { type: "function", function: { name: "report_readiness" } },
      });
    });

    it("a forced call the provider refuses is no verdict: unverified, never unsupported", async () => {
      const { fetchImpl, bodies } = scripted(
        () => jsonResponse(PLAIN),
        () =>
          jsonResponse({ error: { message: "tool_choice is not allowed in thinking mode" } }, 400),
      );
      await expect(probeGatewayToolCallingVerdict(CONFIG, PROVIDER, fetchImpl)).resolves.toEqual({
        status: "unverified",
        outcome: "forced-refused",
      });
      expect(bodies.length).toBeGreaterThanOrEqual(2);
    });

    it("a model that calls no tool in either step does not call tools", async () => {
      const { fetchImpl } = scripted(
        () => jsonResponse(PLAIN),
        () => jsonResponse(PLAIN),
      );
      await expect(probeGatewayToolCallingVerdict(CONFIG, PROVIDER, fetchImpl)).resolves.toEqual({
        status: "unsupported",
        outcome: "no-call",
      });
    });

    it("an endpoint that refuses the offered tool is a verdict, and no forced request follows", async () => {
      const { fetchImpl, bodies } = scripted(
        () => jsonResponse({ error: { message: "tools are not supported" } }, 400),
        () => jsonResponse(CALL),
      );
      await expect(probeGatewayToolCallingVerdict(CONFIG, PROVIDER, fetchImpl)).resolves.toEqual({
        status: "unsupported",
        outcome: "tools-refused",
      });
      expect(bodies.every((body) => body.tool_choice === undefined)).toBe(true);
    });

    it.each([
      ["the first step", 503, 200],
      ["the forced step", 200, 503],
    ] as const)("a busy gateway in %s is inconclusive", async (_name, first, second) => {
      const { fetchImpl } = scripted(
        () => jsonResponse(first === 200 ? PLAIN : {}, first),
        () => jsonResponse(second === 200 ? CALL : {}, second),
      );
      await expect(probeGatewayToolCallingVerdict(CONFIG, PROVIDER, fetchImpl)).resolves.toEqual({
        status: "transient",
        outcome: "inconclusive",
      });
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

describe("thinking continuation readiness (#4059)", () => {
  const provider = { ...PROVIDER, reasoningContinuation: "required-with-tools" as const };
  const config = { ...CONFIG, providers: [provider], capabilities: [CAPABILITY] };
  const message = (round: number): Record<string, unknown> => ({
    role: "assistant",
    reasoning_content: `Readiness reasoning ${String(round)}.`,
    ...(round === 2
      ? { content: "Ready" }
      : {
          content: null,
          tool_calls: [
            {
              id: `probe-${String(round)}`,
              type: "function",
              function: { name: "report_readiness", arguments: '{"status":"ok"}' },
            },
          ],
        }),
  });

  it("requires two tool continuations and a later user turn after a non-tool answer", async () => {
    let calls = 0;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "") as {
        messages: Record<string, unknown>[];
        tool_choice: unknown;
      };
      // The actual DeepSeek thinking contract refuses named/required choices with HTTP 400.
      if (body.tool_choice !== "auto" && body.tool_choice !== "none")
        return Promise.resolve(jsonResponse({}, 400));
      const assistants = body.messages.filter((entry) => entry.role === "assistant");
      expect(assistants.map((entry) => entry.reasoning_content)).toEqual(
        Array.from({ length: calls }, (_, index) => message(index).reasoning_content),
      );
      const round = calls++;
      return Promise.resolve(
        jsonResponse({
          choices: [
            { finish_reason: round === 2 ? "stop" : "tool_calls", message: message(round) },
          ],
        }),
      );
    }) as typeof fetch;
    await expect(probeGatewayToolCalling(config, provider, fetchImpl)).resolves.toBe("verified");
    expect(calls).toBe(4);
  });

  it("does not certify a single successful tool invocation when continuation is rejected", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        calls++ === 0
          ? jsonResponse({ choices: [{ finish_reason: "tool_calls", message: message(0) }] })
          : jsonResponse({}, 400),
      ),
    ) as typeof fetch;
    expect(await probeGatewayToolCalling(config, provider, fetchImpl)).not.toBe("verified");
    expect(calls).toBe(3); // The existing bounded output-token compatibility retry also fails.
  });

  it.each([{ calls: undefined }, { calls: null }, { calls: [] }])(
    "normalizes absent answer-round tool calls (%j)",
    async ({ calls }) => {
      let round = 0;
      const fetchImpl = vi.fn(() => {
        const index = round++;
        return Promise.resolve(
          jsonResponse({
            choices: [
              {
                finish_reason: index === 2 ? "stop" : "tool_calls",
                message: index === 2 ? { ...message(index), tool_calls: calls } : message(index),
              },
            ],
          }),
        );
      }) as typeof fetch;
      await expect(probeGatewayToolCalling(config, provider, fetchImpl)).resolves.toBe("verified");
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      const history = requestBodyAt(fetchImpl, 3).messages as Record<string, unknown>[];
      expect(history.filter((entry) => entry.role === "assistant")[2]).not.toHaveProperty(
        "tool_calls",
      );
    },
  );

  function continuationChoice(round: number): {
    finish_reason: string;
    message: Record<string, unknown>;
  } {
    return { finish_reason: round === 2 ? "stop" : "tool_calls", message: message(round) };
  }

  function malformedChoice(kind: string, round: number): ReturnType<typeof continuationChoice> {
    const choice = continuationChoice(round);
    const calls = message(0).tool_calls as Record<string, unknown>[];
    switch (kind) {
      case "whitespace":
        return { ...choice, message: { ...choice.message, reasoning_content: " \n " } };
      case "missing":
        delete choice.message.reasoning_content;
        return choice;
      case "empty-id":
        return { ...choice, message: { ...choice.message, tool_calls: [{ ...calls[0], id: "" }] } };
      case "multiple-tools":
        return {
          ...choice,
          message: {
            ...choice.message,
            tool_calls: [...calls, { ...calls[0], id: "second-call" }],
          },
        };
      case "unexpected-tool":
        return continuationChoice(0);
      case "unexpected-answer":
        return continuationChoice(2);
      case "empty-answer":
        return { ...choice, message: { ...choice.message, content: "" } };
      case "object-calls":
        return { ...choice, message: { ...choice.message, tool_calls: {} } };
      case "string-calls":
        return { ...choice, message: { ...choice.message, tool_calls: "invalid" } };
      default:
        throw new TypeError("Unknown malformed continuation fixture");
    }
  }

  it.each([
    ["whitespace", 0],
    ["empty-id", 0],
    ["multiple-tools", 1],
    ["unexpected-tool", 2],
    ["unexpected-answer", 0],
    ["unexpected-answer", 1],
    ["empty-answer", 2],
    ["object-calls", 2],
    ["string-calls", 2],
    ["missing", 3],
  ] as const)("rejects %s at continuation round %s", async (kind, rejectingRound) => {
    let calls = 0;
    const fetchImpl = vi.fn(() => {
      const round = calls++;
      const choice =
        round === rejectingRound ? malformedChoice(kind, round) : continuationChoice(round);
      return Promise.resolve(jsonResponse({ choices: [choice] }));
    }) as typeof fetch;
    await expect(probeGatewayToolCalling(config, provider, fetchImpl)).resolves.toBe("unverified");
    expect(fetchImpl).toHaveBeenCalledTimes(rejectingRound + 1);
  });

  it("reserves spend against every accumulated continuation request", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-continuation-probe-budget-"));
    const reserve = vi.spyOn(spendBudget, "reserveGatewaySpendForAttempt");
    let round = 0;
    const fetchImpl = vi.fn(() => {
      const index = round++;
      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              finish_reason: index === 2 ? "stop" : "tool_calls",
              message: message(index),
            },
          ],
        }),
      );
    }) as typeof fetch;
    try {
      await expect(
        probeGatewayToolCalling(config, provider, fetchImpl, undefined, {
          env: {
            [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "1",
            [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(stateDir, "spend.json"),
          },
          capability: CAPABILITY,
          correlationId: "continuation-spend-probe",
        }),
      ).resolves.toBe("verified");
      expect(reserve).toHaveBeenCalledTimes(4);
      expect(reserve.mock.calls.map((call) => call[2].messages.length)).toEqual([2, 4, 6, 8]);
      for (const [index, call] of reserve.mock.calls.entries()) {
        const wire = requestBodyAt(fetchImpl, index).messages as Record<string, unknown>[];
        expect(call[2].messages.map((entry) => entry.role)).toEqual(
          wire.map((entry) => entry.role),
        );
        expect(
          call[2].messages
            .filter((entry) => entry.role === "assistant")
            .map((entry) => entry.reasoningContent),
        ).toEqual(
          wire
            .filter((entry) => entry.role === "assistant")
            .map((entry) => entry.reasoning_content),
        );
      }
    } finally {
      reserve.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["missing", "conflicting", "exhausted"])("refuses %s reasoning state", async (kind) => {
    const assistant: Record<string, unknown> = { ...message(0) };
    if (kind === "missing") delete assistant.reasoning_content;
    if (kind === "conflicting") assistant.reasoning = "Another opaque state";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              finish_reason: kind === "exhausted" ? "length" : "tool_calls",
              message: assistant,
            },
          ],
        }),
      ),
    ) as typeof fetch;
    await expect(probeGatewayToolCalling(config, provider, fetchImpl)).resolves.toBe("unverified");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("counts full reasoning and tools before admitting the next readiness request", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: { ...message(0), reasoning_content: "Context state ".repeat(2000) },
            },
          ],
        }),
      ),
    ) as typeof fetch;
    const bounded = { ...config, capabilities: [{ ...CAPABILITY, contextWindow: 2048 }] };
    await expect(probeGatewayToolCalling(bounded, provider, fetchImpl)).resolves.toBe("unverified");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses another configured provider's credential without replaying altered opaque state", async () => {
    const secret = "synthetic-other-provider-credential";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: { ...message(0), reasoning_content: `State ${secret}` },
            },
          ],
        }),
      ),
    ) as typeof fetch;
    const bounded = {
      ...config,
      providers: [provider, { ...PROVIDER, modelId: "other", apiKey: secret }],
    };
    await expect(probeGatewayToolCalling(bounded, provider, fetchImpl)).resolves.toBe("unverified");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
