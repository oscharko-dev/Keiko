// Customer report on 1.1.13: the field customer's LiteLLM `hosted_vllm` model declares no context
// window, so Keiko planned it as a 4,096-token model and every grounded question failed with a
// context overflow. These tests pin the server half of the repair: the startup probe and every
// provider overflow answer adopt the deployment's real window, persisted and applied without a
// configuration-generation bump, and an admitted turn re-plans and retries exactly once.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assumedChatCapability,
  createDefaultChatCapability,
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
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import {
  adoptReportedContextWindow,
  contextWindowProbesSettledForTests,
  discoverAssumedContextWindow,
  withAdoptedContextWindowRetry,
} from "./gateway-context-window.js";
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
  const deps: UiHandlerDeps =
    fetchImpl === undefined ? built : { ...built, gatewayReadinessFetch: fetchImpl };
  const holder = deps.gatewayConfig;
  if (holder === undefined) throw new Error("expected a runtime gateway config");
  holder.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: MODEL,
          baseUrl: "https://litellm.example.invalid/v1",
          apiKey: "fake-test-key",
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
  return { deps, configPath: holder.storagePath };
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
  it("replaces even a declared window in either direction with the provider's statement", () => {
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
