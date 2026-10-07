import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { describe, expect, it } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { recordGovernedToolModelContent } from "./governedToolModelContent.js";

describe("recordGovernedToolModelContent", () => {
  it("records measured bridge service time in the existing body-free result line", () => {
    const log = createBufferedServerLogSink();
    recordGovernedToolModelContent(log, "run-service-duration", { status: "completed" }, 125);
    expect(log.events).toEqual([
      expect.objectContaining({
        op: "coding-runtime.tool-result-rendered",
        durationMs: 125,
      }),
    ]);
  });
  it("records a block rendering body-free under the run correlation", () => {
    const activityLog = createBufferedServerLogSink();

    recordGovernedToolModelContent(activityLog, "run-rendered", {
      status: "completed",
      read: { text: 'secret "workspace" text\nline two', digest: "a".repeat(64) },
    });

    const [event] = activityLog.events;
    if (event === undefined) throw new Error("Expected the rendered-result event");
    const line = formatActivityLogProofLine(event);
    expect(
      expectActivityLogProof("coding-runtime.tool-result-rendered.emitted-line", line),
    ).toMatchObject({
      correlationId: "run-rendered",
      framing: "blocks",
      textBlockCount: 1,
      resultStatus: "completed",
    });
    expect(line).not.toContain("secret");
    expect(line).not.toContain("workspace");
  });

  it("records a plain JSON rendering without blocks", () => {
    const activityLog = createBufferedServerLogSink();

    recordGovernedToolModelContent(activityLog, "run-rendered", {
      status: "failed",
      reasonCode: "OUT_OF_SCOPE",
    });

    const [event] = activityLog.events;
    if (event === undefined) throw new Error("Expected the rendered-result event");
    expect(
      expectActivityLogProof(
        "coding-runtime.tool-result-rendered.emitted-line",
        formatActivityLogProofLine(event),
      ),
    ).toMatchObject({ framing: "json", textBlockCount: 0, resultStatus: "failed" });
  });

  it("records nothing for a status outside the closed result vocabulary", () => {
    const activityLog = createBufferedServerLogSink();

    recordGovernedToolModelContent(activityLog, "run-rendered", { status: "unknown" });

    expect(activityLog.events).toHaveLength(0);
  });
});
