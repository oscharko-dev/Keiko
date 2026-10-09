import { afterEach, describe, expect, it } from "vitest";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";
import { connectedFollowUpConfiguration } from "./grounded-answer-activity.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

describe("canonical grounded answer and follow-up evidence", () => {
  afterEach(resetServerLogger);
  it("persists same-turn follow-up outcomes without paths, prompts or model bodies", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    let calls = 0;
    const result = await runConnectedRetrievalEval({
      correlationId: "grounded-answer-proof-0001",
      files: {
        "src/Feature.ts": "export function Feature() { return true; }",
        "lib/Companion.ts": "42;",
      },
      query: "Explain src/Feature.ts",
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
    const event = sink.events.find(
      (entry) => entry.op === "search.connected-context.answer-details",
    );
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("search.connected-context.answer-details.line", line);
    expect(persisted).toMatchObject({
      correlationId: "grounded-answer-proof-0001",
      followUpPass: 1,
      followUpPassCount: 1,
      followUpAdmittedPathCount: 1,
      followUpOutcome: "answered",
      filesInPrompt: result.answer?.filesInPrompt,
      completeness: "complete",
      loss: "none",
    });
    expect(line).not.toContain("Companion");
    expect(line).not.toContain("Feature");
    expect(line).not.toContain("Missing evidence");
  });

  it("preserves structured repair failures while retaining the first honest answer", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const result = await runConnectedRetrievalEval({
      files: { "src/Feature.ts": "export function Feature() { return true; }" },
      query: "Explain src/Feature.ts",
      answerer: {
        answer: () => Promise.resolve("Feature is true."),
        repair: async () => {
          await Promise.resolve();
          throw new TypeError("PRIVATE_BODY_CANARY", {
            cause: new RangeError("PRIVATE_CAUSE_CANARY"),
          });
        },
      },
    });
    expect(result.answer?.assistantContent).toBe("Feature is true.");
    const event = sink.events.find(
      (entry) => entry.op === "search.connected-context.answer-details",
    );
    const line = formatActivityLogProofLine(event ?? {});
    const persisted = expectActivityLogProof("search.connected-context.answer-details.line", line);
    expect(persisted).toMatchObject({
      citationRepairDisposition: "failed",
      failureKind: "TypeError",
    });
    expect(persisted.frames).toBeDefined();
    expect(persisted.causeChain).toBeDefined();
    expect(line).not.toContain("PRIVATE_");
  });

  it.each([
    [undefined, 1, "default"],
    ["1", 1, "enabled"],
    ["0", 0, "disabled"],
    ["2", 0, "invalid"],
    ["", 0, "invalid"],
    [" 1 ", 0, "invalid"],
  ] as const)("closes explicit follow-up configuration %s", (value, passesMax, disposition) => {
    expect(connectedFollowUpConfiguration(value)).toEqual({ passesMax, disposition });
  });
});
