import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import type { TraceSession } from "../requirement-trace.js";
import type { JiraChatCatalogContext } from "./jiraChatCatalogConsumer.js";
import { draftUntracedAdvice } from "./jiraChatToolTurn.js";

const UNTRACED = {
  items: [
    { ref: "epic", projectId: "1", issueTypeId: "2", fields: { summary: "Epic" } },
    { ref: "task", projectId: "1", issueTypeId: "2", fields: { summary: "Task" } },
  ],
} as unknown as CatalogJsonObject;
const TRACED = {
  items: [
    {
      ref: "epic",
      projectId: "1",
      issueTypeId: "2",
      fields: { summary: "Epic" },
      requirementIds: ["LH-001"],
    },
  ],
} as unknown as CatalogJsonObject;

function turn(userMessageId: string): JiraChatCatalogContext {
  return { chatId: "chat-1", userMessageId, correlationId: "c-1" } as JiraChatCatalogContext;
}
function session(units: number): TraceSession {
  return {
    unitCount: () => units,
    resolve: () => ({ ok: false, reason: "references", problems: [] }),
    close: vi.fn(),
  };
}

describe("draftUntracedAdvice (S05/S16 of #4173)", () => {
  const deps = { activityLog: createBufferedServerLogSink() };

  it("has no advice port without a requirement source", () => {
    expect(draftUntracedAdvice(deps as never, undefined)).toBeUndefined();
  });

  it("marks the first advice as new and the same untraced items again in the turn as repeated", () => {
    const advise = draftUntracedAdvice(deps as never, () => session(1));
    expect(advise?.(UNTRACED, turn("m-1"))).toMatchObject({
      repeated: false,
      data: { outcome: "rejected", requirementRefusal: "untraced" },
    });
    expect(advise?.(UNTRACED, turn("m-1"))).toMatchObject({
      repeated: true,
      data: { requirementRefusal: "untraced" },
    });
  });

  it("treats the next turn, or different items, as new advice again", () => {
    const advise = draftUntracedAdvice(deps as never, () => session(1));
    advise?.(UNTRACED, turn("m-1"));
    expect(advise?.(UNTRACED, turn("m-2"))?.repeated).toBe(false);
    const other = {
      items: [{ ...((UNTRACED.items as unknown[])[0] as object), ref: "other" }],
    } as unknown as CatalogJsonObject;
    expect(advise?.(other, turn("m-2"))?.repeated).toBe(false);
  });

  it("gives no advice for a traced draft, an empty requirement source or a malformed draft", () => {
    const advise = draftUntracedAdvice(deps as never, () => session(1));
    expect(advise?.(TRACED, turn("m-1"))).toBeUndefined();
    expect(advise?.({}, turn("m-1"))).toBeUndefined();
    const empty = draftUntracedAdvice(deps as never, () => session(0));
    expect(empty?.(UNTRACED, turn("m-1"))).toBeUndefined();
  });
});
