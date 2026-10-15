import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Chat,
  ChatConnectedScope,
  ConnectedContextGroundedAnswer,
  GroundedAnswer,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { createInMemoryEvidenceStore, loadEvidence } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { buildCspHeader } from "./csp.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import { UI_HOST } from "./server.js";
import { closeUiTestServer, startUiTestServer } from "./ui-test-server/_support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";

const MODEL = "questionless-diagnostic-native-proof";
const TARGET = "src/deep/window.ts";
const FACT = "export const diagnosticWindow = 937;";
const FRAME = `    at Object.get (${TARGET}:301:3)`;
const EXTERNAL = "    at execute (node_modules/vitest/runner.js:10:3)";
const KINDS = ["workspace-root", "directory", "files"] as const;
let directory = "";
const servers: Server[] = [];
const stores: UiHandlerDeps["store"][] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-trace-native-")));
});
afterEach(async () => {
  for (const server of servers.splice(0)) await closeUiTestServer(server);
  for (const store of stores.splice(0)) store.close();
  resetServerLogger();
  rmSync(directory, { recursive: true, force: true });
});

function populate(): string {
  const root = join(directory, "workspace");
  mkdirSync(join(root, "src/deep"), { recursive: true });
  const lines = Array.from({ length: 330 }, () => "// ordinary source padding");
  lines[300] = FACT;
  writeFileSync(join(root, TARGET), lines.join("\n"));
  writeFileSync(join(root, "package.json"), '{"engines":{"node":">=24"}}\n');
  writeFileSync(join(root, ".env"), "DENIED_SYNTHETIC_VALUE=must-not-be-read\n");
  return root;
}

function answerModel(calls: GatewayCallRequest[]): ModelPort {
  return {
    call(request): ReturnType<ModelPort["call"]> {
      calls.push(request);
      const sent = request.messages.map((message) => message.content).join("\n");
      return Promise.resolve({
        modelId: MODEL,
        content: sent.includes(FACT)
          ? `The diagnostic window is 937. [${TARGET}:301]`
          : "<assessment>I cannot determine the requested value from supplied source evidence.</assessment>",
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "questionless-native-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 0,
          costClass: "medium",
        },
      });
    },
  };
}

function runtime(root: string, calls: GatewayCallRequest[]): { deps: UiHandlerDeps; chat: Chat } {
  const config = parseGatewayConfig({
    providers: [{ modelId: MODEL, baseUrl: "https://trace.example.invalid/v1", apiKey: "fixture" }],
    capabilities: [
      { ...createDefaultChatCapability(MODEL), contextWindow: 32768, maxOutputTokens: 1024 },
    ],
  });
  const store = createInMemoryUiStore();
  stores.push(store);
  store.createProject(root, "Questionless diagnostic proof");
  return {
    chat: store.createChat(root, "Questionless diagnostic proof", MODEL),
    deps: {
      config,
      configPresent: true,
      env: {},
      store,
      redactor: buildRedactor({}, config),
      registry: createRunRegistry(),
      evidenceStore: createInMemoryEvidenceStore(),
      modelPortFactory: () => answerModel(calls),
    },
  };
}

function connectedScope(root: string, kind: ChatConnectedScope["kind"]): ChatConnectedScope {
  return {
    kind,
    root,
    relativePaths: kind === "workspace-root" ? [] : [kind === "directory" ? "src/deep" : TARGET],
    connectedAtMs: 1,
  };
}

async function nativeJson(
  base: string,
  path: string,
  method: string,
  body: object,
): Promise<{
  readonly status: number;
  readonly json: unknown;
}> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

async function ask(
  kind: ChatConnectedScope["kind"],
  question: string,
): Promise<{
  readonly status: number;
  readonly answer: GroundedAnswer;
  readonly calls: readonly GatewayCallRequest[];
  readonly deps: UiHandlerDeps;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const root = populate();
  const calls: GatewayCallRequest[] = [];
  const { deps, chat } = runtime(root, calls);
  const log = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink: log, level: "info" }));
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps: deps,
    activityLog: log,
  });
  servers.push(started.server);
  const base = `http://${UI_HOST}:${String(started.port)}`;
  const binding = await nativeJson(base, `/api/chats?id=${encodeURIComponent(chat.id)}`, "PATCH", {
    connectedScopes: [connectedScope(root, kind)],
  });
  expect(binding.status).toBe(200);
  const acknowledged = binding.json as { chat: Chat };
  const response = await nativeJson(base, "/api/chats/messages/grounded", "POST", {
    chatId: chat.id,
    content: question,
    expectedGroundingScopeIdentity: acknowledged.chat.groundingScopeIdentity,
  });
  return { status: response.status, answer: response.json as GroundedAnswer, calls, deps, log };
}

function connectedAnswer(answer: GroundedAnswer): ConnectedContextGroundedAnswer {
  expect(answer.groundingKind).toBe("connected-context");
  if (answer.groundingKind !== "connected-context")
    throw new TypeError("Unexpected native grounded answer topology");
  return answer;
}

function assertSupported(result: Awaited<ReturnType<typeof ask>>): void {
  expect(result.status).toBe(200);
  const answer = connectedAnswer(result.answer);
  const prompt = result.calls.map((call) => call.messages.map((message) => message.content)).flat();
  expect(prompt.join("\n")).toContain(FACT);
  expect(result.calls).toHaveLength(1);
  expect(answer.citations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scopePath: TARGET, lineRange: { startLine: 301, endLine: 301 } }),
    ]),
  );
  expect(answer.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(false);
  const runId = answer.evidenceRunId;
  expect(runId).toBeDefined();
  if (runId === undefined) throw new TypeError("Missing native grounded evidence");
  const manifest = loadEvidence(result.deps.evidenceStore, runId);
  expect(manifest?.connectedContext?.files.some((file) => file.scopePath === TARGET)).toBe(true);
  expect(
    result.log.events.find((event) => event.op === "search.connected-context.source-details")
      ?.extra,
  ).toMatchObject({ stackTraceAdmittedPathCount: 1, metadataInjectionReason: "none" });
}

describe("questionless diagnostic pastes through the native grounded HTTP route", () => {
  for (const kind of KINDS) {
    it.each([FRAME, `AssertionError: expected 1 to be 2\n${FRAME}`])(
      `authenticates the supplied line301 source for ${kind}: %s`,
      async (question) => {
        const result = await ask(kind, question);
        assertSupported(result);
      },
    );

    it(`retains the human-question and external-frame healthy twin for ${kind}`, async () => {
      const result = await ask(kind, `Why does this assertion fail?\n${FRAME}\n${EXTERNAL}`);
      assertSupported(result);
      expect(
        connectedAnswer(result.answer).citations.some(
          (citation) => citation.scopePath === "package.json",
        ),
      ).toBe(false);
    });

    it.each(["src/deep/missing.ts", ".env"])(
      `does not restore raw-frame search for unadmitted ${kind} target %s`,
      async (path) => {
        const result = await ask(
          kind,
          `AssertionError: expected 1 to be 2\n    at Object.get (${path}:301:3)\n${EXTERNAL}`,
        );
        expect(result.status).toBe(200);
        expect(
          connectedAnswer(result.answer).citations.some((citation) => citation.scopePath === path),
        ).toBe(false);
        expect(
          result.calls
            .flatMap((call) => call.messages)
            .map((message) => message.content)
            .join("\n"),
        ).not.toContain("DENIED_SYNTHETIC_VALUE");
        expect(
          result.log.events.find((event) => event.op === "search.connected-context.source-details")
            ?.extra,
        ).toMatchObject({ stackTraceAdmittedPathCount: 0, metadataInjectionReason: "none" });
      },
    );

    it(`retains the external-only no-reference healthy twin for ${kind}`, async () => {
      const result = await ask(kind, `AssertionError: expected 1 to be 2\n${EXTERNAL}`);
      expect(result.status).toBe(200);
      expect(result.answer.citations).toEqual([]);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.messages.map((message) => message.content).join("\n")).not.toContain(
        FACT,
      );
    });
  }
});
