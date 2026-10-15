import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

describe("diagnostic reference activity evidence", () => {
  it("formats correlated reference-channel counters without paths or failure text", async () => {
    const log = createBufferedServerLogSink();
    const path = "src/Feature/Probe.test.ts";
    await runConnectedRetrievalEval({
      files: {
        [path]: 'import { probe } from "./Probe";\nprobe();\n',
        "src/Feature/Probe.ts": "export const probe = () => true;\n",
      },
      query: `Why does this assertion fail?\n    at assertFact (${path}:2:5)\n    at run (node_modules/vitest/runner.js:10:3)`,
      correlationId: "diagnostic-reference-proof",
      activityLog: log,
    });
    const source = log.events.find(
      (event) => event.op === "search.connected-context.source-details",
    );
    const selection = log.events.find(
      (event) => event.op === "search.connected-context.selection-details",
    );
    expect(source?.extra).toMatchObject({
      stackTraceDetected: true,
      stackTraceInScopeFrameCount: 1,
      stackTraceAdmittedPathCount: 1,
      testSourcePairCount: 1,
      referenceChannelCount: 1,
      metadataInjectionReason: "none",
    });
    expect(selection?.extra).toMatchObject({
      stackTraceFrameCount: 2,
      stackTraceExternalFrameCount: 1,
    });
    expect(selection?.correlationId).toBe(source?.correlationId);
    const sourceLine = formatActivityLogProofLine(source ?? {});
    const selectionLine = formatActivityLogProofLine(selection ?? {});
    expect(sourceLine + selectionLine).not.toContain(path);
    expect(sourceLine + selectionLine).not.toContain("assertFact");
    expectActivityLogProof("search.connected-context.diagnostic-references.line", sourceLine);
    expectActivityLogProof("search.connected-context.selection-details.line", selectionLine);
  });
});
