import { afterEach, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { logKnowledgeCitationEditorTarget } from "./knowledge-citation-editor-activity.js";

afterEach(resetServerLogger);

it("persists only the closed citation Editor disposition, never the authorized path", () => {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  logKnowledgeCitationEditorTarget("corr-citation-editor", {
    outcome: "authorized",
    target: { root: "/synthetic-private-root", path: "synthetic-private-document.txt" },
  });
  logKnowledgeCitationEditorTarget("corr-citation-editor", {
    outcome: "rejected",
    reason: "source-modified",
  });
  expect(sink.events).toHaveLength(2);
  for (const event of sink.events) {
    const line = formatActivityLogProofLine(event);
    const record = expectActivityLogProof("knowledge.citation.editor-target.line", line);
    expect(record).toMatchObject({
      outcome: event.extra?.outcome,
      completeness: "complete",
      loss: "none",
    });
    expect(line).not.toMatch(/synthetic-private|root|path|document\.txt/u);
  }
});
