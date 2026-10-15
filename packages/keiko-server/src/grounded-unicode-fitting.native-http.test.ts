import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { buildCspHeader } from "./csp.js";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "./observability/index.js";
import { closeUiTestServer, startUiTestServer } from "./ui-test-server/_support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "native-unicode-fitting-proof";
const QUESTION = "Explain the value in src/astral.ts.";
const SOURCE = `export const value = 37; // ${"😀".repeat(2000)}\n`;
let directory = "";
const servers: Server[] = [];
const runtimes: UiHandlerDeps[] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-unicode-fitting-")));
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  resetServerLogger();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await closeUiTestServer(server);
  for (const deps of runtimes.splice(0)) await deps.dispose?.();
  resetServerLogger();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

interface ProviderRequest {
  readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[];
  readonly max_tokens: number;
}

async function provider(requests: ProviderRequest[]): Promise<string> {
  const server = createServer((request, response): void => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string): void => {
      body += chunk;
    });
    request.once("end", (): void => {
      requests.push(JSON.parse(body) as ProviderRequest);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          model: MODEL,
          choices: [
            { message: { role: "assistant", content: "The value is 37. [src/astral.ts:1]" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Unbound provider");
  return `http://127.0.0.1:${String(address.port)}/v1`;
}

function runtime(baseUrl: string, contextWindow: number): { deps: UiHandlerDeps; chatId: string } {
  const root = join(directory, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/astral.ts"), SOURCE);
  const stateDir = join(directory, "state");
  setServerLogger(
    createServerLogger({
      sink: createFileServerLogSink(stateDir, { level: "debug" }),
      level: "debug",
    }),
  );
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env: {},
  });
  runtimes.push(deps);
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [{ modelId: MODEL, baseUrl, apiKey: "fixture", maxRetries: 0 }],
      capabilities: [{ ...createDefaultChatCapability(MODEL), contextWindow, maxOutputTokens: 64 }],
    }),
    true,
  );
  deps.gatewayConfig?.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    deps.gatewayConfig.generation(),
  );
  deps.store.createProject(root, "Unicode fitting proof");
  const chat = deps.store.createChat(root, "Unicode fitting proof", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScope: { kind: "files", relativePaths: ["src/astral.ts"], connectedAtMs: 1 },
  });
  return { deps, chatId: chat.id };
}

async function nativeAsk(
  contextWindow: number,
): Promise<{ deps: UiHandlerDeps; requests: ProviderRequest[] }> {
  const requests: ProviderRequest[] = [];
  const { deps, chatId } = runtime(await provider(requests), contextWindow);
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps: deps,
  });
  servers.push(started.server);
  const response = await fetch(
    `http://127.0.0.1:${String(started.port)}/api/chats/messages/grounded`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify({ chatId, content: QUESTION }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    citations: [
      expect.objectContaining({
        scopePath: "src/astral.ts",
        lineRange: { startLine: 1, endLine: 1 },
      }),
    ],
  });
  await closeUiTestServer(started.server);
  servers.splice(servers.indexOf(started.server), 1);
  return { deps, requests };
}

describe("native grounded Unicode fitting", () => {
  it.each([2050, 2051])(
    "sends whole source characters at the unchanged %i-token window",
    async (contextWindow) => {
      expect(Buffer.from(SOURCE, "utf8").toString("utf8")).toBe(SOURCE);
      const { deps, requests } = await nativeAsk(contextWindow);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (request === undefined) throw new TypeError("Missing provider request");
      const capability = deps.gatewayConfig?.current()?.capabilities?.[0];
      if (capability === undefined) throw new TypeError("Missing configured capability");
      const profile = deriveContextProfileFromCapability(capability);
      expect(request.max_tokens).toBeLessThanOrEqual(64);
      expect(countGatewayPromptTokens({ messages: request.messages })).toBeLessThanOrEqual(
        profile.effectiveInputBudget,
      );
      const user = request.messages.find((message) => message.role === "user")?.content ?? "";
      expect(user).toContain(QUESTION);
      expect(user).toContain("export const value = 37;");
      expect(user).toContain("😀");
      const raw = readPersistedActivityLog(join(directory, "state"));
      expect(analyzeLogText(raw).evidence).toMatchObject({
        classification: "supported",
        corruptLineCount: 0,
      });
      expect(raw).toContain("chat.context.selected");
      expect(raw).toContain("gateway.chat.completed");
      expect(raw).not.toContain(SOURCE);
      expect(raw).not.toContain(QUESTION);
      const numberedExcerpt = /```\n([\s\S]*?)\n```/u.exec(user)?.[1];
      if (numberedExcerpt === undefined) throw new TypeError("Missing actual wire excerpt");
      const sourceExcerpt = numberedExcerpt.replace(/^\d+ \| /gmu, "");
      expect(SOURCE.startsWith(sourceExcerpt)).toBe(true);
      expect({
        excerptBytes: Buffer.byteLength(sourceExcerpt),
        finalCodeUnit: sourceExcerpt.charCodeAt(sourceExcerpt.length - 1),
        wellFormed: Buffer.from(sourceExcerpt, "utf8").toString("utf8") === sourceExcerpt,
      }).toEqual(expect.objectContaining({ wellFormed: true }));
    },
  );
});
