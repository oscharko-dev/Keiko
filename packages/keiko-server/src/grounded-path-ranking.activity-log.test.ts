import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

describe("path-ranked selection activity evidence", () => {
  it("formats actual collision and signal counts without candidate paths", async () => {
    const first = "src/Form/validation.ts";
    const second = "src/Form/feature/validation.ts";
    const log = createBufferedServerLogSink();
    const { pack } = await runConnectedRetrievalEval({
      files: {
        [first]: "export const firstFact = 73;\n",
        [second]: "export const secondFact = 91;\n",
        "README.md": "unrelated prose\n",
      },
      query: `Compare ${first} and ${second}`,
      activityLog: log,
      correlationId: "path-ranked-selection-proof",
    });
    expect(pack.files.map((file) => file.scopePath)).toEqual(
      expect.arrayContaining([first, second]),
    );
    const event = log.events.find(
      (candidate) => candidate.op === "search.connected-context.selection-details",
    );
    expect(event?.extra).toMatchObject({
      basenameCollisionGroupCount: 1,
      basenameDedupDemotedCount: 0,
      exactPathSignalPresentCount: 2,
    });
    expect(event?.extra?.pathSegmentSignalPresentCount).toBeGreaterThanOrEqual(2);
    const formatted = formatActivityLogProofLine(event ?? {});
    expect(formatted).not.toContain(first);
    expect(formatted).not.toContain(second);
    expectActivityLogProof("search.connected-context.path-ranking.line", formatted);
  });
});
