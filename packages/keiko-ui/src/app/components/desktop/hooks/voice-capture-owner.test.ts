import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimVoiceCapture,
  releaseVoiceCapture,
  resetVoiceCaptureOwnerForTests,
  subscribeVoiceCaptureOwner,
  voiceCaptureLeaseAvailable,
  voiceCaptureOwnerSnapshot,
} from "./voice-capture-owner";

afterEach(() => resetVoiceCaptureOwnerForTests());

describe("voice capture owner", () => {
  it("allows one idempotent lease and blocks every overlapping capture mode", () => {
    const dialogueLease = Symbol("dialogue");
    const dictationLease = Symbol("dictation");
    const otherChatLease = Symbol("other-chat");

    expect(voiceCaptureLeaseAvailable("chat-a", dialogueLease)).toBe(true);
    expect(claimVoiceCapture("chat-a", dialogueLease)).toBe(true);
    expect(claimVoiceCapture("chat-a", dialogueLease)).toBe(true);
    expect(voiceCaptureLeaseAvailable("chat-a", dialogueLease)).toBe(true);
    expect(voiceCaptureLeaseAvailable("chat-a", dictationLease)).toBe(false);
    expect(claimVoiceCapture("chat-a", dictationLease)).toBe(false);
    expect(claimVoiceCapture("chat-b", otherChatLease)).toBe(false);

    releaseVoiceCapture(dialogueLease);
    expect(voiceCaptureOwnerSnapshot()).toBeNull();
    expect(claimVoiceCapture("chat-b", otherChatLease)).toBe(true);
    expect(voiceCaptureOwnerSnapshot()).toBe("chat-b");
  });

  it("keeps a lease bound to its original owner and publishes owner changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVoiceCaptureOwner(listener);
    const lease = Symbol("stable-lease");

    expect(claimVoiceCapture("chat-a", lease)).toBe(true);
    expect(claimVoiceCapture("chat-b", lease)).toBe(false);
    releaseVoiceCapture(Symbol("unknown"));
    expect(listener).toHaveBeenCalledOnce();

    releaseVoiceCapture(lease);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    resetVoiceCaptureOwnerForTests();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
