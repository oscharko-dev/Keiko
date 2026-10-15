import { describe, expect, it } from "vitest";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { observedFailureQuery } from "../../../tests/support/observed-failure-query.js";

describe("actual follow-up completion evidence capacity", () => {
  it("keeps both retrieval completions supported through the persisted writer and reader", async () => {
    const log = createBufferedServerLogSink();
    const files: Record<string, string> = {
      "src/Feature.ts": "export const Feature = 1;\n",
      "lib/Companion.ts": "42;\n",
    };
    for (let i = 0; i < 25; i += 1)
      files[`src/Feature-${String(i)}.ts`] = "export const Feature = 1;\n";
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      files,
      query: "Explain src/Feature.ts",
      contextProfile: deriveContextProfile({
        maxInputTokens: 32768,
        inputTokenLimit: 32000,
        reservedOutputTokens: 1024,
        safetyMarginTokens: 256,
      }),
      activityLog: log,
      answerer: {
        answer: async () => {
          await Promise.resolve();
          calls += 1;
          return calls === 1
            ? "Missing evidence: [lib/Companion.ts]"
            : "Companion is 42 [lib/Companion.ts:1].";
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.answer?.followUp).toMatchObject({ outcome: "answered", admittedPathCount: 1 });
    const query = observedFailureQuery(log.events);
    expect(query.integrity.corruptLineCount).toBe(0);
    expect(log.lines().join("\n")).not.toContain("_truncatedFieldCount");
    const completed = log.events.filter(
      (event) => event.op === "search.connected-context.completed",
    );
    expect(completed).toHaveLength(2);
    expect(completed.every((event) => event.extra?.usageElapsedMs !== undefined)).toBe(true);
    expect(
      log.events
        .filter((event) => event.op === "search.connected-context.completion-details")
        .some((event) => event.extra?.augmentationSkipReason === "budget-exhausted"),
    ).toBe(true);
  });
});
