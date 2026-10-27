import type { MemoryId, ProjectId, UserId } from "@oscharko-dev/keiko-contracts/memory";
import { AtlassianActionApprovalRegistry } from "./atlassian/actionApprovals.js";
import { EditorAgentAuthorityRegistry } from "./editor/agentAuthorityRegistry.js";
import { createJiraChatCatalogRuntime } from "./atlassian/jiraChatCatalogRuntime.js";
import { projectChatReadGrant } from "./atlassian/chatReadGrantState.js";
import { processServerLogSink } from "./process-log-sink.js";
import { defaultServerDiagnosticSink } from "./diagnostics-log.js";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { handleSendDesktopChat } from "./chat-handlers.js";
import { handleSendDesktopChatStream } from "./chat-stream-handlers.js";
import { handleDecideChatWriteApproval } from "./atlassian/chatWriteApprovalRoutes.js";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
} from "@oscharko-dev/keiko-model-gateway";
import type {
  AtlassianHttpBodyPort,
  AtlassianCredentialMetadata,
} from "@oscharko-dev/keiko-connectors";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import type { RouteContext } from "./routes.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { handleDecideChatReadConsent } from "./atlassian/chatReadConsentRoutes.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "mixed-chat-proof";
const POD = "d5f5681e-ce98-4c3c-b27e-51d707c9d018";
const CITED =
  "Feature returns true [src/Feature.ts:1].\n\nJira tool result: project SYN is visible.";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Let the existing post-commit Memory owner run its scheduled work before closing the vault.
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const dispose of cleanup.splice(0)) await dispose();
  resetServerLogger();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["new-turn", "fresh-registries"] as const)(
  "reuses still-valid read consent for a real mixed Gateway call after %s",
  async (kind) => {
    const f = runtime();
    const original = approvalOwner(f.deps);
    const firstDecision = vi.spyOn(original, "waitForChatReadGrant");
    provider();
    const request = {
      chatId: f.chatId,
      content: "Read the feature and Jira projects.",
      modelId: MODEL,
    };
    expect((await handleGroundedAsk(context(request), f.deps)).status).toBe(200);
    expect(firstDecision).toHaveBeenCalledTimes(1);
    const first = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.readGrant;
    if (first === undefined) throw new Error("Missing consent projection");
    let deps = f.deps;
    if (kind === "fresh-registries") {
      original.dispose();
      deps = restartConsentGraph(deps);
    }
    const owner = approvalOwner(deps);
    const furtherDecision = vi
      .spyOn(owner, "waitForChatReadGrant")
      .mockRejectedValue(new Error("A valid Chat consent must not request another approval"));
    furtherDecision.mockClear();
    const requests = provider();
    const result = await handleGroundedAsk(context(request), deps);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(requests).toHaveLength(2);
    expect(f.jiraRequests).toEqual(["GET", "GET"]);
    expect(furtherDecision).not.toHaveBeenCalled();
    const retained = owner.getChatReadGrant(first.grantId);
    if (retained === undefined) throw new Error("Missing retained consent");
    expect(projectChatReadGrant(retained.grant)).toEqual(first);
    assertContinuedObservation(deps, f.chatId);
    if (kind === "fresh-registries") assertOriginAuthorityNotRestored(deps, retained);
    owner.dispose();
  },
);

function assertContinuedObservation(deps: UiHandlerDeps, chatId: string): void {
  const last = deps.store
    .listMessages(chatId)
    .filter((message) => message.role === "user")
    .at(-1);
  expect(last?.toolTranscript?.exchanges[0]?.result?.status).toBe("completed");
}

function assertOriginAuthorityNotRestored(
  deps: UiHandlerDeps,
  entry: import("./atlassian/chatReadGrantState.js").ChatReadGrantEntry,
): void {
  expect(
    deps.agentAuthorityRegistry?.resolveChat(
      entry.authority,
      entry.grant.subject,
      "autonomous-delivery",
      new Date().toISOString(),
    ).ok,
  ).toBe(false);
}

function approvalOwner(deps: UiHandlerDeps): AtlassianActionApprovalRegistry {
  if (deps.atlassianActionApprovalRegistry === undefined) throw new Error("Missing approval owner");
  return deps.atlassianActionApprovalRegistry;
}

function restartConsentGraph(deps: UiHandlerDeps): UiHandlerDeps {
  const next = {
    ...deps,
    agentAuthorityRegistry: new EditorAgentAuthorityRegistry(),
    atlassianActionApprovalRegistry: new AtlassianActionApprovalRegistry(
      Date.now,
      deps.store.chatToolReadGrants,
    ),
  };
  const catalog = createJiraChatCatalogRuntime(next, {
    primary: processServerLogSink(),
    diagnostics: defaultServerDiagnosticSink,
  });
  cleanup.push(() => catalog.close());
  return { ...next, jiraChatCatalog: catalog };
}

function context(body: Record<string, unknown>, approvalId?: string): RouteContext {
  return {
    req: mockRequest({ body: JSON.stringify(body) }),
    res: mockResponse().res,
    url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
    params: approvalId === undefined ? {} : { approvalId },
    correlationId: "mixed-chat-proof",
  };
}
function metadata(deps: UiHandlerDeps): AtlassianCredentialMetadata {
  const ownerDigest = jiraChatActorDigest(deps);
  if (ownerDigest === undefined) throw new Error("Missing operator");
  return {
    schemaVersion: "1",
    authRef: "synthetic-credential",
    displayName: "Synthetic Jira",
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
function runtime(
  mutation = false,
  deployment: Readonly<Record<string, string>> = {},
): {
  deps: UiHandlerDeps;
  chatId: string;
  root: string;
  jiraRequests: string[];
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mixed-chat-"));
  const state = mkdtempSync(join(realpathSync(tmpdir()), "keiko-mixed-state-"));
  vi.stubEnv("KEIKO_STATE_DIR", state);
  resetServerLogger();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "Feature.ts"), "export function Feature() { return true; }\n");
  const deps = buildUiHandlerDeps({
    configPath: join(state, "gateway.json"),
    evidenceDir: join(state, "evidence"),
    uiDbPath: join(state, "ui.db"),
    env: {
      ...deployment,
      KEIKO_STATE_DIR: state,
      [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
      [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(state, "spend.db"),
    },
  });
  cleanup.push(async () => {
    await deps.dispose?.();
    resetServerLogger();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  configure(deps);
  deps.store.createProject(root);
  const chat = deps.store.createChat(root, "Mixed Chat", MODEL);
  deps.store.updateChat(
    chat.id,
    {
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
      jiraPodId: POD,
    },
    { verifiedJiraPod: { podId: POD, authenticationGeneration: 1 } },
  );
  const credentials = deps.atlassianConnectorCredentials;
  const approvals = deps.atlassianActionApprovalRegistry;
  if (credentials === undefined || approvals === undefined) throw new Error("Missing owners");
  vi.spyOn(credentials.custody, "list").mockReturnValue([metadata(deps)]);
  const jiraRequests: string[] = [];
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlation, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        expect(lifecycle?.beforeDispatch?.(request)).toBe(true);
        jiraRequests.push(request.method);
        const status = request.method === "GET" ? 200 : 201;
        lifecycle?.onResponse?.(request, status);
        const bodyText = JSON.stringify(
          mutation
            ? { id: "10001", body: "Synthetic approved comment" }
            : [{ id: "10000", key: "SYN", name: "Synthetic Project" }],
        );
        return Promise.resolve({
          kind: "response",
          status,
          bodyText,
          bodyBytes: Buffer.byteLength(bodyText),
          truncated: false,
        });
      },
  );
  vi.spyOn(approvals, "waitForChatReadGrant").mockImplementation(async (id) => {
    const result = await handleDecideChatReadConsent(
      context({ decision: "approve", disclosureVersion: "jira-chat-read-v1" }, id),
      deps,
    );
    expect(result.status).toBe(200);
  });
  vi.spyOn(approvals, "waitForChatWriteApproval").mockImplementation(async (id) => {
    const entry = approvals.getChatWriteApproval(id);
    if (entry === undefined) throw new Error("Missing write approval");
    const result = await handleDecideChatWriteApproval(
      context({ decision: "approve", actionDigest: entry.approval.actionDigest }, id),
      deps,
    );
    expect(result.status).toBe(200);
  });
  return { deps, chatId: chat.id, root, jiraRequests };
}
function configure(deps: UiHandlerDeps): void {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://mixed.example.invalid/v1",
    apiKey: "fixture",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  const config = deps.gatewayConfig;
  if (config === undefined) throw new Error("Missing gateway");
  config.set(
    parseGatewayConfig({
      providers: [provider],
      groundedAnswers: { ownAssessment: "disabled" },
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
          maxOutputTokens: 1024,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
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
function outputCap(body: string): number {
  const request = JSON.parse(body) as {
    readonly max_tokens?: number;
    readonly max_completion_tokens?: number;
  };
  return request.max_tokens ?? request.max_completion_tokens ?? 0;
}
function isProductiveRequest(body: string): boolean {
  return (
    body.includes("File: src/Feature.ts") ||
    body.includes("Citations:") ||
    body.includes('"tools":') ||
    body.includes('"role":"tool"')
  );
}
function providerBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}
function isToolStep(body: string, step: ProviderStep): boolean {
  return body.includes('"tools":') && (step === "tool" || step === "write");
}
function responseContent(
  body: string,
  step: ProviderStep,
  steps: readonly ProviderStep[],
  answerContent?: string,
): string {
  if (answerContent !== undefined) return answerContent;
  return body.includes("Citations:")
    ? "Feature returns true [1]. Jira tool result: project SYN is visible."
    : finalContent(step, steps);
}
function finalContent(step: ProviderStep, steps: readonly ProviderStep[]): string {
  if (step === "uncited") return "Feature returns true.";
  return steps.includes("uncited") ? "Feature returns true [src/Feature.ts:1]." : CITED;
}
type ProviderStep = "tool" | "write" | "answer" | "uncited" | "overflow";
function provider(
  steps: readonly ProviderStep[] = ["tool", "answer"],
  answerContent?: string,
): string[] {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const body = providerBody(init);
      const productive = isProductiveRequest(body);
      const step = productive ? (steps[requests.length] ?? "answer") : "answer";
      if (productive) requests.push(body);
      if (step === "overflow")
        return Promise.resolve(
          Response.json(
            {
              error: {
                message: "max_tokens=1000000000 cannot be greater than max_model_len=8192.",
                code: "400",
              },
            },
            { status: 400 },
          ),
        );
      const tools = isToolStep(body, step);
      return Promise.resolve(
        Response.json({
          id: "mixed-response",
          model: MODEL,
          choices: [
            {
              index: 0,
              message: tools
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `mixed-call-${String(requests.length)}`,
                        type: "function",
                        function: {
                          name: step === "write" ? "jira_comment" : "jira_projects",
                          arguments:
                            step === "write"
                              ? JSON.stringify({
                                  issueKey: "KEIKO-1",
                                  body: "Synthetic approved comment",
                                })
                              : "{}",
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: responseContent(body, step, steps, answerContent),
                  },
              finish_reason: tools ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }),
  );
  return requests;
}

describe("mixed Jira and Data scope through the production gateway", () => {
  it("retrieves the existing evidence pack before Jira orchestration and preserves separate citations", async () => {
    const f = runtime();
    const requests = provider();
    const response = await handleGroundedAsk(
      context({
        chatId: f.chatId,
        content: "Explain src/Feature.ts and list the Jira projects.",
        modelId: MODEL,
      }),
      f.deps,
    );
    expect(response.status).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.includes("File: src/Feature.ts"))).toBe(true);
    expect(requests[0]).toContain('"tools":');
    expect(requests[1]).toContain('"role":"tool"');
    expect((response.body as GroundedAnswer).content).toContain("Jira tool result");
    expect(JSON.stringify((response.body as GroundedAnswer).citations)).not.toContain("jira");
    expect(
      f.deps.store.listMessages(f.chatId).find((message) => message.role === "user")?.toolTranscript
        ?.exchanges,
    ).toHaveLength(1);
  });
});

it("keeps tool orchestration outside the one answer plus one repair synthesis ceiling", async () => {
  const f = runtime();
  const requests = provider(["tool", "tool", "uncited", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(4);
  const caps = requests.map(outputCap);
  expect(caps.every((cap) => cap > 0)).toBe(true);
  expect(caps.slice(1).every((cap, index) => cap < (caps[index] ?? 0))).toBe(true);
  expect(f.jiraRequests).toEqual(["GET", "GET"]);
  expect((response.body as GroundedAnswer).content).toContain("[src/Feature.ts:1]");
});

it("charges physical overflow before a tool response and denies a third synthesis attempt", async () => {
  const f = runtime();
  const requests = provider(["overflow", "tool", "uncited", "answer"]);
  const response = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "Explain src/Feature.ts and list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(3);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect((response.body as GroundedAnswer).content).not.toContain("Jira tool result");
});

it.each(["answer", "uncited"] as const)(
  "retains a committed mutation across context overflow and bounded %s synthesis",
  async (answer) => {
    const f = runtime(true);
    const requests = provider(["write", "overflow", answer, "answer"]);
    const body = {
      chatId: f.chatId,
      projectPath: f.root,
      content: "Explain src/Feature.ts and add the Jira comment.",
      modelId: MODEL,
      clientTurnId: `mixed-write-overflow-${answer}`,
    };
    const response = await handleSendDesktopChat(context(body), f.deps);
    expect(response.status).toBe(200);
    // The overflow and its physical retry spend both synthesis attempts. An uncited retry
    // cannot reset that meter by requesting a fourth provider call for citation repair.
    expect(requests).toHaveLength(3);
    expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
    const messages = f.deps.store.listMessages(f.chatId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.turnState).toBe("completed");
    expect(messages[0]?.toolTranscript?.exchanges).toHaveLength(1);
    expect(messages[0]?.toolTranscript?.exchanges[0]).toMatchObject({
      call: { id: "mixed-call-1", name: "jira_comment" },
      mutationOutcome: "succeeded",
      result: { status: "completed" },
    });
    for (const request of requests.slice(1)) {
      expect(request).toContain('"id":"mixed-call-1"');
      expect(request).toContain('"tool_call_id":"mixed-call-1"');
      expect(request).toContain('"role":"tool"');
    }
    expect(outputCap(requests[1] ?? "{}")).toBeLessThan(outputCap(requests[0] ?? "{}"));
    expect(outputCap(requests[2] ?? "{}")).toBeLessThanOrEqual(outputCap(requests[1] ?? "{}"));
    expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
    expect(f.deps.store.listMessages(f.chatId)).toEqual(messages);
  },
);

it("falls back before admission and replays the same mixed canonical turn without a second write", async () => {
  const f = runtime(true);
  const requests = provider(["write", "answer"]);
  const body = {
    chatId: f.chatId,
    projectPath: f.root,
    content: "Explain src/Feature.ts and add the Jira comment.",
    modelId: MODEL,
    clientTurnId: "mixed-once",
  };
  const stream = await handleSendDesktopChatStream(context(body), f.deps);
  expect(stream).toMatchObject({ status: 400, body: { error: { code: "STREAMING_UNSUPPORTED" } } });
  expect(requests).toHaveLength(0);
  expect(f.jiraRequests).toHaveLength(0);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(0);
  const response = await handleSendDesktopChat(context(body), f.deps);
  expect(response.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  const messages = f.deps.store.listMessages(f.chatId);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.toolTranscript?.exchanges[0]?.mutationOutcome).toBe("succeeded");
  expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(2);
});

async function connectDataPod(
  f: ReturnType<typeof runtime>,
  text: string,
  keepFolder = false,
): Promise<void> {
  const store = openKnowledgeStore({
    dbPath: resolveKnowledgeStorePath({ runtimeStateDir: dirname(f.deps.uiDbPath ?? "") }),
  });
  try {
    const pod = await seedCapsuleWithVectors(store, { displayName: "Synthetic Data Pod", text });
    updateCapsuleState(store, pod.capsuleId, "ready");
    f.deps.store.updateChat(f.chatId, {
      ...(keepFolder ? {} : { connectedScope: null }),
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

it("uses the existing local Data-Pod evidence pack with Jira and keeps its numeric citations", async () => {
  const f = runtime();
  await connectDataPod(f, "Feature returns true. Feature is a function.");
  const requests = provider();
  const result = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "What does Feature return? Also list Jira projects.",
      modelId: MODEL,
    }),
    f.deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.jiraRequests).toEqual(["GET"]);
  expect(requests).toHaveLength(2);
  const answer = result.body as GroundedAnswer;
  expect(answer.groundingKind).toBe("local-knowledge");
  expect(answer.content).toContain("Jira tool result");
  expect(answer.citations).toHaveLength(1);
  expect(JSON.stringify(answer.citations)).not.toContain("jira");
});

it("preserves Data-only desktop refusal and tool-free grounded synthesis", async () => {
  const f = runtime();
  f.deps.store.updateChat(f.chatId, { jiraPodId: null });
  const requests = provider(["answer"]);
  const body = {
    chatId: f.chatId,
    projectPath: f.root,
    content: "Explain src/Feature.ts",
    modelId: MODEL,
  };
  expect((await handleSendDesktopChat(context(body), f.deps)).status).toBe(409);
  expect(f.deps.store.listMessages(f.chatId)).toHaveLength(0);
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain('"tools":');
  expect(f.jiraRequests).toHaveLength(0);
});

it.each(["empty", "unmatched"] as const)(
  "executes permitted Jira reads after %s folder evidence without creating Data citations",
  async (source) => {
    const f = runtime();
    if (source === "empty") rmSync(join(f.root, "src"), { recursive: true });
    else {
      writeFileSync(join(f.root, "empty.txt"), "");
      f.deps.store.updateChat(f.chatId, {
        connectedScope: { kind: "files", relativePaths: ["empty.txt"], connectedAtMs: 0 },
      });
    }
    const requests = provider(["tool", "answer"], "Jira tool result: project SYN is visible.");
    const response = await handleGroundedAsk(
      context({ chatId: f.chatId, content: "List the Jira projects.", modelId: MODEL }),
      f.deps,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    const answer = response.body as GroundedAnswer;
    expect(answer.content).toContain("Jira tool result");
    expect(answer.citations).toEqual([]);
    expect(answer.evidenceRunId).toBeUndefined();
  },
);

it("keeps exact write approval and one remote effect when the connected folder has no evidence", async () => {
  const f = runtime(true);
  rmSync(join(f.root, "src"), { recursive: true });
  const requests = provider(["write", "answer"], "Jira tool result: the comment was added.");
  const body = {
    chatId: f.chatId,
    content: "Add the synthetic Jira comment.",
    modelId: MODEL,
    clientTurnId: "empty-data-write",
  };
  const response = await handleGroundedAsk(context(body), f.deps);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(requests).toHaveLength(2);
  expect((response.body as GroundedAnswer).citations).toEqual([]);
  const approval = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval;
  expect(approval).toBeDefined();
  expect(
    f.deps.atlassianActionApprovalRegistry?.getChatWriteApproval(approval?.approvalId ?? "")
      ?.approval.state,
  ).toBe("claimed");
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
});

it.each([false, true])(
  "answers Jira from an empty Data-Pod pack with hybrid=%s and no false Memory attribution",
  async (hybrid) => {
    const f = runtime();
    rmSync(join(f.root, "src"), { recursive: true });
    await connectDataPod(f, "Orchids grow in violet garden beds.", hybrid);
    const requests = provider(["tool", "answer"], "Jira tool result: project SYN is visible.");
    const response = await handleGroundedAsk(
      context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
      f.deps,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    const answer = response.body as GroundedAnswer;
    expect(answer.content).toContain("Jira tool result");
    expect(answer.citations).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain("answer-only-memory");
    expect(answer.memory).toBeUndefined();
  },
);

it("abstains when a tool-only empty-pack model invents an answer without invoking Jira", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const requests = provider(["answer"], "Invented Jira source fact.");
  const result = await handleGroundedAsk(
    context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
    f.deps,
  );
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(f.jiraRequests).toEqual([]);
  expect((result.body as GroundedAnswer).content).not.toContain("Invented");
  expect((result.body as GroundedAnswer).citations).toEqual([]);
});

it.each([403, 200])(
  "requires successful published Jira evidence after HTTP %s, including empty lists",
  async (status) => {
    const f = runtime();
    rmSync(join(f.root, "src"), { recursive: true });
    jiraHttpResult(f, status, status === 200 ? [] : {});
    const answer =
      status === 200
        ? "The connected Jira contains no projects."
        : "Invented Jira fact: project SYN was released.";
    const requests = provider(["tool", "answer"], answer);
    const result = await handleGroundedAsk(
      context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
      f.deps,
    );
    expect(result.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(f.jiraRequests).toEqual(["GET"]);
    const content = (result.body as GroundedAnswer).content;
    if (status === 200) expect(content).toBe(answer);
    else expect(content).not.toContain("Invented Jira fact");
    expect((result.body as GroundedAnswer).citations).toEqual([]);
    expect(
      f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.result?.status,
    ).toBe(status === 200 ? "completed" : "failed");
  },
);

function jiraHttpResult(f: ReturnType<typeof runtime>, status: number, body: unknown): void {
  const credentials = f.deps.atlassianConnectorCredentials;
  if (credentials === undefined) throw new Error("Missing HTTP owner");
  vi.spyOn(credentials, "httpBodyPortFactory").mockImplementation(
    (_metadata, _correlation, lifecycle) =>
      (request): ReturnType<AtlassianHttpBodyPort> => {
        expect(lifecycle?.beforeDispatch?.(request)).toBe(true);
        f.jiraRequests.push(request.method);
        lifecycle?.onResponse?.(request, status);
        const bodyText = JSON.stringify(body);
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

it("keeps an acknowledged but unconfirmed mixed write in its card without factual synthesis or replay", async () => {
  const f = runtime(true);
  rmSync(join(f.root, "src"), { recursive: true });
  jiraHttpResult(f, 201, {});
  const requests = provider(
    ["write", "answer"],
    "Invented confirmation: the comment was definitely added.",
  );
  const body = {
    chatId: f.chatId,
    content: "Add a Jira comment.",
    modelId: MODEL,
    clientTurnId: "unconfirmed-mixed-write",
  };
  const result = await handleGroundedAsk(context(body), f.deps);
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect((result.body as GroundedAnswer).content).not.toContain("Invented confirmation");
  const exchange = f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0];
  expect(exchange?.mutationOutcome).toBe("succeeded-unconfirmed");
  expect(f.jiraRequests).toEqual(["POST"]);
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(f.jiraRequests).toEqual(["POST"]);
});

it("retains Data-only empty-pack abstention and the missing selected path denial", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const requests = provider();
  f.deps.store.updateChat(f.chatId, {
    connectedScope: { kind: "files", relativePaths: ["src/Missing.ts"], connectedAtMs: 0 },
  });
  const body = { chatId: f.chatId, content: "List Jira projects.", modelId: MODEL };
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(400);
  f.deps.store.updateChat(f.chatId, {
    jiraPodId: null,
    connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 0 },
  });
  expect((await handleGroundedAsk(context(body), f.deps)).status).toBe(200);
  expect(requests).toEqual([]);
  expect(f.jiraRequests).toEqual([]);
});

it("rejects a bound mixed model without verified tool capability before any provider or Jira effect", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const config = f.deps.gatewayConfig;
  const current = config?.current();
  if (config === undefined || current === undefined) throw new Error("Missing gateway");
  config.set(
    parseGatewayConfig({
      ...current,
      capabilities: current.capabilities?.map((capability) =>
        capability.kind === "chat"
          ? { ...capability, toolCallingVerification: undefined }
          : capability,
      ),
    }),
    true,
  );
  config.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    config.generation(),
  );
  const requests = provider();
  const result = await handleGroundedAsk(
    context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
    f.deps,
  );
  expect(result).toMatchObject({
    status: 400,
    body: { error: { code: "CONVERSATION_UNAVAILABLE_MODEL" } },
  });
  expect(JSON.stringify(result.body)).toContain("verified tool calling");
  expect(requests).toEqual([]);
  expect(f.jiraRequests).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps Memory capture governed when an empty-pack Jira turn has Full access", async () => {
  const f = runtime(true);
  rmSync(join(f.root, "src"), { recursive: true });
  f.deps.store.updateChat(f.chatId, { toolMode: "autonomous-delivery" });
  provider(["write", "answer"], "Jira tool result: the comment was added.");
  const result = await handleGroundedAsk(
    context({
      chatId: f.chatId,
      content: "remember that release checks use vitest. Add the Jira comment.",
      modelId: MODEL,
      memory: {
        enabled: true,
        budgetTokens: 1200,
        mode: "autonomous-delivery",
        context: {
          userId: "local-operator",
          workspaceId: f.root,
          projectId: f.root,
          conversationId: f.chatId,
        },
      },
    }),
    { ...f.deps, memoryDeploymentCeiling: "governed-assist" },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(f.jiraRequests.filter((method) => method !== "GET")).toEqual(["POST"]);
  expect(
    f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.approval,
  ).toBeUndefined();
  const vault = f.deps.memoryVault;
  if (vault === undefined) throw new Error("Missing Memory vault");
  const memories = vault.listMemoriesAcrossScopes(vault.listMemoryScopes());
  expect(memories.length).toBeGreaterThan(0);
  expect(memories.every((memory) => memory.status === "proposed")).toBe(true);
  expect((result.body as GroundedAnswer).memory?.context.memories).toEqual([]);
});

it("abstains from fabricated Jira facts after refused consent with empty Data evidence", async () => {
  const f = runtime();
  rmSync(join(f.root, "src"), { recursive: true });
  const registry = f.deps.atlassianActionApprovalRegistry;
  if (registry === undefined) throw new Error("Missing approval owner");
  vi.spyOn(registry, "waitForChatReadGrant").mockImplementation(async (id) => {
    expect(
      (
        await handleDecideChatReadConsent(
          context({ decision: "reject", disclosureVersion: "jira-chat-read-v1" }, id),
          f.deps,
        )
      ).status,
    ).toBe(200);
  });
  const requests = provider(["tool", "answer"], "Invented Jira fact: project SYN was released.");
  const result = await handleGroundedAsk(
    context({ chatId: f.chatId, content: "List Jira projects.", modelId: MODEL }),
    f.deps,
  );
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(f.jiraRequests).toEqual([]);
  expect((result.body as GroundedAnswer).content).not.toContain("Invented Jira fact");
  expect((result.body as GroundedAnswer).citations).toEqual([]);
  expect(f.deps.store.listMessages(f.chatId)[0]?.toolTranscript?.exchanges[0]?.result?.status).toBe(
    "denied",
  );
});

it.each(["disabled", "outside-scope"] as const)(
  "does not attach %s Memory when Jira enables an empty-evidence answer",
  async (kind) => {
    const f = runtime();
    rmSync(join(f.root, "src"), { recursive: true });
    const vault = f.deps.memoryVault;
    if (vault === undefined) throw new Error("Missing Memory vault");
    const canary = "PRIVATE_MEMORY_CANARY_RESERVED_TO_ANOTHER_SOURCE";
    vault.insertMemory({
      id: "isolated-memory" as MemoryId,
      schemaVersion: "1",
      scope:
        kind === "disabled"
          ? { kind: "user", userId: "local-operator" as UserId }
          : { kind: "project", projectId: "another-project" as ProjectId },
      type: "preference",
      body: canary,
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1,
        confidence: 1,
        sensitivity: "public",
      },
      validity: { validFrom: 1 },
      status: "accepted",
      pinned: true,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    });
    const requests = provider(["tool", "answer"], "Jira tool result: project SYN is visible.");
    const result = await handleGroundedAsk(
      context({
        chatId: f.chatId,
        content: "List Jira projects.",
        modelId: MODEL,
        memory: {
          enabled: kind !== "disabled",
          budgetTokens: 1200,
          mode: "autonomous-delivery",
          context: {
            userId: "local-operator",
            workspaceId: f.root,
            projectId: f.root,
            conversationId: f.chatId,
          },
        },
      }),
      { ...f.deps, memoryDeploymentCeiling: "governed-assist" },
    );
    expect(result.status).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests.join(" ")).not.toContain(canary);
    expect((result.body as GroundedAnswer).memory?.context.memories).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain(canary);
  },
);

it.each(["default", "preserve"] as const)(
  "keeps %s document policy and the credential floor across real mixed Jira rounds",
  async (policy) => {
    const secret = "synthetic-configured-infrastructure-value";
    const phone = "+49 30 12345678";
    const f = runtime(false, {
      KEIKO_DEFAULT_API_KEY: secret,
      ...(policy === "preserve" ? { KEIKO_CONTENT_REDACTION: "off" } : {}),
    });
    writeFileSync(
      join(f.root, "src", "Feature.ts"),
      [
        "export function Feature() { return true; }",
        `// Contact: ${phone}`,
        `// Infrastructure credential: ${secret}`,
        "",
      ].join("\n"),
    );
    const requests = provider(
      ["tool", "answer"],
      `${CITED} Contact: ${phone}; credential: ${secret}`,
    );
    const result = await handleGroundedAsk(
      context({
        chatId: f.chatId,
        content: "Explain src/Feature.ts and list Jira projects.",
        modelId: MODEL,
      }),
      f.deps,
    );
    expect(result.status).toBe(200);
    expect(f.jiraRequests).toEqual(["GET"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.includes(phone))).toBe(policy === "preserve");
    expect(requests.every((request) => !request.includes(secret))).toBe(true);
    const answer = result.body as GroundedAnswer;
    expect(answer.content.includes(phone)).toBe(policy === "preserve");
    expect(answer.content).not.toContain(secret);
    const stored = f.deps.store.listMessages(f.chatId);
    expect(stored.find((message) => message.role === "assistant")?.content.includes(phone)).toBe(
      policy === "preserve",
    );
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(answer.citations)).not.toContain("jira");
  },
);
