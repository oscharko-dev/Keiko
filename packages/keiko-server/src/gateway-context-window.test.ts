// Customer report on 1.1.13: the field customer's LiteLLM `hosted_vllm` model declares no context
// window, so Keiko planned it as a 4,096-token model and every grounded question failed with a
// context overflow. These tests pin the server half of the repair: the startup probe and every
// provider overflow answer adopt the deployment's real window, persisted and applied without a
// configuration-generation bump, and an admitted turn re-plans and retries exactly once.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assumedChatCapability,
  createDefaultChatCapability,
  createDefaultEmbeddingCapability,
  findConfiguredCapability,
  parseGatewayConfig,
  type ModelCapability,
} from "@oscharko-dev/keiko-model-gateway";
import { ContextOverflowError, ProviderError } from "@oscharko-dev/keiko-security/errors/gateway";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  resetServerLogFailureNotices,
  resetServerLogger,
} from "../../../tests/support/activity-log-test-support.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import {
  adoptReportedContextWindow,
  contextWindowProbesSettledForTests,
  discoverAssumedContextWindow,
  stopAssumedContextWindowDiscovery,
  withAdoptedContextWindowRetry,
} from "./gateway-context-window.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { readChatContextStatus } from "./chat-context-status.js";
import { handleChatContextStatus } from "./store-handlers.js";
import type { RouteContext } from "./routes.js";

const MODEL = "gemma-4-31b-it";
const roots: string[] = [];
const disposals: UiHandlerDeps[] = [];

afterEach(async () => {
  resetServerLogger();
  for (const deps of disposals.splice(0)) await deps.dispose?.();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function capture(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

function rejection(message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: null, code: "400" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function fixture(
  capability: ModelCapability,
  fetchImpl?: typeof fetch,
  overrides: Partial<UiHandlerDeps> = {},
): { deps: UiHandlerDeps; configPath: string } {
  return fixtureOf([capability], fetchImpl, overrides);
}

// One deployment per capability, all behind the same gateway, each addressed by its capability id.
function fixtureOf(
  capabilities: readonly ModelCapability[],
  fetchImpl?: typeof fetch,
  overrides: Partial<UiHandlerDeps> = {},
): { deps: UiHandlerDeps; configPath: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-context-window-"));
  roots.push(root);
  const built = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {},
  });
  disposals.push(built);
  const deps: UiHandlerDeps = {
    ...built,
    ...(fetchImpl === undefined ? {} : { gatewayReadinessFetch: fetchImpl }),
    ...overrides,
  };
  const holder = deps.gatewayConfig;
  if (holder === undefined) throw new Error("expected a runtime gateway config");
  holder.set(
    parseGatewayConfig({
      providers: capabilities.map((capability) => ({
        modelId: capability.id,
        baseUrl: "https://litellm.example.invalid/v1",
        apiKey: "fake-test-key",
        timeoutMs: 5_000,
        maxRetries: 0,
        retryBaseDelayMs: 1,
      })),
      capabilities,
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
    }),
    true,
  );
  return { deps, configPath: holder.storagePath };
}

function recordedDiagnostics(): {
  readonly records: ServerDiagnosticRecord[];
  readonly diagnostics: { readonly record: (record: ServerDiagnosticRecord) => void };
} {
  const records: ServerDiagnosticRecord[] = [];
  return {
    records,
    diagnostics: {
      record: (record): void => {
        records.push(record);
      },
    },
  };
}

function vllmWindow(tokens: number): Response {
  return rejection(`max_tokens=1000000000 cannot be greater than max_model_len=${String(tokens)}.`);
}

function persistedLine(sink: ReturnType<typeof createBufferedServerLogSink>, op: string): string {
  return formatActivityLogProofLine(sink.events.find((event) => event.op === op) ?? {});
}

function stored(deps: UiHandlerDeps): ModelCapability | undefined {
  const config = deps.gatewayConfig?.current();
  return config === undefined ? undefined : findConfiguredCapability(config, MODEL);
}

describe("context-window probe", () => {
  it("adopts the window vLLM names, persisted, without a generation bump", async () => {
    const sink = capture();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        rejection("max_tokens=1000000000 cannot be greater than max_model_len=65536."),
      ),
    );
    const { deps, configPath } = fixture(assumedChatCapability(MODEL), fetchImpl);
    const generation = deps.gatewayConfig?.generation();
    void discoverAssumedContextWindow(deps, MODEL, "corr-startup-window");
    await contextWindowProbesSettledForTests(deps);

    expect(stored(deps)?.contextWindow).toBe(65_536);
    expect(stored(deps)).not.toHaveProperty("contextWindowAssumed");
    expect(stored(deps)?.contextWindowReported).toBe(true);
    expect(deps.gatewayConfig?.generation()).toBe(generation);
    expectActivityLogProof(
      "gateway.context-window.probe.line",
      persistedLine(sink, "gateway.context-window.probe"),
    );
    expectActivityLogProof(
      "gateway.context-window.adoption.line",
      persistedLine(sink, "gateway.context-window.adoption"),
    );
    const persisted = readFileSync(configPath, "utf8");
    expect(persisted).toContain('"contextWindow": 65536');
    expect(persisted).not.toContain("contextWindowAssumed");
    // PR #3678 review: the probe is its own background operation, joined to the read that
    // spawned it — never a second use of that read's correlation.
    const probeLine = sink.events.find((event) => event.op === "gateway.context-window.probe");
    expect(probeLine).toMatchObject({
      parentCorrelationId: "corr-startup-window",
      extra: expect.objectContaining({ state: "reported", contextWindow: 65_536 }) as unknown,
    });
    expect(probeLine?.correlationId).toEqual(expect.any(String));
    expect(probeLine?.correlationId).not.toBe("corr-startup-window");
    expect(
      sink.events.find((event) => event.op === "gateway.context-window.adoption"),
    ).toMatchObject({
      correlationId: probeLine?.correlationId,
      parentCorrelationId: "corr-startup-window",
    });
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        extra: expect.objectContaining({
          source: "window-probe",
          state: "adopted",
          previousContextWindow: 4_096,
          wasAssumed: true,
        }) as unknown,
      }),
    );
  });

  it("asks each deployment once and keeps the assumption when the provider states nothing", async () => {
    const sink = capture();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
          status: 200,
        }),
      ),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    void discoverAssumedContextWindow(deps, MODEL, "corr-first");
    void discoverAssumedContextWindow(deps, MODEL, "corr-second");
    await contextWindowProbesSettledForTests(deps);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stored(deps)?.contextWindowAssumed).toBe(true);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.probe",
        extra: expect.objectContaining({ state: "not-reported", httpStatus: 200 }) as unknown,
      }),
    );
  });

  it("never probes a model whose window was declared", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { deps } = fixture(
      { ...createDefaultChatCapability(MODEL), contextWindow: 32_768 },
      fetchImpl,
    );
    void discoverAssumedContextWindow(deps, MODEL, "corr-declared");
    await contextWindowProbesSettledForTests(deps);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("deployment-bound adoption", () => {
  // PR #3678 review: a probe answer that arrives after setup replaced the deployment behind the
  // alias must not rewrite the replacement's window.
  it("ignores a late window statement of a deployment the alias no longer routes to", async () => {
    const sink = capture();
    let answer!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    void discoverAssumedContextWindow(deps, MODEL, "corr-stale");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    deps.gatewayConfig?.set(
      parseGatewayConfig({
        providers: [
          {
            modelId: MODEL,
            baseUrl: "https://replacement.example.invalid/v1",
            apiKey: "fake-test-key",
            timeoutMs: 5_000,
            maxRetries: 0,
            retryBaseDelayMs: 1,
          },
        ],
        capabilities: [{ ...createDefaultChatCapability(MODEL), contextWindow: 131_072 }],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
      }),
      true,
    );
    answer(rejection("max_tokens=1000000000 cannot be greater than max_model_len=8192."));
    await contextWindowProbesSettledForTests(deps);
    expect(stored(deps)?.contextWindow).toBe(131_072);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        extra: expect.objectContaining({
          state: "stale-deployment",
          contextWindow: 8_192,
        }) as unknown,
      }),
    );
  });
});

describe("generation-bound adoption", () => {
  // PR #3678 review: a multi-tenant proxy routes one alias by API key. A setup that replaced only
  // the credentials keeps endpoint and alias (and so the fingerprint), but it is a different routing:
  // the replaced tenant's late answer must not overwrite the new tenant's window, and the new
  // routing is asked anew.
  it("ignores a late statement after a credential-only replacement and asks the new routing", async () => {
    const sink = capture();
    const answers: ((response: Response) => void)[] = [];
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    void discoverAssumedContextWindow(deps, MODEL, "corr-tenant-a");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    const replacement = (apiKey: string, capability: ModelCapability): void => {
      deps.gatewayConfig?.set(
        parseGatewayConfig({
          providers: [
            {
              modelId: MODEL,
              baseUrl: "https://litellm.example.invalid/v1",
              apiKey,
              timeoutMs: 5_000,
              maxRetries: 0,
              retryBaseDelayMs: 1,
            },
          ],
          capabilities: [capability],
          circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 1 },
        }),
        true,
      );
    };
    replacement("fake-tenant-b-key", assumedChatCapability(MODEL));
    answers[0]?.(rejection("max_tokens=1000000000 cannot be greater than max_model_len=8192."));
    await contextWindowProbesSettledForTests(deps);
    expect(stored(deps)?.contextWindowAssumed).toBe(true);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        extra: expect.objectContaining({ state: "stale-deployment" }) as unknown,
      }),
    );

    void discoverAssumedContextWindow(deps, MODEL, "corr-tenant-b");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
    answers[1]?.(rejection("max_tokens=1000000000 cannot be greater than max_model_len=131072."));
    await contextWindowProbesSettledForTests(deps);
    expect(stored(deps)?.contextWindow).toBe(131_072);
  });
});

describe("provider-reported window adoption", () => {
  // PR #3678 audit: a provider statement may LOWER an operator-declared window (the deployment
  // cannot take more than it says), but it never RAISES one — the declared cap stays the operator's.
  it("lowers a declared window to the provider's statement", () => {
    const sink = capture();
    const { deps } = fixture({ ...createDefaultChatCapability(MODEL), contextWindow: 32_768 });
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 16_384, correlationId: "corr-overflow" },
      "provider-overflow",
    );
    expect(stored(deps)?.contextWindow).toBe(16_384);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        correlationId: "corr-overflow",
        extra: expect.objectContaining({
          source: "provider-overflow",
          state: "adopted",
          previousContextWindow: 32_768,
          wasAssumed: false,
        }) as unknown,
      }),
    );
  });

  // PR #3678 review (P1): lowering a declared window must not turn it into a learned one that a
  // later statement raises past the operator's ceiling.
  it("keeps a lowered declared window a ceiling that a later statement cannot raise", () => {
    capture();
    const { deps, configPath } = fixture({
      ...createDefaultChatCapability(MODEL),
      contextWindow: 32_768,
    });
    for (const [tokens, id] of [
      [16_384, "corr-declared-lower"],
      [131_072, "corr-declared-raise-after-lower"],
    ] as const) {
      adoptReportedContextWindow(
        deps,
        { modelId: MODEL, contextWindowTokens: tokens, correlationId: id },
        "provider-overflow",
      );
    }

    expect(stored(deps)?.contextWindow).toBe(16_384);
    expect(stored(deps)).not.toHaveProperty("contextWindowReported");
    // The persisted file keeps the ceiling as a declared window, so a restart cannot lose it.
    expect(readFileSync(configPath, "utf8")).not.toContain("contextWindowReported");
  });

  it("never raises a declared window from a provider statement and records it unchanged", () => {
    const sink = capture();
    const { deps } = fixture({ ...createDefaultChatCapability(MODEL), contextWindow: 32_768 });
    const before = deps.gatewayConfig?.current();
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 131_072, correlationId: "corr-declared-raise" },
      "provider-overflow",
    );
    expect(deps.gatewayConfig?.current()).toBe(before);
    expect(stored(deps)?.contextWindow).toBe(32_768);
    expect(stored(deps)).not.toHaveProperty("contextWindowReported");
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        correlationId: "corr-declared-raise",
        extra: expect.objectContaining({ state: "unchanged", contextWindow: 131_072 }) as unknown,
      }),
    );
  });

  it("adopts a larger window for an assumed window and for a provider-reported one", () => {
    const sink = capture();
    const assumed = fixture(assumedChatCapability(MODEL)).deps;
    adoptReportedContextWindow(
      assumed,
      { modelId: MODEL, contextWindowTokens: 131_072, correlationId: "corr-assumed-raise" },
      "provider-overflow",
    );
    expect(stored(assumed)?.contextWindow).toBe(131_072);
    expect(stored(assumed)?.contextWindowReported).toBe(true);

    const reported = fixture({
      ...createDefaultChatCapability(MODEL),
      contextWindow: 16_384,
      contextWindowReported: true,
    }).deps;
    adoptReportedContextWindow(
      reported,
      { modelId: MODEL, contextWindowTokens: 65_536, correlationId: "corr-reported-raise" },
      "provider-overflow",
    );
    expect(stored(reported)?.contextWindow).toBe(65_536);
    expect(sink.events.filter((event) => event.op === "gateway.context-window.adoption")).toEqual([
      expect.objectContaining({
        extra: expect.objectContaining({
          state: "adopted",
          previousContextWindow: 4_096,
          wasAssumed: true,
        }) as unknown,
      }),
      expect.objectContaining({
        extra: expect.objectContaining({
          state: "adopted",
          previousContextWindow: 16_384,
          wasAssumed: false,
        }) as unknown,
      }),
    ]);
  });

  it("records an unchanged statement without rewriting the configuration", () => {
    const sink = capture();
    const { deps } = fixture({ ...createDefaultChatCapability(MODEL), contextWindow: 32_768 });
    const before = deps.gatewayConfig?.current();
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 32_768, correlationId: "corr-same" },
      "provider-overflow",
    );
    expect(deps.gatewayConfig?.current()).toBe(before);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        extra: expect.objectContaining({ state: "unchanged" }) as unknown,
      }),
    );
  });
});

describe("withAdoptedContextWindowRetry", () => {
  function overflow(window: number): ContextOverflowError {
    const error = new ContextOverflowError("provider reported context overflow");
    error.reportedContextWindowTokens = window;
    return error;
  }

  it("re-plans and retries once after the overflow taught Keiko the real window", async () => {
    const sink = capture();
    const { deps } = fixture(assumedChatCapability(MODEL));
    const planned: number[] = [];
    const result = await withAdoptedContextWindowRetry(
      deps,
      { modelId: MODEL, surface: "chat-buffered", correlationId: "corr-retry" },
      () => {
        planned.push(stored(deps)?.contextWindow ?? 0);
        if (planned.length === 1) {
          // What the Gateway's report hook does synchronously before rethrowing.
          adoptReportedContextWindow(
            deps,
            { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "corr-retry" },
            "provider-overflow",
          );
          return Promise.reject(overflow(8_192));
        }
        return Promise.resolve("answer");
      },
    );
    expect(result).toBe("answer");
    expect(planned).toEqual([4_096, 8_192]);
    expectActivityLogProof(
      "gateway.context-window.retry.line",
      persistedLine(sink, "gateway.context-window.retry"),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.retry",
        correlationId: "corr-retry",
        extra: expect.objectContaining({
          surface: "chat-buffered",
          plannedContextWindow: 128_000,
          contextWindow: 8_192,
        }) as unknown,
      }),
    );
  });

  it("does not retry when the window was already planned, after content, or for other errors", async () => {
    const { deps } = fixture({ ...createDefaultChatCapability(MODEL), contextWindow: 8_192 });
    const attempt = vi.fn(() => Promise.reject(overflow(8_192)));
    await expect(
      withAdoptedContextWindowRetry(
        deps,
        { modelId: MODEL, surface: "grounded", correlationId: undefined },
        attempt,
      ),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(attempt).toHaveBeenCalledTimes(1);

    const assumed = fixture(assumedChatCapability(MODEL)).deps;
    const afterContent = vi.fn(() => {
      adoptReportedContextWindow(
        assumed,
        { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "c" },
        "provider-overflow",
      );
      return Promise.reject(overflow(8_192));
    });
    await expect(
      withAdoptedContextWindowRetry(
        assumed,
        { modelId: MODEL, surface: "chat-stream", correlationId: "c", retryable: () => false },
        afterContent,
      ),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(afterContent).toHaveBeenCalledTimes(1);

    const other = vi.fn(() => Promise.reject(new ProviderError("upstream failed", 502)));
    await expect(
      withAdoptedContextWindowRetry(
        deps,
        { modelId: MODEL, surface: "chat-buffered", correlationId: undefined },
        other,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe("retry on the refined gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // PR #3678 review: the retry after an adoption must run on the Gateway built from the refined
  // configuration. A port resolved BEFORE the adoption kept the Gateway of the old window, so its
  // admission and output allocation still planned the window Keiko had just learned was wrong.
  it("plans a port resolved before the adoption against the adopted window", async () => {
    const { deps } = fixture({
      ...createDefaultChatCapability(MODEL),
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
    });
    const questionMarker = "refined-gateway-question";
    const providerQuestions = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((_input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.includes(questionMarker)) providerQuestions();
        return Promise.resolve(rejection("upstream refused"));
      }),
    );
    const port = deps.modelPortFactory(MODEL);
    if (port === undefined) throw new Error("expected a model port");
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 4_096, correlationId: "corr-refined" },
      "provider-overflow",
    );
    // About 6,000 tokens: inside the old 128,000 window, far outside the adopted 4,096.
    const oversized = `${questionMarker} ${"alpha beta gamma delta ".repeat(1_500)}`;
    const error: unknown = await port
      .call(
        { modelId: MODEL, messages: [{ role: "user", content: oversized }], stream: false },
        new AbortController().signal,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(providerQuestions).not.toHaveBeenCalled();
  });
});

describe("context status of an assumed window", () => {
  it("tells the meter that the window is assumed and plans the default geometry", () => {
    const { deps } = fixture(assumedChatCapability(MODEL));
    const project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-assumed-project-"));
    roots.push(project);
    deps.store.createProject(project, "Assumed");
    const chatId = deps.store.createChat(project, "Assumed", MODEL).id;
    const status = readChatContextStatus(deps, chatId, MODEL);
    expect(status.contextWindowAssumed).toBe(true);
    expect(status.contextWindowTokens).toBe(128_000);
    expect(status.inputBudgetTokens).toBe(116_000);
  });
});

describe("context meter reading", () => {
  it("waits for the window probe so the first reading already carries the real window", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        rejection("max_tokens=1000000000 cannot be greater than max_model_len=32768."),
      ),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    const project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-meter-project-"));
    roots.push(project);
    deps.store.createProject(project, "Meter");
    const chatId = deps.store.createChat(project, "Meter", MODEL).id;
    const query = new URLSearchParams({ chatId, projectPath: project, modelId: MODEL });
    const result = await handleChatContextStatus(
      {
        correlationId: "corr-meter",
        params: {},
        url: new URL(`http://localhost/api/chats/context?${query.toString()}`),
      } as unknown as RouteContext,
      deps,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ contextWindowTokens: 32_768 });
    expect(result.body).not.toHaveProperty("contextWindowAssumed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// PR #3678 audit (O10): a reading of a model whose probe had already answered without a window
// waited on the shared queue, so it sat behind another model's slow probe for its whole deadline.
describe("context meter reading beside another model's probe", () => {
  it("answers at once for a model whose probe finished while another model's is still running", async () => {
    capture();
    const A = "model-a";
    const B = "model-b";
    let answerB!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!body.includes("1000000000")) return Promise.reject(new TypeError("not a window probe"));
      if (body.includes(`"${B}"`)) {
        return new Promise<Response>((resolve) => {
          answerB = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    });
    const { deps } = fixtureOf([assumedChatCapability(A), assumedChatCapability(B)], fetchImpl);
    const project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-meter-two-models-"));
    roots.push(project);
    deps.store.createProject(project, "Meter");
    const chatId = deps.store.createChat(project, "Meter", A).id;
    void discoverAssumedContextWindow(deps, A, "corr-a-probe");
    await contextWindowProbesSettledForTests(deps);
    void discoverAssumedContextWindow(deps, B, "corr-b-probe");
    await vi.waitFor(() => {
      expect(answerB).toBeDefined();
    });

    const started = performance.now();
    const result = await handleChatContextStatus(
      {
        correlationId: "corr-meter-a",
        params: {},
        url: new URL(
          `http://localhost/api/chats/context?${new URLSearchParams({ chatId, projectPath: project, modelId: A }).toString()}`,
        ),
      } as unknown as RouteContext,
      deps,
    );
    // The reading's own wait is three seconds; model B's probe is still running.
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(result.body).toMatchObject({ contextWindowAssumed: true });
    expect(result.body).not.toHaveProperty("contextWindowProbePending");

    answerB(vllmWindow(65_536));
    await contextWindowProbesSettledForTests(deps);
  });
});

describe("context meter reading of a slow probe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // PR #3678 review: a probe slower than the reading's wait must not leave the meter on the
  // assumption for good — the reading says the probe is still running, so the meter reads again.
  it("marks the reading pending while the window probe is still running", async () => {
    vi.useFakeTimers();
    let answer!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    const project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-meter-slow-"));
    roots.push(project);
    deps.store.createProject(project, "Meter");
    const chatId = deps.store.createChat(project, "Meter", MODEL).id;
    const query = new URLSearchParams({ chatId, projectPath: project, modelId: MODEL });
    const reading = handleChatContextStatus(
      {
        correlationId: "corr-meter-slow",
        params: {},
        url: new URL(`http://localhost/api/chats/context?${query.toString()}`),
      } as unknown as RouteContext,
      deps,
    );
    await vi.advanceTimersByTimeAsync(3_001);
    const result = await reading;
    expect(result.body).toMatchObject({
      contextWindowAssumed: true,
      contextWindowProbePending: true,
    });
    answer(rejection("max_tokens=1000000000 cannot be greater than max_model_len=32768."));
    vi.useRealTimers();
    await contextWindowProbesSettledForTests(deps);
    expect(stored(deps)?.contextWindow).toBe(32_768);
  });
});

describe("provider-reported window re-check", () => {
  it("asks a provider-reported deployment again and adopts a larger redeployed window", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        rejection("max_tokens=1000000000 cannot be greater than max_model_len=131072."),
      ),
    );
    const { deps } = fixture(
      { ...createDefaultChatCapability(MODEL), contextWindow: 16_384, contextWindowReported: true },
      fetchImpl,
    );
    void discoverAssumedContextWindow(deps, MODEL, "corr-recheck");
    await contextWindowProbesSettledForTests(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stored(deps)?.contextWindow).toBe(131_072);
    expect(stored(deps)?.contextWindowReported).toBe(true);
  });

  // PR #3678 review: an idle meter opened after a restart shows the persisted reported window while
  // the background re-check runs. The reading says so, and the next reading carries the new window.
  it("marks the idle reading pending while a reported window is re-checked", async () => {
    let answer!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const { deps } = fixture(
      { ...createDefaultChatCapability(MODEL), contextWindow: 16_384, contextWindowReported: true },
      fetchImpl,
    );
    const project = mkdtempSync(join(realpathSync(tmpdir()), "keiko-meter-recheck-"));
    roots.push(project);
    deps.store.createProject(project, "Meter");
    const chatId = deps.store.createChat(project, "Meter", MODEL).id;
    const read = (): Promise<{ readonly body: unknown }> =>
      handleChatContextStatus(
        {
          correlationId: "corr-meter-recheck",
          params: {},
          url: new URL(
            `http://localhost/api/chats/context?${new URLSearchParams({ chatId, projectPath: project, modelId: MODEL }).toString()}`,
          ),
        } as unknown as RouteContext,
        deps,
      );
    expect((await read()).body).toMatchObject({
      contextWindowTokens: 16_384,
      contextWindowProbePending: true,
    });
    answer(rejection("max_tokens=1000000000 cannot be greater than max_model_len=131072."));
    await contextWindowProbesSettledForTests(deps);
    const after = (await read()).body;
    expect(after).toMatchObject({ contextWindowTokens: 131_072 });
    expect(after).not.toHaveProperty("contextWindowProbePending");
  });
});

// PR #3678 audit (G4): a read-only or managed configuration file made the durable write throw
// before the refinement, so the learned window was never applied and every overflow repeated.
describe("adoption when the configuration cannot be persisted", () => {
  it("applies the window in memory and reports the persistence failure", () => {
    const sink = capture();
    const { records, diagnostics } = recordedDiagnostics();
    const { deps, configPath } = fixture(assumedChatCapability(MODEL), undefined, { diagnostics });
    // A directory where the file must be replaced: the atomic write fails for every user.
    rmSync(configPath, { force: true });
    mkdirSync(configPath);
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "corr-read-only" },
      "provider-overflow",
    );
    expect(stored(deps)?.contextWindow).toBe(8_192);
    expect(stored(deps)?.contextWindowReported).toBe(true);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        correlationId: "corr-read-only",
        extra: expect.objectContaining({ state: "adopted", contextWindow: 8_192 }) as unknown,
      }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: "corr-read-only",
      operation: "gateway.context-window",
      source: "gateway-setup.adopted-context-window",
      message: "The verified gateway context window could not be persisted.",
    });
  });

  it("lets a retry re-plan on the adopted window although the write failed", async () => {
    capture();
    const { diagnostics } = recordedDiagnostics();
    const { deps, configPath } = fixture(assumedChatCapability(MODEL), undefined, { diagnostics });
    rmSync(configPath, { force: true });
    mkdirSync(configPath);
    const planned: number[] = [];
    const result = await withAdoptedContextWindowRetry(
      deps,
      { modelId: MODEL, surface: "chat-buffered", correlationId: "corr-read-only-retry" },
      () => {
        planned.push(stored(deps)?.contextWindow ?? 0);
        if (planned.length > 1) return Promise.resolve("answer");
        adoptReportedContextWindow(
          deps,
          { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "corr-read-only-retry" },
          "provider-overflow",
        );
        const error = new ContextOverflowError("provider reported context overflow");
        error.reportedContextWindowTokens = 8_192;
        return Promise.reject(error);
      },
    );
    expect(result).toBe("answer");
    expect(planned).toEqual([4_096, 8_192]);
  });

  it("adopts through the persisting fallback when the holder has no refine", () => {
    const sink = capture();
    const { deps } = fixture(assumedChatCapability(MODEL));
    const holder = deps.gatewayConfig;
    if (holder === undefined) throw new Error("expected a runtime gateway config");
    const withoutRefine = { ...holder, refine: undefined };
    const generation = holder.generation();
    adoptReportedContextWindow(
      { ...deps, gatewayConfig: withoutRefine },
      { modelId: MODEL, contextWindowTokens: 16_384, correlationId: "corr-no-refine" },
      "provider-overflow",
    );
    expect(stored(deps)?.contextWindow).toBe(16_384);
    expect(holder.generation()).toBeGreaterThan(generation);
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        extra: expect.objectContaining({ state: "adopted" }) as unknown,
      }),
    );
  });
});

describe("adoption states that leave the configuration alone", () => {
  it("records a statement about an unconfigured gateway", () => {
    const sink = capture();
    const { deps } = fixture(assumedChatCapability(MODEL));
    adoptReportedContextWindow(
      { ...deps, gatewayConfig: undefined },
      { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "corr-unconfigured" },
      "provider-overflow",
    );
    expectActivityLogProof(
      "gateway.context-window.adoption.line",
      persistedLine(sink, "gateway.context-window.adoption"),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        correlationId: "corr-unconfigured",
        extra: expect.objectContaining({ state: "unconfigured", contextWindow: 8_192 }) as unknown,
      }),
    );
    expect(stored(deps)?.contextWindowAssumed).toBe(true);
  });

  it("records a statement about a model that is not a chat model", () => {
    const sink = capture();
    const { deps } = fixture(createDefaultEmbeddingCapability(MODEL));
    adoptReportedContextWindow(
      deps,
      { modelId: MODEL, contextWindowTokens: 8_192, correlationId: "corr-not-chat" },
      "provider-overflow",
    );
    expectActivityLogProof(
      "gateway.context-window.adoption.line",
      persistedLine(sink, "gateway.context-window.adoption"),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.adoption",
        correlationId: "corr-not-chat",
        extra: expect.objectContaining({ state: "not-chat", contextWindow: 8_192 }) as unknown,
      }),
    );
    expect(stored(deps)?.kind).toBe("embedding");
  });
});

describe("context-window probe failure evidence", () => {
  it("records a transport failure as a failed probe with its diagnostic", async () => {
    const sink = capture();
    const { records, diagnostics } = recordedDiagnostics();
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl, { diagnostics });
    void discoverAssumedContextWindow(deps, MODEL, "corr-failed-read");
    await contextWindowProbesSettledForTests(deps);

    expectActivityLogProof(
      "gateway.context-window.probe.line",
      persistedLine(sink, "gateway.context-window.probe"),
    );
    const probeLine = sink.events.find((event) => event.op === "gateway.context-window.probe");
    expect(probeLine).toMatchObject({
      parentCorrelationId: "corr-failed-read",
      errorKind: "unavailable",
      extra: expect.objectContaining({ state: "failed" }) as unknown,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: probeLine?.correlationId,
      parentCorrelationId: "corr-failed-read",
      operation: "gateway.context-window",
      source: "gateway-context-window.probe",
      message: "The gateway context-window probe could not be completed.",
    });
    expect(stored(deps)?.contextWindowAssumed).toBe(true);
  });

  it("records a probe skipped under a spend budget without asking the provider", async () => {
    const sink = capture();
    const fetchImpl = vi.fn<typeof fetch>();
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    const holder = deps.gatewayConfig;
    if (holder === undefined) throw new Error("expected a runtime gateway config");
    const budgeted = {
      ...deps,
      gatewayConfig: { ...holder, spendBudget: { reserve: vi.fn() } },
    };
    await discoverAssumedContextWindow(budgeted, MODEL, "corr-budgeted");
    expect(fetchImpl).not.toHaveBeenCalled();
    expectActivityLogProof(
      "gateway.context-window.probe.line",
      persistedLine(sink, "gateway.context-window.probe"),
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        op: "gateway.context-window.probe",
        parentCorrelationId: "corr-budgeted",
        extra: expect.objectContaining({ state: "skipped-spend-budget" }) as unknown,
      }),
    );
  });
});

// PR #3678 audit (G11): a probe was marked done before its outcome was known, so one transient
// outage at the first reading left the model on its assumption until a restart.
describe("context-window probe retry after a failure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function outage(): Promise<Response> {
    return Promise.reject(new TypeError("fetch failed"));
  }

  it("asks again once the cooldown has passed and adopts the window then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    const sink = capture();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(outage)
      .mockImplementation(() => Promise.resolve(vllmWindow(65_536)));
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    void discoverAssumedContextWindow(deps, MODEL, "corr-outage");
    await contextWindowProbesSettledForTests(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-30T10:00:10.000Z"));
    void discoverAssumedContextWindow(deps, MODEL, "corr-too-early");
    await contextWindowProbesSettledForTests(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-30T10:00:31.000Z"));
    void discoverAssumedContextWindow(deps, MODEL, "corr-after-cooldown");
    await contextWindowProbesSettledForTests(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stored(deps)?.contextWindow).toBe(65_536);
    expect(
      sink.events
        .filter((event) => event.op === "gateway.context-window.probe")
        .map((event) => (event.extra as { state?: unknown }).state),
    ).toEqual(["failed", "reported"]);
  });

  it("gives up after a bounded number of failed attempts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    capture();
    const fetchImpl = vi.fn<typeof fetch>(outage);
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      vi.setSystemTime(new Date(Date.parse("2026-09-30T10:00:00.000Z") + attempt * 60_000));
      void discoverAssumedContextWindow(deps, MODEL, `corr-attempt-${String(attempt)}`);
      await contextWindowProbesSettledForTests(deps);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not ask again after an answer that named no window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    capture();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 })),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    void discoverAssumedContextWindow(deps, MODEL, "corr-answered");
    await contextWindowProbesSettledForTests(deps);
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    void discoverAssumedContextWindow(deps, MODEL, "corr-answered-again");
    await contextWindowProbesSettledForTests(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// PR #3678 audit (O5): a logging failure inside a probe step rejected the shared queue for good, so
// no later probe ever ran, and the dropped promise of a reading became an unhandled rejection.
describe("context-window probe queue", () => {
  afterEach(() => {
    vi.useRealTimers();
    // The failure notice of the throwing logger is flushed while stderr is still muted.
    resetServerLogFailureNotices();
    vi.restoreAllMocks();
  });

  it("survives a probe whose logging throws and keeps serving later probes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const inner = createServerLogger({ sink: createBufferedServerLogSink(), level: "info" });
    setServerLogger({
      ...inner,
      info: (): void => {
        throw new Error("logger down");
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.reject(new TypeError("fetch failed")))
      .mockImplementation(() => Promise.resolve(vllmWindow(32_768)));
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    void discoverAssumedContextWindow(deps, MODEL, "corr-logger-down");
    await expect(contextWindowProbesSettledForTests(deps)).resolves.toBeUndefined();

    vi.setSystemTime(new Date("2026-09-30T10:01:00.000Z"));
    void discoverAssumedContextWindow(deps, MODEL, "corr-logger-down-again");
    await expect(contextWindowProbesSettledForTests(deps)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stored(deps)?.contextWindow).toBe(32_768);
  });

  // PR #3678 audit (O10): a reading of a model whose probe already answered waited on the shared
  // queue, so it sat behind another model's probe for its whole deadline.
  it("does not make a reading of one model wait for another model's probe", async () => {
    capture();
    const A = "model-a";
    const B = "model-b";
    let answerB!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes(`"${B}"`)) {
        return new Promise<Response>((resolve) => {
          answerB = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    });
    const { deps } = fixtureOf(
      [
        { ...assumedChatCapability(A), id: A },
        { ...assumedChatCapability(B), id: B },
      ],
      fetchImpl,
    );
    void discoverAssumedContextWindow(deps, A, "corr-a-first");
    await contextWindowProbesSettledForTests(deps);
    void discoverAssumedContextWindow(deps, B, "corr-b");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    const pending = Symbol("pending");
    const settled = await Promise.race([
      discoverAssumedContextWindow(deps, A, "corr-a-reading"),
      new Promise<symbol>((resolve) => {
        setTimeout(() => {
          resolve(pending);
        }, 50);
      }),
    ]);
    expect(settled).not.toBe(pending);

    answerB(vllmWindow(65_536));
    await contextWindowProbesSettledForTests(deps);
  });

  it("waits for the model's own probe while it is in flight", async () => {
    capture();
    let answer!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl);
    void discoverAssumedContextWindow(deps, MODEL, "corr-own");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    const pending = Symbol("pending");
    const raced = await Promise.race([
      discoverAssumedContextWindow(deps, MODEL, "corr-own-reading"),
      new Promise<symbol>((resolve) => {
        setTimeout(() => {
          resolve(pending);
        }, 50);
      }),
    ]);
    expect(raced).toBe(pending);
    answer(vllmWindow(32_768));
    await contextWindowProbesSettledForTests(deps);
    expect(stored(deps)?.contextWindow).toBe(32_768);
  });
});

// PR #3678 audit (O5): shutdown aborts the probe in flight, and the abort is not a defect.
describe("context-window probe at shutdown", () => {
  it("records nothing for a probe the shutdown aborted", async () => {
    const sink = capture();
    const { records, diagnostics } = recordedDiagnostics();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    const { deps } = fixture(assumedChatCapability(MODEL), fetchImpl, { diagnostics });
    void discoverAssumedContextWindow(deps, MODEL, "corr-shutdown");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    await stopAssumedContextWindowDiscovery(deps);
    expect(sink.events.filter((event) => event.op === "gateway.context-window.probe")).toEqual([]);
    expect(records).toEqual([]);
    expect(stored(deps)?.contextWindowAssumed).toBe(true);
  });
});
