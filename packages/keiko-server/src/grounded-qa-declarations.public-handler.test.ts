import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatConnectedScope, GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { DEFAULT_EXPLORATION_BUDGET } from "@oscharko-dev/keiko-contracts/connected-context";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import {
  createDefaultChatCapability,
  CancelledError,
  parseGatewayConfig,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import { createRunRegistry } from "./runs.js";
import {
  buildQuery,
  buildSelectedScopeFrom,
  deriveScopeIdFrom,
  handleGroundedAsk,
} from "./grounded-qa.js";
import { defaultRetriever } from "./grounded-qa-multi-source.js";
import { mockRequest, mockResponse } from "./_support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "declaration-fixture";
const cleanups: (() => void)[] = [];
afterEach(() => {
  resetServerLogger();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function selectedScope(root: string, count: number, bracket: boolean): ChatConnectedScope {
  const relativePaths = bracket
    ? ["app/z-users/[id]/page.tsx"]
    : Array.from({ length: 12 }, (_, index) => `src/selected-${String(index).padStart(2, "0")}.ts`);
  for (const path of relativePaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      `export const TARGET_${path.replaceAll(/[^A-Za-z0-9]/gu, "_")} = 73;\n` +
        (bracket
          ? ""
          : "// Selected implementation needs its actual repository evidence.\n".repeat(80)),
    );
  }
  return { kind: "files", root, relativePaths, connectedAtMs: count };
}

function fixture(
  scopeCount: number,
  bracket: boolean,
  response: string,
): {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
  readonly calls: GatewayCallRequest[];
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-public-declarations-")));
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const scopes = Array.from({ length: scopeCount }, (_, index) =>
    selectedScope(join(root, String(index)), index, bracket),
  );
  store.createProject(root, "Declaration membership");
  const chat = store.createChat(root, "Declaration membership", MODEL);
  store.updateChat(chat.id, { connectedScopes: scopes });
  const calls: GatewayCallRequest[] = [];
  const log = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink: log, level: "info" }));
  return { chatId: chat.id, calls, log, deps: runtimeDeps(store, calls, response) };
}

function runtimeDeps(
  store: UiHandlerDeps["store"],
  calls: GatewayCallRequest[],
  response: string,
): UiHandlerDeps {
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://declaration.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability(MODEL),
        contextWindow: 8192,
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
      },
    ],
  });
  return {
    config,
    configPresent: true,
    env: { KEIKO_CONNECTED_FOLLOW_UP_PASSES_MAX: "0" },
    store,
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => answerModel(calls, response),
  };
}

async function connectReadyPod(deps: UiHandlerDeps, chatId: string): Promise<UiHandlerDeps> {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined) throw new TypeError("Missing connected chat");
  const runtimeStateDir = join(chat.projectPath, "runtime");
  const store = openKnowledgeStore({ dbPath: resolveKnowledgeStorePath({ runtimeStateDir }) });
  try {
    const pod = await seedCapsuleWithVectors(store, { displayName: "Declaration membership" });
    updateCapsuleState(store, pod.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
  return { ...deps, uiDbPath: join(runtimeStateDir, "keiko-ui.db") };
}

function answerModel(calls: GatewayCallRequest[], content: string): ModelPort {
  return {
    call: (request): ReturnType<ModelPort["call"]> => {
      calls.push(request);
      return Promise.resolve({
        modelId: MODEL,
        content,
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "declaration-proof",
          promptTokens: 100,
          completionTokens: 10,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
}

async function ask(deps: UiHandlerDeps, chatId: string): Promise<GroundedAnswer> {
  const result = await handleGroundedAsk(
    {
      correlationId: "public-declaration-membership",
      req: mockRequest({
        body: JSON.stringify({ chatId, content: "Explain the selected implementation" }),
      }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://localhost/api/chats/messages/grounded"),
    },
    deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as GroundedAnswer;
}

describe("public declaration membership", () => {
  it("uses request cancellation after a healthy retrieval worker has closed", async () => {
    const { deps, chatId } = fixture(2, false, "unused");
    const chat = deps.store.findChatById(chatId);
    const connected = chat?.connectedScopes?.[0];
    if (chat === undefined || connected === undefined)
      throw new TypeError("Missing connected chat");
    const scope = buildSelectedScopeFrom(chat, connected, deriveScopeIdFrom(chat, connected, 0));
    const request = new AbortController();
    const worker = new AbortController();
    const output = await defaultRetriever(
      request.signal,
      deps,
      "declaration-cancellation",
    )(
      {
        scope,
        query: buildQuery("Explain the selected implementation", Date.now),
        workspaceRoot: scope.workspaceRoot,
        budget: DEFAULT_EXPLORATION_BUDGET,
      },
      worker.signal,
    );
    worker.abort();
    expect(output.declarationScopeIndexFor?.(["src/selected-11.ts"])).toEqual(
      new Map([["src/selected-11.ts", "unread-in-scope"]]),
    );
    request.abort();
    expect(() => output.declarationScopeIndexFor?.(["src/selected-11.ts"])).toThrow(CancelledError);
  });

  it.each([
    { scopeCount: 1, hybrid: false },
    { scopeCount: 2, hybrid: false },
    { scopeCount: 1, hybrid: true },
  ])(
    "retains a verified budget-omitted selected file across $scopeCount folder scopes (hybrid: $hybrid)",
    async ({ scopeCount, hybrid }) => {
      const path = "src/selected-11.ts";
      const { deps, chatId, calls, log } = fixture(
        scopeCount,
        false,
        `Missing evidence: [${path}]`,
      );
      const answer = await ask(hybrid ? await connectReadyPod(deps, chatId) : deps, chatId);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.messages.map((message) => message.content).join("\n")).not.toContain(
        "TARGET_src_selected_11_ts",
      );
      expect(answer.answerKind).toBe("insufficiency");
      expect(answer.insufficiencyDeclarations).toEqual([
        { scopePath: path, state: "unread-in-scope" },
      ]);
      expect(deps.store.listMessages(chatId).at(-1)?.content).toBe(`Missing evidence: [${path}]`);
      expect(
        log.events
          .filter((event) => event.op === "search.citations.reconciled")
          .some((event) => event.extra?.declaredUnreadInScopeCount === 1),
      ).toBe(true);
    },
  );

  it.each([
    { scopeCount: 1, hybrid: false },
    { scopeCount: 2, hybrid: false },
    { scopeCount: 1, hybrid: true },
  ])(
    "keeps a literal bracket route classified as insufficiency across $scopeCount folder scopes (hybrid: $hybrid)",
    async ({ scopeCount, hybrid }) => {
      const path = "app/z-users/[id]/page.tsx";
      const { deps, chatId, calls } = fixture(scopeCount, true, `Missing evidence: [${path}]`);
      const answer = await ask(hybrid ? await connectReadyPod(deps, chatId) : deps, chatId);
      expect(calls).toHaveLength(1);
      expect(answer.answerKind).toBe("insufficiency");
      expect(answer.insufficiencyDeclarations).toEqual([
        { scopePath: path, state: "read-in-this-turn" },
      ]);
    },
  );

  it.each(["src/unknown.ts", ".ssh/id_ed25519"])(
    "does not promote an unknown or denied path: %s",
    async (path) => {
      const { deps, chatId, calls } = fixture(2, false, `Missing evidence: [${path}]`);
      const answer = await ask(deps, chatId);
      expect(calls).toHaveLength(1);
      expect(answer.insufficiencyDeclarations).toBeUndefined();
      expect(answer.content).not.toContain(path);
      expect(deps.store.listMessages(chatId).at(-1)?.content).not.toContain(path);
    },
  );
});
