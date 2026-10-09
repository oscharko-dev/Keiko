import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayChatMessage,
} from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import {
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { seedCapsuleWithVectors } from "@oscharko-dev/keiko-local-knowledge/testing";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import { handleGroundedAsk } from "./grounded-qa.js";
import { mockRequest, mockResponse } from "./_support.js";
import {
  QUALIFICATION_SPEND_BUDGET_USD_ENV,
  QUALIFICATION_SPEND_LEDGER_PATH_ENV,
} from "./gateway-spend-budget.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const MODEL = "plural-physical-synthesis-ceiling";
const UNCITED = "Feature returns true.";
const OVERFLOW = "context-overflow";
const UNAVAILABLE = "service-unavailable";
let root = "";
let stateDir = "";
const disposals: UiHandlerDeps[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-plural-synthesis-")));
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-plural-state-")));
  vi.stubEnv("KEIKO_STATE_DIR", stateDir);
  resetServerLogger();
  for (const source of ["alpha", "beta"]) {
    const path = join(root, source, "src/Feature.ts");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export function Feature() { return true; }\n");
  }
});

afterEach(async () => {
  for (const deps of disposals.splice(0)) await deps.dispose?.();
  resetServerLogger();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function providerResponse(content: string): Response {
  const overflow = content === OVERFLOW;
  const unavailable = content === UNAVAILABLE;
  const payload = overflow
    ? { error: { message: "max_tokens=1000000000 cannot be greater than max_model_len=8192." } }
    : unavailable
      ? { error: { message: "The provider is temporarily unavailable." } }
      : {
          id: "plural-synthesis-proof",
          model: MODEL,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
  return new Response(JSON.stringify(payload), {
    status: overflow ? 400 : unavailable ? 503 : 200,
    headers: { "content-type": "application/json" },
  });
}

function configuredRuntime(hybrid: boolean): {
  readonly deps: UiHandlerDeps;
  readonly chatId: string;
} {
  const deps = buildUiHandlerDeps({
    configPath: join(stateDir, "gateway.json"),
    evidenceDir: join(stateDir, "evidence"),
    uiDbPath: join(stateDir, "ui.db"),
    env: {
      [QUALIFICATION_SPEND_BUDGET_USD_ENV]: "100",
      [QUALIFICATION_SPEND_LEDGER_PATH_ENV]: join(stateDir, "spend.db"),
    },
  });
  disposals.push(deps);
  deps.gatewayConfig?.set(
    parseGatewayConfig({
      providers: [
        {
          modelId: MODEL,
          baseUrl: "https://plural.example.invalid/v1",
          apiKey: "fixture",
          maxRetries: 2,
          retryBaseDelayMs: 1,
        },
      ],
      capabilities: [
        {
          ...createDefaultChatCapability(MODEL),
          contextWindow: 32768,
          maxOutputTokens: 1024,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
        },
      ],
    }),
    true,
  );
  deps.gatewayConfig?.recordVerifiedCapability(
    MODEL,
    { conversationReady: true },
    new Date().toISOString(),
    deps.gatewayConfig.generation(),
  );
  deps.store.createProject(root, "Plural synthesis ceiling");
  const chat = deps.store.createChat(root, "Plural synthesis ceiling", MODEL);
  deps.store.updateChat(chat.id, {
    connectedScopes: (hybrid ? ["alpha"] : ["alpha", "beta"]).map((source, index) => ({
      root: join(root, source),
      kind: "files",
      relativePaths: ["src/Feature.ts"],
      connectedAtMs: index,
    })),
  });
  return { deps, chatId: chat.id };
}

async function connectReadyPod(deps: UiHandlerDeps, chatId: string): Promise<void> {
  const runtimeStateDir = dirname(deps.uiDbPath ?? "");
  const store = openKnowledgeStore({ dbPath: resolveKnowledgeStorePath({ runtimeStateDir }) });
  try {
    const pod = await seedCapsuleWithVectors(store, { displayName: "Synthesis ceiling" });
    updateCapsuleState(store, pod.capsuleId, "ready");
    deps.store.updateChat(chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: pod.capsuleId, connectedAtMs: 1 }],
    });
  } finally {
    store.close();
  }
}

async function scriptedTurn(
  hybrid: boolean,
  sequence: "overflow-repair" | "transient-repair" | "transient-cited" | "repair",
): Promise<{
  readonly calls: readonly { readonly messages: readonly GatewayChatMessage[] }[];
  readonly reservations: number;
  readonly answer: GroundedAnswer;
}> {
  const calls: { readonly messages: readonly GatewayChatMessage[] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!body.includes("Feature()"))
        return Promise.resolve(providerResponse("No matching evidence."));
      calls.push(JSON.parse(body) as { readonly messages: readonly GatewayChatMessage[] });
      const cited = hybrid
        ? "Feature returns true [1]."
        : "Feature returns true [source:1|src/Feature.ts:1].";
      const responses = providerSequence(sequence, cited);
      return Promise.resolve(providerResponse(responses[calls.length - 1] ?? cited));
    }),
  );
  const { deps, chatId } = configuredRuntime(hybrid);
  if (hybrid) await connectReadyPod(deps, chatId);
  const budget = deps.gatewayConfig?.spendBudget;
  if (budget === undefined) throw new TypeError("Missing real durable spend budget");
  const reserve = vi.spyOn(budget, "reserve");
  const result = await handleGroundedAsk(
    {
      req: mockRequest({ body: JSON.stringify({ chatId, content: "Explain src/Feature.ts" }) }),
      res: mockResponse().res,
      params: {},
      correlationId: "plural-synthesis-ceiling",
    },
    deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return { calls, reservations: reserve.mock.calls.length, answer: result.body as GroundedAnswer };
}

function providerSequence(sequence: string, cited: string): readonly string[] {
  if (sequence === "overflow-repair") return [OVERFLOW, UNCITED, cited];
  if (sequence === "transient-repair") return [UNAVAILABLE, UNCITED, cited];
  if (sequence === "transient-cited") return [UNAVAILABLE, cited];
  return [UNCITED, cited];
}

describe("actual configured plural synthesis dispatches", () => {
  it.each([false, true])(
    "shares the two physical calls with adopted-window retry (hybrid=%s)",
    async (hybrid) => {
      const turn = await scriptedTurn(hybrid, "overflow-repair");
      expect(turn.calls).toHaveLength(2);
      expect(turn.reservations).toBe(2);
      expect(turn.answer.citations).toHaveLength(0);
      expect(turn.answer.uncertainty.map((marker) => marker.kind)).toContain("uncited-answer");
    },
  );

  it.each([false, true])(
    "preserves the healthy initial answer plus repair (hybrid=%s)",
    async (hybrid) => {
      const turn = await scriptedTurn(hybrid, "repair");
      expect(turn.calls).toHaveLength(2);
      expect(turn.reservations).toBe(2);
      expect(turn.answer.citations).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "charges actual successful and rejected prompts cumulatively (hybrid=%s)",
    async (hybrid) => {
      const turn = await scriptedTurn(hybrid, "overflow-repair");
      const sentTokens = turn.calls.reduce((sum, call) => sum + countGatewayPromptTokens(call), 0);
      const answer = turn.answer;
      if (answer.groundingKind !== "hybrid" && answer.groundingKind !== "connected-context")
        throw new TypeError("Missing folder synthesis answer");
      const usage =
        answer.groundingKind === "hybrid"
          ? answer.contextPack.folder.usage
          : answer.contextPack.usage;
      expect(usage.modelInputTokens).toBeGreaterThanOrEqual(sentTokens);
    },
  );

  it.each([false, true])(
    "preserves a transient retry inside the two-call grant (hybrid=%s)",
    async (hybrid) => {
      const turn = await scriptedTurn(hybrid, "transient-cited");
      expect(turn.calls).toHaveLength(2);
      expect(turn.reservations).toBe(2);
      expect(turn.answer.citations).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "shares physical internal retries with marker repair (hybrid=%s)",
    async (hybrid) => {
      const turn = await scriptedTurn(hybrid, "transient-repair");
      expect(turn.calls).toHaveLength(2);
      expect(turn.reservations).toBe(2);
      expect(turn.answer.citations).toHaveLength(0);
    },
  );
});
