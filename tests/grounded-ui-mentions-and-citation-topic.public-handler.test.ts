import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { ConnectedContextGroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "../packages/keiko-server/src/deps.js";
import { handleGroundedAsk } from "../packages/keiko-server/src/grounded-qa.js";
import { createRunRegistry } from "../packages/keiko-server/src/runs.js";
import type { RouteContext } from "../packages/keiko-server/src/routes.js";
import { createInMemoryUiStore } from "../packages/keiko-server/src/store/index.js";
import { resetServerLogger } from "./support/activity-log-test-support.js";
import { readPersistedActivityLog } from "./support/activity-log-proof.js";

import { appendRepositoryReference } from "../packages/keiko-ui/src/app/components/desktop/chatRepositoryReference.js";
import { EN_MESSAGES } from "../packages/keiko-ui/src/lib/i18n-messages.en.js";

const MODEL = "ui-mention-and-citation-topic-proof";
const FACT = "documentedValue=937";
const DECOY_FACT = "documentedValue=211";

function put(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function populate(path: string): void {
  put(path, `export const checkerLimit = 937; // ${FACT}\n`);
  put(`@${path}`, `export const checkerLimit = 211; // ${DECOY_FACT}\n`);
  for (let index = 0; index < 384; index += 1)
    put(
      `src/decoy-${String(index).padStart(3, "0")}/overview.ts`,
      "// Service initialization and request processing overview.\n".repeat(110),
    );
}

let root = "";
let stateDir = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-complete-manual-path-"));
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-complete-manual-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
});
afterEach(() => {
  resetServerLogger();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function modelFor(requests: GatewayRequest[], path: string): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      requests.push(request);
      return Promise.resolve({
        modelId: request.modelId,
        content: `The documented value is ${path.startsWith("@") ? "211" : "937"}. [${path}:1]`,
        finishReason: "stop",
        toolCalls: [],
        structuredOutput: null,
        usage: {
          requestId: "complete-manual-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 0,
          costClass: "medium",
        },
      });
    },
  };
}

function runtime(
  requests: GatewayRequest[],
  path: string,
): { readonly deps: UiHandlerDeps; readonly chatId: string } {
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://complete-manual.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 4096, maxOutputTokens: 512 },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Complete manual path");
  const chat = store.createChat(root, "Complete manual path", MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
  });
  return {
    chatId: chat.id,
    deps: {
      config,
      configPresent: true,
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      modelPortFactory: () => modelFor(requests, path),
      store,
    },
  };
}

async function dispatch(
  query: string,
  deps: UiHandlerDeps,
  chatId: string,
): Promise<Awaited<ReturnType<typeof handleGroundedAsk>>> {
  const req = Readable.from([
    Buffer.from(JSON.stringify({ chatId, projectPath: root, modelId: MODEL, content: query })),
  ]) as IncomingMessage;
  req.headers = {};
  const ctx: RouteContext = {
    req,
    res: new EventEmitter() as RouteContext["res"],
    url: new URL("http://localhost/api/chats/messages/grounded"),
    params: {},
    correlationId: "complete-manual-public-handler",
  };
  return handleGroundedAsk(ctx, deps);
}

function eligibleMissingHistory(deps: UiHandlerDeps, chatId: string): void {
  for (const [index, message] of [
    { role: "user" as const, content: "What is the checker limit?" },
    { role: "assistant" as const, content: "I need the checker file to establish that limit." },
  ].entries())
    deps.store.createMessage({
      ...message,
      chatId,
      timestamp: index + 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
}

function expectedFact(path: string): string {
  return path.startsWith("@") ? DECOY_FACT : FACT;
}

function assertPathAdmission(
  query: string,
  path: string,
  prompt: string,
  details: Record<string, unknown> | undefined,
): void {
  if (!query.includes(".ts")) return;
  expect(prompt.indexOf(`File: ${path}`)).toBe(prompt.indexOf("File: "));
  expect(details?.explicitPathAdmittedCount).toBe(1);
  expect(details?.explicitPathRejectedCount).toBe(0);
}

async function ask(query: string, path: string, previousQuestion = false): Promise<string> {
  const requests: GatewayRequest[] = [];
  const { deps, chatId } = runtime(requests, path);
  if (previousQuestion) eligibleMissingHistory(deps, chatId);
  const response = await dispatch(query, deps, chatId);
  expect(response.status).toBe(200);
  const records = readPersistedActivityLog(stateDir)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const details = records.find((record) => record.op === "search.connected-context.source-details");
  expect(records.map((record) => record.op)).not.toContain("server-log.write-failed");
  expect(requests[0]?.stream).toBe(false);
  const prompt = requests[0]?.messages[1]?.content;
  if (typeof prompt !== "string") throw new TypeError("Expected the actual fitted grounded prompt");
  expect(prompt.includes(`File: ${path}`)).toBe(true);
  expect(prompt.includes(expectedFact(path))).toBe(true);
  assertPathAdmission(query, path, prompt, details);
  const body = response.body as ConnectedContextGroundedAnswer;
  expect(body.citations.some((citation) => citation.scopePath === path)).toBe(true);

  return prompt;
}

describe("UI references and citation subjects through the actual public handler", () => {
  it.each(["checker", "validation"])("admits the actual composer mention for %s", async (name) => {
    const path = `src/${name}.ts`;
    populate(path);
    await ask(appendRepositoryReference("Explain", path), path);
  });

  it("admits the actual missing-evidence follow-up template with eligible history", async () => {
    const path = "src/checker.ts";
    populate(path);
    await ask(EN_MESSAGES["scope.missing.followUp"].replace("{path}", path), path, true);
  });

  it.each(["bare", "backtick"])("retains the healthy %s ordinary-path control", async (quoting) => {
    const path = "src/checker.ts";
    populate(path);
    await ask(`Explain ${quoting === "bare" ? path : `\`${path}\``}`, path);
  });

  it.each(["backtick", "doublequoted", "canonical"])(
    "preserves literal @ filenames with %s syntax",
    async (quoting) => {
      const path = "src/checker.ts";
      populate(path);
      const literal = `@${path}`;
      const reference =
        quoting === "backtick"
          ? `\`${literal}\``
          : quoting === "doublequoted"
            ? `"${literal}"`
            : `./${literal}`;
      await ask(`Explain ${reference}`, literal);
    },
  );

  it.each(["manual", "handbook"])("retains the requested citation subject %s", async (topic) => {
    populate("src/checker.ts");
    const path = "docs/citation-rule.txt";
    put(path, `To cite the ${topic}, use the documented rule ${FACT}.\n`);
    await ask(`How do I cite the ${topic}?`, path);
  });

  it("keeps separate presentation instructions out of the substantive manual question", async () => {
    populate("src/checker.ts");
    const path = "docs/vesper.txt";
    put(path, `Vesper dosing interlock temperature trips at ${FACT}.\n`);
    await ask(
      "What temperature trips the Vesper dosing interlock? Cite the authoritative manual. Keep the answer under 100 words.",
      path,
    );
  });
});
