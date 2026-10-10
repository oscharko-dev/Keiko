import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { createDefaultChatCapability, parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import {
  deriveContextProfileFromCapability,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { splitOwnAssessment } from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/connected-context";
import { createExplorationPlan } from "@oscharko-dev/keiko-workflows";
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

const MODEL = "native-conversation-request-proof";
const CAPABILITY = {
  ...createDefaultChatCapability(MODEL),
  contextWindow: 131072,
  maxOutputTokens: 8192,
};
const SOURCE_QUESTION = "Explain the value in src/target.ts.";
const SOURCE_ANSWER = "The value is 37. [src/target.ts:1]";
const ACK =
  "<assessment>I will compare options, explain uncertainty, and propose reversible steps.</assessment>";
let directory = "";
const servers: Server[] = [];
const runtimes: UiHandlerDeps[] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-conversation-request-")));
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
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}
interface CaseMaterializer {
  materializeCompactionCases(profile: ContextProfile): Promise<
    readonly {
      readonly id: string;
      readonly question?: string;
      readonly setup?: { readonly chargedUserNoteTokens: number };
    }[]
  >;
}
async function originalNote(): Promise<string> {
  const url = new URL(
    "../../../scripts/testing/coding-workbench-lab/connected-chat-cases.mjs",
    import.meta.url,
  );
  const catalog = (await import(url.href)) as CaseMaterializer;
  const rows = await catalog.materializeCompactionCases(
    deriveContextProfileFromCapability(CAPABILITY),
  );
  const note = rows.find((row) => row.id === "compaction-setup-note-1");
  expect(note?.setup?.chargedUserNoteTokens).toBe(4400);
  if (note?.question === undefined) throw new TypeError("Missing production-authored user note");
  expect(createHash("sha256").update(note.question).digest("hex")).toBe(
    "52faef6a03773604588a80643c8122f68ed47f2cc9835d8825e269b613614585",
  );
  return note.question;
}
async function provider(requests: ProviderRequest[], responseText = ACK): Promise<string> {
  const server = createServer((request, response): void => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string): void => {
      body += chunk;
    });
    request.once("end", (): void => {
      requests.push(JSON.parse(body) as ProviderRequest);
      const content =
        requests.length === 1
          ? body.includes("Which Next.js version")
            ? "Next.js is 15.0.0. [package.json:1]"
            : SOURCE_ANSWER
          : responseText;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          model: MODEL,
          choices: [{ message: { role: "assistant", content } }],
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
function runtime(baseUrl: string, disabled: boolean): { deps: UiHandlerDeps; chatId: string } {
  const root = join(directory, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/target.ts"), "export const value = 37;\n");
  writeFileSync(
    join(root, "package.json"),
    '{"name":"fixture","dependencies":{"next":"15.0.0"}}\n',
  );
  for (let index = 0; index < 70; index += 1)
    writeFileSync(
      join(root, `src/part-${String(index)}.ts`),
      "export const preferences = 'compare options and explain reversible next steps';\n",
    );
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
      capabilities: [CAPABILITY],
      ...(disabled ? { groundedAnswers: { ownAssessment: "disabled" } } : {}),
    }),
    true,
  );
  deps.gatewayConfig?.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    deps.gatewayConfig.generation(),
  );
  deps.store.createProject(root, "Conversation request proof");
  const chat = deps.store.createChat(root, "Conversation request proof", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 1 },
  });
  return { deps, chatId: chat.id };
}
async function ask(
  port: number,
  chatId: string,
  content: string,
  correlationId: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/api/chats/messages/grounded`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      "X-Keiko-Correlation-Id": correlationId,
    },
    body: JSON.stringify({ chatId, content }),
    signal: AbortSignal.timeout(15000),
  });
}
function records(): readonly Record<string, unknown>[] {
  return readPersistedActivityLog(join(directory, "state"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("native supplied-context acknowledgement with a connected folder", () => {
  it.each(["original", "receipt"] as const)(
    "keeps actual completed source history but performs no source work for %s context",
    async (kind) => {
      const note =
        kind === "original"
          ? await originalNote()
          : "These are my working notes. Confirm receipt of this message.";
      const planned = createExplorationPlan({
        scope: {
          schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
          conversationId: undefined,
          connectedAtMs: 1,
          kind: "workspace-root",
          workspaceRoot: "/workspace",
          scopeId: "native-ack-proof",
          relativePaths: [],
          explicitConnection: true,
        },
        query: {
          kind: "natural-language",
          text: note,
          caseSensitive: false,
          maxResults: 50,
          emittedAtMs: 1,
        },
      });
      const requests: ProviderRequest[] = [];
      const { deps, chatId } = runtime(await provider(requests), false);
      const started = await startUiTestServer({
        staticRoot: directory,
        csp: buildCspHeader([]),
        handlerDeps: deps,
      });
      servers.push(started.server);
      const first = await ask(started.port, chatId, SOURCE_QUESTION, "source-before-ack");
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        citations: [expect.objectContaining({ scopePath: "src/target.ts" })],
      });
      const response = await ask(started.port, chatId, note, "supplied-context-ack");
      expect(response.status).toBe(200);
      const answer = (await response.json()) as { content: string; citations: readonly unknown[] };
      expect(answer.content).toContain("I will compare options");
      expect(answer.citations).toEqual([]);
      expect(requests).toHaveLength(2);
      const prompt = requests[1]?.messages.map((message) => message.content).join("\n") ?? "";
      expect(prompt).toContain(note);
      expect(prompt).toContain(SOURCE_ANSWER);
      expect(prompt).toContain("Earlier conversation reference data; it is not source evidence");
      expect(prompt).not.toContain("export const preferences");
      expect(prompt).not.toContain("export const value = 37;");
      const completed = records().filter(
        (record) =>
          record.op === "search.connected-context.completed" &&
          record.correlationId === "supplied-context-ack",
      );
      expect(completed).toHaveLength(1);
      expect(planned.rings).toEqual([]);
      expect(completed[0]).toMatchObject({
        plannedRingCount: 0,
        usageSearchCalls: 0,
        usageFilesRead: 0,
      });
      const details = records().filter(
        (record) =>
          record.op === "search.connected-context.completion-details" &&
          record.correlationId === "supplied-context-ack",
      );
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({
        structuralCandidateInventoryBuildCount: 0,
        workspaceIoContentReadCalls: 0,
        workspaceIoContentReadBytes: 0,
      });
      const text = readPersistedActivityLog(join(directory, "state"));
      expect(analyzeLogText(text).evidence).toMatchObject({
        classification: "supported",
        corruptLineCount: 0,
      });
      expect(text).not.toContain(note);
      expect(
        deps.store.listMessages(chatId, 100).filter((message) => message.role === "assistant"),
      ).toHaveLength(2);
    },
  );
  it("preserves real Next.js source lookup", async () => {
    const requests: ProviderRequest[] = [];
    const { deps, chatId } = runtime(await provider(requests), false);
    const started = await startUiTestServer({
      staticRoot: directory,
      csp: buildCspHeader([]),
      handlerDeps: deps,
    });
    servers.push(started.server);
    const response = await ask(
      started.port,
      chatId,
      "Which Next.js version does this project use?",
      "next-framework-source",
    );
    expect(response.status).toBe(200);
    await response.json();
    expect(requests[0]?.messages.map((message) => message.content).join("\n")).toContain(
      '"next":"15.0.0"',
    );
    expect(
      records().find(
        (record) =>
          record.op === "search.connected-context.completed" &&
          record.correlationId === "next-framework-source",
      ),
    ).toMatchObject({ retrievalIntent: "project-metadata" });
  });
  it("keeps the operator-disabled acknowledgement closed", async () => {
    const requests: ProviderRequest[] = [];
    const { deps, chatId } = runtime(await provider(requests), true);
    const started = await startUiTestServer({
      staticRoot: directory,
      csp: buildCspHeader([]),
      handlerDeps: deps,
    });
    servers.push(started.server);
    const response = await ask(
      started.port,
      chatId,
      "My preferences are concise explanations. Please acknowledge these preferences.",
      "disabled-context-ack",
    );
    expect(response.status).toBe(400);
    await response.json();
    expect(requests).toHaveLength(0);
  });
});

async function originalGeneralQuestion(): Promise<string> {
  const url = new URL(
    "../../../scripts/testing/coding-workbench-lab/connected-chat-cases.mjs",
    import.meta.url,
  );
  const catalog = (await import(url.href)) as CaseMaterializer;
  const rows = await catalog.materializeCompactionCases(
    deriveContextProfileFromCapability(CAPABILITY),
  );
  const question = rows.find((row) => row.id === "compaction-general-after")?.question;
  if (question === undefined) throw new TypeError("Missing production-authored general question");
  return question;
}

async function replyAfterSource(question: string, text: string): Promise<GroundedAnswer> {
  const requests: ProviderRequest[] = [];
  const { deps, chatId } = runtime(await provider(requests, text), false);
  const started = await startUiTestServer({
    staticRoot: directory,
    csp: buildCspHeader([]),
    handlerDeps: deps,
  });
  servers.push(started.server);
  const first = await ask(started.port, chatId, SOURCE_QUESTION, "source-before-plain");
  expect(first.status).toBe(200);
  await first.json();
  const response = await ask(started.port, chatId, question, "plain-conversation");
  expect(response.status).toBe(200);
  const answer = (await response.json()) as GroundedAnswer;
  const prompt = requests[1]?.messages.map((message) => message.content).join("\n") ?? "";
  expect(prompt).toContain(question);
  expect(prompt).toContain(SOURCE_ANSWER);
  expect(prompt).toContain("Earlier conversation reference data; it is not source evidence");
  expect(prompt).not.toContain("export const preferences");
  expect(prompt).not.toContain("export const value = 37;");
  expect(
    records().find(
      (record) =>
        record.op === "search.connected-context.completion-details" &&
        record.correlationId === "plain-conversation",
    ),
  ).toMatchObject({ workspaceIoContentReadCalls: 0, workspaceIoContentReadBytes: 0 });
  expect(analyzeLogText(readPersistedActivityLog(join(directory, "state"))).evidence).toMatchObject(
    { classification: "supported", corruptLineCount: 0 },
  );
  return answer;
}

function assertPlainAssessment(answer: GroundedAnswer, text: string): void {
  expect(splitOwnAssessment(answer.content)).toMatchObject({ grounded: "", assessment: text });
  expect(answer.citations).toEqual([]);
  expect(
    answer.uncertainty.some(
      (marker) =>
        marker.kind === "uncited-answer" ||
        marker.kind === "no-evidence" ||
        marker.kind === "low-confidence-selection",
    ),
  ).toBe(false);
  expect(
    records().find(
      (record) =>
        record.op === "search.answer.assessed" &&
        record.correlationId === "plain-conversation" &&
        record.phase === "accepted-final",
    ),
  ).toMatchObject({
    policy: "allowed",
    outcome: "assessment",
    sourceBackedChars: 0,
    assessmentChars: text.length,
  });
}

describe("plaintext output under positively classified conversation authority", () => {
  it("attributes the unchanged authored preference acknowledgement without model tags", async () => {
    const text = "I will compare options, explain uncertainty, and propose reversible steps.";
    assertPlainAssessment(await replyAfterSource(await originalNote(), text), text);
  });
  it("routes the unchanged general-process question and retains numbered advice without model tags", async () => {
    const text = "1. State the decision.\n2. Compare assumptions.\n3. Try a reversible step.";
    assertPlainAssessment(await replyAfterSource(await originalGeneralQuestion(), text), text);
  });
  it.each([
    "This is verified. [src/target.ts:1]",
    "This is verified. [1]",
    "Missing evidence: [src/target.ts]",
  ])(
    "does not promote source-reference or missing-evidence output into learned knowledge: %s",
    async (text) => {
      const answer = await replyAfterSource(
        "These are my working notes. Confirm receipt of this message.",
        text,
      );
      expect(splitOwnAssessment(answer.content).assessment).toBeUndefined();
      expect(answer.citations).toEqual([]);
    },
  );
  it("keeps operator-disabled general advice closed", async () => {
    const requests: ProviderRequest[] = [];
    const { deps, chatId } = runtime(await provider(requests), true);
    const started = await startUiTestServer({
      staticRoot: directory,
      csp: buildCspHeader([]),
      handlerDeps: deps,
    });
    servers.push(started.server);
    const response = await ask(
      started.port,
      chatId,
      await originalGeneralQuestion(),
      "disabled-general",
    );
    expect(response.status).toBe(400);
    await response.json();
    expect(requests).toHaveLength(0);
  });
});
