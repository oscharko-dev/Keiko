import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectedContextGroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { mockRequest, mockResponse } from "./_support.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";

const MODEL = "located-path-identity-proof";
const RANGE_PATH = "src/Delta/guard.mjs";
let root = "";
let stateDir = "";
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-located-identity-"));
  stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-located-state-"));
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

function put(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function populate(path: string, line: number, decoy?: string): void {
  const lines = Array.from({ length: 360 }, () => "// ordinary source padding");
  lines[line - 1] =
    line === 7 ? 'throw new Error("guardedFact=937");' : "export const guardedFact = 937;";
  put(path, lines.join("\n"));
  if (decoy !== undefined) put(decoy, "export const guardedFact = 211;\n");
  for (let index = 0; index < 120; index += 1)
    put(
      `aa-decoy/${String(index)}/guard.mjs`,
      "// independent ordinary source navigation\n".repeat(110),
    );
}

function model(requests: GatewayCallRequest[], path: string, line: number): ModelPort {
  return {
    call(request): ReturnType<ModelPort["call"]> {
      requests.push(request);
      return Promise.resolve({
        modelId: MODEL,
        content: `The guarded value is 937. [${path}:${String(line)}]`,
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "located-proof",
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
  requests: GatewayCallRequest[],
  path: string,
  line: number,
  compact: boolean,
): { readonly deps: UiHandlerDeps; readonly chatId: string } {
  const config = parseGatewayConfig({
    groundedAnswers: { ownAssessment: "disabled" },
    providers: [
      { modelId: MODEL, baseUrl: "https://located.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability(MODEL),
        contextWindow: compact ? 8192 : 32768,
        maxOutputTokens: 1024,
      },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Located identity");
  const chat = store.createChat(root, "Located identity", MODEL);
  store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 1 },
  });
  if (compact) seedHistory(store, chat.id);
  return {
    chatId: chat.id,
    deps: {
      config,
      configPresent: true,
      env: {},
      store,
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      evidenceStore: createInMemoryEvidenceStore(),
      modelPortFactory: () => model(requests, path, line),
    },
  };
}

function seedHistory(store: UiHandlerDeps["store"], chatId: string): void {
  for (let index = 0; index < 80; index += 1)
    store.createMessage({
      chatId,
      role: index % 2 === 0 ? "user" : "assistant",
      content: "Discuss unrelated engineering context and retain fresh source authority. ".repeat(
        30,
      ),
      timestamp: Date.now() - 100000 + index,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
}

async function ask(query: string, path: string, line: number, compact = false): Promise<void> {
  const requests: GatewayCallRequest[] = [];
  const { deps, chatId } = runtime(requests, path, line, compact);
  const response = await handleGroundedAsk(
    {
      params: {},
      correlationId: "located-identity-public",
      url: new URL("http://localhost/api/chats/messages/grounded"),
      req: mockRequest({ body: JSON.stringify({ chatId, content: query }) }),
      res: mockResponse().res,
    },
    deps,
  );
  expect(response.status).toBe(200);
  const prompt = requests[0]?.messages.map((message) => message.content).join("\n") ?? "";
  expect(prompt.includes(`File: ${path}`)).toBe(true);
  expect(prompt.includes("guardedFact = 937") || prompt.includes("guardedFact=937")).toBe(true);
  const decoyPosition = prompt.indexOf("guardedFact = 211");
  if (decoyPosition !== -1) expect(prompt.indexOf(`File: ${path}`)).toBeLessThan(decoyPosition);
  const answer = response.body as ConnectedContextGroundedAnswer;
  expect(answer.citations.some((citation) => citation.scopePath === path)).toBe(true);
  const records = readPersistedActivityLog(stateDir)
    .split("\n")
    .filter(Boolean)
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  const details = records.find((record) => record.op === "search.connected-context.source-details");
  expect(details?.explicitPathAdmittedCount).toBe(1);
  if (!query.includes("\n")) expect(details?.explicitPathRejectedCount).toBe(0);
  if (query.includes(":178-182") || query.includes(":180") || query.includes(":7"))
    expect(details?.explicitLineHintCount).toBe(1);
}

function actualNodeStack(path: string): string {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(join(root, path)).href)})`,
    ],
    { encoding: "utf8", maxBuffer: 65536, timeout: 5000, env: { NODE_NO_WARNINGS: "1" } },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(pathToFileURL(join(root, path)).href);
  return result.stderr;
}

describe("located path identity through real files and the public grounded handler", () => {
  for (const compact of [false, true])
    it.each(["bare", "backtick", "double", "bracket", "parenthesis"])(
      `preserves the full ranged path in %s form with compact=${String(compact)}`,
      async (form) => {
        populate(RANGE_PATH, 180, "aa-decoy/guard.mjs");
        const path = `${RANGE_PATH}:178-182`;
        const token =
          form === "backtick"
            ? `\`${path}\``
            : form === "double"
              ? `"${path}"`
              : form === "bracket"
                ? `[${path}]`
                : form === "parenthesis"
                  ? `(${path})`
                  : path;
        await ask(`Read ${token} and explain its value.`, RANGE_PATH, 180, compact);
      },
    );

  it.each(["src/Delta/guard.mjs:180", "`src/Delta/guard.mjs:180`", '"src/Delta/guard.mjs"'])(
    "retains the healthy exact path control %s",
    async (token) => {
      populate(RANGE_PATH, 180, "aa-decoy/guard.mjs");
      await ask(`Read ${token} and explain its value.`, RANGE_PATH, 180);
    },
  );

  for (const sibling of [false, true])
    it.each(["pressure check", "überhitzung"])(
      `preserves actual Node ESM URL identity for %s with sibling=${String(sibling)}`,
      async (name) => {
        const path = `zz-source/${name}.mjs`;
        const encoded = `zz-source/${encodeURIComponent(name)}.mjs`;
        populate(path, 7, sibling ? encoded : undefined);
        await ask(`Why does this fail?\n${actualNodeStack(path)}`, path, 7);
      },
    );

  it("retains the ordinary ASCII Node ESM stack", async () => {
    const path = "zz-source/pressure.mjs";
    populate(path, 7);
    await ask(`Why does this fail?\n${actualNodeStack(path)}`, path, 7);
  });

  it("does not URL-decode ordinary literal-percent filesystem frame paths", async () => {
    const path = "zz-source/pressure%20check.mjs";
    populate(path, 7, "zz-source/pressure check.mjs");
    await ask(`Why does this fail?\n    at pressure (${path}:7:1)`, path, 7);
  });

  it("retains the direct file-URL admission control", async () => {
    const path = "zz-source/pressure check.mjs";
    populate(path, 7, "zz-source/pressure%20check.mjs");
    await ask(`Read ${pathToFileURL(join(root, path)).href}:7 and explain the failure.`, path, 7);
  });
});
