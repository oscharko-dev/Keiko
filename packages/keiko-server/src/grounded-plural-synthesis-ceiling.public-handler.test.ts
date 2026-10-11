import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceManifest } from "@oscharko-dev/keiko-contracts/evidence";
import type { GroundedAnswer } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
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
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const MODEL = "plural-physical-synthesis-ceiling";
const UNCITED = "Feature returns true.";
const OVERFLOW = "context-overflow";
const UNAVAILABLE = "service-unavailable";
const UNKNOWN_OUTPUT = "unknown-stream-output";
const UNSUPPORTED_USAGE = "unsupported-stream-options";
const UNSUPPORTED_OUTPUT = "unsupported-max-tokens";
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
  if (content === UNKNOWN_OUTPUT) return unknownOutputResponse();
  const rejected =
    content === UNSUPPORTED_USAGE
      ? "stream_options"
      : content === UNSUPPORTED_OUTPUT
        ? "max_tokens"
        : undefined;
  if (rejected !== undefined)
    return Response.json(
      { error: { param: rejected, code: "unsupported_parameter" } },
      { status: 400 },
    );
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

function unknownOutputResponse(): Response {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (reads === 0)
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`,
          ),
        );
      else controller.error(new TypeError("Synthetic reset after unmeasured output"));
      reads += 1;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
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
  sequence:
    | "overflow-repair"
    | "transient-repair"
    | "transient-cited"
    | "repair"
    | "initial-cited"
    | "repair-rejected"
    | "repair-failed"
    | "unknown-output"
    | "usage-repair"
    | "usage-cited"
    | "output-repair"
    | "output-cited",
  expectedStatus = 200,
): Promise<{
  readonly calls: readonly { readonly messages: GatewayCallRequest["messages"] }[];
  readonly reservations: number;
  readonly answer: GroundedAnswer;
  readonly synthesisCounts: readonly number[];
  readonly completedCounts: readonly number[];
  readonly body: unknown;
}> {
  const calls: { readonly messages: GatewayCallRequest["messages"] }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_url, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (!body.includes("Feature()"))
        return Promise.resolve(providerResponse("No matching evidence."));
      calls.push(JSON.parse(body) as { readonly messages: GatewayCallRequest["messages"] });
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
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  const result = await handleGroundedAsk(
    {
      req: mockRequest({ body: JSON.stringify({ chatId, content: "Explain src/Feature.ts" }) }),
      res: mockResponse().res,
      params: {},
      url: new URL("http://127.0.0.1/api/chats/messages/grounded"),
      correlationId: "plural-synthesis-ceiling",
    },
    deps,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(expectedStatus);
  const synthesisCounts = sink.events
    .filter((event) => event.op === "search.connected-context.answer-details")
    .map((event) =>
      expectActivityLogProof(
        "search.connected-context.answer-details.line",
        formatActivityLogProofLine(event),
      ),
    )
    .map((event) => (typeof event.synthesisCallCount === "number" ? event.synthesisCallCount : 0));
  return {
    calls,
    reservations: reserve.mock.calls.length,
    answer: result.body as GroundedAnswer,
    synthesisCounts,
    completedCounts: completedEvidenceCounts(deps, result.body as GroundedAnswer),
    body: result.body,
  };
}

function completedEvidenceCounts(deps: UiHandlerDeps, answer: GroundedAnswer): readonly number[] {
  if (answer.groundingKind === "local-knowledge") return [];
  const ids = new Set([
    ...(answer.evidenceRunId === undefined ? [] : [answer.evidenceRunId]),
    ...(answer.evidenceRunIds ?? []),
  ]);
  return [...ids].map((runId) => {
    const json = deps.evidenceStore.get(runId);
    if (json === undefined) throw new TypeError("Missing actual source evidence");
    return (JSON.parse(json) as EvidenceManifest).usageTotals.requestCount;
  });
}

function successfulResponseSequence(
  sequence: string,
  cited: string,
): readonly string[] | undefined {
  if (sequence === "initial-cited") return [cited];
  if (sequence === "repair-rejected") return [UNCITED, cited.replace("true", "false")];
  if (sequence === "repair-failed") return [UNCITED, UNAVAILABLE];
  return undefined;
}

function providerSequence(sequence: string, cited: string): readonly string[] {
  const completed = successfulResponseSequence(sequence, cited);
  if (completed !== undefined) return completed;
  if (sequence === "unknown-output") return [UNKNOWN_OUTPUT, cited];
  if (sequence.startsWith("usage-"))
    return [UNSUPPORTED_USAGE, ...(sequence.endsWith("cited") ? [cited] : [UNCITED, cited])];
  if (sequence.startsWith("output-"))
    return [UNSUPPORTED_OUTPUT, ...(sequence.endsWith("cited") ? [cited] : [UNCITED, cited])];
  if (sequence === "overflow-repair") return [OVERFLOW, UNCITED, cited];
  if (sequence === "transient-repair") return [UNAVAILABLE, UNCITED, cited];
  if (sequence === "transient-cited") return [UNAVAILABLE, cited];
  return [UNCITED, cited];
}

describe("actual configured plural synthesis dispatches", () => {
  it.each(
    [false, true].flatMap(
      (hybrid) =>
        [
          { hybrid, sequence: "initial-cited", completed: 1, physical: 1 },
          { hybrid, sequence: "repair", completed: 2, physical: 2 },
          { hybrid, sequence: "repair-rejected", completed: 2, physical: 2 },
          { hybrid, sequence: "overflow-repair", completed: 1, physical: 2 },
          { hybrid, sequence: "transient-cited", completed: 1, physical: 2 },
          { hybrid, sequence: "repair-failed", completed: 1, physical: 2 },
        ] as const,
    ),
  )(
    "persists completed synthesis calls separately from physical attempts (%j)",
    async ({ hybrid, sequence, completed, physical }) => {
      const turn = await scriptedTurn(hybrid, sequence);
      expect(turn.calls).toHaveLength(physical);
      expect(turn.completedCounts).not.toHaveLength(0);
      expect(
        turn.completedCounts.every((count) => count === completed),
        JSON.stringify(turn.completedCounts),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    "refuses retry after unknown output exhausted the original grant (hybrid=%s)",
    async (hybrid) => {
      const turn = await scriptedTurn(hybrid, "unknown-output", 502);
      expect(turn.calls).toHaveLength(1);
      expect(turn.reservations).toBe(1);
      expect(turn.body).toMatchObject({ error: { code: "GATEWAY_CONTEXT_OVERFLOW" } });
    },
  );

  it.each([
    { hybrid: false, sequence: "usage-repair", cited: false },
    { hybrid: true, sequence: "usage-repair", cited: false },
    { hybrid: false, sequence: "output-repair", cited: false },
    { hybrid: true, sequence: "output-repair", cited: false },
    { hybrid: false, sequence: "usage-cited", cited: true },
    { hybrid: true, sequence: "usage-cited", cited: true },
    { hybrid: false, sequence: "output-cited", cited: true },
    { hybrid: true, sequence: "output-cited", cited: true },
  ] as const)(
    "shares actual compatibility attempts with repair (%j)",
    async ({ hybrid, sequence, cited }) => {
      const turn = await scriptedTurn(hybrid, sequence);
      expect(turn.calls).toHaveLength(2);
      expect(turn.reservations).toBe(2);
      expect(turn.answer.citations).toHaveLength(cited ? 1 : 0);
      expect(turn.synthesisCounts.every((count) => count === 2)).toBe(true);
    },
  );
  it.each([false, true])(
    "shares the two physical calls with adopted-window retry (hybrid=%s)",
    async (hybrid) => {
      const turn = await scriptedTurn(hybrid, "overflow-repair");
      expect(turn.calls).toHaveLength(2);
      expect(turn.reservations).toBe(2);
      expect(turn.synthesisCounts).not.toHaveLength(0);
      expect(turn.synthesisCounts.every((count) => count === 2)).toBe(true);
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
