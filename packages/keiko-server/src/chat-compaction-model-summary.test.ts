import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  type ContextCompactionModelSummary,
  type ContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryEvidenceStore,
  type EvidenceManifest,
  loadEvidence,
  type EvidenceStore,
} from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { GatewayRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import { enrichChatCompactionWithModelSummary } from "./chat-compaction-model-summary.js";

const CHAT_ID = "chat-model-summary-1";
const MODEL_ID = "summary-model";
const SECRET = "sk-summary-secret-1234567890abcdef";
const ABS_PATH = "/Users/private/project/src/secret.ts";
const NOW = 1_700_000_000_000;

function response(
  content: string,
  structuredOutput: NormalizedResponse["structuredOutput"] = null,
): NormalizedResponse {
  return {
    modelId: MODEL_ID,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput,
    usage: {
      requestId: "summary-request",
      promptTokens: 1,
      completionTokens: 1,
      latencyMs: 1,
      costClass: "medium",
    },
  };
}

function message(role: ChatMessage["role"], content: string, index: number): ChatMessage {
  return {
    id: `m-${String(index)}`,
    chatId: CHAT_ID,
    role,
    content,
    timestamp: NOW + index,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function compactionRecord(): ContextCompactionRecord {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "exceeded effective input budget",
    itemsBefore: 2,
    itemsAfter: 1,
    tokensBefore: 1000,
    tokensAfter: 120,
    preservedFacts: [
      {
        statement: "the current plan uses compaction evidence",
        sourceRef: { kind: "message", stableId: "history-msg-0" },
      },
    ],
    decisions: ["enrich deterministic compaction with a model-written continuity summary"],
  };
}

function redactor(value: unknown): unknown {
  return typeof value === "string" ? value.replaceAll(SECRET, "[REDACTED]") : value;
}

function deps(store: EvidenceStore, model: ModelPort | undefined): UiHandlerDeps {
  return {
    evidenceStore: store,
    env: {},
    redactor,
    modelPortFactory: () => model,
  } as unknown as UiHandlerDeps;
}

function runId(messageCount: number): string {
  return `chat-${sha256Hex(CHAT_ID).slice(0, 16)}-t${String(messageCount)}`;
}

function requireManifest(manifest: EvidenceManifest | undefined): EvidenceManifest {
  if (manifest === undefined) {
    throw new Error("expected evidence manifest");
  }
  return manifest;
}

function requireModelSummary(
  store: EvidenceStore,
  messageCount: number,
): ContextCompactionModelSummary {
  const manifest = requireManifest(loadEvidence(store, runId(messageCount)));
  const summary = manifest.compaction?.[0]?.modelSummary;
  if (summary === undefined) {
    throw new Error("expected model summary");
  }
  return summary;
}

function requireFirstRequest(calls: readonly GatewayRequest[]): GatewayRequest {
  const request = calls[0];
  if (request === undefined) {
    throw new Error("expected model request");
  }
  return request;
}

function requireSummaryPrompt(request: GatewayRequest): string {
  const message = request.messages[1];
  if (message === undefined) {
    throw new Error("expected summary prompt message");
  }
  return message.content;
}

function requireStrings(values: readonly string[] | undefined, name: string): readonly string[] {
  if (values === undefined) {
    throw new Error(`expected ${name}`);
  }
  return values;
}

function structuredSummaryOutput(): NormalizedResponse["structuredOutput"] {
  return {
    content: `Keep the compaction plan active. ${SECRET} Avoid ${ABS_PATH}.`,
    decisions: ["use structured running-summary evidence"],
    constraints: [`Do not persist ${SECRET}`],
    filesAndSymbols: [`${ABS_PATH} buildSummaryPrompt`],
    debuggingContext: ["invalid summaries fall back explicitly"],
    openThreads: ["verify streaming parity"],
  };
}

function structuredSummaryModel(calls: GatewayRequest[]): ModelPort {
  return {
    call(request): Promise<NormalizedResponse> {
      calls.push(request);
      return Promise.resolve(response("", structuredSummaryOutput()));
    },
  };
}

function neverResolvingModel(): ModelPort {
  return {
    call(): Promise<NormalizedResponse> {
      return new Promise<NormalizedResponse>(() => undefined);
    },
  };
}

function defaultEnrichmentInput(
  messageCount = 2,
): Parameters<typeof enrichChatCompactionWithModelSummary>[1] {
  return {
    compaction: compactionRecord(),
    chatId: CHAT_ID,
    modelId: MODEL_ID,
    messageCount,
    startedAt: NOW,
    finishedAt: NOW + 1,
    historyPrefix: [
      message("user", `Remember the plan and ${SECRET} at ${ABS_PATH}`, 0),
      message("assistant", "Acknowledged.", 1),
    ],
  };
}

function expectStructuredSummaryRequest(request: GatewayRequest, prompt: string): void {
  expect(request.responseFormat?.type).toBe("json_schema");
  expect(prompt).toContain("Turn 1/2");
  expect(prompt).not.toContain(SECRET);
  expect(prompt).not.toContain(ABS_PATH);
}

function expectStructuredSummaryPersisted(summary: ContextCompactionModelSummary): void {
  expect(summary.status).toBe("valid");
  expect(summary.validationState).toBe("redacted");
  expect(summary.content).toContain("Keep the compaction plan active.");
  expect(summary.content).not.toContain(SECRET);
  expect(summary.content).not.toContain(ABS_PATH);
  expect(summary.content.length).toBeLessThanOrEqual(1200);
  expect(requireStrings(summary.decisions, "decisions")).toContain(
    "use structured running-summary evidence",
  );
  expect(requireStrings(summary.constraints, "constraints").join("\n")).not.toContain(SECRET);
  expect(requireStrings(summary.filesAndSymbols, "filesAndSymbols").join("\n")).not.toContain(
    ABS_PATH,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("enrichChatCompactionWithModelSummary", () => {
  it("persists a redacted bounded structured model-written summary for future resurfacing", async () => {
    const store = createInMemoryEvidenceStore();
    const calls: GatewayRequest[] = [];
    await enrichChatCompactionWithModelSummary(
      deps(store, structuredSummaryModel(calls)),
      defaultEnrichmentInput(),
    );

    const persisted = requireModelSummary(store, 2);
    const request = requireFirstRequest(calls);
    const prompt = requireSummaryPrompt(request);

    expect(calls).toHaveLength(1);
    expectStructuredSummaryRequest(request, prompt);
    expectStructuredSummaryPersisted(persisted);
  });

  it("keeps a safe legacy text fallback when structured output is unavailable", async () => {
    const store = createInMemoryEvidenceStore();
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        return Promise.resolve(response(`Keep legacy continuity active. ${SECRET}.`));
      },
    };

    await enrichChatCompactionWithModelSummary(deps(store, model), defaultEnrichmentInput(3));

    const persisted = requireModelSummary(store, 3);
    expect(persisted.status).toBe("valid");
    expect(persisted.validationState).toBe("redacted");
    expect(persisted.content).toContain("Keep legacy continuity active.");
    expect(persisted.content).not.toContain(SECRET);
  });

  it("persists rejected metadata when structured output is invalid", async () => {
    const store = createInMemoryEvidenceStore();
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        return Promise.resolve(response("ignored", { content: 5 }));
      },
    };

    await enrichChatCompactionWithModelSummary(deps(store, model), defaultEnrichmentInput(4));

    const persisted = requireModelSummary(store, 4);
    expect(persisted.status).toBe("invalid");
    expect(persisted.validationState).toBe("rejected");
    expect(persisted.failureReason).toBe("invalid-structured-output");
    expect(persisted.content).toBe("");
  });

  it("persists unavailable metadata when the model is not configured", async () => {
    const store = createInMemoryEvidenceStore();

    await enrichChatCompactionWithModelSummary(deps(store, undefined), defaultEnrichmentInput(5));

    const persisted = requireModelSummary(store, 5);
    expect(persisted.status).toBe("unavailable");
    expect(persisted.validationState).toBe("rejected");
    expect(persisted.failureReason).toBe("model-unavailable");
    expect(persisted.content).toBe("");
  });

  it("persists timed-out metadata when the summary call does not settle", async () => {
    vi.useFakeTimers();
    const store = createInMemoryEvidenceStore();
    const enrichment = enrichChatCompactionWithModelSummary(
      deps(store, neverResolvingModel()),
      defaultEnrichmentInput(6),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await enrichment;

    const persisted = requireModelSummary(store, 6);
    expect(persisted.status).toBe("timed-out");
    expect(persisted.validationState).toBe("rejected");
    expect(persisted.failureReason).toBe("timed-out");
    expect(persisted.content).toBe("");
  });
});
