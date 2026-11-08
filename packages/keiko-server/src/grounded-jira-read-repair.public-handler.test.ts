// #4321, Golden reporting step 3: exercise the real Knowledge answer/repair caller and
// governed Jira read. Only the two external boundaries (model and native HTTP) are fixtures.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import {
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { jiraOperationDefinitions } from "./atlassian/jiraOperationRegistry.js";
import { mockRequest, mockResponse } from "./_support.js";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import type { RouteContext } from "./routes.js";

const MODEL = "golden-read-repair";
const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const KNOWLEDGE_TEXT = "Feature returns true. Feature is a function.";
const CURRENT = "Golden current observed project";
const PRIOR = "Golden previous turn project";
const RAW = "native unprojected payload marker";
const FAILED = "forged successful project in rejected native payload";
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const close of cleanup.splice(0)) await close();
  resetServerLogger();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function configure(deps: UiHandlerDeps): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://golden-model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  const config = deps.gatewayConfig;
  if (config === undefined) throw new Error("Missing Gateway configuration owner");
  config.set(
    parseGatewayConfig({
      providers: [provider],
      groundedAnswers: { ownAssessment: "disabled" },
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
          maxOutputTokens: 1024,
          toolCalling: true,
          toolCallingVerification: {
            status: "verified",
            checkedAt: new Date().toISOString(),
            probe: "gateway-tool-calling-v1",
            configurationFingerprint: toolCallingConfigurationFingerprint(provider),
          },
        },
      ],
    }),
    true,
  );
  config.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    config.generation(),
  );
}

function credential(deps: UiHandlerDeps): AtlassianCredentialMetadata {
  const ownerDigest = jiraChatActorDigest(deps);
  if (ownerDigest === undefined) throw new Error("Missing Chat principal");
  return {
    schemaVersion: "1",
    authRef: "synthetic-golden-jira",
    displayName: "Synthetic Golden Jira",
    baseUrl: "https://jira.example.invalid",
    createdAt: 1,
    generation: 1,
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    livePod: {
      podId: POD,
      ownerDigest,
      creationRequestId: "d5f5681e-ce98-4c3c-b27e-51d707c9d019",
      verificationRevision: 1,
      verificationInProgress: false,
      verificationStatus: "ok",
    },
  };
}

interface NativeState {
  name: string;
  denied: boolean;
  report?: boolean;
  readonly requests: { readonly method: string; readonly url: string }[];
}

/** Two literal native hits. The production report owner performs all aggregation/projection. */
const REPORT_ISSUES = [
  {
    id: "10001",
    key: "KERD-1",
    raw: RAW,
    fields: {
      summary: "Golden completed task",
      project: { id: "10000", key: "KERD" },
      issuetype: { id: "10", name: "Task", subtask: false },
      status: { id: "5", name: "Done", statusCategory: { key: "done", name: "Done" } },
      parent: null,
      issuelinks: [],
      labels: [],
      assignee: null,
      duedate: null,
      timeoriginalestimate: 3600,
      description: null,
    },
  },
  {
    id: "10002",
    key: "KERD-2",
    raw: RAW,
    fields: {
      summary: "Golden open task",
      project: { id: "10000", key: "KERD" },
      issuetype: { id: "10", name: "Task", subtask: false },
      status: { id: "1", name: "Open", statusCategory: { key: "new", name: "To Do" } },
      parent: null,
      issuelinks: [],
      labels: [],
      assignee: null,
      duedate: null,
      timeoriginalestimate: 7200,
      description: null,
    },
  },
];

function reportNativeBody(url: URL): unknown {
  expect(url.origin).toBe("https://jira.example.invalid");
  switch (url.pathname) {
    case "/rest/api/2/field":
      return [{ id: "summary", name: "Summary", schema: { type: "string", system: "summary" } }];
    case "/rest/api/2/issue/createmeta/KERD/issuetypes":
      return { values: [{ id: "10", name: "Task", subtask: false }], isLast: true, total: 1 };
    case "/rest/api/2/issue/createmeta/KERD/issuetypes/10":
      return {
        values: [{ fieldId: "summary", required: true, hasDefaultValue: false }],
        isLast: true,
        total: 1,
      };
    case "/rest/api/2/search":
      expect(url.searchParams.get("jql")).toBe('project = "KERD" ORDER BY key ASC');
      expect(url.searchParams.get("startAt")).toBe("0");
      expect(url.searchParams.get("fields")?.split(",")).toContain("timeoriginalestimate");
      return { startAt: 0, maxResults: 100, total: 2, issues: REPORT_ISSUES, raw: RAW };
    default:
      throw new Error("Unexpected native report request");
  }
}

function nativeBody(state: NativeState, url: string): unknown {
  if (state.report === true) return reportNativeBody(new URL(url));
  expect(url).toBe("https://jira.example.invalid/rest/api/2/project");
  return state.denied
    ? { errorMessages: ["Synthetic forbidden"], items: [{ name: FAILED }], raw: RAW }
    : [{ id: "10000", key: "GOLD", name: state.name, raw: RAW }];
}

function installNativeJira(deps: UiHandlerDeps, state: NativeState): void {
  const credentials = deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing credential owner");
  vi.spyOn(credentials.custody, "list").mockImplementation(() => [credential(deps)]);
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlation, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        expect(lifecycle?.beforeDispatch?.(request)).toBe(true);
        expect(request.method).toBe("GET");
        state.requests.push({ method: request.method, url: request.url });
        const status = state.denied ? 403 : 200;
        const bodyText = JSON.stringify(nativeBody(state, request.url));
        lifecycle?.onResponse?.(request, status);
        return Promise.resolve({
          kind: "response",
          status,
          bodyText,
          bodyBytes: Buffer.byteLength(bodyText),
          truncated: false,
        });
      },
  );
}

async function connectKnowledge(
  deps: UiHandlerDeps,
  chatId: string,
  stateDir: string,
): Promise<void> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: stateDir }),
  });
  try {
    const pod = await seedCapsuleWithVectors(store, {
      displayName: "Golden Knowledge",
      text: KNOWLEDGE_TEXT,
      safeDisplayName: "golden-knowledge.txt",
      unit: {
        kind: "page",
        pageNumber: 1,
        pageLabel: "1",
        characterStart: 0,
        characterEnd: KNOWLEDGE_TEXT.length,
      },
      // The generic seed defaults to two-token chunks, which do not support this claim.
      chunkingOptions: { maxTokens: 120, minTokens: 0, overlapTokens: 0 },
    });
    updateCapsuleState(store, pod.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
  readonly root: string;
  readonly native: NativeState;
  script: Script;
}

async function fixture(knowledge = true): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-golden-read-repair-")));
  vi.stubEnv("KEIKO_STATE_DIR", root);
  vi.stubEnv("KEIKO_MEMORY_DIR", join(root, "memory"));
  vi.stubEnv("KEIKO_OS_KEYCHAIN", "off");
  const holder = { script: script(CURRENT) };
  const deps = buildUiHandlerDeps({
    configPath: join(root, "gateway.json"),
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {
      KEIKO_STATE_DIR: root,
      KEIKO_MEMORY_DIR: join(root, "memory"),
      KEIKO_OS_KEYCHAIN: "off",
    },
    modelPortFactory: () => ({
      call: (request, signal): Promise<NormalizedResponse> =>
        holder.script.model.call(request, signal),
    }),
  });
  cleanup.push(async () => {
    await deps.dispose?.();
    resetServerLogger();
    rmSync(root, { recursive: true, force: true });
  });
  configure(deps);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Golden reporting", MODEL);
  deps.store.updateChat(
    chat.id,
    { jiraPodId: POD, toolMode: "governed-assist" },
    {
      verifiedJiraPod: { podId: POD, authenticationGeneration: 1 },
    },
  );
  const native: NativeState = { name: CURRENT, denied: false, requests: [] };
  installNativeJira(deps, native);
  if (knowledge) await connectKnowledge(deps, chat.id, root);
  return {
    deps,
    chatId: chat.id,
    root,
    native,
    get script(): Script {
      return holder.script;
    },
    set script(value: Script) {
      holder.script = value;
    },
  };
}

interface Script {
  readonly model: ModelPort;
  readonly calls: GatewayCallRequest[];
  readonly answers: GatewayCallRequest[];
}

function response(content: string): NormalizedResponse {
  return {
    modelId: MODEL,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "golden-response",
      promptTokens: 100,
      completionTokens: 20,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

function toolEvidence(request: GatewayCallRequest): string {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.content)
    .join("\n");
}

function readCall(
  request: GatewayCallRequest,
  name: "jira.projects" | "jira.report" | "jira.discover" | "jira.describe",
  args: CatalogJsonObject = {},
  id = "golden-current-read",
): NormalizedResponse {
  if (request.toolCatalog?.kind !== "bound") throw new Error("Missing real bound tool catalog");
  const tool = request.toolCatalog.projection.tools.find(
    (entry) => entry.toolRef.canonicalId === `keiko.${name}`,
  );
  if (tool === undefined) throw new Error("Jira read was not offered");
  const bridge = createGatewayToolCatalogBridge({ ...request, stream: false }, Date.now);
  return {
    ...response(""),
    finishReason: "tool_calls",
    toolCalls: [bridge.bind({ id, name: tool.alias, arguments: args })],
  };
}

/** A model cannot recover the fixture's observed name from the question or the Pod text. */
function scriptedAnswer(request: GatewayCallRequest, observed: string, cite: boolean): string {
  const knowledge = request.messages.some((message) => message.content.includes("Citations:"));
  if (knowledge)
    expect(
      request.messages.some((message) =>
        message.content.includes(`\`\`\`text\n${KNOWLEDGE_TEXT}\n\`\`\``),
      ),
    ).toBe(true);
  const marker = cite && knowledge ? " [1]" : "";
  const jira = toolEvidence(request).includes(observed)
    ? `Jira tool result: project GOLD is named ${observed}.`
    : "No current Jira project observation is available.";
  return knowledge ? `Feature returns true${marker}.\n\n${jira}` : jira;
}

interface ReadSelection {
  readonly name: "jira.projects" | "jira.report";
  readonly args: CatalogJsonObject;
  read: boolean;
  described: boolean;
  discoveryId?: string;
}

function metadataLabel(value: unknown): string {
  return typeof value === "string" ? value : "missing";
}

function metadataResult(
  request: GatewayCallRequest,
  id: string,
): Readonly<Record<string, unknown>> {
  const message = request.messages.find(
    (entry) => entry.role === "tool" && entry.toolCallId === id,
  );
  if (message === undefined) throw new Error("Missing actual metadata response");
  const result: unknown = JSON.parse(message.content);
  if (!record(result)) throw new Error("Malformed actual metadata response");
  const data = record(result.data) ? result.data : undefined;
  if (result.status !== "completed" || data?.outcome !== "succeeded")
    throw new Error(
      `Metadata ${id}: status=${metadataLabel(result.status)}, reason=${metadataLabel(result.reason)}, outcome=${metadataLabel(data?.outcome)}, dataReason=${metadataLabel(data?.reason)}`,
    );
  return data;
}

function discoveredIdentity(
  page: Readonly<Record<string, unknown>> | undefined,
  name: ReadSelection["name"],
): string | undefined {
  if (!Array.isArray(page?.items)) return undefined;
  const item: unknown = page.items.find(
    (value: unknown) => record(value) && value.tool === name.replaceAll(".", "_"),
  );
  return record(item) && typeof item.identity === "string" ? item.identity : undefined;
}

/** Start at this fixture's target; exercising catalog enumeration belongs to the P1 suite. */
function selectedDiscovery(
  request: GatewayCallRequest,
  selection: ReadSelection,
): NormalizedResponse {
  const startAt = jiraOperationDefinitions().findIndex((entry) => entry.tool === selection.name);
  if (startAt < 0) throw new Error("Requested read has no catalog definition");
  selection.discoveryId = `golden-discover-${String(startAt)}`;
  return readCall(request, "jira.discover", { startAt, maxResults: 1 }, selection.discoveryId);
}

/** Select only the identity actually returned by the current turn's real discovery tool. */
function selectedRead(
  request: GatewayCallRequest,
  selection: ReadSelection,
): NormalizedResponse | undefined {
  if (selection.read) return undefined;
  if (request.toolCatalog?.kind !== "bound") throw new Error("Missing bound selection catalog");
  if (
    request.toolCatalog.projection.tools.some(
      (tool) => tool.toolRef.canonicalId === `keiko.${selection.name}`,
    )
  ) {
    selection.read = true;
    return readCall(request, selection.name, selection.args);
  }
  if (selection.described) {
    metadataResult(request, "golden-describe");
    throw new Error("Describe did not offer the selected read");
  }
  if (selection.discoveryId === undefined) return selectedDiscovery(request, selection);
  const page = metadataResult(request, selection.discoveryId);
  const identity = discoveredIdentity(page, selection.name);
  if (identity === undefined) throw new Error("Discovery did not return the requested read");
  selection.described = true;
  return readCall(request, "jira.describe", { identities: [identity] }, "golden-describe");
}

function scriptedModel(
  name: ReadSelection["name"],
  args: CatalogJsonObject,
  next: (request: GatewayCallRequest, round: number) => NormalizedResponse,
): Script {
  const calls: GatewayCallRequest[] = [];
  const answers: GatewayCallRequest[] = [];
  const selection: ReadSelection = { name, args, read: false, described: false };
  const model: ModelPort = {
    call: (request): Promise<NormalizedResponse> => {
      // Background Memory/retrieval calls are not productive answer or repair calls.
      if (
        request.toolCatalog === undefined &&
        !request.messages.some((message) => message.content.includes("Citations:"))
      )
        return Promise.resolve(response("[]"));
      calls.push(request);
      const selected = selectedRead(request, selection);
      if (selected === undefined) answers.push(request);
      const result = selected ?? next(request, answers.length);
      const admitted = request.attemptAdmission?.({ promptTokens: 100, maxOutputTokens: 100 });
      admitted?.settle(result.usage, true, "observed");
      return Promise.resolve(result);
    },
  };
  return { model, calls, answers };
}

function script(observed: string, citeFirst = false, changedRepair?: string): Script {
  return scriptedModel("jira.projects", {}, (request, round) => {
    if (round > 1 && changedRepair !== undefined) return response(changedRepair);
    return response(scriptedAnswer(request, observed, citeFirst || round > 1));
  });
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answerContent(body: unknown): string {
  if (!record(body) || typeof body.content !== "string")
    throw new Error("Missing actual answer content");
  return body.content;
}

function reportFigures(request: GatewayCallRequest): string | undefined {
  for (const message of request.messages.filter((entry) => entry.role === "tool")) {
    const result: unknown = JSON.parse(message.content);
    if (!record(result) || result.status !== "completed" || !record(result.data)) continue;
    const { data } = result;
    if (data.outcome !== "succeeded" || !record(data.report)) continue;
    if (typeof data.report.figures === "string") return data.report.figures;
  }
  return undefined;
}

function reportScript(changedRepair?: string): Script {
  return scriptedModel("jira.report", { projectKey: "KERD" }, (request, round) => {
    if (round > 1 && changedRepair !== undefined) return response(changedRepair);
    expect(
      request.messages.some((message) =>
        message.content.includes(`\`\`\`text\n${KNOWLEDGE_TEXT}\n\`\`\``),
      ),
    ).toBe(true);
    const figures = reportFigures(request);
    const facts =
      figures === undefined
        ? "No current Jira report observation is available."
        : `Jira tool result for KERD (KERD-1, KERD-2):\n${figures}`;
    return response(`Feature returns true${round > 1 ? " [1]" : ""}.\n\n${facts}`);
  });
}

function context(f: Fixture, turn: string): RouteContext {
  return {
    req: mockRequest({
      body: JSON.stringify({
        chatId: f.chatId,
        projectPath: f.root,
        modelId: MODEL,
        content:
          f.native.report === true
            ? "What does Feature return? Also report KERD project progress and original estimates."
            : "What does Feature return? Also list the current Jira projects.",
        clientTurnId: turn,
        memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
      }),
    }),
    res: mockResponse().res,
    url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
    params: {},
    correlationId: turn,
  };
}

function currentExchange(f: Fixture): ChatToolTranscript | undefined {
  return f.deps.store
    .listMessages(f.chatId)
    .filter((message) => message.role === "user")
    .at(-1)?.toolTranscript;
}

function expectSelection(f: Fixture, name: "jira_projects" | "jira_report"): void {
  const exchanges = currentExchange(f)?.exchanges ?? [];
  const discovery = exchanges.filter((entry) => entry.call.name === "jira_discover");
  const description = exchanges.filter((entry) => entry.call.name === "jira_describe");
  expect(discovery).toHaveLength(1);
  expect(description).toHaveLength(1);
  for (const entry of [...discovery, ...description])
    expect(entry.result?.status).toBe("completed");
  expect(exchanges.filter((entry) => entry.call.name === name)).toHaveLength(1);
  expect(f.script.calls).toHaveLength(
    discovery.length + description.length + 1 + f.script.answers.length,
  );
}

it("retains this turn's validated Jira read evidence when repairing a Knowledge Pod answer", async () => {
  const f = await fixture();
  const result = await handleGroundedAsk(context(f, "golden-current-turn"), f.deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const exchange = currentExchange(f)?.exchanges.find(
    (entry) => entry.call.name === "jira_projects",
  );
  expect(exchange?.result).toMatchObject({
    status: "completed",
    data: { outcome: "succeeded", items: [{ key: "GOLD", name: CURRENT }] },
  });
  expect(JSON.stringify(exchange)).not.toContain(RAW);
  expect(f.native.requests).toHaveLength(1);
  expectSelection(f, "jira_projects");
  expect(f.script.answers).toHaveLength(2);
  const initialAnswer = f.script.answers[0];
  const repair = f.script.answers[1];
  if (initialAnswer === undefined || repair === undefined)
    throw new Error("Missing synthesis calls");
  expect(toolEvidence(initialAnswer)).toContain(CURRENT);
  expect(
    repair.messages.some((message) =>
      message.content.includes(`\`\`\`text\n${KNOWLEDGE_TEXT}\n\`\`\``),
    ),
  ).toBe(true);
  expect(repair.toolCatalog).toBeUndefined();
  // Baseline pin: a completed card must not lose its evidence at the final repair handoff.
  expect(toolEvidence(repair)).toContain(CURRENT);
  expect(toolEvidence(repair)).not.toContain(RAW);
  expect(answerContent(result.body)).toContain(CURRENT);
  expect(result.body).toMatchObject({ citations: [expect.anything()] });
});

it("does not promote prior, rejected or raw Jira payloads to current repair evidence", async () => {
  const f = await fixture();
  f.native.name = PRIOR;
  f.script = script(PRIOR, true);
  const first = await handleGroundedAsk(context(f, "golden-prior-turn"), f.deps);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(answerContent(first.body)).toContain(PRIOR);
  expectSelection(f, "jira_projects");
  expect(f.script.answers).toHaveLength(1);
  f.native.denied = true;
  f.script = script(CURRENT);
  const next = await handleGroundedAsk(context(f, "golden-denied-turn"), f.deps);
  expect(next.status, JSON.stringify(next.body)).toBe(200);
  const exchange = currentExchange(f)?.exchanges.find(
    (entry) => entry.call.name === "jira_projects",
  );
  expect(exchange?.result).toMatchObject({
    status: "failed",
    data: { outcome: "failed", reason: "permission-denied" },
  });
  expect(f.native.requests).toHaveLength(2);
  expectSelection(f, "jira_projects");
  expect(f.script.answers).toHaveLength(2);
  const repair = f.script.answers[1];
  if (repair === undefined) throw new Error("Missing denied-turn repair");
  for (const marker of [PRIOR, RAW, FAILED, CURRENT]) {
    expect(toolEvidence(repair)).not.toContain(marker);
    expect(JSON.stringify(next.body)).not.toContain(marker);
  }
  expect(repair.toolCatalog).toBeUndefined();
});

it("keeps the Jira-only tool answer when no Knowledge Pod is connected", async () => {
  const f = await fixture(false);
  const result = await handleSendDesktopChat(context(f, "golden-no-knowledge"), f.deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.native.requests).toHaveLength(1);
  expectSelection(f, "jira_projects");
  expect(f.script.answers).toHaveLength(1);
  const answer = f.deps.store.listMessages(f.chatId).at(-1);
  expect(answer?.role).toBe("assistant");
  expect(answer?.content).toContain(CURRENT);
  expect(answer?.content).not.toContain("[1]");
  expect(answer?.content).not.toContain(RAW);
});

function observedReportFigures(f: Fixture): string {
  const exchange = currentExchange(f)?.exchanges.find((entry) => entry.call.name === "jira_report");
  expect(exchange?.result).toMatchObject({
    status: "completed",
    data: {
      outcome: "succeeded",
      status: "complete",
      report: {
        scope: { projectKey: "KERD", estimateUnit: "seconds" },
        completeness: { complete: true, issuesRead: 2, issuesTotal: 2, pageCount: 1 },
        progress: {
          project: {
            total: 2,
            new: 1,
            done: 1,
            estimate: { total: 10800, done: 3600, remaining: 7200, unestimated: 0 },
          },
        },
      },
    },
  });
  expect(JSON.stringify(exchange)).not.toContain(RAW);
  expect(f.native.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/rest/api/2/field",
    "/rest/api/2/issue/createmeta/KERD/issuetypes",
    "/rest/api/2/issue/createmeta/KERD/issuetypes/10",
    "/rest/api/2/search",
  ]);
  const initialAnswer = f.script.answers[0];
  if (initialAnswer === undefined) throw new Error("Missing report synthesis");
  const figures = reportFigures(initialAnswer);
  if (figures === undefined) throw new Error("Missing projected report figures");
  expect(figures).toContain("Issues in the report: 2; done: 1");
  expect(figures).toContain("10800;3600;7200");
  return figures;
}

it("preserves real jira.report figures alongside Knowledge excerpts through final citation repair", async () => {
  const f = await fixture();
  f.native.report = true;
  f.script = reportScript();
  const result = await handleGroundedAsk(context(f, "golden-report-turn"), f.deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const figures = observedReportFigures(f);
  expectSelection(f, "jira_report");
  expect(f.script.answers).toHaveLength(2);
  const repair = f.script.answers[1];
  if (repair === undefined) throw new Error("Missing report repair call");
  expect(repair.toolCatalog).toBeUndefined();
  expect(reportFigures(repair)).toBe(figures);
  expect(JSON.stringify(repair.messages)).not.toContain(RAW);
  expect(answerContent(result.body)).toContain(figures);
  expect(result.body).toMatchObject({ citations: [expect.anything()] });
  expect(answerContent(result.body)).toContain("KERD");
  expect(f.native.requests).toHaveLength(4);
});

it.each([
  {
    name: "GOLD project identity",
    report: false,
    altered:
      "Feature returns true [1].\n\nJira tool result: project GOLD is named Counterfeit project.",
  },
  {
    name: "KERD report facts",
    report: true,
    altered:
      "Feature returns true [1].\n\nJira tool result for KRED: Issues in the report: 99; done: 99.",
  },
  {
    name: "GOLD project identity after malformed annotation JSON",
    report: false,
    altered: "{",
  },
])("preserves this turn's $name when citation repair is invalid", async ({ report, altered }) => {
  const f = await fixture();
  f.native.report = report;
  f.script = report ? reportScript(altered) : script(CURRENT, false, altered);
  const result = await handleGroundedAsk(context(f, "golden-altered-repair"), f.deps);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expectSelection(f, report ? "jira_report" : "jira_projects");
  expect(f.script.answers).toHaveLength(2);
  const repair = f.script.answers[1];
  if (repair === undefined) throw new Error("Missing adversarial repair request");
  expect(repair.toolCatalog).toBeUndefined();
  const retained = report ? observedReportFigures(f) : CURRENT;
  expect(toolEvidence(repair)).toContain(report ? "KERD" : CURRENT);
  expect(answerContent(result.body)).toContain(retained);
  expect(JSON.stringify(result.body)).not.toContain("Counterfeit project");
  expect(JSON.stringify(result.body)).not.toContain("KRED");
  expect(JSON.stringify(result.body)).not.toContain("99; done: 99");
  expect(f.native.requests).toHaveLength(report ? 4 : 1);
});
