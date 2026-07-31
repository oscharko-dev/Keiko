import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CLEANUP_DEFERRED_ERROR,
  chatSessionErrorPresentation,
} from "./chat-session-error";

describe("chatSessionErrorPresentation", () => {
  it("maps content-free cleanup state without exposing the machine sentinel", () => {
    expect(chatSessionErrorPresentation(ATTACHMENT_CLEANUP_DEFERRED_ERROR)).toEqual({
      kind: "attachment-cleanup-deferred",
    });
  });

  it("preserves opaque errors and the empty state", () => {
    expect(chatSessionErrorPresentation("opaque-session-error")).toEqual({
      kind: "message",
      message: "opaque-session-error",
    });
    expect(chatSessionErrorPresentation(undefined)).toEqual({ kind: "none" });
  });
});
