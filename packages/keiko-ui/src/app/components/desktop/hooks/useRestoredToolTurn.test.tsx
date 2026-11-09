import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchChatMessages } from "@/lib/api";
import type { Chat, ChatMessage } from "@/lib/types";
import { useRestoredToolTurn } from "./useRestoredToolTurn";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchChatMessages: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
const chat = { id: "restored-chat", projectPath: "/repo" } as Chat;
const pending: ChatMessage = {
  id: "turn",
  chatId: chat.id,
  role: "user",
  canonicalTurnRef: "a".repeat(64),
  content: "Create one issue.",
  timestamp: 1,
  runId: undefined,
  workflowId: undefined,
  workflowStatus: undefined,
  shortResult: undefined,
  taskType: undefined,
  turnState: "pending",
  toolTranscript: {
    schemaVersion: 1,
    exchanges: [
      {
        call: {
          id: "call-1",
          name: "jira_create",
          arguments: {},
        },
        approval: {
          kind: "jira-chat-write",
          chatId: chat.id,
          approvalId: "approval-1",
          state: "pending",
          podId: "11111111-1111-4111-8111-111111111111",
          bindingGeneration: 1,
          authenticationGeneration: 1,
          invocationId: "invocation-1",
          operation: "jira.create",
          actionDigest: "a".repeat(64),
          requestedAt: 1,
          expiresAt: 4102444800000,
        },
      },
    ],
  },
};
const completed = { ...pending, turnState: "completed" as const };
const assistant = {
  ...pending,
  id: "answer",
  role: "assistant" as const,
  content: "Created once.",
};

it("reads the full persisted page when the known canonical turn is outside the recent window", async () => {
  vi.mocked(fetchChatMessages).mockImplementation((_id, _project, _signal, limit) =>
    Promise.resolve({ messages: limit === 8 ? [] : [completed, assistant] }),
  );
  const publish = vi.fn();
  renderHook(() => useRestoredToolTurn(chat, [pending], false, publish));
  await waitFor(() => expect(publish).toHaveBeenCalledWith(completed, [completed, assistant]), {
    timeout: 2500,
  });
});

it("aborts its observation and refuses a late response after unmount", async () => {
  let resolve!: (value: { messages: ChatMessage[] }) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(fetchChatMessages).mockImplementation((_id, _project, supplied) => {
    signal = supplied;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const publish = vi.fn();
  const { unmount } = renderHook(() => useRestoredToolTurn(chat, [pending], false, publish));
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolve({ messages: [completed, assistant] });
  });
  expect(publish).toHaveBeenCalledTimes(1);
});
