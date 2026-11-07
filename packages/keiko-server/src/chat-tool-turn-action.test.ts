import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { transcriptReportsToolAction } from "./chat-tool-turn.js";

function exchange(
  canonicalId: string,
  mutationOutcome?: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  return {
    call: { id: canonicalId, name: canonicalId, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "invocation",
      toolRef: { canonicalId, contractVersion: 1 },
      projectionDigest: null,
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data: {},
      effectStarted: mutationOutcome !== undefined,
      metrics: { inputBytes: 0, outputBytes: 0, resultCount: 1, durationMs: 0 },
    },
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
  } as unknown as ChatToolExchange;
}

describe("a turn whose answer reports a change tool (#4292)", () => {
  it("counts a change Keiko sent", () => {
    expect(transcriptReportsToolAction([exchange("keiko.jira.draft", "succeeded")])).toBe(true);
  });

  it("counts a change tool that sent nothing because every issue already existed", () => {
    const exchanges = [
      exchange("keiko.knowledge.requirements"),
      exchange("keiko.jira.draft", "not-dispatched"),
    ];
    expect(transcriptReportsToolAction(exchanges)).toBe(true);
  });

  it("leaves a turn of reads alone, so its answer still gets its citations", () => {
    expect(
      transcriptReportsToolAction([
        exchange("keiko.knowledge.requirements"),
        exchange("keiko.jira.draft.batch"),
      ]),
    ).toBe(false);
    expect(transcriptReportsToolAction([])).toBe(false);
  });
});
