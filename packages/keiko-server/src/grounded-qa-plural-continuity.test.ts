import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatConnectedScope } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import type { RetrievalOnlyOutput } from "./grounded-orchestrator.js";
import { createInMemoryUiStore } from "./store/index.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import {
  retrieveConnectedContextPack,
  runGroundedExploration,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";
import { mockRequest, mockResponse } from "./_support.js";

const roots: string[] = [];
const stores: ReturnType<typeof createInMemoryUiStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtime(): UiHandlerDeps {
  const store = createInMemoryUiStore();
  stores.push(store);
  return {
    config: undefined,
    configPresent: false,
    uiDbPath: join(projectRoot("state"), "keiko-ui.db"),
    env: {},
    evidenceStore: createInMemoryEvidenceStore(),
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function projectRoot(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `keiko-public-continuity-${name}-`)));
  roots.push(root);
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  writeFileSync(join(root, "src", "deep", "unseen.ts"), "export const continuitySentinel = 17;\n");
  return root;
}

function seedChat(deps: UiHandlerDeps, scopeCount: number): string {
  const scopes: ChatConnectedScope[] = Array.from({ length: scopeCount }, (_, index) => ({
    kind: "directory",
    relativePaths: ["src"],
    connectedAtMs: 1,
    root: projectRoot(String(index)),
  }));
  const root = scopes[0]?.root;
  if (root === undefined) throw new TypeError("Missing fixture root");
  deps.store.createProject(root, "Continuity");
  const chat = deps.store.createChat(root, "Continuity", "fixture");
  deps.store.updateChat(chat.id, { connectedScopes: scopes });
  let timestamp = 1;
  for (const message of [
    { role: "user" as const, content: "Which validation routine fails?" },
    { role: "assistant" as const, content: "Missing evidence: [src/deep/unseen.ts]" },
  ])
    deps.store.createMessage({
      ...message,
      chatId: chat.id,
      timestamp: timestamp++,
      runId: undefined,
      workflowId: undefined,
      attachments: [],
    });
  return chat.id;
}

async function connectReadyPod(deps: UiHandlerDeps, chatId: string): Promise<void> {
  if (deps.uiDbPath === undefined) throw new TypeError("Missing fixture state directory");
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: dirname(deps.uiDbPath) }),
  });
  try {
    const pod = await seedCapsuleWithVectors(store, { displayName: "Public continuity" });
    updateCapsuleState(store, pod.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

async function ask(
  deps: UiHandlerDeps,
  chatId: string,
  content: string,
): Promise<readonly OrchestratorInput[]> {
  const captured: OrchestratorInput[] = [];
  const retrievalDeps = {
    correlationId: "public-plural-continuity",
    answerer: {
      answer: (): Promise<string> => Promise.resolve("Implementation [src/deep/unseen.ts:1]."),
    },
  };
  const retriever = (input: OrchestratorInput): Promise<RetrievalOnlyOutput> => {
    captured.push(input);
    return retrieveConnectedContextPack(input, retrievalDeps);
  };
  const result = await handleGroundedAsk(
    {
      correlationId: "public-plural-continuity",
      req: mockRequest({ body: JSON.stringify({ chatId, content }) }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://localhost/api/chats/messages/grounded"),
    },
    deps,
    (input) => {
      captured.push(input);
      return runGroundedExploration(input, retrievalDeps);
    },
    {
      retriever,
      answerer: (): Promise<string> =>
        Promise.resolve("Implementation [source:1|src/deep/unseen.ts:1]."),
    },
    {
      folderRetriever: retriever,
      connectorRetrieve: () => Promise.resolve({ references: [], noEvidence: true }),
      answer: () => Promise.resolve("Implementation [src/deep/unseen.ts:1]."),
    },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return captured;
}

describe("public grounded handler preserves assistant referents across folder dispatch", () => {
  it.each([
    ["Can you see the file now?", 1, false],
    ["Can you see the file now?", 2, false],
    ["Can you see the file now?", 1, true],
    ["Siehst du die Datei jetzt?", 1, false],
    ["Siehst du die Datei jetzt?", 2, false],
    ["Siehst du die Datei jetzt?", 1, true],
  ] as const)(
    "forwards canonical eligible history for %s with %s folders (hybrid=%s)",
    async (content, scopeCount, hybrid) => {
      const deps = runtime();
      const chatId = seedChat(deps, scopeCount);
      if (hybrid) await connectReadyPod(deps, chatId);
      const captured = await ask(deps, chatId, content);
      expect(captured).toHaveLength(scopeCount);
      for (const input of captured) {
        expect(input.assistantReferents).toEqual([
          { path: "src/deep/unseen.ts", origin: "assistant" },
        ]);
        expect(input.continuityReferentSource).toBe("assistant-declaration");
        expect(input.query.text).toContain(content);
      }
    },
  );
});
