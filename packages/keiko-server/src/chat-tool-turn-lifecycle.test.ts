import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextOverflowError,
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { ChatToolTurn, type ChatToolTurnOptions } from "./chat-tool-turn.js";
import { createInMemoryUiStore } from "./store/index.js";
import { probeVerifiedGatewayConfig } from "./_support.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import type { CatalogTrustedContext } from "./tool-catalog/catalogToolPorts.js";
import { createCatalogToolBinder } from "./tool-catalog/catalogToolDispatch.js";
import { catalogToolFixture } from "./tool-catalog/__fixtures__/catalogToolFixture.js";
import { processServerLogSink } from "./process-log-sink.js";

const MODEL = "synthetic-turn-lifecycle";
const stores: ReturnType<typeof createInMemoryUiStore>[] = [];
const roots: string[] = [];
const request: GatewayCallRequest = {
  modelId: MODEL,
  messages: [{ role: "user", content: "Read the selected synthetic source." }],
  maxOutputTokens: 100,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
});
afterEach(() => {
  try {
    for (const store of stores.splice(0)) store.close();
  } finally {
    vi.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

interface LifecycleContext extends CatalogTrustedContext {
  readonly selectJiraOperations?: (
    identities: readonly string[],
    result: CatalogJsonObject,
  ) => Promise<void>;
  readonly selectedJiraOperations?: () => readonly string[];
}
// Require the optional hook in this fixture; the actual base call/round/finally code is never mocked.
type LifecycleOptions = ChatToolTurnOptions<LifecycleContext> & {
  readonly finalizeTurn: () => Promise<void>;
};
class LifecycleTurn extends ChatToolTurn<LifecycleContext> {
  static create(options: LifecycleOptions): LifecycleTurn {
    return new LifecycleTurn(options);
  }
  protected override reserveAuthorityPrompt(): boolean {
    return true;
  }
  protected override observedMutation(): undefined {
    return undefined;
  }
}

function gateway(): ReturnType<typeof probeVerifiedGatewayConfig> {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  return probeVerifiedGatewayConfig(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
          toolCalling: true,
          toolCallingVerification: {
            status: "verified",
            checkedAt: new Date().toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(provider),
          },
        },
      ],
    }),
  );
}

function fixture(
  finalizeTurn: () => Promise<void>,
  selectionClose?: () => Promise<void>,
  observeSelection?: (selected: readonly string[] | undefined) => void,
): {
  readonly turn: LifecycleTurn;
  readonly diagnostics: ServerDiagnosticRecord[];
} {
  const f = catalogToolFixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-turn-lifecycle-")));
  roots.push(root);
  const store = createInMemoryUiStore();
  stores.push(store);
  const project = store.createProject(root);
  const chat = store.createChat(project.path, "Synthetic lifecycle", MODEL);
  const message = store.createMessage({
    chatId: chat.id,
    role: "user",
    content: "Read the synthetic source.",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  const diagnostics: ServerDiagnosticRecord[] = [];
  const bind: ChatToolTurnOptions<LifecycleContext>["bind"] = (
    context,
    budgetPort,
    invocationRegistry,
  ) =>
    createCatalogToolBinder(
      {
        ...f.input,
        budgetPort,
        handlerBindings: [
          {
            ...f.handler,
            execute: async (args, handlerContext): ReturnType<typeof f.handler.execute> => {
              if (selectionClose !== undefined) {
                if (context.selectJiraOperations === undefined)
                  throw new Error("Missing selection port");
                observeSelection?.(context.selectedJiraOperations?.());
                await context.selectJiraOperations(["GET /synthetic"], { text: "selected" });
              }
              return f.handler.execute(args, handlerContext);
            },
          },
        ],
      },
      { ...f.options, context: () => context, invocationRegistry },
    );
  const turn = LifecycleTurn.create({
    deps: {
      store,
      gatewayConfig: gateway(),
      diagnostics: {
        record: (entry): void => {
          diagnostics.push(entry);
        },
      },
    },
    message,
    context: f.context,
    managed: f.pure,
    correlationId: "turn-lifecycle",
    budget: { maxRuntimeMs: 59000, maxToolCalls: 5, maxPromptTokens: 100000, maxPatchBytes: 0 },
    bind,
    finalizeTurn,
    ...(selectionClose === undefined
      ? {}
      : {
          selectTools: (): ReturnType<NonNullable<LifecycleOptions["selectTools"]>> =>
            Promise.resolve({ managed: f.pure, bind, close: selectionClose }),
        }),
  });
  return { turn, diagnostics };
}

function answer(): NormalizedResponse {
  return {
    modelId: MODEL,
    content: "The synthetic source was read.",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "synthetic-round",
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function selectedModel(next: () => Promise<NormalizedResponse>): ModelPort {
  let rounds = 0;
  return {
    call: (round): Promise<NormalizedResponse> => {
      if (++rounds > 1) return next();
      const bridge = createGatewayToolCatalogBridge(round, Date.now);
      return Promise.resolve({
        ...answer(),
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          bridge.bind({ id: "read-one", name: "fixture_read", arguments: { path: "fixture.ts" } }),
        ],
      });
    },
  };
}

type Settled = { readonly response: NormalizedResponse } | { readonly error: unknown };
function observe(work: Promise<NormalizedResponse>): Promise<Settled> {
  return work.then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
}
type Terminal = "success" | "error" | "cancel";
const terminals: readonly Terminal[] = ["success", "error", "cancel"];
function terminalModel(terminal: Terminal, controller: AbortController, failure: Error): ModelPort {
  return {
    call: (): Promise<NormalizedResponse> => {
      if (terminal === "success") return Promise.resolve(answer());
      if (terminal === "cancel") controller.abort(failure);
      return Promise.reject(failure);
    },
  };
}
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release = (): void => {
    throw new TypeError("Missing deferred test resolver");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      release();
    },
  };
}

describe("ChatToolTurn Jira operation selection", () => {
  it("tells the next describe which settled selection it replaces (LIM22)", async () => {
    const log = vi.spyOn(processServerLogSink(), "write").mockImplementation(() => undefined);
    onTestFinished(() => {
      log.mockRestore();
    });
    const observed: (readonly string[] | undefined)[] = [];
    const f = fixture(
      () => Promise.resolve(),
      () => Promise.resolve(),
      (selected) => observed.push(selected),
    );
    let rounds = 0;
    const model: ModelPort = {
      call: (round): Promise<NormalizedResponse> => {
        if (++rounds > 2) return Promise.resolve(answer());
        const bridge = createGatewayToolCatalogBridge(round, Date.now);
        return Promise.resolve({
          ...answer(),
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            bridge.bind({
              id: `read-${String(rounds)}`,
              name: "fixture_read",
              arguments: { path: "fixture.ts" },
            }),
          ],
        });
      },
    };
    await expect(f.turn.call(model, request, new AbortController().signal)).resolves.toMatchObject({
      content: answer().content,
    });
    expect(observed).toEqual([[], ["GET /synthetic"]]);
    const selections = log.mock.calls
      .map(([event]) => event)
      .filter((event) => event.op === "jira.catalog.selection")
      .map((event) => event.extra);
    expect(selections).toEqual([
      expect.objectContaining({ surface: "chat", selectedCount: 1, deselectedCount: 0 }),
      expect.objectContaining({ surface: "chat", selectedCount: 1, retainedCount: 1 }),
    ]);
  });
});

describe("ChatToolTurn final lifetime cleanup", () => {
  it.each(terminals)("awaits the finalizer before a %s call settles", async (terminal) => {
    const entered = deferred();
    const release = deferred();
    let finalized = 0;
    const f = fixture(async () => {
      finalized++;
      entered.resolve();
      await release.promise;
    });
    const controller = new AbortController();
    const failure = new Error("synthetic original failure");
    let returned = false;
    const settled = observe(
      f.turn.call(terminalModel(terminal, controller, failure), request, controller.signal),
    ).then((result) => {
      returned = true;
      return result;
    });
    try {
      expect(
        await Promise.race([
          entered.promise.then(() => "finalizing"),
          settled.then(() => "settled"),
        ]),
      ).toBe("finalizing");
      expect(finalized).toBe(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await settled).toEqual(
      terminal === "success" ? { response: answer() } : { error: failure },
    );
  });

  it("keeps an adopted window retry open and finalizes once after its subsequent answer", async () => {
    let finalized = 0;
    let closed = 0;
    const f = fixture(
      () => {
        finalized++;
        return Promise.resolve();
      },
      () => {
        closed++;
        return Promise.resolve();
      },
    );
    const overflow = new ContextOverflowError("synthetic adopted window");
    const signal = new AbortController().signal;
    const first = f.turn.call(
      selectedModel(() => Promise.reject(overflow)),
      request,
      signal,
      undefined,
      (error) => error === overflow,
    );
    await expect(first).rejects.toBe(overflow);
    expect(finalized).toBe(0);
    expect(closed).toBe(0);
    await expect(
      f.turn.call({ call: () => Promise.resolve(answer()) }, request, signal),
    ).resolves.toMatchObject({ content: answer().content });
    expect(finalized).toBe(1);
    expect(closed).toBe(1);
  });

  it.each(terminals)(
    "retains the original %s outcome when private cleanup fails",
    async (terminal) => {
      const secret = "synthetic-private-cleanup-canary";
      const f = fixture(() => Promise.reject(new Error(secret)));
      const controller = new AbortController();
      const original = new Error("synthetic original failure");
      const settled = await observe(
        f.turn.call(terminalModel(terminal, controller, original), request, controller.signal),
      );
      expect(settled).toEqual(
        terminal === "success" ? { response: answer() } : { error: original },
      );
      expect(f.diagnostics).toMatchObject([
        { operation: "chat.tool-turn.finalize", errorClass: "Error" },
      ]);
      expect(JSON.stringify(f.diagnostics)).not.toContain(secret);
    },
  );

  it.each(["success", "error"])(
    "still finalizes after selection release fails on %s",
    async (terminal) => {
      const events: string[] = [];
      const original = new Error("synthetic original failure");
      const f = fixture(
        () => {
          events.push("private-finished");
          return Promise.resolve();
        },
        () => {
          events.push("selection-close");
          return Promise.reject(new Error("synthetic-private-selection-canary"));
        },
      );
      const model = selectedModel(() =>
        terminal === "success" ? Promise.resolve(answer()) : Promise.reject(original),
      );
      const settled = await observe(f.turn.call(model, request, new AbortController().signal));
      if (terminal === "success")
        expect(settled).toMatchObject({ response: { content: answer().content } });
      else expect(settled).toEqual({ error: original });
      expect(events).toEqual(["selection-close", "private-finished"]);
      expect(f.diagnostics).toMatchObject([
        { operation: "chat.tool-turn.selection-release", errorClass: "Error" },
      ]);
      expect(JSON.stringify(f.diagnostics)).not.toContain("synthetic-private-selection-canary");
    },
  );
});
