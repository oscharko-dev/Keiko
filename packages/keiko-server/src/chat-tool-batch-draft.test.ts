import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  batchDraftDecision,
  BATCH_DRAFT_SKIP_REASONS,
  JIRA_DRAFT_BATCH_TOOL_ID,
} from "./chat-tool-batch-draft.js";
import { recordChatToolBatchDraftOffer } from "./chat-tool-turn-ending.js";

const DRAFT_ID = "0b6f7a9e-1c2d-4e3f-8a4b-5c6d7e8f9a0b";
const DRAFT_DIGEST = "a".repeat(64);

function exchange(
  data: Record<string, unknown> | null,
  overrides: { status?: string; canonicalId?: string } = {},
): ChatToolExchange {
  return {
    call: { id: "batch-1", name: "jira_draft_batch", arguments: {} },
    result: {
      status: overrides.status ?? "completed",
      toolRef: {
        canonicalId: overrides.canonicalId ?? JIRA_DRAFT_BATCH_TOOL_ID,
        contractVersion: 1,
      },
      data,
    },
  } as unknown as ChatToolExchange;
}
const clean = {
  outcome: "succeeded",
  createRequested: true,
  failedCount: 0,
  unresolvedRefCount: 0,
  draftId: DRAFT_ID,
  draftDigest: DRAFT_DIGEST,
};

describe("batchDraftDecision", () => {
  it("offers the approval only for a clean, complete batch the human asked to create", () => {
    expect(batchDraftDecision(exchange(clean))).toEqual({
      kind: "offer",
      draftId: DRAFT_ID,
      draftDigest: DRAFT_DIGEST,
    });
  });

  it.each([
    ["a failed result", exchange(clean, { status: "failed" }), "not-completed"],
    ["another tool", exchange(clean, { canonicalId: "keiko.jira.draft" }), "not-completed"],
    ["a batch that did not succeed", exchange({ ...clean, outcome: "partial" }), "not-completed"],
    ["a result without data", exchange(null), "not-completed"],
    [
      "a batch nobody asked to create",
      exchange({ ...clean, createRequested: false }),
      "not-requested",
    ],
    ["a missing request flag", exchange({ ...clean, createRequested: undefined }), "not-requested"],
    ["failed issues", exchange({ ...clean, failedCount: 1 }), "items-failed"],
    ["unresolved references", exchange({ ...clean, unresolvedRefCount: 2 }), "refs-unresolved"],
    ["a missing draft id", exchange({ ...clean, draftId: undefined }), "no-draft"],
    ["a malformed draft id", exchange({ ...clean, draftId: "not-an-id" }), "no-draft"],
    ["a malformed digest", exchange({ ...clean, draftDigest: "abc" }), "no-draft"],
  ])("skips %s", (_name, stored, reason) => {
    expect(batchDraftDecision(stored)).toEqual({ kind: "skip", reason });
  });

  it("never reads a running exchange as a clean batch", () => {
    expect(
      batchDraftDecision({ call: { id: "batch-1", name: "jira_draft_batch", arguments: {} } }),
    ).toEqual({ kind: "skip", reason: "not-completed" });
  });
});

describe("recordChatToolBatchDraftOffer", () => {
  it("records the dispatch and every skip reason as closed words under the turn correlation", () => {
    const logs = createBufferedServerLogSink();
    for (const decision of ["dispatched", ...BATCH_DRAFT_SKIP_REASONS] as const)
      recordChatToolBatchDraftOffer(logs, {
        correlationId: "batch-offer-proof",
        messageId: "message-private-id",
        decision,
      });
    const events = logs.events.filter((entry) => entry.op === "chat.tool-turn.batch-draft-offer");
    expect(events).toHaveLength(1 + BATCH_DRAFT_SKIP_REASONS.length);
    expect(events[0]?.extra).toMatchObject({ outcome: "dispatched" });
    expect(events[0]?.extra).not.toHaveProperty("reason");
    expect(events[1]?.extra).toMatchObject({ outcome: "skipped", reason: "not-completed" });
    const line = formatActivityLogProofLine(events[1] ?? {});
    expectActivityLogProof("chat.tool-turn.batch-draft-offer.line", line);
    expect(line).not.toContain("message-private-id");
  });
});
