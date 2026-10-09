import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnAssessmentPolicy } from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { ConnectedContextGroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { createRunRegistry } from "./runs.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { readPersistedActivityLog } from "../../../tests/support/activity-log-proof.js";

const MODEL = "complete-manual-path-proof";
const LONG_SEGMENT = `z${"a".repeat(64)}`;
const SUFFIX_SEGMENT = "a".repeat(64);
const DEEP_SEGMENTS = Array.from({ length: 72 }, (_value, index) => `d${String(index)}`);
const FACT = "namedManualFact=937";
const DECOY_FACT = "namedManualFact=211";

function targetFor(extension: string, deep = false): string {
  return `${deep ? DEEP_SEGMENTS.join("/") : `src/${LONG_SEGMENT}`}/manual.${extension}`;
}

function put(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function populate(extension: string, deep: boolean): string {
  const path = targetFor(extension, deep);
  put(path, FACT);
  put(
    `${deep ? DEEP_SEGMENTS.slice(8).join("/") : `src/${SUFFIX_SEGMENT}`}/manual.${extension}`,
    DECOY_FACT,
  );
  for (let index = 0; index < 120; index += 1)
    put(
      `src/a-decoy-${String(index).padStart(3, "0")}/manual.${extension}`,
      "<nav>Home | Operating instructions | Maintenance | Restart</nav>\n".repeat(110),
    );
  return path;
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

function modelFor(
  requests: GatewayRequest[],
  path: string,
  answerFor?: (request: GatewayRequest) => string,
): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      requests.push(request);
      return Promise.resolve({
        modelId: request.modelId,
        content: answerFor?.(request) ?? `The named manual fact is 937. [${path}:1]`,
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
  options: {
    readonly policy?: OwnAssessmentPolicy;
    readonly answerFor?: (request: GatewayRequest) => string;
  } = {},
): { readonly deps: UiHandlerDeps; readonly chatId: string } {
  const config = parseGatewayConfig({
    groundedAnswers: { ownAssessment: options.policy ?? "disabled" },
    providers: [
      { modelId: MODEL, baseUrl: "https://complete-manual.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 2048 },
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
      modelPortFactory: () => modelFor(requests, path, options.answerFor),
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

async function ask(query: string, path: string): Promise<string> {
  const requests: GatewayRequest[] = [];
  const { deps, chatId } = runtime(requests, path);
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
  expect(prompt.includes(FACT)).toBe(true);
  expect(prompt.includes(DECOY_FACT)).toBe(false);
  const body = response.body as ConnectedContextGroundedAnswer;
  expect(body.citations.some((citation) => citation.scopePath === path)).toBe(true);
  expect(details?.explicitPathAdmittedCount).toBe(1);
  expect(details?.explicitPathRejectedCount).toBe(0);
  return prompt;
}

function populateIndependentManuals(
  first: string,
  second: string,
  fact: string,
  count: number,
  missing: boolean,
): void {
  if (!missing) put(first, FACT);
  put(second, `<main><h1>Authoritative procedure</h1><p>${fact}</p></main>`);
  for (let i = 0; i < count - 2; i += 1)
    put(
      `documents/navigation-${String(i)}.html`,
      "<nav>Home | Operating instructions | Maintenance | Restart</nav>\n".repeat(110),
    );
}

function requestContent(request: GatewayRequest): string {
  return request.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
}

describe("complete bounded manual paths through the actual public grounded handler", () => {
  it.each([
    {
      first: "docs/atlas/trip.html",
      second: "docs/pumps/reset.html",
      topic: "pump reset delays",
      fact: "Pump reset delays are 43 seconds.",
      count: 258,
      missing: false,
    },
    {
      first: "manuals/instruments/temperature.html",
      second: "manuals/seals/flush.html",
      topic: "seal flush duration",
      fact: "Seal flush duration is 67 minutes.",
      count: 98,
      missing: false,
    },
    {
      first: "docs/atlas/absent.html",
      second: "docs/pumps/reset.html",
      topic: "pump reset delays",
      fact: "Pump reset delays are 43 seconds.",
      count: 258,
      missing: true,
    },
  ])(
    "retains an independent prose topic after $first (missing=$missing)",
    async ({ first, second, topic, fact, count, missing }) => {
      populateIndependentManuals(first, second, fact, count, missing);
      const requests: GatewayRequest[] = [];
      const { deps, chatId } = runtime(requests, first, {
        answerFor: (request) =>
          requestContent(request).includes(fact)
            ? `${fact} [${second}:1]`
            : `The named manual fact is 937. [${first}:1]`,
      });
      const response = await dispatch(`Read ${first} and explain ${topic}.`, deps, chatId);
      expect(response.status).toBe(200);
      expect(requests.some((request) => requestContent(request).includes(fact))).toBe(true);
      const answer = response.body as ConnectedContextGroundedAnswer;
      expect(answer.content).toContain(fact);
      expect(answer.citations.some((citation) => citation.scopePath === second)).toBe(true);
    },
  );

  it("keeps an unavailable explicit target honest while allowing separately labelled knowledge", async () => {
    const path = populate("html", false);
    const absent = `src/missing${LONG_SEGMENT}/manual.html`;
    const requests: GatewayRequest[] = [];
    const knowledge =
      "<assessment>\nI can offer general guidance, but this named source is unavailable.\n</assessment>";
    const { deps, chatId } = runtime(requests, path, {
      policy: "allowed",
      answerFor: () => knowledge,
    });
    const response = await dispatch(`Explain ${absent}`, deps, chatId);
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requestContent(requests[0]!)).not.toContain(FACT);
    expect(requestContent(requests[0]!)).not.toContain(DECOY_FACT);
    const answer = response.body as ConnectedContextGroundedAnswer;
    expect(answer.content).toBe(knowledge);
    expect(answer.citations).toEqual([]);
    expect(readPersistedActivityLog(stateDir)).toContain('"explicitPathRejectedCount":1');
  });

  it.each(["bare", "backtick", "doublequoted"])(
    "retains an ordinary short source path as a healthy %s control",
    async (quoting) => {
      populate("ts", false);
      const path = "src/ordinary/handler.ts";
      put(path, FACT);
      const reference =
        quoting === "bare" ? path : quoting === "backtick" ? `\`${path}\`` : `"${path}"`;
      await ask(`Explain ${reference}`, path);
    },
  );

  it("does not substitute a suffix collision or invoke the model for a missing complete path", async () => {
    const path = populate("html", false);
    const requests: GatewayRequest[] = [];
    const { deps, chatId } = runtime(requests, path);
    const absent = `src/missing${LONG_SEGMENT}/manual.html`;
    const response = await dispatch(`Explain ${absent}`, deps, chatId);
    expect(response.status).toBe(200);
    expect(requests).toEqual([]);
    const answer = response.body as ConnectedContextGroundedAnswer;
    expect(answer.citations).toEqual([]);
    expect(answer.content).not.toContain(FACT);
    expect(answer.content).not.toContain(DECOY_FACT);
  });

  it.each(
    ["html", "htm", "xhtml", "txt"].flatMap((extension) =>
      ["bare", "backtick", "doublequoted"].map((quoting) => ({ extension, quoting })),
    ),
  )("retains the full >64-character segment for $extension $quoting references", async (row) => {
    const path = populate(row.extension, false);
    const reference =
      row.quoting === "bare" ? path : row.quoting === "backtick" ? `\`${path}\`` : `"${path}"`;
    await ask(`Explain ${reference}`, path);
  });

  it.each(["bare", "backtick", "doublequoted"])(
    "retains the complete 72-directory path for %s references",
    async (quoting) => {
      const path = populate("html", true);
      const reference =
        quoting === "bare" ? path : quoting === "backtick" ? `\`${path}\`` : `"${path}"`;
      await ask(`Explain ${reference}`, path);
    },
  );
});
