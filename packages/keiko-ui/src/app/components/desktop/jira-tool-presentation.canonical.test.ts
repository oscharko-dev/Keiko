import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { KNOWLEDGE_TOOL_IDENTITIES } from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import { createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { isCanonicalKnowledgeExchange } from "./jira-tool-presentation";

function exchange(name: string, canonicalId: string, version: number): ChatToolExchange {
  return {
    call: { id: "c", name, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "r",
      toolRef: createToolRef(canonicalId, version),
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: {},
    },
  };
}

describe("canonical Knowledge exchange presentation follows the contracts table", () => {
  it("accepts every contracts identity and rejects a bumped version", () => {
    for (const t of KNOWLEDGE_TOOL_IDENTITIES) {
      expect(isCanonicalKnowledgeExchange(exchange(t.name, t.canonicalId, t.contractVersion))).toBe(
        true,
      );
      expect(
        isCanonicalKnowledgeExchange(exchange(t.name, t.canonicalId, t.contractVersion + 1)),
      ).toBe(false);
    }
  });
});
