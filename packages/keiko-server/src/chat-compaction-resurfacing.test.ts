import { describe, expect, it } from "vitest";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  type ContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import {
  createInMemoryEvidenceStore,
  persistCompactionEvidence,
} from "@oscharko-dev/keiko-evidence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  CHAT_COMPACTION_CONTEXT_HEADER,
  buildChatCompactionResurfacingContext,
} from "./chat-compaction-resurfacing.js";

const NOW = 1_700_000_000_000;
const CHAT_ID = "chat-resurface-1";
const OTHER_CHAT_ID = "chat-resurface-2";
const SECRET = "sk-resurface-secret-1234567890abcdef";
const ABS_PATH = "/Users/private/project/src/secret.ts";

function runId(chatId: string, turn: number): string {
  return `chat-${sha256Hex(chatId).slice(0, 16)}-t${String(turn)}`;
}

function record(overrides: Partial<ContextCompactionRecord> = {}): ContextCompactionRecord {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "exceeded effective input budget",
    itemsBefore: 4,
    itemsAfter: 1,
    tokensBefore: 1000,
    tokensAfter: 120,
    preservedFacts: [
      {
        statement: "structured summaries are persisted",
        sourceRef: { kind: "message", stableId: "m1" },
      },
    ],
    userConstraints: [{ statement: "do not store raw private logs" }],
    decisions: ["use governed evidence manifests"],
    openQuestions: ["should #1728 consume lane diagnostics?"],
    assumptions: [
      {
        statement: "oldest dropped turn was no longer active",
        rationale: "explicitly marked uncertain",
        confidence: "low",
      },
    ],
    rehydration: {
      schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
      laneId: "repo-evidence",
      handleId: "handle-1",
      itemCount: 1,
      approxTokens: 20,
      kind: "repo-file",
      scopePath: "src/a.ts",
      lineRange: { startLine: 4, endLine: 7 },
      contentHash: "hash-a",
    },
    sourceSpans: [
      {
        kind: "repo-file",
        stableId: "span-1",
        scopePath: "src/b.ts",
        lineRange: { startLine: 8, endLine: 9 },
        contentHash: "hash-b",
      },
    ],
    invalidationKeys: [{ scopePath: "src/a.ts", contentHash: "file-hash-a" }],
    ...overrides,
  };
}

function persist(input: {
  readonly chatId: string;
  readonly turn: number;
  readonly records: readonly ContextCompactionRecord[];
  readonly additionalSecrets?: readonly string[];
}): ReturnType<typeof createInMemoryEvidenceStore> {
  const store = createInMemoryEvidenceStore();
  persistCompactionEvidence(
    {
      runId: runId(input.chatId, input.turn),
      modelId: "model-a",
      records: input.records,
      startedAt: NOW + input.turn,
      finishedAt: NOW + input.turn + 1,
      chatIdHash: sha256Hex(input.chatId),
    },
    { store, env: {}, additionalSecrets: input.additionalSecrets },
  );
  return store;
}

describe("buildChatCompactionResurfacingContext", () => {
  it("resurfaces same-chat pinned facts, decisions, constraints, questions, and rehydration", () => {
    const store = persist({ chatId: CHAT_ID, turn: 4, records: [record()] });

    const context = buildChatCompactionResurfacingContext(store, CHAT_ID);

    expect(context).toContain(CHAT_COMPACTION_CONTEXT_HEADER);
    expect(context).toContain("structured summaries are persisted");
    expect(context).toContain("use governed evidence manifests");
    expect(context).toContain("do not store raw private logs");
    expect(context).toContain("should #1728 consume lane diagnostics?");
    expect(context).toContain("Assumptions (not facts)");
    expect(context).toContain("src/a.ts:4-7");
    expect(context).toContain("src/b.ts:8-9");
    expect(context).toContain("re-verify");
  });

  it("ignores compaction manifests from other chats", () => {
    const store = persist({ chatId: OTHER_CHAT_ID, turn: 2, records: [record()] });

    expect(buildChatCompactionResurfacingContext(store, CHAT_ID)).toBeUndefined();
  });

  it("does not surface secrets or raw absolute paths from persisted compaction evidence", () => {
    const store = persist({
      chatId: CHAT_ID,
      turn: 5,
      records: [
        record({
          preservedFacts: [
            {
              statement: `secret ${SECRET} in ${ABS_PATH}`,
              sourceRef: { kind: "repo-file", stableId: "abs", scopePath: ABS_PATH },
            },
          ],
          decisions: [`do not leak ${SECRET}`],
          filesInspected: [ABS_PATH],
        }),
      ],
      additionalSecrets: [SECRET, ABS_PATH],
    });

    const context = buildChatCompactionResurfacingContext(store, CHAT_ID) ?? "";

    expect(context).not.toContain(SECRET);
    expect(context).not.toContain(ABS_PATH);
    expect(context).not.toContain("/Users/private");
    expect(context).toContain("[REDACTED]");
  });
});
