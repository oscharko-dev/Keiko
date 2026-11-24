import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createInMemoryWorkspaceIndexStore,
  createWorkspaceIndex,
  type WorkspaceIndex,
} from "@oscharko-dev/keiko-workspace";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { createChatToolTurn, type ChatToolTurnPort } from "./chat-tool-runtime.js";
import { ConversationModelNotReadyError } from "./conversation-readiness-admission.js";
import { admitConnectedFolderToolSource } from "./grounded-qa.js";
import {
  createGroundedSynthesisAttemptAdmission,
  createGroundedSynthesisCallBudget,
} from "./grounded-answer.js";
import {
  callGroundedSynthesisModel,
  GROUNDED_FOLDER_TOOL_TURN_GUIDANCE,
  GROUNDED_TOOL_TURN_GUIDANCE,
  groundedToolTurnGuidance,
} from "./grounded-plural-synthesis.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import type { ChatMessage } from "./store/index.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "folder-chat-model";
const SELECTED = "folder.files.turn-selected";
const FACT = "Der Kostenrahmen liegt bei 120000 Euro.";
const POD = "folder-turn-pod" as KnowledgeCapsuleId;

const cleanup: (() => Promise<void> | void)[] = [];
let sink: BufferedServerLogSink;
beforeEach(() => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  resetServerLogger();
  vi.restoreAllMocks();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function folder(): string {
  const root = tempDir("keiko-folder-turn-src-");
  const files: Record<string, string> = {
    // No trailing newline: the file has exactly three lines.
    "docs/budget.txt": `Planung\n${FACT}\nEnde`,
    "docs/plan.md": "# Plan\n\nStart ist im Maerz.\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** The setup placeholder of a model whose window nobody declared: not a window to plan with. */
const ASSUMED_WINDOW = { contextWindow: 4096, maxOutputTokens: 4096, contextWindowAssumed: true };

function configure(deps: UiHandlerDeps, toolCalling: boolean, assumedWindow = false): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          maxOutputTokens: 1024,
          contextWindow: 16_384,
          ...(assumedWindow ? ASSUMED_WINDOW : {}),
          toolCalling,
          toolCallingVerification: {
            status: toolCalling ? "verified" : "unsupported",
            checkedAt: new Date().toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(provider),
          },
        },
      ],
    }),
    true,
  );
}

interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly root: string;
  readonly chatId: string;
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly accept: (key: string) => ChatMessage;
  /** The call the grounded route makes: the folder admission is supplied, as in production. */
  readonly createTurn: (key: string) => Promise<ChatToolTurnPort | undefined>;
  readonly admissions: () => number;
}

function fixture(
  options: { readonly toolCalling?: boolean; readonly assumedWindow?: boolean } = {},
): Fixture {
  const runtimeDir = tempDir("keiko-folder-turn-state-");
  const root = folder();
  const diagnostics: ServerDiagnosticRecord[] = [];
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(runtimeDir, "evidence"),
    uiDbPath: join(runtimeDir, "runtime-ui.db"),
    env: { KEIKO_STATE_DIR: runtimeDir },
    diagnostics: { record: (record) => diagnostics.push(record) },
  });
  cleanup.push(async () => {
    await deps.dispose?.();
  });
  configure(deps, options.toolCalling ?? true, options.assumedWindow ?? false);
  const project = deps.store.createProject(root);
  const chat = deps.store.updateChat(deps.store.createChat(project.path, "Folder", MODEL).id, {
    connectedScopes: [{ kind: "workspace-root", root, relativePaths: [], connectedAtMs: 1 }],
  });
  let admissions = 0;
  const accept: Fixture["accept"] = (key) => {
    const accepted = deps.store.admitChatTurn(key, {
      chatId: chat.id,
      role: "user",
      content: "What does the folder say about the budget?",
      timestamp: Date.now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (accepted.kind !== "admitted") throw new Error("Expected an accepted human turn");
    return accepted.userMessage;
  };
  return {
    deps,
    root,
    chatId: chat.id,
    diagnostics,
    accept,
    admissions: () => admissions,
    createTurn: (key) =>
      createChatToolTurn(deps, MODEL, accept(key), new AbortController().signal, key, {
        connectedFolder: () => {
          admissions += 1;
          const current = deps.store.findChatById(chat.id);
          if (current === undefined) throw new Error("Expected the Chat.");
          return admitConnectedFolderToolSource(current, deps, undefined, key);
        },
      }),
  };
}

function response(count: number): NormalizedResponse {
  return {
    modelId: MODEL,
    content: "The budget is 120000 Euro.",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: `folder-response-${String(count)}`,
      promptTokens: 100,
      completionTokens: 10,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

/** Calls the folder tool once with `args`, then answers; `beforeCall` runs before the tool call. */
function model(
  calls: GatewayCallRequest[],
  args: Record<string, string | number>,
  beforeCall: () => void = () => undefined,
): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      const admission = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 100 });
      const answer = response(calls.length);
      admission?.settle(answer.usage, true, "observed");
      if (calls.length > 1) return Promise.resolve(answer);
      if (request.toolCatalog?.kind !== "bound") throw new Error("Expected a bound tool catalog");
      const entry = request.toolCatalog.projection.tools.find(
        (tool) => tool.toolRef.canonicalId === "keiko.folder.files",
      );
      if (entry === undefined) throw new Error("Expected the folder tool");
      expect(request.toolCatalog.projection.tools).toHaveLength(1);
      expect(entry.alias).toBe("folder_files");
      const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
      beforeCall();
      return Promise.resolve({
        ...answer,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [bridge.bind({ id: "folder-call", name: entry.alias, arguments: args })],
      });
    },
  };
}

/** Calls the folder tool once per entry of `rounds`, one call a round, then answers. */
function modelInRounds(
  calls: GatewayCallRequest[],
  rounds: readonly Record<string, string | number>[],
): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      calls.push(request);
      const admission = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 100 });
      const answer = response(calls.length);
      admission?.settle(answer.usage, true, "observed");
      const args = rounds[calls.length - 1];
      if (args === undefined) return Promise.resolve(answer);
      const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
      return Promise.resolve({
        ...answer,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          bridge.bind({
            id: `folder-call-${String(calls.length)}`,
            name: "folder_files",
            arguments: args,
          }),
        ],
      });
    },
  };
}

function toolMessages(request: GatewayCallRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => message.content)
    .join("\n");
}

function selections(): readonly Record<string, unknown>[] {
  return sink.events
    .filter((event) => event.op === SELECTED)
    .map((event) =>
      expectActivityLogProof("folder.files.turn-selected.line", formatActivityLogProofLine(event)),
    );
}

describe("turn selection for a Chat with a connected folder", () => {
  it("runs the folder tool turn when the model is ready for tools", async () => {
    const f = fixture();
    expect(f.deps.connectedFolderChatCatalog).toBeDefined();
    const turn = await f.createTurn("folder-tool-turn");
    if (turn?.connectedFolder === undefined) throw new Error("Expected a folder tool turn");
    expect(turn.connectedFolder.returnedWindows()).toEqual([]);
    const calls: GatewayCallRequest[] = [];
    const answer = await turn.call(
      turn.meter(model(calls, { view: "read", path: "docs/budget.txt" })),
      { modelId: MODEL, messages: [{ role: "user", content: "What is the budget?" }] },
      new AbortController().signal,
    );
    expect(answer.content).toBe("The budget is 120000 Euro.");
    expect(calls).toHaveLength(2);
    expect(toolMessages(calls[1])).toContain(FACT);
    expect(toolMessages(calls[1])).toContain("untrusted-document-text");
    const windows = turn.connectedFolder.returnedWindows();
    expect(windows).toMatchObject([{ path: "docs/budget.txt", startLine: 1, endLine: 3 }]);
    expect(windows[0]?.excerpt.content).toContain(FACT);
    expect(turn.hasUsableObservation()).toBe(true);
    const selected = sink.events.filter((event) => event.op === SELECTED);
    expect(selections()).toMatchObject([{ selection: "tool-turn" }]);
    expect(selected[0]?.correlationId).toBe("folder-tool-turn");
    const operations = sink.events.filter((event) => event.op === "folder.files.operation");
    expect(operations).toHaveLength(1);
    expect(operations[0]?.correlationId).toBe("folder-tool-turn");
    const persisted = [...selected, ...operations].map(formatActivityLogProofLine).join("\n");
    expect(persisted).not.toContain("budget.txt");
    expect(persisted).not.toContain(f.root);
    expect(analyzeLogText(persisted).timelines).toHaveLength(1);
  });

  it("returns a copy of the windows, so a reader cannot change what the turn recorded", async () => {
    const f = fixture();
    const turn = await f.createTurn("folder-windows-copy");
    if (turn?.connectedFolder === undefined) throw new Error("Expected a folder tool turn");
    await turn.call(
      turn.meter(model([], { view: "search", query: "Kostenrahmen" })),
      { modelId: MODEL, messages: [{ role: "user", content: "Budget?" }] },
      new AbortController().signal,
    );
    const windows = turn.connectedFolder.returnedWindows();
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((window) => window.path === "docs/budget.txt")).toBe(true);
    (windows as unknown[]).length = 0;
    expect(turn.connectedFolder.returnedWindows().length).toBeGreaterThan(0);
  });

  it("gives the model the closed reason of a refused call, and nothing it may cite", async () => {
    const f = fixture();
    const turn = await f.createTurn("folder-refused-call");
    if (turn?.connectedFolder === undefined) throw new Error("Expected a folder tool turn");
    const calls: GatewayCallRequest[] = [];
    await turn.call(
      turn.meter(model(calls, { view: "read", path: "docs/budget.txt", startLine: 9000 })),
      { modelId: MODEL, messages: [{ role: "user", content: "Budget?" }] },
      new AbortController().signal,
    );
    expect(calls).toHaveLength(2);
    expect(toolMessages(calls[1])).toContain("out-of-range");
    expect(toolMessages(calls[1])).toContain("Read from startLine 1");
    expect(toolMessages(calls[1])).not.toContain(FACT);
    expect(turn.connectedFolder.returnedWindows()).toEqual([]);
    expect(turn.hasUsableObservation()).toBe(false);
  });

  it("keeps the one-shot path, without an error, when the model is not ready for tools", async () => {
    const f = fixture({ toolCalling: false });
    const factory = vi.fn(() => undefined);
    Object.assign(f.deps, { modelPortFactory: factory });
    await expect(f.createTurn("folder-no-tools")).resolves.toBeUndefined();
    expect(selections()).toEqual([
      expect.objectContaining({ selection: "one-shot-model-not-tool-ready" }),
    ]);
    expect(sink.events.find((event) => event.op === SELECTED)?.correlationId).toBe(
      "folder-no-tools",
    );
    // Nothing was admitted or minted for a turn that does not run.
    expect(f.admissions()).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps the Knowledge turn of a Chat that also has a Knowledge Pod", async () => {
    const f = fixture();
    f.deps.store.updateChat(f.chatId, {
      localKnowledgeScope: { kind: "capsule", capsuleId: POD, connectedAtMs: 1 },
    });
    const turn = await f.createTurn("folder-with-knowledge");
    expect(turn).toBeDefined();
    expect(turn?.connectedFolder).toBeUndefined();
    expect(f.admissions()).toBe(0);
    expect(selections()).toEqual([]);
    // That composition keeps its refusal for a model without tool calling.
    configure(f.deps, false);
    await expect(f.createTurn("folder-with-knowledge-no-tools")).rejects.toBeInstanceOf(
      ConversationModelNotReadyError,
    );
    expect(selections()).toEqual([]);
  });

  it("offers no tool turn to a Chat with two folders", async () => {
    const f = fixture();
    const second = folder();
    f.deps.store.updateChat(f.chatId, {
      connectedScopes: [
        { kind: "workspace-root", root: f.root, relativePaths: [], connectedAtMs: 1 },
        { kind: "workspace-root", root: second, relativePaths: [], connectedAtMs: 2 },
      ],
    });
    await expect(f.createTurn("two-folders")).resolves.toBeUndefined();
    expect(f.admissions()).toBe(0);
    expect(selections()).toEqual([]);
  });

  it("offers no tool turn to a route that supplies no folder admission", async () => {
    const f = fixture();
    const turn = await createChatToolTurn(
      f.deps,
      MODEL,
      f.accept("ordinary-route"),
      new AbortController().signal,
      "ordinary-route",
    );
    expect(turn).toBeUndefined();
    expect(selections()).toEqual([]);
  });

  it("starts no tool turn when the Chat's folder changes while the catalog loads", async () => {
    const f = fixture();
    const other = folder();
    const catalog = f.deps.connectedFolderChatCatalog;
    if (catalog === undefined) throw new Error("Expected the folder catalog.");
    const load = catalog.get.bind(catalog);
    vi.spyOn(catalog, "get").mockImplementation(async () => {
      const managed = await load();
      // The admitted folder is the old one; an authority minted now would cover the new one.
      f.deps.store.updateChat(f.chatId, {
        connectedScopes: [
          { kind: "workspace-root", root: other, relativePaths: [], connectedAtMs: 2 },
        ],
      });
      return managed;
    });
    await expect(f.createTurn("folder-changed-while-loading")).resolves.toBeUndefined();
    expect(f.admissions()).toBe(1);
    expect(selections()).toMatchObject([{ selection: "one-shot-scope-unavailable" }]);
  });

  it("keeps the one-shot path when the folder is no longer admitted", async () => {
    const f = fixture();
    rmSync(f.root, { recursive: true, force: true });
    await expect(f.createTurn("folder-gone")).resolves.toBeUndefined();
    expect(f.admissions()).toBe(1);
    expect(selections()).toMatchObject([{ selection: "one-shot-scope-unavailable" }]);
  });
});

describe("what the model keeps of a turn's earlier tool results", () => {
  // Regression: the continuation was fitted to the raw `contextWindow` of the capability. For a
  // model whose window nobody declared that is the setup placeholder, so every earlier result was
  // replaced by an elision record each round and the model read the same files again and again
  // (48 calls for a two-file comparison in the answer-quality eval of 2026-11-21).
  it.each([
    ["a declared window", false],
    ["a window nobody declared", true],
  ])("still sends the first read when the second one returns, for %s", async (_name, assumed) => {
    const f = fixture({ assumedWindow: assumed });
    const turn = await f.createTurn(`folder-keeps-results-${String(assumed)}`);
    if (turn?.connectedFolder === undefined) throw new Error("Expected a folder tool turn");
    const calls: GatewayCallRequest[] = [];
    await turn.call(
      turn.meter(
        modelInRounds(calls, [
          { view: "read", path: "docs/budget.txt" },
          { view: "read", path: "docs/plan.md" },
        ]),
      ),
      { modelId: MODEL, messages: [{ role: "user", content: "Budget and start?" }] },
      new AbortController().signal,
    );
    expect(calls).toHaveLength(3);
    const sent = toolMessages(calls[2]);
    expect(sent).toContain("Start ist im Maerz.");
    expect(sent).toContain(FACT);
    expect(sent).not.toContain('"elided":true');
    expect(sink.events.filter((event) => event.op === "chat.tool-turn.context-fitted")).toEqual([]);
  });
});

describe("a folder tool turn whose Chat scope changes", () => {
  it("returns no folder content once the Chat is connected to another folder", async () => {
    const f = fixture();
    const other = folder();
    const turn = await f.createTurn("folder-scope-change");
    if (turn?.connectedFolder === undefined) throw new Error("Expected a folder tool turn");
    const calls: GatewayCallRequest[] = [];
    const changed = (): void => {
      f.deps.store.updateChat(f.chatId, {
        connectedScopes: [
          { kind: "workspace-root", root: other, relativePaths: [], connectedAtMs: 2 },
        ],
      });
    };
    const outcome = await turn
      .call(
        turn.meter(model(calls, { view: "read", path: "docs/budget.txt" }, changed)),
        { modelId: MODEL, messages: [{ role: "user", content: "What is the budget?" }] },
        new AbortController().signal,
      )
      .then(
        () => "answered",
        () => "ended",
      );
    expect(["answered", "ended"]).toContain(outcome);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map(toolMessages).join("\n")).not.toContain(FACT);
    expect(turn.connectedFolder.returnedWindows()).toEqual([]);
    expect(turn.hasUsableObservation()).toBe(false);
    const stored = f.deps.store.listMessages(f.chatId);
    expect(JSON.stringify(stored.map((message) => message.toolTranscript))).not.toContain(FACT);
  });
});

describe("the turn's workspace index", () => {
  type Counting = WorkspaceIndex & { readonly saves: () => number };

  function counting(failing: boolean, gate: Promise<void> = Promise.resolve()): Counting {
    const base = createWorkspaceIndex(createInMemoryWorkspaceIndexStore());
    let saves = 0;
    return {
      loadSnapshot: (scopeKey, isActive) => base.loadSnapshot(scopeKey, isActive),
      saveSnapshot: async (scopeKey, snapshot, isActive): Promise<void> => {
        saves += 1;
        await gate;
        if (failing) throw new Error("index store fault");
        await base.saveSnapshot(scopeKey, snapshot, isActive);
      },
      saves: (): number => saves,
    };
  }

  interface SearchedTurn {
    readonly savesWhileRunning: number;
    readonly indexFlushed: () => Promise<void>;
  }

  /** Resolves when the answer is back; the index flush of the turn may still be running. */
  async function searchTurn(f: Fixture, index: Counting): Promise<SearchedTurn> {
    Object.assign(f.deps, { workspaceIndexForRoot: () => index });
    const turn = await f.createTurn("folder-index");
    if (turn?.connectedFolder === undefined) throw new Error("Expected a folder tool turn");
    const calls: GatewayCallRequest[] = [];
    let savesWhileRunning = -1;
    const inner = model(calls, { view: "search", query: "Kostenrahmen" });
    await turn.call(
      turn.meter({
        call: (request, signal): Promise<NormalizedResponse> => {
          if (calls.length === 1) savesWhileRunning = index.saves();
          return inner.call(request, signal);
        },
      }),
      { modelId: MODEL, messages: [{ role: "user", content: "Budget?" }] },
      new AbortController().signal,
    );
    expect(toolMessages(calls[1])).toContain(FACT);
    return { savesWhileRunning, indexFlushed: turn.connectedFolder.indexFlushed };
  }

  it("holds index writes during the turn and flushes them when the turn ends", async () => {
    const f = fixture();
    const index = counting(false);
    const turn = await searchTurn(f, index);
    expect(turn.savesWhileRunning).toBe(0);
    await turn.indexFlushed();
    expect(index.saves()).toBeGreaterThan(0);
    expect(
      f.diagnostics.filter((record) => record.operation === "folder.files.index-flush"),
    ).toEqual([]);
  });

  it("returns the answer without waiting for the index to reach the store", async () => {
    const f = fixture();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const index = counting(false, gate);
    // The store accepts nothing until the gate opens, and the answer is back all the same.
    const turn = await searchTurn(f, index);
    let flushed = false;
    const settled = turn.indexFlushed().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    open();
    await settled;
    expect(index.saves()).toBeGreaterThan(0);
  });

  it("reports a rejected index write instead of dropping it", async () => {
    const f = fixture();
    const index = counting(true);
    await (await searchTurn(f, index)).indexFlushed();
    const reported = f.diagnostics.filter(
      (record) => record.operation === "folder.files.index-flush",
    );
    expect(reported).toHaveLength(index.saves());
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]).toMatchObject({ correlationId: "folder-index" });
    expect(JSON.stringify(reported)).not.toContain("index store fault");
  });
});

describe("grounded guidance of a folder tool turn", () => {
  it("tells the model to look further in the folder, and keeps the other sources' wording", async () => {
    const f = fixture();
    const turn = await f.createTurn("folder-guidance");
    if (turn?.connectedFolder === undefined) throw new Error("Expected a folder tool turn");
    expect(groundedToolTurnGuidance(turn)).toBe(GROUNDED_FOLDER_TOOL_TURN_GUIDANCE);
    const other = { ...turn, connectedFolder: undefined } as ChatToolTurnPort;
    expect(groundedToolTurnGuidance(other)).toBe(GROUNDED_TOOL_TURN_GUIDANCE);
    for (const phrase of [
      "only a first ranked selection",
      "list directories",
      "search with different words",
      "read more lines",
      "untrusted data",
      "[path:start-end]",
      "only line ranges you actually received",
    ])
      expect(GROUNDED_FOLDER_TOOL_TURN_GUIDANCE).toContain(phrase);
    expect(GROUNDED_FOLDER_TOOL_TURN_GUIDANCE).not.toContain("Jira");
    const calls: GatewayCallRequest[] = [];
    const budget = createGroundedSynthesisCallBudget();
    const tracker = createGroundedSynthesisAttemptAdmission(budget, {
      inputTokensMax: 4000,
      outputTokensMax: 1000,
    });
    await callGroundedSynthesisModel(
      turn.meter(model(calls, { view: "list" })),
      {
        modelId: MODEL,
        messages: [{ role: "user", content: "What is in the folder?" }],
        attemptAdmission: tracker.admission,
      },
      new AbortController().signal,
      tracker,
      turn,
    );
    const system = (calls[0]?.messages ?? [])
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    expect(system).toContain(GROUNDED_FOLDER_TOOL_TURN_GUIDANCE);
    expect(system.join("\n")).not.toContain("label Jira tool results");
  });
});
