import type { ChatToolBatchProgress } from "@oscharko-dev/keiko-contracts/bff-wire";
import { isDesktopChatStreamEvent } from "@oscharko-dev/keiko-contracts/runtime/desktop-chat-stream-wire";
import { describe, expect, it } from "vitest";
import { toolEventIdentity, toolTranscriptEvents } from "./chat-stream-handlers.js";
import type { ChatMessage } from "./store/index.js";

const progress = (
  draftedCount: number,
  failedCount = 0,
  phase = "drafting",
): ChatToolBatchProgress =>
  ({
    phase,
    draftedCount,
    plannedCount: 10,
    coveredRequirementCount: draftedCount,
    requirementCount: 30,
    failedCount,
  }) as ChatToolBatchProgress;

function message(batchProgress: ChatToolBatchProgress | undefined, settled = false): ChatMessage {
  return {
    id: "message-1",
    toolTranscript: {
      schemaVersion: 1,
      exchanges: [
        {
          call: { id: "batch-1", name: "jira_draft_batch", arguments: {} },
          ...(batchProgress === undefined ? {} : { batchProgress }),
          ...(settled ? { result: { status: "completed" } } : {}),
        },
      ],
    },
  } as unknown as ChatMessage;
}

/** The identities the stream would write for these successive transcript states. */
function frames(states: readonly ChatMessage[]): readonly string[] {
  const sent = new Set<string>();
  for (const state of states)
    for (const event of toolTranscriptEvents(state)) {
      const identity = toolEventIdentity(event);
      if (identity !== undefined) sent.add(identity);
    }
  return [...sent];
}

describe("tool-exchange frames of a running draft batch", () => {
  it("writes one frame per counted page, none for a repeated state, and one for the settled call", () => {
    const states = [
      message(undefined),
      message(progress(0, 0, "outlining")),
      message(progress(0)),
      message(progress(0)),
      message(progress(4)),
      message(progress(4, 1)),
      message(progress(4, 1, "complete")),
      message(progress(4, 1, "complete"), true),
    ];
    expect(frames(states)).toHaveLength(7);
  });

  it("carries the progress on a payload the wire contract admits", () => {
    const [event] = toolTranscriptEvents(message(progress(4)));
    expect(event?.event).toBe("tool-exchange");
    expect(isDesktopChatStreamEvent(event)).toBe(true);
    expect(event).toMatchObject({ data: { exchange: { batchProgress: progress(4) } } });
  });

  it("keeps the identity of an exchange without progress unchanged", () => {
    const [event] = toolTranscriptEvents(message(undefined));
    if (event === undefined) throw new TypeError("Missing event");
    expect(toolEventIdentity(event)).toBe("exchange:batch-1:started:");
  });
});
