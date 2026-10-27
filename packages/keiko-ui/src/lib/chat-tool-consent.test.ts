import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import * as api from "./api";
import { watchChatToolConsent } from "./chat-tool-consent";
const chat = {
  id: "chat-1",
  jiraPodBinding: {
    podId: "pod-1",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    connectedAtMs: 1000,
  },
};
const message: ChatMessage = {
  id: "message-1",
  chatId: "chat-1",
  role: "user",
  content: "Read Jira",
  timestamp: 1000,
  canonicalTurnRef: "scoped-digest",
  turnState: "pending",
  runId: undefined,
  workflowId: undefined,
  workflowStatus: undefined,
  shortResult: undefined,
  taskType: undefined,
  toolTranscript: {
    schemaVersion: 1,
    exchanges: [],
    readGrant: {
      kind: "jira-chat-read",
      grantId: "grant-1",
      chatId: "chat-1",
      podId: "pod-1",
      bindingGeneration: 1,
      authenticationGeneration: 1,
      state: "pending",
      disclosureVersion: "jira-chat-read-v1",
      requestedAt: 1000,
      expiresAt: 2000,
    },
  },
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("buffered Chat consent observation", () => {
  it("uses the scoped turn digest, deduplicates states and stops with the accepted request", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [message] });
    const publish = vi.fn();
    const stop = watchChatToolConsent(
      chat,
      "/repo",
      () => Promise.resolve("scoped-digest"),
      new AbortController().signal,
      publish,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledExactlyOnceWith(message);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("ignores another turn and drops an in-flight observation after cancellation", async () => {
    vi.useFakeTimers();
    type Response = Awaited<ReturnType<typeof api.fetchChatMessages>>;
    let release: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = vi
      .spyOn(api, "fetchChatMessages")
      .mockResolvedValueOnce({ messages: [{ ...message, canonicalTurnRef: "other" }] })
      .mockReturnValueOnce(pending);
    const publish = vi.fn();
    const controller = new AbortController();
    const stop = watchChatToolConsent(
      chat,
      "/repo",
      () => Promise.resolve("scoped-digest"),
      controller.signal,
      publish,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.abort();
    if (release === undefined) throw new Error("Missing controlled response");
    release({ messages: [message] });
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).not.toHaveBeenCalled();
    stop();
  });
});
