import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Chat,
  ChatConnectedScope,
  FilesTreeResponse,
  GroundedAnswer,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ConnectedContextGroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  handleUpdateChat,
  type UiHandlerDeps,
} from "../../packages/keiko-server/dist/index.js";
import { handleFilesTree } from "../../packages/keiko-server/dist/files.js";
import { handleGroundedAsk } from "../../packages/keiko-server/dist/grounded-qa.js";
import type { RouteContext, RouteResult } from "../../packages/keiko-server/dist/routes.js";
import {
  installActivityLogTestWriter,
  resetServerLogger,
} from "../../packages/keiko-activity-log/dist/server-logger.js";

interface NativeFilesChatFixture {
  readonly root: string;
  readonly alias: string;
  readonly chat: Chat;
  readonly patch: (
    scopes: readonly ChatConnectedScope[] | null,
    identity?: string,
  ) => Promise<{ chat: Chat }>;
  readonly tree: (root: string, path?: string) => Promise<FilesTreeResponse>;
  readonly ask: () => Promise<{ answer: ConnectedContextGroundedAnswer; betaSent: boolean }>;
  readonly close: () => Promise<void>;
}

function nativeRequest<T>(base: string, path: string, body?: object): Promise<T> {
  return new Promise((resolve, reject): void => {
    const call = request(
      new URL(path, base),
      {
        method: body === undefined ? "GET" : path.startsWith("/api/chats?") ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
      },
      (response): void => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer): void => {
          chunks.push(chunk);
        });
        response.on("end", (): void => {
          if (response.statusCode !== 200) {
            reject(new Error(`Native request failed: ${String(response.statusCode ?? 0)}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error("Invalid native fixture JSON", { cause: error }),
            );
          }
        });
      },
    );
    call.on("error", reject);
    call.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function dispatch(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  if (ctx.url.pathname === "/api/chats") return handleUpdateChat(ctx, deps);
  if (ctx.url.pathname === "/api/files/tree") return handleFilesTree(ctx, deps);
  return handleGroundedAsk(ctx, deps);
}

async function nativeServer(deps: UiHandlerDeps): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res): void => {
    const ctx: RouteContext = {
      correlationId: "files-chat-canonical-root-proof",
      req,
      res,
      params: {},
      url: new URL(req.url ?? "/", "http://localhost"),
    };
    void dispatch(ctx, deps)
      .then((result): void => {
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      })
      .catch((): void => {
        res.statusCode = 500;
        res.end();
      });
  });
  await new Promise<void>((resolve, reject): void => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new TypeError("Missing native fixture listener");
  return { base: `http://127.0.0.1:${String(address.port)}`, server };
}

function answerFromSentSources(request: GatewayCallRequest, path: string): string {
  const prompt = request.messages.map((message) => message.content).join("\n");
  const section = [...prompt.matchAll(/### Source (\d+):([\s\S]*?)(?=### Source \d+:|$)/gu)].find(
    (match) => match[2]?.includes(`File: ${path}`),
  );
  const marker = section?.[1] === undefined ? `[${path}:1]` : `[source:${section[1]}|${path}:1]`;
  return `${path.startsWith("Beta/") ? "Beta is 73" : "Alpha is 11"} ${marker}.`;
}

function fixtureModel(observe: (betaSent: boolean) => void): ModelPort {
  return {
    call(request): ReturnType<ModelPort["call"]> {
      const betaSent = request.messages.some((message) =>
        message.content.includes("validationBeta = 73"),
      );
      observe(betaSent);
      return Promise.resolve({
        modelId: "files-scope-model",
        content: answerFromSentSources(request, betaSent ? "Beta/two.ts" : "Alpha/one.ts"),
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "files-scope-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
}

function seedFiles(): { directory: string; root: string; alias: string } {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-files-canonical-root-")));
  const root = join(directory, "real");
  const alias = join(directory, "alias");
  for (const folder of ["Alpha", "Beta"]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "Alpha/one.ts"), "export const validationAlpha = 11;\n");
  writeFileSync(join(root, "Beta/two.ts"), "export const validationBeta = 73;\n");
  symlinkSync(root, alias, "dir");
  return { directory, root, alias };
}

function fixtureDeps(
  directory: string,
  store: UiHandlerDeps["store"],
  model: ModelPort,
): UiHandlerDeps {
  installActivityLogTestWriter();
  const config = parseGatewayConfig({
    providers: [
      { modelId: "files-scope-model", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability("files-scope-model"),
        contextWindow: 32768,
        maxOutputTokens: 1024,
      },
    ],
    groundedAnswers: { ownAssessment: "disabled" },
  });
  return {
    store,
    config,
    configPresent: true,
    uiDbPath: join(directory, "state/ui.db"),
    env: {},
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => model,
  };
}

async function closeNativeFixture(
  server: Server,
  store: UiHandlerDeps["store"],
  directory: string,
): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    server.close((error): void => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  store.close();
  rmSync(directory, { recursive: true, force: true });
  resetServerLogger();
}

export async function nativeFilesChatFixture(): Promise<NativeFilesChatFixture> {
  const { directory, root, alias } = seedFiles();
  const store = createInMemoryUiStore();
  store.createProject(root, "Files scope proof");
  const chat = store.createChat(root, "Files scope proof", "files-scope-model");
  let acknowledgedChat = chat;
  let betaSent = false;
  const deps = fixtureDeps(
    directory,
    store,
    fixtureModel((sent): void => {
      betaSent ||= sent;
    }),
  );
  const { base, server } = await nativeServer(deps);
  return {
    root,
    alias,
    chat,
    async patch(scopes, identity): Promise<{ chat: Chat }> {
      const reply = await nativeRequest<{ chat: Chat }>(
        base,
        `/api/chats?id=${encodeURIComponent(chat.id)}`,
        {
          connectedScopes: scopes,
          ...(identity === undefined ? {} : { expectedGroundingScopeIdentity: identity }),
        },
      );
      acknowledgedChat = reply.chat;
      return reply;
    },
    tree(selectedRoot, path = ""): Promise<FilesTreeResponse> {
      return nativeRequest(
        base,
        `/api/files/tree?root=${encodeURIComponent(selectedRoot)}&path=${encodeURIComponent(path)}`,
      );
    },
    async ask(): Promise<{ answer: ConnectedContextGroundedAnswer; betaSent: boolean }> {
      const answer = await nativeRequest<GroundedAnswer>(base, "/api/chats/messages/grounded", {
        chatId: chat.id,
        content: "Explain validationAlpha and validationBeta implementation.",
        expectedGroundingScopeIdentity: acknowledgedChat.groundingScopeIdentity,
      });
      if (answer.groundingKind !== "connected-context")
        throw new TypeError("Unexpected native answer topology");
      return { answer, betaSent };
    },
    close: (): Promise<void> => closeNativeFixture(server, store, directory),
  };
}
