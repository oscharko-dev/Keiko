import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { ChatConnectedScope, GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createInMemoryUiStore } from "./store/index.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { handleUpdateChat } from "./store-handlers.js";
import { mockRequest, mockResponse } from "./_support.js";
import type { RouteContext, RouteResult } from "./routes.js";
import {
  retrieveConnectedContextPack,
  runGroundedExploration,
  type OrchestratorInput,
} from "./grounded-orchestrator.js";
import { sentGroundedFileCount } from "./grounded-prompt.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(): {
  readonly deps: UiHandlerDeps;
  readonly root: string;
  readonly chatId: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-missing-file-next-turn-")));
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "initial.ts"), "export const initialSentinel = 11;\n");
  writeFileSync(join(root, "src", "validation.ts"), "export const validationSentinel = 73;\n");
  store.createProject(root, "Next answer");
  const chat = store.createChat(root, "Next answer", "fixture");
  store.updateChat(chat.id, {
    connectedScopes: [{ kind: "directory", root, relativePaths: ["src"], connectedAtMs: 1 }],
  });
  return {
    root,
    chatId: chat.id,
    deps: {
      config: undefined,
      configPresent: false,
      env: {},
      evidenceStore: createInMemoryEvidenceStore(),
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store,
    },
  };
}

function route(url: string, body: object): RouteContext {
  return {
    correlationId: "missing-file-next-turn",
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    params: {},
    url: new URL(url),
  };
}

async function nextAnswer(
  deps: UiHandlerDeps,
  chatId: string,
): Promise<{ readonly result: RouteResult; readonly readPaths: readonly string[] }> {
  const readPaths: string[] = [];
  const content = "Please inspect @src/validation.ts again using the connected evidence.";
  const answer = "Validation uses sentinel 73 [source:1|src/validation.ts:1].";
  const retrievalDeps = { answerer: { answer: (): Promise<string> => Promise.resolve(answer) } };
  const observe = (input: OrchestratorInput): void => {
    expect(input.query.text).toContain("src/validation.ts");
  };
  const result = await handleGroundedAsk(
    route("http://localhost/api/chats/messages/grounded", { chatId, content }),
    deps,
    async (input) => {
      observe(input);
      const output = await runGroundedExploration(input, retrievalDeps);
      readPaths.push(...output.pack.files.map((file) => file.scopePath));
      return output;
    },
    {
      retriever: async (input) => {
        observe(input);
        const output = await retrieveConnectedContextPack(input, retrievalDeps);
        readPaths.push(...output.pack.files.map((file) => file.scopePath));
        return output;
      },
      answerer: (_question, labeled) => {
        const packs = labeled.map((entry) => entry.pack);
        expect(
          packs
            .flatMap((pack) =>
              pack.files.flatMap((file) => file.excerpts.map((excerpt) => excerpt.content)),
            )
            .join("\n"),
        ).toContain("validationSentinel = 73");
        return Promise.resolve({
          content: answer,
          usage: { promptTokens: 0, completionTokens: 0 },
          sentEvidencePacks: packs,
          filesInPrompt: sentGroundedFileCount(packs),
        });
      },
    },
  );
  return { result, readPaths };
}

it("acknowledges the added file through the scope API and reads/cites it in the actual next answer", async () => {
  const { deps, root, chatId } = fixture();
  const scopes: ChatConnectedScope[] = [
    { kind: "directory", root, relativePaths: ["src"], connectedAtMs: 1 },
    { kind: "files", root, relativePaths: ["src/validation.ts"], connectedAtMs: 2 },
  ];
  const acknowledgment = await handleUpdateChat(
    route(`http://localhost/api/chats?id=${chatId}`, { connectedScopes: scopes }),
    deps,
  );
  expect(acknowledgment.status, JSON.stringify(acknowledgment.body)).toBe(200);
  expect(deps.store.findChatById(chatId)?.connectedScopes).toContainEqual(scopes[1]);
  const { result, readPaths } = await nextAnswer(deps, chatId);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const answer = result.body as GroundedAnswer;
  expect(answer.groundingKind).toBe("connected-context");
  if (answer.groundingKind !== "connected-context") throw new TypeError("Missing connected answer");
  expect(readPaths).toContain("src/validation.ts");
  expect(answer.citations.map((citation) => citation.scopePath)).toContain("src/validation.ts");
  expect(answer.content).toContain("sentinel 73");
  expect(answer.evidenceRunIds?.length).toBeGreaterThan(0);
  expect(deps.store.listMessages(chatId).at(-1)?.groundedAnswer).toEqual(answer);
});
