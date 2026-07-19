import { describe, expect, it } from "vitest";

import {
  capturedStartedSessionIdAfter,
  capturedStartedSessionIds,
  type CapturedDebugSessionEvent,
} from "./debugSessionStartCapture.js";

function started(sessionId: string): CapturedDebugSessionEvent {
  return {
    event: "editor-debug:session-started",
    data: JSON.stringify({ event: { sessionId } }),
  };
}

describe("debug session start capture", () => {
  it("returns only a session-started event after the observed sequence boundary", () => {
    const events: readonly CapturedDebugSessionEvent[] = [
      started("previous-session"),
      { event: "editor-debug:output", data: "not-json" },
      { event: "editor-debug:session-started", data: "{" },
      { event: "editor-debug:session-started", data: JSON.stringify({ event: {} }) },
      started("new-session"),
    ];

    expect(capturedStartedSessionIds(events)).toEqual(["previous-session", "new-session"]);
    expect(capturedStartedSessionIdAfter(events, 1)).toBe("new-session");
  });

  it("does not reuse an old session when no new start event was observed", () => {
    const events = [started("previous-session")];

    expect(capturedStartedSessionIdAfter(events, 1)).toBeUndefined();
  });
});
