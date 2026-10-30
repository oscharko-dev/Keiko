import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFileServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  executeLocalSupportQuery,
} from "@oscharko-dev/keiko-activity-log/reader";
import { CODING_SAFE_ACTIVITY_VERIFICATION_OUTCOMES } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { recordGovernedToolModelContent } from "./governedToolModelContent.js";

const stateDirectories: string[] = [];
afterEach(() => {
  for (const directory of stateDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

// #3579: a verification the Workbench card shows as waiting for the operator, as having nothing to
// run, or as not run, must read back from the log as that and not as a bare failed result.
describe("the closed verification outcome on the rendering record (#3579)", () => {
  it.each(CODING_SAFE_ACTIVITY_VERIFICATION_OUTCOMES)(
    "records the outcome %s beside the result status, body-free",
    (verificationOutcome) => {
      const activityLog = createBufferedServerLogSink();

      recordGovernedToolModelContent(
        activityLog,
        "run-verification-outcome",
        { status: verificationOutcome === "passed" ? "completed" : "failed" },
        41,
        verificationOutcome,
      );

      const [event] = activityLog.events;
      if (event === undefined) throw new Error("Expected the rendered-result event");
      expect(
        expectActivityLogProof(
          "coding-runtime.tool-result-rendered.emitted-line",
          formatActivityLogProofLine(event),
        ),
      ).toMatchObject({
        correlationId: "run-verification-outcome",
        framing: "json",
        resultStatus: verificationOutcome === "passed" ? "completed" : "failed",
        verificationOutcome,
      });
    },
  );

  it("omits the field for a result that is not a verification", () => {
    const activityLog = createBufferedServerLogSink();

    recordGovernedToolModelContent(activityLog, "run-no-outcome", { status: "completed" }, 3);

    const [event] = activityLog.events;
    if (event === undefined) throw new Error("Expected the rendered-result event");
    expect(Object.keys(event.extra ?? {})).not.toContain("verificationOutcome");
  });

  it("retains every verification that did not pass in the incident query, and only those", () => {
    const stateDir = mkdtempSync(join(realpathSync(tmpdir()), "keiko-verification-outcome-"));
    stateDirectories.push(stateDir);
    const fromMs = Date.now() - 1;
    const activityLog = createBufferedServerLogSink();
    // The file sink opens with a diagnostic line that borrows the first write's correlation, so the
    // healthy control is written last to keep its correlation independent of any failure root.
    const outcomes = [
      ...CODING_SAFE_ACTIVITY_VERIFICATION_OUTCOMES.filter((outcome) => outcome !== "passed"),
      "passed" as const,
    ];
    for (const verificationOutcome of outcomes) {
      recordGovernedToolModelContent(
        activityLog,
        `run-${verificationOutcome}`,
        { status: verificationOutcome === "passed" ? "completed" : "failed" },
        5,
        verificationOutcome,
      );
    }
    const sink = createFileServerLogSink(stateDir);
    for (const event of activityLog.events) sink.write(event);
    sink.close?.();
    const schema = activityLogOperationSchema("coding-runtime.tool-result-rendered");
    expect(schema?.diagnosticWhen).toContainEqual({
      field: "verificationOutcome",
      values: ["failed-check", "waiting-for-trust", "no-runnable-steps", "not-run"],
    });

    const { result } = executeLocalSupportQuery(
      stateDir,
      {
        kind: "closure",
        queryClass: "incident",
        roots: [],
        windows: [{ fromMs, toMs: Date.now() + 1 }],
        requiredClasses: { kind: "observed-failures" },
        unresolved: false,
      },
      { ...DEFAULT_SUPPORT_QUERY_LIMITS, maxContextEvents: 0 },
      { trigger: "query" },
    );

    const retained = result.events
      .filter((selected) => selected.parsed.view.op === "coding-runtime.tool-result-rendered")
      .map((selected) => selected.parsed.correlationId)
      .sort();
    expect(retained).toEqual([
      "run-failed-check",
      "run-no-runnable-steps",
      "run-not-run",
      "run-waiting-for-trust",
    ]);
    expect(result.truncation.omittedContextEventCount).toBeGreaterThan(0);
  });
});
