import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultChatCapability,
  createGatewayToolCatalogBridge,
  parseGatewayConfig,
  toolCallingConfigurationFingerprint,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { compileToolProjection, createKeikoToolCatalog } from "@oscharko-dev/keiko-tool-catalog";
import {
  NATIVE_TOOL_CATALOG_RUNTIME,
  type CatalogJsonObject,
  type ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { ChatToolTurn, type ChatToolTurnOptions } from "./chat-tool-turn.js";
import { podFixture, type PodFixture } from "./_requirementSupport.js";
import { probeVerifiedGatewayConfig } from "./_support.js";
import { createKnowledgeDocumentsTool } from "./knowledgeDocumentsTool.js";
import { jiraOperationForTool } from "./atlassian/jiraManagedProvider.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import {
  jiraChatCatalogConsumerPort,
  jiraChatCatalogRoutes,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
} from "./atlassian/jiraChatCatalogConsumer.js";
import { createCatalogToolBinder } from "./tool-catalog/catalogToolDispatch.js";
import type { CatalogToolHandlerBinding } from "./tool-catalog/catalogToolPorts.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const MODEL = "synthetic-turn-coverage";
const CORRELATION = "synthetic-turn-coverage";
const fixtures: PodFixture[] = [];
const CREATE_ARGS: CatalogJsonObject = {
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "Create the explicitly named synthetic task" },
};
const CREATE_RESULT: CatalogJsonObject = {
  outcome: "succeeded",
  issueId: "10002",
  issueKey: "SYN-1",
};
const INVENTORY_RESULT: CatalogJsonObject = {
  outcome: "succeeded",
  view: "inventory",
  totals: { documentCount: 3 },
  items: [],
  coverage: { inventoryComplete: false, atEnd: false },
  nextCursor: "synthetic-inventory-next",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
});
afterEach(() => {
  try {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  } finally {
    resetServerLogger();
    vi.useRealTimers();
  }
});

class CoverageTurn extends ChatToolTurn<JiraChatCatalogContext> {
  static create(options: ChatToolTurnOptions<JiraChatCatalogContext>): CoverageTurn {
    return new CoverageTurn(options);
  }
  protected override reserveAuthorityPrompt(): boolean {
    return true;
  }
  protected override observedMutation(
    call: NormalizedResponse["toolCalls"][number],
    _identity: string,
    result: ToolResultEnvelope,
  ): ChatToolExchange["mutationOutcome"] {
    return call.invocation?.toolRef.canonicalId === "keiko.jira.create" &&
      result.status === "completed"
      ? "succeeded"
      : undefined;
  }
}

function gateway(): ReturnType<typeof probeVerifiedGatewayConfig> {
  const provider = {
    modelId: MODEL,
    baseUrl: "https://model.example.invalid/v1",
    apiKey: "synthetic-unused",
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  return probeVerifiedGatewayConfig(
    parseGatewayConfig({
      providers: [provider],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
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
  );
}

function catalog(
  pod: PodFixture,
  executed: string[],
): {
  readonly catalog: ReturnType<typeof createKeikoToolCatalog>;
  readonly projection: ReturnType<typeof compileToolProjection>;
  readonly handlers: readonly CatalogToolHandlerBinding<JiraChatCatalogConsumer>[];
} {
  const createOperation = jiraOperationForTool("jira.create");
  if (createOperation === undefined) throw new TypeError("Missing production create operation");
  const declarations = [createKnowledgeDocumentsTool(pod.deps), createOperation.declaration];
  const routes = jiraChatCatalogRoutes(["knowledge.documents", "jira.create"]);
  const entries = routes.map((route) => {
    const declaration = declarations.find((entry) => entry.name === route.name);
    if (declaration === undefined) throw new TypeError("Missing production declaration");
    const descriptor = declaration.descriptor;
    const handler: CatalogToolHandlerBinding<JiraChatCatalogConsumer> = {
      toolRef: descriptor.toolRef,
      descriptorDigest: descriptor.descriptorDigest,
      handlerId: descriptor.handlerRequirement.id,
      handlerVersion: descriptor.handlerRequirement.contractVersion,
      catalogAction: route.catalogAction,
      readiness: () => "ready",
      previewAction: route.previewAction,
      actionFor: route.actionFor,
      execute: (_args, context) => {
        if (!context.beforeEffect()) throw new TypeError("Synthetic effect refused");
        executed.push(route.name);
        const data =
          route.name === "jira.create"
            ? { ...CREATE_RESULT, operationBinding: createOperation.binding }
            : INVENTORY_RESULT;
        return Promise.resolve(route.resultFor(data, context));
      },
    };
    return { alias: route.alias, descriptor, handler };
  });
  const profile = { id: "coverage-fixture", version: 1 };
  const value = createKeikoToolCatalog([
    {
      profile,
      adapterDialect: { id: "gateway-json-schema", version: 1 },
      adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
      entries: entries.map(({ alias, descriptor }) => ({ alias, descriptor })),
    },
  ]);
  return {
    catalog: value,
    projection: compileToolProjection(value, profile),
    handlers: entries.map((entry) => entry.handler),
  };
}

function contextFor(chatId: string, userMessageId: string): JiraChatCatalogContext {
  return {
    runId: "synthetic-coverage-run",
    correlationId: CORRELATION,
    chatId,
    userMessageId,
    authority: "synthetic-coverage-authority",
    authorityReference: { runId: "synthetic-coverage-run", envelopeDigest: "a".repeat(64) },
    deadlineAt: new Date(60000).toISOString(),
    authorityExpiresAt: new Date(60000).toISOString(),
    signal: new AbortController().signal,
  };
}

async function fixture(): Promise<{
  readonly turn: CoverageTurn;
  readonly executed: string[];
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly exchanges: () => readonly ChatToolExchange[];
}> {
  const pod = await podFixture([{ capsuleId: "coverage-pod", text: "Synthetic attached source." }]);
  fixtures.push(pod);
  const message = pod.deps.store.createMessage({
    chatId: pod.chatId,
    role: "user",
    content: "Create the explicitly named task.",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  const executed: string[] = [];
  const managed = catalog(pod, executed);
  const sink = createBufferedServerLogSink();
  const diagnostics: ServerDiagnosticRecord[] = [];
  const diagnosticSink = {
    record: (entry: ServerDiagnosticRecord): void => {
      diagnostics.push(entry);
    },
  };
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  let serial = 0;
  const turn = CoverageTurn.create({
    deps: { ...pod.deps, gatewayConfig: gateway(), activityLog: sink, diagnostics: diagnosticSink },
    message,
    context: contextFor(pod.chatId, message.id),
    managed,
    correlationId: CORRELATION,
    budget: { maxRuntimeMs: 59000, maxToolCalls: 6, maxPromptTokens: 100000, maxPatchBytes: 0 },
    bind: (context, budgetPort, invocationRegistry) =>
      createCatalogToolBinder<JiraChatCatalogConsumer>(
        {
          consumerPort: jiraChatCatalogConsumerPort,
          projection: managed.projection,
          handlerBindings: managed.handlers,
          authorityPort: {
            preview: () => ({ ok: true }),
            admit: () => ({ ok: true, mutationGuard: { check: (): boolean => true } }),
          },
          approvalPort: { available: () => false, request: () => Promise.resolve(undefined) },
          budgetPort,
          logPort: { primary: sink, diagnostics: diagnosticSink },
        },
        {
          catalog: managed.catalog,
          context: () => context,
          now: Date.now,
          mintId: () => `coverage-invocation-${String(++serial)}`,
          invocationRegistry,
        },
      ),
  });
  return {
    turn,
    executed,
    sink,
    diagnostics,
    exchanges: () => pod.deps.store.findMessageById(message.id)?.toolTranscript?.exchanges ?? [],
  };
}

function answer(): NormalizedResponse {
  return {
    modelId: MODEL,
    content: "The requested operation is settled.",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "synthetic-coverage-response",
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 1,
      costClass: "low",
    },
  };
}

type Step = "jira_create" | "knowledge_documents";
function model(steps: readonly Step[], requests: GatewayCallRequest[]): ModelPort {
  return {
    call: (request): Promise<NormalizedResponse> => {
      requests.push(request);
      const step = steps[requests.length - 1];
      if (step === undefined) return Promise.resolve(answer());
      const bridge = createGatewayToolCatalogBridge(request, Date.now);
      return Promise.resolve({
        ...answer(),
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          bridge.bind({
            id: `model-coverage-${String(requests.length)}`,
            name: step,
            arguments: step === "jira_create" ? CREATE_ARGS : { view: "inventory" },
          }),
        ],
      });
    },
  };
}

interface Scenario {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly executed: readonly string[];
  readonly rounds: number;
  readonly corrected: boolean;
}
describe("ChatToolTurn incidental inventory coverage (#4321)", () => {
  it.each<Scenario>([
    {
      name: "runtime inventory and named creation",
      steps: ["jira_create"],
      executed: ["knowledge.documents", "jira.create"],
      rounds: 2,
      corrected: false,
    },
    {
      name: "runtime inventory without creation",
      steps: [],
      executed: ["knowledge.documents"],
      rounds: 2,
      corrected: true,
    },
    {
      name: "model inventory and named creation",
      steps: ["knowledge_documents", "jira_create"],
      executed: ["knowledge.documents", "knowledge.documents", "jira.create"],
      rounds: 4,
      corrected: true,
    },
  ])("preserves the exact correction boundary for $name", async (scenario) => {
    const f = await fixture();
    const requests: GatewayCallRequest[] = [];
    const response = await f.turn.call(
      model(scenario.steps, requests),
      {
        modelId: MODEL,
        messages: [{ role: "user", content: "Complete the selected operation." }],
        maxOutputTokens: 100,
      },
      new AbortController().signal,
    );
    expect(
      response.content,
      JSON.stringify({
        diagnostics: f.diagnostics.map((entry) => ({
          operation: entry.operation,
          errorClass: entry.errorClass,
          code: entry.code,
          frames: entry.frames,
        })),
        ended: f.sink.events.filter((event) => event.op === "chat.tool-turn.ended"),
      }),
    ).toBe(answer().content);
    expect(f.diagnostics).toEqual([]);
    expect(requests).toHaveLength(scenario.rounds);
    expect(f.executed).toEqual(scenario.executed);
    const exchanges = f.exchanges();
    expect(exchanges).toHaveLength(scenario.executed.length);
    expect(exchanges.every((exchange) => exchange.result?.status === "completed")).toBe(true);
    expect(exchanges[0]?.call.arguments).toEqual({ view: "inventory" });
    expect(exchanges[0]?.result?.data).toEqual(INVENTORY_RESULT);
    const corrected = f.sink.events.filter((event) => event.op === "chat.tool-turn.corrected");
    expect(corrected).toHaveLength(scenario.corrected ? 1 : 0);
    for (const event of corrected) {
      expect(
        expectActivityLogProof("chat.tool-turn.corrected.line", formatActivityLogProofLine(event)),
      ).toMatchObject({
        correctionKind: "knowledge-coverage",
        pendingKnowledgePageCount: 1,
        settledExchangeCount: scenario.executed.length,
        completeness: "complete",
        loss: "none",
      });
    }
    const coverage = f.sink.events.filter((event) => event.op === "knowledge.documents.operation");
    expect(coverage).toHaveLength(1);
    for (const event of coverage) {
      expect(
        expectActivityLogProof(
          "knowledge.documents.operation.line",
          formatActivityLogProofLine(event),
        ),
      ).toMatchObject({
        operation: "coverage",
        documentCount: 3,
        pendingPageCount: scenario.corrected ? 1 : 0,
      });
    }
  });
});
