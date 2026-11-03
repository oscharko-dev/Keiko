import { describe, expect, it } from "vitest";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessageRole,
} from "@oscharko-dev/keiko-contracts";

import { deliveredMessageSignal } from "./codingWorkbenchInboxSignal";

const AT = "2026-10-24T12:00:00.000Z";

function message(
  id: string,
  role: CodingSafeActivityMessageRole,
  text = "text",
): AvailableCodingSafeActivityFeed["turns"][number]["messages"][number] {
  return {
    messageId: id,
    role,
    occurredAt: AT,
    segments: [{ kind: "text", text, truncated: false }],
    truncated: false,
  };
}

function feed(
  ...turns: readonly (readonly [string, CodingSafeActivityMessageRole][])[]
): AvailableCodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-1",
    updatedAt: AT,
    turns: turns.map((messages, index) => ({
      turnId: `turn-${String(index)}`,
      messages: messages.map(([id, role]) => message(id, role)),
      tools: [],
      truncated: false,
    })),
    truncated: false,
    droppedEventCount: 0,
  };
}

describe("the signal that a waiting message was handed to the model", () => {
  it("is null until the live feed holds anything", () => {
    expect(deliveredMessageSignal(null)).toBeNull();
  });

  it("counts the messages the person wrote across every turn and nothing else", () => {
    expect(deliveredMessageSignal(feed())).toBe(0);
    expect(deliveredMessageSignal(feed([["a", "assistant"]]))).toBe(0);
    expect(
      deliveredMessageSignal(
        feed(
          [
            ["u1", "user"],
            ["a1", "assistant"],
          ],
          [
            ["u2", "user"],
            ["u3", "user"],
          ],
        ),
      ),
    ).toBe(3);
  });

  it("changes when a message is handed over and not when the answer grows", () => {
    const before = deliveredMessageSignal(feed([["u1", "user"]]));
    const grown = deliveredMessageSignal({
      ...feed([["u1", "user"]]),
      turns: [
        {
          ...feed([["u1", "user"]]).turns[0]!,
          messages: [message("u1", "user", "a much longer text than before")],
        },
      ],
    });
    const delivered = deliveredMessageSignal(
      feed([
        ["u1", "user"],
        ["u2", "user"],
      ]),
    );

    expect(grown).toBe(before);
    expect(delivered).not.toBe(before);
  });
});
