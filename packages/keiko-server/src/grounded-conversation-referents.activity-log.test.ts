import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

const path = "src/Feature/validation.ts";
const history = [
  { role: "user" as const, content: "Explain this validation routine" },
  { role: "assistant" as const, content: `Missing evidence: [${path}]` },
];

describe("actual two-turn assistant reference retrieval", () => {
  it.each(["siehst du die Datei jetzt?", "can you see the file now?"])(
    "reads a declaration for %s",
    async (query) => {
      const log = createBufferedServerLogSink();
      const result = await runConnectedRetrievalEval({
        files: {
          [path]: "export function validateFeature() { return true; }\n",
          "README.md": "Project overview\n",
        },
        query,
        history,
        activityLog: log,
        correlationId: "assistant-continuity-proof",
      });
      expect(result.pack.files.map((file) => file.scopePath)).toContain(path);
      expect(
        result.pack.files.some((file) => file.scopePath === path && file.excerpts.length > 0),
      ).toBe(true);
      const event = log.events.find(
        (entry) => entry.op === "search.connected-context.selection-details",
      );
      expect(event?.extra).toMatchObject({
        continuityReferentSource: "assistant-declaration",
        continuityReferentCount: 1,
        continuityAdmittedCount: 1,
        continuityRejectedCount: 0,
      });
      const line = formatActivityLogProofLine(event ?? {});
      expect(line).not.toContain(path);
      expect(line).not.toContain("validateFeature");
      expectActivityLogProof("search.connected-context.continuity.line", line);
    },
  );

  it("rejects an unsafe assistant path through the same live boundary", async () => {
    const log = createBufferedServerLogSink();
    await runConnectedRetrievalEval({
      files: { "README.md": "Project overview\n" },
      query: "Try again",
      history: [
        { role: "user", content: "Inspect this source file" },
        { role: "assistant", content: "Read `../private-canary.ts`." },
      ],
      activityLog: log,
      correlationId: "assistant-continuity-rejected",
    });
    const event = log.events.find(
      (entry) => entry.op === "search.connected-context.selection-details",
    );
    expect(event?.extra).toMatchObject({
      continuityReferentCount: 1,
      continuityAdmittedCount: 0,
      continuityRejectedCount: 1,
    });
    expect(formatActivityLogProofLine(event ?? {})).not.toContain("private-canary");
  });
});
