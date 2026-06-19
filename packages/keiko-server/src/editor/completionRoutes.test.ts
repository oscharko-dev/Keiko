import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { EvidenceStore } from "@oscharko-dev/keiko-contracts";
import type { GatewayConfig, ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type { EditorCompletionWireResponse, LatencyClass } from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import {
  COMPLETION_LANGUAGE_SERVICE_LIMITS,
  handleEditorCompletion,
  type CompletionChatFactory,
  type EditorCompletionRouteOptions,
} from "./completionRoutes.js";
import {
  createEditorModelTokenBudget,
  type EditorModelTokenBudget,
} from "./editorModelTokenBudget.js";

function postContext(body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/completion"),
  };
}

function postContextWithResponseClose(body: unknown): RouteContext {
  const ctx = postContext(body);
  const res = {
    writableEnded: false,
    on(event: string, listener: () => void) {
      if (event === "close") {
        listener();
      }
      return res;
    },
  } as unknown as ServerResponse;
  return { ...ctx, res };
}

let root: string;
let store: UiStore;

function deps(
  config?: GatewayConfig,
  evidenceStore: EvidenceStore = createInMemoryEvidenceStore(),
  env: Record<string, string | undefined> = {},
): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor(env, config),
    evidenceStore,
    env,
    ...(config === undefined ? {} : { config }),
  } as unknown as UiHandlerDeps;
}

function fimCapability(latencyClass: LatencyClass): ModelCapability {
  return {
    id: "fim-1",
    kind: "chat",
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "low",
    latencyClass,
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    supportsInfilling: true,
    infillingAlignment: "instruct",
  };
}

function fimConfig(latencyClass: LatencyClass): GatewayConfig {
  return {
    providers: [{ modelId: "fim-1", baseUrl: "http://localhost", apiKey: "x" }],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
    capabilities: [fimCapability(latencyClass)],
  } as unknown as GatewayConfig;
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

function body(result: { status: number; body: unknown }): EditorCompletionWireResponse {
  return result.body as EditorCompletionWireResponse;
}

const cannedChat: CompletionChatFactory = () => () =>
  Promise.resolve('["value.alpha", "value.beta"]');

function routeOptions(overrides: EditorCompletionRouteOptions = {}): EditorCompletionRouteOptions {
  return { languageServiceNow: () => 0, ...overrides };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-completion-route-")));
  await mkdir(join(root, "src"));
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("POST /api/editor/completion — request validation", () => {
  it("rejects a malformed request with 400 INVALID_REQUEST", async () => {
    const result = await handleEditorCompletion(postContext({ root }), deps());
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("maps an unsupported language to 422", async () => {
    const result = await handleEditorCompletion(
      postContext(
        completionBody({ document: { path: "src/a.rb", languageId: "ruby", text: "x = 1\n" } }),
      ),
      deps(),
    );
    expect(result.status).toBe(422);
  });

  it("rejects an overlay path that escapes the workspace with 403", async () => {
    const result = await handleEditorCompletion(
      postContext(
        completionBody({
          document: { path: "../escape.ts", languageId: "typescript", text: "const a = 1;\n" },
        }),
      ),
      deps(),
    );
    expect(result.status).toBe(403);
  });

  it("rejects invalid changed-file context selectors before retrieval", async () => {
    const result = await handleEditorCompletion(
      postContext(completionBody({ context: { changedFiles: ["src/../package.json"] } })),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("caps changed-file context selectors to the shared editor-context route limit", async () => {
    const changedFiles = Array.from({ length: 65 }, (_, index) => `src/f${index.toString()}.ts`);
    const result = await handleEditorCompletion(
      postContext(completionBody({ context: { changedFiles } })),
      deps(),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
});

describe("POST /api/editor/completion — deterministic tier (no gateway model)", () => {
  it("uses the completion-specific deterministic deadline budget", () => {
    expect(COMPLETION_LANGUAGE_SERVICE_LIMITS.deadlineMs).toBe(500);
    expect(COMPLETION_LANGUAGE_SERVICE_LIMITS.maxCompletionItems).toBe(256);
  });

  it("returns deterministic items with a deterministic-only provenance and degrade reason", async () => {
    const result = await handleEditorCompletion(
      postContext(completionBody()),
      deps(),
      routeOptions(),
    );
    expect(result.status).toBe(200);
    const payload = body(result);
    expect(payload.schemaVersion).toBe("1");
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items.every((item) => item.origin === "deterministic")).toBe(true);
    expect(payload.items.some((item) => item.label === "alpha")).toBe(true);
    expect(payload.provenance.sources).toEqual(["deterministic-language-service"]);
    expect(payload.provenance.modelMode).toBe("deterministic");
    expect(payload.provenance.degradeReason).toBe("no-infilling-model");
    expect(payload.provenance.promptHash).toBeUndefined();
  });

  it("cancels analysis when the client disconnects (499)", async () => {
    const result = await handleEditorCompletion(
      postContextWithResponseClose(completionBody()),
      deps(),
    );
    expect(result.status).toBe(499);
  });
});

describe("POST /api/editor/completion — gated model-assisted tier", () => {
  it("keeps deterministic items first and reports model + deterministic provenance (AC7)", async () => {
    const result = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      routeOptions({ chatFactory: cannedChat }),
    );
    expect(result.status).toBe(200);
    const payload = body(result);
    const modelItems = payload.items.filter((item) => item.origin === "model-assisted");
    expect(modelItems.map((item) => item.insertText)).toEqual(["value.alpha", "value.beta"]);
    expect(payload.items[0]?.origin).toBe("deterministic");
    expect(payload.provenance.sources).toEqual(
      expect.arrayContaining(["deterministic-language-service", "model-assisted"]),
    );
    expect(payload.provenance.modelMode).toBe("as-you-type");
    expect(payload.provenance.modelId).toBe("fim-1");
    expect(payload.provenance.gatewayPolicyVersion).toBe("editor-completion/1");
    expect(payload.provenance.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips the model tier when the per-root token budget is exhausted (LLM10)", async () => {
    const tokenBudget = createEditorModelTokenBudget({ maxTokensPerWindow: 10, windowMs: 60_000 });
    // Pre-exhaust the window at the injected clock time.
    tokenBudget.record(root, 1_000, 10);
    const result = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      routeOptions({
        chatFactory: cannedChat,
        tokenBudget,
        now: () => 1_000,
      }),
    );
    expect(result.status).toBe(200);
    const payload = body(result);
    expect(payload.items.some((item) => item.origin === "model-assisted")).toBe(false);
    expect(payload.provenance.sources).not.toContain("model-assisted");
  });

  it("settles model token usage so a later request in the window degrades (LLM10)", async () => {
    const usageChat: CompletionChatFactory = () => () =>
      Promise.resolve({
        content: '["value.alpha"]',
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
    const options: EditorCompletionRouteOptions = routeOptions({
      chatFactory: usageChat,
      tokenBudget,
      now: () => 1_000,
    });
    const first = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      options,
    );
    expect(body(first).items.some((item) => item.origin === "model-assisted")).toBe(true);
    // The first call settled to 49,500 tokens; the second reservation must skip the model tier.
    const second = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      options,
    );
    expect(body(second).items.some((item) => item.origin === "model-assisted")).toBe(false);
  });

  it("reserves before provider calls so concurrent requests cannot both enter a one-call window", async () => {
    let reserved = false;
    const tokenBudget: EditorModelTokenBudget = {
      isExhausted: () => reserved,
      record: () => undefined,
      tryReserve: () => {
        if (reserved) {
          return undefined;
        }
        reserved = true;
        return {
          reservedTokens: 1,
          settle: () => undefined,
          cancel: (): void => {
            reserved = false;
          },
        };
      },
    };
    let releaseFirst: ((value: string) => void) | undefined;
    let startedFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const chat = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          startedFirst?.();
          releaseFirst = resolve;
        }),
    );
    const options: EditorCompletionRouteOptions = routeOptions({
      chatFactory: () => chat,
      tokenBudget,
      now: () => 1_000,
    });
    const first = handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      options,
    );
    await firstStarted;
    const second = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      options,
    );
    expect(body(second).items.some((item) => item.origin === "model-assisted")).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    releaseFirst?.('["value.alpha"]');
    expect(body(await first).items.some((item) => item.origin === "model-assisted")).toBe(true);
  });

  it("redacts overlay secrets before the dropdown completion prompt is sent", async () => {
    const secret = "example-env-token-1234567890abcd";
    let capturedUserPrompt = "";
    const chatFactory: CompletionChatFactory = () => (request) => {
      capturedUserPrompt = request.user;
      return Promise.resolve('["safeCandidate"]');
    };
    const result = await handleEditorCompletion(
      postContext(
        completionBody({
          document: {
            path: "src/a.ts",
            languageId: "typescript",
            text: `const token = "${secret}";\nvalue.\n`,
          },
        }),
      ),
      deps(fimConfig("fast"), createInMemoryEvidenceStore(), { KEIKO_DEFAULT_API_KEY: secret }),
      routeOptions({ chatFactory }),
    );
    expect(result.status).toBe(200);
    expect(body(result).items.some((item) => item.origin === "model-assisted")).toBe(true);
    expect(capturedUserPrompt).not.toContain(secret);
    expect(capturedUserPrompt).toContain("[REDACTED]");
  });

  it("records content-free Gateway usage evidence for model-assisted calls", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const chat: CompletionChatFactory = () => () =>
      Promise.resolve({
        content: '["value.alpha"]',
        usage: {
          requestId: "gateway-request-1",
          promptTokens: 10,
          completionTokens: 2,
          latencyMs: 123,
          costClass: "low",
        },
      });
    const result = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast"), evidenceStore),
      routeOptions({ chatFactory: chat }),
    );
    expect(result.status).toBe(200);
    const runId = evidenceStore.list().find((id) => id.startsWith("editor-completion-model-"));
    expect(runId).toBeDefined();
    const manifest = JSON.parse(evidenceStore.get(runId ?? "") ?? "{}") as {
      readonly editorCompletionModelSchemaVersion?: string;
      readonly modelId?: string;
      readonly gatewayPolicyVersion?: string;
      readonly promptHash?: string;
      readonly itemCount?: number;
      readonly usage?: { readonly requestId?: string; readonly promptTokens?: number };
    };
    expect(manifest.editorCompletionModelSchemaVersion).toBe("1");
    expect(manifest.modelId).toBe("fim-1");
    expect(manifest.gatewayPolicyVersion).toBe("editor-completion/1");
    expect(manifest.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.itemCount).toBe(1);
    expect(manifest.usage).toMatchObject({ requestId: "gateway-request-1", promptTokens: 10 });
  });

  it("does not run a manual-only model on a trigger character, but does on an explicit invoke", async () => {
    const triggerChar = await handleEditorCompletion(
      postContext(completionBody({ triggerKind: "trigger-character", triggerCharacter: "." })),
      deps(fimConfig("standard")),
      routeOptions({ chatFactory: cannedChat }),
    );
    const triggerPayload = body(triggerChar);
    expect(triggerPayload.items.every((item) => item.origin === "deterministic")).toBe(true);
    expect(triggerPayload.provenance.modelMode).toBe("manual");
    expect(triggerPayload.provenance.promptHash).toBeUndefined();

    const invoked = await handleEditorCompletion(
      postContext(completionBody({ triggerKind: "invoked" })),
      deps(fimConfig("standard")),
      routeOptions({ chatFactory: cannedChat }),
    );
    const invokedPayload = body(invoked);
    expect(invokedPayload.items.some((item) => item.origin === "model-assisted")).toBe(true);
    expect(invokedPayload.provenance.modelMode).toBe("manual");
  });

  it("omits model identity/hash when the model is invoked but returns no items", async () => {
    // Provenance honesty: modelId/gatewayPolicyVersion/promptHash identify the model that produced
    // the response's items, so an invoked-but-empty model must not stamp them on the response.
    const emptyChat: CompletionChatFactory = () => () => Promise.resolve("[]");
    const result = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      routeOptions({ chatFactory: emptyChat }),
    );
    const payload = body(result);
    expect(payload.items.every((item) => item.origin === "deterministic")).toBe(true);
    expect(payload.provenance.sources).toEqual(["deterministic-language-service"]);
    expect(payload.provenance.modelMode).toBe("as-you-type");
    expect(payload.provenance.modelId).toBeUndefined();
    expect(payload.provenance.gatewayPolicyVersion).toBeUndefined();
    expect(payload.provenance.promptHash).toBeUndefined();
  });

  it("degrades to deterministic-only when the model call fails (AC4)", async () => {
    const failingChat: CompletionChatFactory = () => () =>
      Promise.reject(new Error("gateway down"));
    const result = await handleEditorCompletion(
      postContext(completionBody()),
      deps(fimConfig("fast")),
      routeOptions({ chatFactory: failingChat }),
    );
    expect(result.status).toBe(200);
    const payload = body(result);
    expect(payload.items.every((item) => item.origin === "deterministic")).toBe(true);
    expect(payload.provenance.sources).toEqual(["deterministic-language-service"]);
    expect(payload.provenance.promptHash).toBeUndefined();
  });

  it("reuses the governed repository-search/context service and surfaces it as a source (AC6)", async () => {
    // A real workspace file the reused #1211 repo-search provider can match — proving the route does
    // not implement an editor-specific search but invokes the existing governed context API.
    await writeFile(
      join(root, "src", "a.ts"),
      "export const alphaHelper = (): number => 1;\n",
      "utf8",
    );
    const result = await handleEditorCompletion(
      postContext(completionBody({ context: { queryText: "alphaHelper" } })),
      deps(fimConfig("fast")),
      routeOptions({ chatFactory: cannedChat }),
    );
    const payload = body(result);
    expect(payload.provenance.sources).toEqual(
      expect.arrayContaining(["model-assisted", "repository-context"]),
    );
  });

  it("honors the host-supplied context budget in the recorded context evidence", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const result = await handleEditorCompletion(
      postContext(completionBody({ contextBudgetBytes: 1 })),
      deps(fimConfig("fast"), evidenceStore),
      routeOptions({ chatFactory: cannedChat }),
    );
    expect(result.status).toBe(200);
    const runId = evidenceStore.list().find((id) => id.startsWith("coding-context-"));
    expect(runId).toBeDefined();
    const manifest = JSON.parse(evidenceStore.get(runId ?? "") ?? "{}") as {
      readonly budgetBytes?: number;
    };
    expect(manifest.budgetBytes).toBe(1);
  });

  it("never lets a base-FIM model be elected (only aligned models run)", async () => {
    const baseConfig = {
      providers: [{ modelId: "base-fim", baseUrl: "http://localhost", apiKey: "x" }],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
      capabilities: [{ ...fimCapability("fast"), id: "base-fim", infillingAlignment: "base" }],
    } as unknown as GatewayConfig;
    const chat = vi.fn(() => Promise.resolve("[]"));
    const factory: CompletionChatFactory = () => chat;
    const result = await handleEditorCompletion(
      postContext(completionBody()),
      deps(baseConfig),
      routeOptions({ chatFactory: factory }),
    );
    const payload = body(result);
    expect(chat).not.toHaveBeenCalled();
    expect(payload.items.every((item) => item.origin === "deterministic")).toBe(true);
    expect(payload.provenance.modelMode).toBe("deterministic");
    expect(payload.provenance.degradeReason).toBe("only-base-infilling-model");
  });
});
