import { describe, expect, it } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
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

function response(content: string): NormalizedResponse {
  return {
    modelId: MODEL_ID,
    content,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
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

describe("enrichChatCompactionWithModelSummary", () => {
  it("persists a redacted bounded model-written summary for future resurfacing", async () => {
    const store = createInMemoryEvidenceStore();
    const calls: GatewayRequest[] = [];
    const model: ModelPort = {
      call(request): Promise<NormalizedResponse> {
        calls.push(request);
        return Promise.resolve(
          response(`Keep the compaction plan active. ${SECRET} Avoid ${ABS_PATH}.`),
        );
      },
    };

    await enrichChatCompactionWithModelSummary(deps(store, model), {
      compaction: compactionRecord(),
      chatId: CHAT_ID,
      modelId: MODEL_ID,
      messageCount: 2,
      startedAt: NOW,
      finishedAt: NOW + 1,
      historyPrefix: [
        message("user", `Remember the plan and ${SECRET} at ${ABS_PATH}`, 0),
        message("assistant", "Acknowledged.", 1),
      ],
    });

    const manifest = requireManifest(loadEvidence(store, runId(2)));
    const persisted = manifest.compaction?.[0]?.modelSummary?.content ?? "";
    const prompt = calls[0]?.messages[1]?.content ?? "";

    expect(calls).toHaveLength(1);
    expect(prompt).toContain("Turn 1/2");
    expect(prompt).not.toContain(SECRET);
    expect(prompt).not.toContain(ABS_PATH);
    expect(persisted).toContain("Keep the compaction plan active.");
    expect(persisted).not.toContain(SECRET);
    expect(persisted).not.toContain(ABS_PATH);
    expect(persisted.length).toBeLessThanOrEqual(1200);
  });

  it("does not persist an enrichment record when the model returns no usable summary", async () => {
    const store = createInMemoryEvidenceStore();
    const model: ModelPort = {
      call(): Promise<NormalizedResponse> {
        return Promise.resolve(response("   "));
      },
    };

    await enrichChatCompactionWithModelSummary(deps(store, model), {
      compaction: compactionRecord(),
      chatId: CHAT_ID,
      modelId: MODEL_ID,
      messageCount: 3,
      startedAt: NOW,
      finishedAt: NOW + 1,
      historyPrefix: [message("user", "compact me", 0), message("assistant", "ok", 1)],
    });

    expect(store.list()).toEqual([]);
  });
});
