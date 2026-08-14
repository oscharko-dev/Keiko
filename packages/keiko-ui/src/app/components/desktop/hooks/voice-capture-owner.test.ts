import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimVoiceCapture,
  releaseVoiceCapture,
  resetVoiceCaptureOwnerForTests,
  subscribeVoiceCaptureOwner,
  voiceCaptureOwnerSnapshot,
} from "./voice-capture-owner";

afterEach(() => resetVoiceCaptureOwnerForTests());

describe("voice capture owner", () => {
  it("allows multiple capture leases for one chat and blocks every other chat", () => {
    const dialogueLease = Symbol("dialogue");
    const dictationLease = Symbol("dictation");
    const otherChatLease = Symbol("other-chat");

    expect(claimVoiceCapture("chat-a", dialogueLease)).toBe(true);
    expect(claimVoiceCapture("chat-a", dictationLease)).toBe(true);
    expect(claimVoiceCapture("chat-b", otherChatLease)).toBe(false);

    releaseVoiceCapture(dialogueLease);
    expect(voiceCaptureOwnerSnapshot()).toBe("chat-a");
    expect(claimVoiceCapture("chat-b", otherChatLease)).toBe(false);

    releaseVoiceCapture(dictationLease);
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
