// Executable Activity Log proof for `git.draft-related-issues` (#3532). `draftRelatedIssuesActivity.ts`
// has no behavioural test of its own elsewhere in the suite, so this drives its one exported writer,
// `logDraftRelatedIssues`, directly with a capturing sink -- the production entry point the module
// owns -- rather than restating the event shape by hand.

import { describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { logDraftRelatedIssues } from "./draftRelatedIssuesActivity.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

function captureSink(): {
  readonly events: ServerLogEvent[];
  readonly write: (event: ServerLogEvent) => void;
} {
  const events: ServerLogEvent[] = [];
  return { events, write: (event): void => void events.push(event) };
}

describe("logDraftRelatedIssues", () => {
  it("resolves the git.draft-related-issues proof for a resolved outcome", () => {
    const sink = captureSink();
    logDraftRelatedIssues(
      sink,
      { correlationId: "corr-draft-related-issues-resolved", runId: "run-related-issues-1" },
      { state: "resolved", count: 2 },
    );
    expect(sink.events).toHaveLength(1);
    const persisted = expectActivityLogProof(
      "git.draft-related-issues.emitted-line",
      formatActivityLogProofLine(sink.events[0] ?? {}),
    );
    expect(persisted).toMatchObject({ state: "resolved", count: 2, runId: "run-related-issues-1" });
  });

  it("logs a body-free unavailable outcome with its closed errorKind", () => {
    const sink = captureSink();
    logDraftRelatedIssues(
      sink,
      { correlationId: "corr-draft-related-issues-unavailable", runId: "run-related-issues-2" },
      { state: "unavailable", count: 0, errorKind: "unavailable", failureKind: "GitHubApiError" },
    );
    expect(sink.events).toEqual([
      {
        category: "process",
        op: "git.draft-related-issues",
        correlationId: "corr-draft-related-issues-unavailable",
        level: "warn",
        errorKind: "unavailable",
        extra: {
          completeness: "complete",
          loss: "none",
          runId: "run-related-issues-2",
          state: "unavailable",
          count: 0,
          failureKind: "GitHubApiError",
        },
      },
    ]);
  });
});
