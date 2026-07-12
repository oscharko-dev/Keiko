import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  resolveEditorM7Settings,
  type EvidenceStore,
} from "@oscharko-dev/keiko-contracts";
import type { GatewayConfig, ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type {
  CostClass,
  EditorM7SettingId,
  EditorM7SettingValue,
  EditorM7SettingsSnapshot,
  EditorInlineCompletionWireResponse,
  LatencyClass,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import { handleEditorCompletion, type CompletionChatFactory } from "./completionRoutes.js";
import {
  handleEditorInlineCompletion,
  handleEditorInlineCompletionTelemetry,
  isInlineCompletionEnabledByPolicy,
  type EditorInlineCompletionRouteOptions,
  type InlineCompletionChatFactory,
} from "./inlineCompletionRoutes.js";
import { createInlineCompletionRateLimiter } from "./inlineCompletionRateLimiter.js";
import { createEditorModelTokenBudget } from "./editorModelTokenBudget.js";

function postContext(body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/inline-completion"),
  };
}

let root: string;
let store: UiStore;

function deps(
  input: {
    config?: GatewayConfig;
    env?: Record<string, string | undefined>;
    evidenceStore?: EvidenceStore;
    aiSettings?: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined;
  } = {},
): UiHandlerDeps {
  const aiSettings = input.aiSettings ?? { inlineCompletion: true };
  return {
    store,
    redactor: buildRedactor(input.env ?? {}, input.config),
    evidenceStore: input.evidenceStore ?? createInMemoryEvidenceStore(),
    env: input.env ?? {},
    editorSettingsControl: editorSettingsControl(aiSettings),
    ...(input.config === undefined ? {} : { config: input.config }),
  } as unknown as UiHandlerDeps;
}

function editorSettingsSnapshot(
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>,
): EditorM7SettingsSnapshot {
  const userValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  const workspaceValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  if (values.inlineCompletion !== undefined) {
    userValues.inlineCompletion = values.inlineCompletion;
  }
  if (values.testGeneration !== undefined) {
    workspaceValues.testGeneration = values.testGeneration;
  }
  if (values.patchApply !== undefined) {
    workspaceValues.patchApply = values.patchApply;
  }
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    storeState: "ready",
    userRevision: 1,
    workspaceRevision: 1,
    revision: 1_000_001,
    etag: '"edm7-test-inline"',
    root,
    definitions: EDITOR_M7_SETTING_REGISTRY,
    settings: resolveEditorM7Settings({
      user: { scope: "user", values: userValues },
      workspace: { scope: "workspace", values: workspaceValues },
    }),
    eventSequence: 1,
  };
}

function editorSettingsControl(
  values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>,
): { readonly read: (realRoot: string) => Promise<EditorM7SettingsSnapshot> } {
  return { read: () => Promise.resolve(editorSettingsSnapshot(values)) };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fimCapability(
  latencyClass: LatencyClass,
  overrides: { readonly id?: string; readonly costClass?: CostClass } = {},
): ModelCapability {
  return {
    id: overrides.id ?? "fim-1",
    kind: "chat",
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: overrides.costClass ?? "low",
    latencyClass,
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    supportsInfilling: true,
    infillingAlignment: "instruct",
  };
}

function fimConfig(
  latencyClass: LatencyClass,
  overrides: { readonly id?: string; readonly costClass?: CostClass } = {},
): GatewayConfig {
  const capability = fimCapability(latencyClass, overrides);
  return {
    providers: [{ modelId: capability.id, baseUrl: "http://localhost", apiKey: "x" }],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [capability],
  } as unknown as GatewayConfig;
}

function inlineBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root,
    document: {
      path: "src/a.ts",
      languageId: "typescript",
      text: "function add(a, b) {\n  return \n}\n",
    },
    position: { line: 1, character: 9 },
    triggerKind: "automatic",
    contextBudgetBytes: 4_096,
    ...overrides,
  };
}

function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root,
    document: {
      path: "src/a.ts",
      languageId: "typescript",
      text: "const value = { alpha: 1 };\nvalue.\n",
    },
    position: { line: 1, character: 6 },
    triggerKind: "invoked",
    contextBudgetBytes: 4_096,
    ...overrides,
  };
}

function body(result: { status: number; body: unknown }): EditorInlineCompletionWireResponse {
  return result.body as EditorInlineCompletionWireResponse;
}

// A chat factory that returns a fixed continuation; never reaches a live gateway.
const cannedChat: InlineCompletionChatFactory = () => () => Promise.resolve("a + b;");

// A permissive limiter so model-running tests are not affected by the process-wide cooldown.
function permissiveOptions(
  chatFactory: InlineCompletionChatFactory = cannedChat,
): EditorInlineCompletionRouteOptions {
  return {
    chatFactory,
    rateLimiter: createInlineCompletionRateLimiter({
      minIntervalMs: 0,
      maxPerWindow: 1_000,
      windowMs: 60_000,
    }),
    now: () => 1_000,
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-inline-route-")));
  await mkdir(join(root, "src"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("isInlineCompletionEnabledByPolicy", () => {
  it("defaults to enabled and tolerates a missing env", () => {
    expect(isInlineCompletionEnabledByPolicy(undefined)).toBe(true);
    expect(isInlineCompletionEnabledByPolicy({})).toBe(true);
  });

  it("disables on a falsy token (case-insensitive)", () => {
    for (const token of ["0", "false", "off", "no", "disabled", "OFF", " Off "]) {
      expect(isInlineCompletionEnabledByPolicy({ KEIKO_EDITOR_INLINE_COMPLETION: token })).toBe(
        false,
      );
    }
  });

  it("stays enabled for any other value", () => {
    expect(isInlineCompletionEnabledByPolicy({ KEIKO_EDITOR_INLINE_COMPLETION: "on" })).toBe(true);
  });
});

describe("POST /api/editor/inline-completion — validation & containment", () => {
  it("rejects a malformed request with 400 INVALID_REQUEST", async () => {
    const result = await handleEditorInlineCompletion(postContext({ root }), deps());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects an overlay path that escapes the workspace", async () => {
    const result = await handleEditorInlineCompletion(
      postContext(
        inlineBody({
          document: { path: "../escape.ts", languageId: "typescript", text: "const a = 1;\n" },
        }),
      ),
      deps(),
    );
    expect(result.status).toBe(403);
  });
});

describe("POST /api/editor/inline-completion — degradation (model-only)", () => {
  it("returns zero items without calling the model until the user explicitly opts in", async () => {
    const chat = vi.fn(() => Promise.resolve("a + b;"));
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast"), aiSettings: { inlineCompletion: false } }),
      permissiveOptions(() => chat),
    );
    expect(result.status).toBe(200);
    expect(body(result).items).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("returns zero items with a degrade reason when no gateway is configured", async () => {
    const result = await handleEditorInlineCompletion(postContext(inlineBody()), deps());
    expect(result.status).toBe(200);
    const wire = body(result);
    expect(wire.items).toEqual([]);
    expect(wire.provenance.modelMode).toBe("deterministic");
    expect(wire.provenance.degradeReason).toBe("no-infilling-model");
  });

  it("returns zero items when disabled by policy, even with a fast FIM model configured", async () => {
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast"), env: { KEIKO_EDITOR_INLINE_COMPLETION: "off" } }),
      permissiveOptions(),
    );
    expect(result.status).toBe(200);
    const wire = body(result);
    expect(wire.items).toEqual([]);
    expect(wire.provenance.modelMode).toBe("deterministic");
  });

  it("does not run the model on an automatic trigger when only a manual (standard) FIM model exists", async () => {
    const chat = vi.fn(() => Promise.resolve("a + b;"));
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody({ triggerKind: "automatic" })),
      deps({ config: fimConfig("standard") }),
      permissiveOptions(() => chat),
    );
    expect(body(result).items).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
    expect(body(result).provenance.modelMode).toBe("manual");
  });

  it("runs a manual (standard) FIM model on an explicit trigger", async () => {
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody({ triggerKind: "explicit" })),
      deps({ config: fimConfig("standard") }),
      permissiveOptions(),
    );
    const wire = body(result);
    expect(wire.items).toHaveLength(1);
    expect(wire.items[0]?.insertText).toBe("a + b;");
    expect(wire.provenance.modelMode).toBe("manual");
  });

  it("applies the server-owned low cost ceiling when the client omits maxCostClass", async () => {
    const chat = vi.fn(() => Promise.resolve("a + b;"));
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast", { costClass: "high" }) }),
      permissiveOptions(() => chat),
    );
    const wire = body(result);
    expect(wire.items).toEqual([]);
    expect(wire.provenance.modelMode).toBe("deterministic");
    expect(wire.provenance.degradeReason).toBe("over-cost-ceiling");
    expect(chat).not.toHaveBeenCalled();
  });

  it("does not let the client raise the server-owned cost ceiling", async () => {
    const chat = vi.fn(() => Promise.resolve("a + b;"));
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody({ maxCostClass: "high" })),
      deps({ config: fimConfig("fast", { costClass: "high" }) }),
      permissiveOptions(() => chat),
    );
    expect(body(result).items).toEqual([]);
    expect(body(result).provenance.degradeReason).toBe("over-cost-ceiling");
    expect(chat).not.toHaveBeenCalled();
  });

  it("allows deployment policy to raise the server cost ceiling", async () => {
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({
        config: fimConfig("fast", { costClass: "high" }),
        env: { KEIKO_EDITOR_INLINE_COMPLETION_MAX_COST_CLASS: "high" },
      }),
      permissiveOptions(),
    );
    expect(body(result).items).toHaveLength(1);
  });
});

describe("POST /api/editor/inline-completion — model tier (fast FIM, as-you-type)", () => {
  it("produces ghost text with content-free model provenance", async () => {
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      permissiveOptions(),
    );
    const wire = body(result);
    expect(wire.items).toHaveLength(1);
    expect(wire.items[0]?.insertText).toBe("a + b;");
    expect(wire.provenance.modelMode).toBe("as-you-type");
    expect(wire.provenance.modelId).toBe("fim-1");
    expect(wire.provenance.gatewayPolicyVersion).toBe("editor-inline-completion/1");
    expect(wire.provenance.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(wire.provenance.sources).toContain("model-assisted");
  });

  it("skips the model tier and renders no ghost text when the token budget is exhausted (LLM10)", async () => {
    const tokenBudget = createEditorModelTokenBudget({ maxTokensPerWindow: 10, windowMs: 60_000 });
    tokenBudget.record(root, 1_000, 10);
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      { ...permissiveOptions(), tokenBudget },
    );
    expect(body(result).items).toEqual([]);
    expect(body(result).provenance.sources).not.toContain("model-assisted");
  });

  it("settles model token usage so a later request in the window degrades (LLM10)", async () => {
    const usageChat: InlineCompletionChatFactory = () => () =>
      Promise.resolve({
        content: "a + b;",
        usage: {
          requestId: "req-1",
          promptTokens: 49_000,
          completionTokens: 500,
          latencyMs: 1,
          costClass: "low",
        },
      });
    const tokenBudget = createEditorModelTokenBudget({
      maxTokensPerWindow: 50_000,
      windowMs: 60_000,
    });
    const options = { ...permissiveOptions(usageChat), tokenBudget };
    const first = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      options,
    );
    expect(body(first).items).toHaveLength(1);
    // The first call settled to 49,500 tokens; the second reservation must skip the model tier.
    const second = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      options,
    );
    expect(body(second).items).toEqual([]);
  });

  it("shares the LLM10 token reservation budget with dropdown completion", async () => {
    const completionChat: CompletionChatFactory = () => () =>
      Promise.resolve({
        content: '["value.alpha"]',
        usage: {
          requestId: "completion-req-1",
          promptTokens: 49_000,
          completionTokens: 500,
          latencyMs: 1,
          costClass: "low",
        },
      });
    const inlineChat = vi.fn(() => Promise.resolve("a + b;"));
    const tokenBudget = createEditorModelTokenBudget({
      maxTokensPerWindow: 50_000,
      windowMs: 60_000,
    });
    const completion = await handleEditorCompletion(
      postContext(completionBody()),
      deps({ config: fimConfig("fast") }),
      {
        chatFactory: completionChat,
        tokenBudget,
        now: () => 1_000,
        languageServiceNow: () => 0,
      },
    );
    expect(JSON.stringify(completion.body)).toContain("model-assisted");
    const inline = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      { ...permissiveOptions(() => inlineChat), tokenBudget },
    );
    expect(body(inline).items).toEqual([]);
    expect(inlineChat).not.toHaveBeenCalled();
  });

  it("never echoes the buffer text in the response (content boundary)", async () => {
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      permissiveOptions(),
    );
    expect(JSON.stringify(result.body)).not.toContain("function add");
  });

  it("records content-free model evidence without prompt or buffer text", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast"), evidenceStore }),
      permissiveOptions(),
    );
    const records = evidenceStore.list().map((runId) => evidenceStore.get(runId) ?? "");
    const modelRecord = records.find((value) => value.includes("editor-inline-completion/1"));
    expect(modelRecord).toBeDefined();
    expect(modelRecord).not.toContain("function add");
    expect(modelRecord).not.toContain("a + b;");
  });

  it("redacts overlay secrets before the model prompt is sent", async () => {
    const secret = "example-env-token-1234567890abcd";
    let capturedUserPrompt = "";
    const chatFactory: InlineCompletionChatFactory = () => (request) => {
      capturedUserPrompt = request.user;
      return Promise.resolve("safe;");
    };
    const result = await handleEditorInlineCompletion(
      postContext(
        inlineBody({
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: `const token = "${secret}";\nconst value = \n`,
          },
          position: { line: 1, character: 14 },
        }),
      ),
      deps({
        config: fimConfig("fast"),
        env: { KEIKO_DEFAULT_API_KEY: secret },
      }),
      permissiveOptions(chatFactory),
    );
    expect(body(result).items).toHaveLength(1);
    expect(capturedUserPrompt).not.toContain(secret);
    expect(capturedUserPrompt).toContain("[REDACTED]");
  });

  it("degrades to zero items when the model call fails (never breaks the route)", async () => {
    const failing: InlineCompletionChatFactory = () => () => Promise.reject(new Error("boom"));
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      permissiveOptions(failing),
    );
    expect(result.status).toBe(200);
    expect(body(result).items).toEqual([]);
  });

  it("self-cancels as-you-type model calls after the latency budget", async () => {
    let chatCalls = 0;
    const abortingChat: ReturnType<InlineCompletionChatFactory> = (_request, signal) => {
      chatCalls += 1;
      return new Promise<string>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    };
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      {
        ...permissiveOptions(() => abortingChat),
        asYouTypeTimeoutMs: 5,
      },
    );
    expect(result.status).toBe(200);
    expect(body(result).items).toEqual([]);
    expect(chatCalls).toBe(1);
  });

  it("bounds output length by maxOutputTokens (≈4 chars/token)", async () => {
    const long: InlineCompletionChatFactory = () => () => Promise.resolve("x".repeat(500));
    const result = await handleEditorInlineCompletion(
      postContext(inlineBody({ maxOutputTokens: 4 })),
      deps({ config: fimConfig("fast") }),
      permissiveOptions(long),
    );
    expect(body(result).items[0]?.insertText).toHaveLength(16);
  });
});

describe("POST /api/editor/inline-completion — rate limiting", () => {
  it("skips the model and returns zero items once the per-root cooldown is hit", async () => {
    const rateLimiter = createInlineCompletionRateLimiter({
      minIntervalMs: 1_000,
      maxPerWindow: 10,
      windowMs: 60_000,
    });
    const chat = vi.fn(() => Promise.resolve("a + b;"));
    const options: EditorInlineCompletionRouteOptions = {
      chatFactory: () => chat,
      rateLimiter,
      now: () => 5_000,
    };
    const first = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      options,
    );
    const second = await handleEditorInlineCompletion(
      postContext(inlineBody()),
      deps({ config: fimConfig("fast") }),
      options,
    );
    expect(body(first).items).toHaveLength(1);
    expect(body(second).items).toEqual([]);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("shares a limiter bucket across root aliases that resolve to the same real root", async () => {
    const rateLimiter = createInlineCompletionRateLimiter({
      minIntervalMs: 1_000,
      maxPerWindow: 10,
      windowMs: 60_000,
    });
    const chat = vi.fn(() => Promise.resolve("a + b;"));
    const options: EditorInlineCompletionRouteOptions = {
      chatFactory: () => chat,
      rateLimiter,
      now: () => 5_000,
    };
    const first = await handleEditorInlineCompletion(
      postContext(inlineBody({ root })),
      deps({ config: fimConfig("fast") }),
      options,
    );
    const second = await handleEditorInlineCompletion(
      postContext(inlineBody({ root: `${root}/.` })),
      deps({ config: fimConfig("fast") }),
      options,
    );
    expect(body(first).items).toHaveLength(1);
    expect(body(second).items).toEqual([]);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/editor/inline-completion/telemetry", () => {
  function telemetryReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      root,
      offered: 5,
      shown: 4,
      accepted: 2,
      rejected: 1,
      ignored: 1,
      partiallyAccepted: 0,
      requestCount: 6,
      requestLatencyMsP50: 45,
      requestLatencyMsP95: 120,
      ...overrides,
    };
  }

  it("rejects a malformed report with 400", async () => {
    const result = await handleEditorInlineCompletionTelemetry(
      postContext({ root, offered: -1 }),
      deps(),
    );
    expect(result.status).toBe(400);
  });

  it("records content-free acceptance evidence (no path, no code) and returns 200", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const result = await handleEditorInlineCompletionTelemetry(
      postContext(telemetryReport()),
      deps({ evidenceStore }),
      { now: () => 9_000 },
    );
    expect(result.status).toBe(200);
    const records = evidenceStore.list().map((runId) => evidenceStore.get(runId) ?? "");
    const record = records.find((value) => value.includes("editor-inline-completion-telemetry"));
    expect(record).toBeDefined();
    expect(record).toContain('"accepted":2');
    expect(record).toContain('"requestLatencyMsP50":45');
    expect(record).toContain('"requestLatencyMsP95":120');
    // The raw workspace root path is never persisted (only a hash).
    expect(record).not.toContain(root);
  });

  it("canonicalizes root aliases before hashing telemetry evidence", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const aliasRoot = `${root}/.`;
    const result = await handleEditorInlineCompletionTelemetry(
      postContext(telemetryReport({ root: aliasRoot })),
      deps({ evidenceStore }),
      { now: () => 9_001 },
    );
    expect(result.status).toBe(200);
    const records = evidenceStore.list().map((runId) => evidenceStore.get(runId) ?? "");
    const record = records.find((value) => value.includes("editor-inline-completion-telemetry"));
    expect(record).toBeDefined();
    expect(record).toContain(sha256Hex(root));
    expect(record).not.toContain(sha256Hex(aliasRoot));
    expect(record).not.toContain(aliasRoot);
  });

  it("rejects telemetry for a nonexistent root instead of recording spoofed evidence", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const result = await handleEditorInlineCompletionTelemetry(
      postContext(telemetryReport({ root: join(root, "missing") })),
      deps({ evidenceStore }),
      { now: () => 9_002 },
    );
    expect(result.status).not.toBe(200);
    expect(evidenceStore.list()).toEqual([]);
  });
});
