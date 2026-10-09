import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import { splitOwnAssessment } from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import { createInMemoryEvidenceStore, loadEvidence } from "@oscharko-dev/keiko-evidence";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
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
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { formatActivityLogProofLine } from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

const MODEL = "general-knowledge-authority-proof";
const GENERAL =
  "<assessment>Compare the benefits and tradeoffs. This is general learned knowledge, without live verification.</assessment>";
const TOPOLOGIES = ["single", "plural", "pod", "hybrid"] as const;
type Topology = (typeof TOPOLOGIES)[number];
type ScriptedAnswer = string | ((request: GatewayCallRequest) => string);
const cleanups: (() => void)[] = [];

afterEach(() => {
  resetServerLogger();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scriptedModel(
  calls: GatewayCallRequest[],
  responses: readonly ScriptedAnswer[],
): ModelPort {
  let synthesisIndex = 0;
  return {
    call(request): ReturnType<ModelPort["call"]> {
      calls.push(request);
      const scripted = request.messages[0]?.content.startsWith("Rewrite broad retrieval questions")
        ? '{"queries":[]}'
        : (responses[synthesisIndex++] ?? responses.at(-1) ?? GENERAL);
      const content = typeof scripted === "string" ? scripted : scripted(request);
      return Promise.resolve({
        modelId: MODEL,
        content,
        toolCalls: [],
        structuredOutput: null,
        finishReason: "stop",
        usage: {
          requestId: "general-knowledge-proof",
          promptTokens: 1,
          completionTokens: 1,
          latencyMs: 1,
          costClass: "medium",
        },
      });
    },
  };
}

interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
  readonly calls: GatewayCallRequest[];
  readonly directory: string;
}

function seedFolders(directory: string, empty: boolean): readonly string[] {
  const roots = ["alpha", "beta"].map((name) => join(directory, name));
  for (const root of roots) {
    mkdirSync(join(root, "src"), { recursive: true });
    if (!empty) writeFileSync(join(root, "src/Feature.ts"), "export const Feature = true;\n");
  }
  return roots;
}

async function fixture(
  topology: Topology,
  responses: readonly ScriptedAnswer[],
  options: {
    readonly disabled?: boolean;
    readonly empty?: boolean;
    readonly compact?: boolean;
  } = {},
): Promise<Fixture> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-general-authority-")));
  vi.stubEnv("KEIKO_STATE_DIR", join(directory, "state"));
  const config = parseGatewayConfig({
    providers: [
      { modelId: MODEL, baseUrl: "https://general.example.invalid/v1", apiKey: "fixture" },
    ],
    capabilities: [
      {
        ...createDefaultChatCapability(MODEL),
        contextWindow: options.compact ? 8192 : 32768,
        maxOutputTokens: 1024,
      },
    ],
    ...(options.disabled ? { groundedAnswers: { ownAssessment: "disabled" } } : {}),
  });
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const roots = seedFolders(directory, options.empty === true);
  const root = roots[0];
  if (root === undefined) throw new TypeError("Missing fixture root");
  store.createProject(root, "General knowledge authority");
  const chat = store.createChat(root, "General knowledge authority", MODEL);
  if (topology !== "pod")
    store.updateChat(chat.id, {
      connectedScopes: roots.slice(0, topology === "plural" ? 2 : 1).map((folder) => ({
        kind: "directory",
        root: folder,
        relativePaths: ["src"],
        connectedAtMs: 1,
      })),
    });
  const calls: GatewayCallRequest[] = [];
  const model = scriptedModel(calls, responses);
  const deps: UiHandlerDeps = {
    config,
    configPresent: true,
    env: {},
    uiDbPath: join(directory, "state/ui.db"),
    store,
    redactor: buildRedactor({}, config),
    registry: createRunRegistry(),
    evidenceStore: createInMemoryEvidenceStore(),
    modelPortFactory: () => model,
  };
  if (topology === "pod" || topology === "hybrid") await connectPod(deps, chat.id);
  if (options.compact) seedLongHistory(deps, chat.id);
  return { deps, chatId: chat.id, calls, directory };
}

function seedLongHistory(deps: UiHandlerDeps, chatId: string): void {
  for (let index = 0; index < 80; index += 1)
    deps.store.createMessage({
      chatId,
      role: index % 2 === 0 ? "user" : "assistant",
      content:
        "Discuss general engineering tradeoffs and preserve the selected source authority. ".repeat(
          40,
        ),
      timestamp: Date.now() - 100000 + index,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
}

async function connectPod(deps: UiHandlerDeps, chatId: string): Promise<void> {
  const runtimeStateDir = dirname(deps.uiDbPath ?? "");
  const store = openKnowledgeStore({ dbPath: resolveKnowledgeStorePath({ runtimeStateDir }) });
  try {
    const pod = await seedCapsuleWithVectors(store, {
      displayName: "General knowledge authority",
      text: "Feature is true. This source explains Feature.",
    });
    updateCapsuleState(store, pod.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

async function ask(setup: Fixture, content: string): Promise<GroundedAnswer> {
  const result = await handleGroundedAsk(
    {
      params: {},
      correlationId: "general-knowledge-public",
      url: new URL("http://localhost/api/chats/messages/grounded"),
      req: mockRequest({ body: JSON.stringify({ chatId: setup.chatId, content }) }),
      res: mockResponse().res,
    },
    setup.deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as GroundedAnswer;
}

function synthesisCalls(setup: Fixture): readonly GatewayCallRequest[] {
  return setup.calls.filter(
    (request) => !request.messages[0]?.content.startsWith("Rewrite broad retrieval questions"),
  );
}

function sourceCitationCount(answer: GroundedAnswer): number {
  return (
    answer.citations.length +
    (answer.groundingKind === "hybrid" ? answer.knowledgeCitations.length : 0)
  );
}

function sourcedFolderResponse(topology: Topology): ScriptedAnswer {
  return (request): string => {
    const messages = request.messages.map((message) => message.content).join("\n");
    const hybridMarker = /\[(\d+)\] ### Folder source:/u.exec(messages)?.[1];
    if (topology === "hybrid" && hybridMarker === undefined)
      throw new TypeError("Missing actual sent folder marker");
    const marker =
      topology === "hybrid"
        ? `[${hybridMarker ?? ""}]`
        : topology === "plural"
          ? "[source:1|src/Feature.ts:1]"
          : "[src/Feature.ts:1]";
    return `Feature is false ${marker}.`;
  };
}

function assertAssessmentOnly(answer: GroundedAnswer): void {
  expect(splitOwnAssessment(answer.content).assessment).toContain("Compare the benefits");
  expect(sourceCitationCount(answer)).toBe(0);
  if (answer.groundingKind === "connected-context" || answer.groundingKind === "hybrid")
    expect(answer.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(false);
  expect(
    answer.uncertainty.some(
      (marker) => marker.kind === "no-evidence" || marker.kind === "low-confidence-selection",
    ),
  ).toBe(false);
}

describe("learned knowledge uses the existing assessment authority across connected sources", () => {
  it.each(["plural", "hybrid"] as const)(
    "binds final accepted assessment evidence to each actual retrieved folder in %s",
    async (topology) => {
      const setup = await fixture(topology, [GENERAL]);
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      assertAssessmentOnly(await ask(setup, "How should a team compare alternatives?"));
      const accepted = sink.events.filter(
        (event) => event.op === "search.answer.assessed" && event.extra?.phase === "accepted-final",
      );
      expect(accepted).toHaveLength(topology === "plural" ? 2 : 1);
      const retrieved = new Set(
        sink.events
          .filter((event) => event.op.startsWith("search.connected-context."))
          .map((event) => event.extra?.scopeIdentitySha256),
      );
      for (const event of accepted) {
        expect(event.extra).toMatchObject({
          policy: "allowed",
          outcome: "assessment-only",
          sourceBackedChars: 0,
        });
        expect(event.extra?.queryIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(retrieved.has(event.extra?.scopeIdentitySha256)).toBe(true);
        const line = formatActivityLogProofLine(event);
        expect(line).toContain("accepted-final");
        expect(line).not.toContain("Compare the benefits");
        expect(line).not.toContain("src/Feature.ts");
      }
    },
  );
  it.each(TOPOLOGIES)(
    "permits general learned knowledge in %s without another synthesis call",
    async (topology) => {
      const setup = await fixture(topology, [GENERAL]);
      const answer = await ask(setup, "How should a team compare alternatives?");
      assertAssessmentOnly(answer);
      expect(synthesisCalls(setup)).toHaveLength(1);
      expect(synthesisCalls(setup)[0]?.messages[0]?.content).toContain("general explanations");
      expect(synthesisCalls(setup)[0]?.messages[0]?.content).toContain("live verification");
    },
  );

  it.each(["single", "plural", "hybrid"] as const)(
    "allows a zero-folder-evidence general answer in %s",
    async (topology) => {
      const setup = await fixture(topology, [GENERAL], { empty: true });
      const answer = await ask(setup, "Wie kann ein Team Alternativen vergleichen?");
      assertAssessmentOnly(answer);
      expect(synthesisCalls(setup)).toHaveLength(1);
      if (answer.groundingKind === "connected-context")
        expect(answer.contextPack.filesInPrompt).toBe(0);
      if (answer.groundingKind === "hybrid")
        expect(answer.contextPack.folder.filesInPrompt).toBe(0);
    },
  );

  it.each(TOPOLOGIES)(
    "neutralizes model-authored assessment when the operator disables it in %s",
    async (topology) => {
      const setup = await fixture(topology, [GENERAL], { disabled: true });
      const answer = await ask(setup, "Explain src/Feature.ts");
      expect(splitOwnAssessment(answer.content).assessment).toBeUndefined();
      expect(answer.content).not.toContain("Compare the benefits");
      expect(synthesisCalls(setup).length).toBeLessThanOrEqual(1);
      expect(synthesisCalls(setup)[0]?.messages[0]?.content ?? "").not.toContain(
        "general explanations",
      );
    },
  );

  it.each(["plural", "hybrid"] as const)(
    "keeps a mixed source claim cited and the assessment separate in %s",
    async (topology) => {
      const citation = topology === "plural" ? "[source:1|src/Feature.ts:1]" : "[1]";
      const setup = await fixture(topology, [`Feature is true ${citation}.\n\n${GENERAL}`]);
      const answer = await ask(setup, "Explain src/Feature.ts and discuss general tradeoffs.");
      expect(sourceCitationCount(answer)).toBeGreaterThan(0);
      expect(splitOwnAssessment(answer.content).assessment).toContain("Compare the benefits");
      expect(synthesisCalls(setup)).toHaveLength(1);
    },
  );

  it.each(["plural", "hybrid"] as const)(
    "retains the citation requirement for an unsupported source claim in %s",
    async (topology) => {
      const setup = await fixture(topology, [`Feature is false.\n\n${GENERAL}`]);
      const answer = await ask(setup, "Explain src/Feature.ts");
      expect(synthesisCalls(setup)).toHaveLength(2);
      if (answer.groundingKind !== "connected-context" && answer.groundingKind !== "hybrid")
        throw new TypeError("Expected folder evidence authority");
      expect(answer.uncertainty.some((marker) => marker.kind === "uncited-answer")).toBe(true);
      expect(sourceCitationCount(answer)).toBe(0);
    },
  );
  it.each(["single", "plural", "hybrid"] as const)(
    "keeps a disabled zero-source scope closed in %s",
    async (topology) => {
      const setup = await fixture(topology, [GENERAL], { disabled: true, empty: true });
      const answer = await ask(setup, "Danke");
      expect(synthesisCalls(setup)).toHaveLength(0);
      expect(splitOwnAssessment(answer.content).assessment).toBeUndefined();
    },
  );

  it.each(TOPOLOGIES)("supports ordinary short conversation in %s", async (topology) => {
    const setup = await fixture(topology, [GENERAL]);
    assertAssessmentOnly(await ask(setup, "Danke"));
    expect(synthesisCalls(setup)).toHaveLength(1);
  });

  it.each(["plural", "hybrid"] as const)(
    "supports actual no-anchor conversation without inventing a ready plan in %s",
    async (topology) => {
      const setup = await fixture(topology, [GENERAL]);
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      assertAssessmentOnly(await ask(setup, "?"));
      expect(synthesisCalls(setup)).toHaveLength(1);
      const retrievals = sink.events.filter(
        (event) => event.op === "search.connected-context.completed",
      );
      expect(retrievals).toHaveLength(topology === "plural" ? 2 : 1);
      for (const event of retrievals)
        expect(event.extra).toMatchObject({
          retrievalIntent: "clarification-needed",
          retrievalAnchorCount: 0,
          plannedRingCount: 0,
          usageSearchCalls: 0,
          usageFilesRead: 0,
        });
    },
  );

  it.each(TOPOLOGIES)(
    "preserves source → general → source authority through actual history compaction in %s",
    async (topology) => {
      const citation =
        topology === "single"
          ? "[src/Feature.ts:1]"
          : topology === "plural"
            ? "[source:1|src/Feature.ts:1]"
            : "[1]";
      const sourced = `Feature is true ${citation}.`;
      const setup = await fixture(topology, [sourced, GENERAL, sourced], { compact: true });
      const first = await ask(setup, "Explain Feature in src/Feature.ts");
      expect(sourceCitationCount(first)).toBeGreaterThan(0);
      assertAssessmentOnly(await ask(setup, "Wie kann ein Team Alternativen vergleichen?"));
      const final = await ask(setup, "Explain Feature in src/Feature.ts again");
      expect(sourceCitationCount(final)).toBeGreaterThan(0);
      expect(synthesisCalls(setup)).toHaveLength(3);
      expect(
        setup.deps.store
          .listMessages(setup.chatId, 100)
          .some(
            (message) => message.role === "assistant" && message.content.includes("<assessment>"),
          ),
      ).toBe(true);
      const contextEvidence = setup.deps.evidenceStore
        .list()
        .filter((id) => id.startsWith("chat-"));
      expect(
        contextEvidence.some(
          (id) => (loadEvidence(setup.deps.evidenceStore, id)?.compaction?.length ?? 0) > 0,
        ),
      ).toBe(true);
    },
  );
  it.each(["single", "plural", "hybrid"] as const)(
    "keeps a suggested path as an untrusted hint until a human requests its source in %s",
    async (topology) => {
      const suggestion =
        "<assessment>Compare the benefits and tradeoffs. A proposed example could use src/Feature.ts.</assessment>";
      const setup = await fixture(
        topology,
        [suggestion, GENERAL, sourcedFolderResponse(topology)],
        { compact: true },
      );
      assertAssessmentOnly(await ask(setup, "How should a team compare alternatives?"));
      assertAssessmentOnly(await ask(setup, "Please expand these general tradeoffs."));
      for (const name of ["alpha", "beta"])
        writeFileSync(
          join(setup.directory, name, "src/Feature.ts"),
          "export const Feature = false;\n",
        );
      const answer = await ask(setup, "Explain the suggested src/Feature.ts file now.");
      if (answer.groundingKind === "local-knowledge")
        throw new TypeError("Expected connected folder answer");
      expect(answer.citations.some((citation) => citation.scopePath === "src/Feature.ts")).toBe(
        true,
      );
      expect(synthesisCalls(setup)).toHaveLength(3);
      const finalPrompt =
        synthesisCalls(setup)
          .at(-1)
          ?.messages.map((message) => message.content)
          .join("\n") ?? "";
      expect(finalPrompt).toContain("export const Feature = false;");
      expect(splitOwnAssessment(answer.content).assessment).toBeUndefined();
    },
  );
});
