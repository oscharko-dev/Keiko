import { describe, expect, it } from "vitest";
import {
  CircuitOpenError,
  ProviderError,
  TimeoutError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { openCodeGatewayCatalogAdvertisement } from "./__fixtures__/toolCatalog.js";
import { Gateway, type GatewayCallRequest } from "./gateway.js";
import {
  bufferedCallBudgetMs,
  codingWorkbenchProviderTimeoutMs,
  GATEWAY_CODING_OUTAGE_WINDOW_MS,
} from "./resilience.js";
import { GatewayToolCatalogError } from "./toolCatalogBridge.js";
import type {
  Clock,
  GatewayConfig,
  GatewayStreamChunk,
  ModelCapability,
  NormalizedResponse,
  ProviderAdapter,
} from "./types.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";

// #3873: at peak load a customer's LiteLLM gateway sheds load for minutes. An autonomous coding
// turn keeps retrying a transiently unavailable provider and waits through an open breaker for an
// outage-length window, buffered and streamed alike; every other surface keeps its fail-fast
// attempt count.

const MODEL = "coding-outage-model";

// The three request shapes that reach the gateway: a coding turn (the coding sidecar route sets the
// coding-workbench timeout floors AND the explicit outage policy), the commit draft (an interactive
// surface that borrows only the floors, #3591), and any other interactive call.
type RequestShape = "coding-turn" | "commit-draft" | "interactive";

function request(shape: RequestShape): GatewayCallRequest {
  return {
    modelId: MODEL,
    messages: [{ role: "user", content: "Synthetic outage probe" }],
    ...(shape === "interactive" ? {} : { latencyProfile: "coding-workbench" as const }),
    ...(shape === "coding-turn" ? { outagePolicy: "outage-window" as const } : {}),
  };
}

function config(
  breaker = { failureThreshold: 1_000, cooldownMs: 30_000, halfOpenProbes: 1 },
): GatewayConfig {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "synthetic-test-token",
        timeoutMs: 30_000,
        maxRetries: 2,
        retryBaseDelayMs: 500,
      },
    ],
    circuitBreaker: breaker,
  };
}

function answer(): NormalizedResponse {
  return {
    modelId: MODEL,
    content: "Synthetic answer",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: { requestId: "r", promptTokens: 1, completionTokens: 1, latencyMs: 1, costClass: "low" },
  };
}

/**
 * A clock whose sleeps advance simulated time at once, so minutes of backoff run in microseconds.
 * `advance` lets a synthetic provider spend simulated time itself, as a silent attempt does.
 */
function simulatedClock(
  start = 1_000_000,
): Clock & { readonly elapsed: () => number; readonly advance: (ms: number) => void } {
  let now = start;
  return {
    now: (): number => now,
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted === true) return Promise.reject(new Error("aborted"));
      now += ms;
      return Promise.resolve();
    },
    elapsed: (): number => now - start,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

// The failure a synthetic provider answers with; the default is the overloaded gateway's 503.
type SyntheticFailure = () => Error;

const UNAVAILABLE: SyntheticFailure = () => new ProviderError("Synthetic 503", 503);
const SILENT: SyntheticFailure = () => new TimeoutError("Synthetic silent attempt");
const REFUSED: SyntheticFailure = () => new TransportError("Synthetic refused connection");

// `config()` with the provider's attempt count and the outage window replaced, as an operator of a
// LiteLLM route (which retries on its own, so `maxRetries: 0`) would set them.
function windowConfig(codingOutageWindowMs: number, maxRetries = 0): GatewayConfig {
  const base = config();
  return {
    ...base,
    providers: base.providers.map((entry) => ({ ...entry, maxRetries })),
    codingOutageWindowMs,
  };
}

/** A provider that fails its first `failures` calls (with a 503 by default), then succeeds. */
function recoveringProvider(
  failures: number,
  failure: SyntheticFailure = UNAVAILABLE,
): {
  call: ProviderAdapter["call"];
  calls: () => number;
} {
  let calls = 0;
  return {
    call: (): Promise<NormalizedResponse> => {
      calls += 1;
      return calls <= failures ? Promise.reject(failure()) : Promise.resolve(answer());
    },
    calls: (): number => calls,
  };
}

type ProviderStream = NonNullable<ProviderAdapter["callStream"]>;

/** The streamed counterpart: a stream that fails before its first chunk, then answers. */
function recoveringStream(
  failures: number,
  failure: SyntheticFailure = UNAVAILABLE,
): {
  callStream: ProviderStream;
  calls: () => number;
} {
  let calls = 0;
  return {
    callStream: async function* (): AsyncGenerator<GatewayStreamChunk> {
      calls += 1;
      await Promise.resolve();
      if (calls <= failures) throw failure();
      yield { type: "delta", token: "Synthetic answer" };
      yield { type: "done", response: answer() };
    },
    calls: (): number => calls,
  };
}

// A model answer that calls the governed edit tool with arguments its schema rejects: the provider
// answered, the model's own output is invalid. Read through the real adapter and tool catalog, so
// the rejection, its schema-repair correction and its retry are the production ones.
const CATALOG_NOW = Date.parse("2026-09-05T00:00:00.000Z");

function invalidToolCallAnswer(callId: string): Response {
  const toolCall = {
    id: callId,
    type: "function",
    function: {
      name: "keiko_changeset_edit",
      arguments: JSON.stringify({
        changeset: { patch: "synthetic", files: "synthetic", selectedFiles: [] },
      }),
    },
  };
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [toolCall] } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function toolCallingCapability(): ModelCapability {
  return {
    id: MODEL,
    kind: "chat",
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "fixture",
    preferredUseCases: [],
    knownLimitations: [],
  };
}

function recordingLog(events: ModelGatewayLogEvent[]): ModelGatewayLogSink {
  return {
    write: (event): void => {
      events.push(event);
    },
  };
}

function gatewayFor(
  provider: ProviderAdapter["call"],
  clock: Clock,
  gatewayConfig: GatewayConfig = config(),
  events: ModelGatewayLogEvent[] = [],
): Gateway {
  return new Gateway(gatewayConfig, {
    adapter: { call: provider },
    clock,
    random: () => 0.5,
    log: recordingLog(events),
  });
}

// A native streaming adapter: the buffered transport must never be used by these calls.
function streamingGatewayFor(
  callStream: ProviderStream,
  clock: Clock,
  gatewayConfig: GatewayConfig = config(),
  events: ModelGatewayLogEvent[] = [],
): Gateway {
  return new Gateway(gatewayConfig, {
    adapter: {
      call: (): Promise<NormalizedResponse> =>
        Promise.reject(new TypeError("Unexpected buffered transport")),
      callStream,
    },
    clock,
    random: () => 0.5,
    log: recordingLog(events),
  });
}

async function streamedContent(stream: AsyncIterable<GatewayStreamChunk>): Promise<string> {
  let content = "";
  for await (const chunk of stream) {
    if (chunk.type === "delta") content += chunk.token;
  }
  return content;
}

function linesOf(events: readonly ModelGatewayLogEvent[], op: string): ModelGatewayLogEvent[] {
  return events.filter((event) => event.op === op);
}

describe("coding-workbench outage tolerance", () => {
  it("keeps retrying a provider that recovers after more failures than its attempt count", async () => {
    const provider = recoveringProvider(8);

    const result = await gatewayFor(provider.call, simulatedClock()).chat(request("coding-turn"));

    expect(result.content).toBe("Synthetic answer");
    expect(provider.calls()).toBe(9);
  });

  it("keeps the configured attempt count for every other surface", async () => {
    const provider = recoveringProvider(8);

    await expect(
      gatewayFor(provider.call, simulatedClock()).chat(request("interactive")),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(provider.calls()).toBe(3);
  });

  // #3873 review: the commit draft borrows the coding-workbench timeout floors (#3591) but a person
  // waits on it, so the latency profile alone must never select the outage window.
  it("keeps the attempt count for a commit draft that borrows the coding latency profile", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringProvider(8);

    await expect(
      gatewayFor(provider.call, simulatedClock(), config(), events).chat(request("commit-draft")),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(provider.calls()).toBe(3);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "max-retries", retryPolicy: "attempts" });
  });

  it("refuses a commit draft at once on an open breaker", async () => {
    const clock = simulatedClock();
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringProvider(3);
    const gateway = gatewayFor(provider.call, clock, config(breaker));

    await expect(gateway.chat(request("commit-draft"))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(provider.calls()).toBe(2);
    expect(clock.elapsed()).toBeLessThan(30_000);
  });

  it("stops once the outage window cannot hold another retry", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringProvider(Number.POSITIVE_INFINITY);

    await expect(
      gatewayFor(provider.call, clock, config(), events).chat(request("coding-turn")),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(clock.elapsed()).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    expect(clock.elapsed()).toBeGreaterThan(GATEWAY_CODING_OUTAGE_WINDOW_MS - 30_000);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "budget", retryPolicy: "outage-window" });
  });

  // #3873 review: the window rides out an unavailable provider, never the model's own output. A
  // model that keeps answering with an invalid tool-call shape gets the configured attempts and its
  // schema-repair corrections, then the turn ends with the invalid-shape rejection, as without it.
  it("keeps the attempt count for a model that keeps returning an invalid tool-call shape", async () => {
    const events: ModelGatewayLogEvent[] = [];
    let calls = 0;
    const gateway = new Gateway(
      { ...config(), capabilities: [toolCallingCapability()] },
      {
        clock: simulatedClock(CATALOG_NOW),
        random: (): number => 0.5,
        fetchImpl: (): Promise<Response> => {
          calls += 1;
          return Promise.resolve(invalidToolCallAnswer(`call-${String(calls)}`));
        },
        log: recordingLog(events),
      },
    );

    const outcome = await gateway
      .chat({
        ...request("coding-turn"),
        toolCatalog: openCodeGatewayCatalogAdvertisement(CATALOG_NOW),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(calls).toBe(3);
    expect(outcome).toBeInstanceOf(GatewayToolCatalogError);
    expect(outcome).toMatchObject({
      code: "GATEWAY_MALFORMED_TOOL_CALL",
      reason: "invalid-arguments",
      retryable: true,
    });
    expect(linesOf(events, "gateway.tool-catalog.repair")).toHaveLength(2);
    const scheduled = linesOf(events, "gateway.retry.scheduled");
    expect(scheduled.map((line) => line.extra?.retryPolicy)).toEqual(["attempts", "attempts"]);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "max-retries", retryPolicy: "attempts" });
  });

  it("still retries a provider that keeps timing out through the window", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringProvider(Number.POSITIVE_INFINITY, SILENT);

    await expect(
      gatewayFor(provider.call, clock, config(), events).chat(request("coding-turn")),
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(provider.calls()).toBeGreaterThan(3);
    expect(clock.elapsed()).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    expect(clock.elapsed()).toBeGreaterThan(GATEWAY_CODING_OUTAGE_WINDOW_MS - 30_000);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "budget", retryPolicy: "outage-window" });
  });

  it("waits through an open breaker instead of refusing the call", async () => {
    const clock = simulatedClock();
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringProvider(3);

    const result = await gatewayFor(provider.call, clock, config(breaker)).chat(
      request("coding-turn"),
    );

    expect(result.content).toBe("Synthetic answer");
    expect(provider.calls()).toBe(4);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(30_000);
    expect(clock.elapsed()).toBeLessThan(GATEWAY_CODING_OUTAGE_WINDOW_MS);
  });

  it("bounds a wait on a saturated probe slot by the outage window", async () => {
    const clock = simulatedClock();
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    let calls = 0;
    let releaseProbe: (() => void) | undefined;
    let probeStarted: (() => void) | undefined;
    const probing = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    // Two 503s open the breaker; the half-open probe then hangs, so the slot stays saturated.
    const provider: ProviderAdapter["call"] = () => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new ProviderError("Synthetic 503", 503));
      probeStarted?.();
      return new Promise<NormalizedResponse>((resolve) => {
        releaseProbe = (): void => {
          resolve(answer());
        };
      });
    };
    const gateway = gatewayFor(provider, clock, config(breaker));
    const holder = gateway.chat(request("coding-turn"));
    await probing;
    const waitingSince = clock.elapsed();

    await expect(gateway.chat(request("coding-turn"))).rejects.toBeInstanceOf(CircuitOpenError);

    expect(clock.elapsed() - waitingSince).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    releaseProbe?.();
    await expect(holder).resolves.toMatchObject({ content: "Synthetic answer" });
  });

  it("bounds the retries by a configured window", async () => {
    const clock = simulatedClock();
    const provider = recoveringProvider(Number.POSITIVE_INFINITY);

    await expect(
      gatewayFor(provider.call, clock, { ...config(), codingOutageWindowMs: 60_000 }).chat(
        request("coding-turn"),
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(clock.elapsed()).toBeLessThanOrEqual(60_000);
    expect(clock.elapsed()).toBeGreaterThan(30_000);
  });

  // #3873 review: the configured window is the operator's explicit bound. It was clipped to the
  // provider's own budget, 600 s at `maxRetries: 0` whatever was set; the call's budget now extends
  // to the window plus the one attempt it admits last, read through the real adapter here.
  it("keeps retrying a refused connection past 600 s under a 30-minute window at maxRetries 0", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    let calls = 0;
    const gatewayConfig = windowConfig(1_800_000);
    const gateway = new Gateway(gatewayConfig, {
      clock,
      random: (): number => 0.5,
      fetchImpl: (): Promise<Response> => {
        calls += 1;
        return Promise.reject(new TypeError("fetch failed"));
      },
      log: recordingLog(events),
    });

    await expect(gateway.chat(request("coding-turn"))).rejects.toBeInstanceOf(TransportError);

    expect(clock.elapsed()).toBeGreaterThan(600_000);
    expect(clock.elapsed()).toBeGreaterThan(1_800_000 - 30_000);
    expect(clock.elapsed()).toBeLessThanOrEqual(1_800_000);
    expect(calls).toBeGreaterThan(30);
    const provider = gatewayConfig.providers[0];
    if (provider === undefined) throw new TypeError("expected the configured provider");
    const raised = { ...provider, timeoutMs: codingWorkbenchProviderTimeoutMs(provider.timeoutMs) };
    expect(linesOf(events, "gateway.chat.started")[0]?.extra?.requestBudgetMs).toBe(
      bufferedCallBudgetMs(raised, 1_800_000),
    );
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "budget", retryPolicy: "outage-window" });
  });

  // A silent attempt ends at its own bound (here the 600 s whole-body floor) and is retried only
  // while the window still has room: one silent attempt spends the default ten-minute window, a
  // thirty-minute window holds three. The last one ends past the window, and its stop line must
  // still be written: it once carried a negative `remainingMs` and was rejected as invalid.
  it.each([
    [GATEWAY_CODING_OUTAGE_WINDOW_MS, 1],
    [1_800_000, 3],
  ])(
    "retries a silent attempt only while a %i ms window has room for it",
    async (windowMs, attempts) => {
      const clock = simulatedClock();
      const events: ModelGatewayLogEvent[] = [];
      let calls = 0;
      const silent: ProviderAdapter["call"] = (_request, provider) => {
        calls += 1;
        clock.advance(provider.timeoutMs);
        return Promise.reject(SILENT());
      };

      await expect(
        gatewayFor(silent, clock, windowConfig(windowMs), events).chat(request("coding-turn")),
      ).rejects.toBeInstanceOf(TimeoutError);

      expect(calls).toBe(attempts);
      expect(clock.elapsed()).toBeGreaterThanOrEqual(attempts * 600_000);
      const exhausted = linesOf(events, "gateway.retry.exhausted");
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]?.extra).toMatchObject({
        attempt: attempts,
        reason: "budget",
        remainingMs: 0,
        retryPolicy: "outage-window",
      });
    },
  );

  it("keeps the attempt count for a coding call when the window is switched off", async () => {
    const provider = recoveringProvider(8);

    await expect(
      gatewayFor(provider.call, simulatedClock(), { ...config(), codingOutageWindowMs: 0 }).chat(
        request("coding-turn"),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(provider.calls()).toBe(3);
  });

  it("refuses a coding call at once on an open breaker when the window is switched off", async () => {
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringProvider(3);
    const gateway = gatewayFor(provider.call, simulatedClock(), {
      ...config(breaker),
      codingOutageWindowMs: 0,
    });

    await expect(gateway.chat(request("coding-turn"))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(provider.calls()).toBe(2);
  });

  it("still refuses at once on an open breaker outside the coding profile", async () => {
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringProvider(3);
    const gateway = gatewayFor(provider.call, simulatedClock(), config(breaker));

    await expect(gateway.chat(request("interactive"))).rejects.toBeInstanceOf(CircuitOpenError);
    expect(provider.calls()).toBe(2);
  });
});

// #3873 review: the coding sidecar route streams upstream whenever the model advertises streaming,
// so the streamed startup retries and every admission wait must run under the same window.
describe("coding-workbench outage tolerance (streamed)", () => {
  it("keeps retrying a provider that recovers after more failures than its attempt count", async () => {
    const provider = recoveringStream(8);

    const content = await streamedContent(
      streamingGatewayFor(provider.callStream, simulatedClock()).chatStream(request("coding-turn")),
    );

    expect(content).toBe("Synthetic answer");
    expect(provider.calls()).toBe(9);
  });

  it("keeps the configured attempt count for every other surface", async () => {
    const provider = recoveringStream(8);

    await expect(
      streamedContent(
        streamingGatewayFor(provider.callStream, simulatedClock()).chatStream(
          request("interactive"),
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(provider.calls()).toBe(3);
  });

  it("stops once the outage window cannot hold another retry", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringStream(Number.POSITIVE_INFINITY);

    await expect(
      streamedContent(
        streamingGatewayFor(provider.callStream, clock, config(), events).chatStream(
          request("coding-turn"),
        ),
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(clock.elapsed()).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    expect(clock.elapsed()).toBeGreaterThan(GATEWAY_CODING_OUTAGE_WINDOW_MS - 30_000);
    expect(provider.calls()).toBeGreaterThan(3);
    const scheduled = linesOf(events, "gateway.retry.scheduled");
    expect(scheduled.length).toBeGreaterThan(2);
    expect(scheduled.every((line) => line.extra?.retryPolicy === "outage-window")).toBe(true);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "budget", retryPolicy: "outage-window" });
  });

  // A stream never replays a rejected tool-call shape (that needs the buffered path's repair), and
  // the window does not change it: one call, ended under the attempt policy.
  it("ends a rejected tool-call shape at once instead of retrying it through the window", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringStream(
      Number.POSITIVE_INFINITY,
      () => new GatewayToolCatalogError("invalid-arguments", undefined, true),
    );

    await expect(
      streamedContent(
        streamingGatewayFor(provider.callStream, simulatedClock(), config(), events).chatStream(
          request("coding-turn"),
        ),
      ),
    ).rejects.toBeInstanceOf(GatewayToolCatalogError);

    expect(provider.calls()).toBe(1);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "terminal", retryPolicy: "attempts" });
  });

  // #3873 review: the stream's own 30-minute budget no longer clips a longer configured window.
  it("keeps retrying a refused connection past the stream budget under a one-hour window", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringStream(Number.POSITIVE_INFINITY, REFUSED);

    await expect(
      streamedContent(
        streamingGatewayFor(provider.callStream, clock, windowConfig(3_600_000), events).chatStream(
          request("coding-turn"),
        ),
      ),
    ).rejects.toBeInstanceOf(TransportError);

    expect(clock.elapsed()).toBeGreaterThan(1_800_000);
    expect(clock.elapsed()).toBeGreaterThan(3_600_000 - 30_000);
    expect(clock.elapsed()).toBeLessThanOrEqual(3_600_000);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "budget", retryPolicy: "outage-window" });
  });

  it("still retries a provider that keeps timing out through the window", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const provider = recoveringStream(Number.POSITIVE_INFINITY, SILENT);

    await expect(
      streamedContent(
        streamingGatewayFor(provider.callStream, clock, config(), events).chatStream(
          request("coding-turn"),
        ),
      ),
    ).rejects.toBeInstanceOf(TimeoutError);

    expect(provider.calls()).toBeGreaterThan(3);
    expect(clock.elapsed()).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    expect(clock.elapsed()).toBeGreaterThan(GATEWAY_CODING_OUTAGE_WINDOW_MS - 30_000);
    const exhausted = linesOf(events, "gateway.retry.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.extra).toMatchObject({ reason: "budget", retryPolicy: "outage-window" });
  });

  // A failed half-open probe re-opens the breaker; the streamed turn waits for the next probe
  // instead of ending on the probe's failure, exactly as the buffered turn does.
  it("waits through an open breaker instead of refusing the call", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    const provider = recoveringStream(3);

    const content = await streamedContent(
      streamingGatewayFor(provider.callStream, clock, config(breaker), events).chatStream(
        request("coding-turn"),
      ),
    );

    expect(content).toBe("Synthetic answer");
    expect(provider.calls()).toBe(4);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(30_000);
    expect(clock.elapsed()).toBeLessThan(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    const waits = linesOf(events, "gateway.circuit.wait");
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((line) => line.extra?.retryPolicy === "outage-window")).toBe(true);
  });

  it("bounds a wait on a saturated probe slot by the outage window", async () => {
    const clock = simulatedClock();
    const events: ModelGatewayLogEvent[] = [];
    const breaker = { failureThreshold: 2, cooldownMs: 30_000, halfOpenProbes: 1 };
    let calls = 0;
    let releaseProbe: (() => void) | undefined;
    let probeStarted: (() => void) | undefined;
    const probing = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    // Two 503s open the breaker; the half-open probe then hangs, so the slot stays saturated.
    const callStream: ProviderStream = async function* (): AsyncGenerator<GatewayStreamChunk> {
      calls += 1;
      if (calls <= 2) throw new ProviderError("Synthetic 503", 503);
      probeStarted?.();
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      yield { type: "delta", token: "Synthetic answer" };
      yield { type: "done", response: answer() };
    };
    const gateway = streamingGatewayFor(callStream, clock, config(breaker), events);
    const holder = streamedContent(gateway.chatStream(request("coding-turn")));
    await probing;
    const waitingSince = clock.elapsed();

    await expect(
      streamedContent(gateway.chatStream(request("coding-turn"))),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    expect(clock.elapsed() - waitingSince).toBeLessThanOrEqual(GATEWAY_CODING_OUTAGE_WINDOW_MS);
    const refused = linesOf(events, "gateway.circuit.wait").find(
      (line) => line.extra?.outcome === "budget-refused",
    );
    expect(refused?.extra).toMatchObject({
      reason: "probe-saturated",
      retryPolicy: "outage-window",
    });
    releaseProbe?.();
    await expect(holder).resolves.toBe("Synthetic answer");
  });
});
