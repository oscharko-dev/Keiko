import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchChatMessages } from "@/lib/api";
import type { Chat, ChatMessage } from "@/lib/types";
import {
  RESTORED_TURN_POLL_MAX_ATTEMPTS,
  restoredTurnPollDelayMs,
  useRestoredToolTurn,
} from "./useRestoredToolTurn";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  fetchChatMessages: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetClientDiagnosticWriter();
});
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
  const onAbandoned = vi.fn();
  renderHook(() => useRestoredToolTurn(chat, [pending], false, publish, onAbandoned));
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
  const onAbandoned = vi.fn();
  const { unmount } = renderHook(() =>
    useRestoredToolTurn(chat, [pending], false, publish, onAbandoned),
  );
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolve({ messages: [completed, assistant] });
  });
  expect(publish).toHaveBeenCalledTimes(1);
});

it("backs the poll spacing off from one second to a ten second ceiling", () => {
  const delays = Array.from({ length: RESTORED_TURN_POLL_MAX_ATTEMPTS }, (_, attempt) =>
    restoredTurnPollDelayMs(attempt),
  );
  expect(delays[0]).toBe(1000);
  expect(delays[14]).toBe(1000);
  expect(delays[15]).toBe(2000);
  expect(delays[45]).toBe(8000);
  expect(Math.max(...delays)).toBe(10_000);
  expect(delays).toEqual([...delays].sort((left, right) => left - right));
  // The schedule outlasts the ten minute approval lifetime, so a live review is observed to its end.
  expect(delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(10 * 60 * 1000);
});

it("gives up after a bounded number of polls when the turn never settles", async () => {
  vi.useFakeTimers();
  const diagnostics = vi.fn();
  setClientDiagnosticWriter(diagnostics);
  vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
  const publish = vi.fn();
  const onAbandoned = vi.fn();
  renderHook(() => useRestoredToolTurn(chat, [pending], false, publish, onAbandoned));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  });
  // One recent-window read and one full read per poll while the turn row stays absent.
  const calls = vi.mocked(fetchChatMessages).mock.calls.length;
  expect(calls).toBe(RESTORED_TURN_POLL_MAX_ATTEMPTS * 2);
  expect(diagnostics).toHaveBeenCalledWith(
    "Restored chat turn observation gave up.",
    expect.objectContaining({ kind: "other" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  });
  expect(vi.mocked(fetchChatMessages).mock.calls.length).toBe(calls);
  expect(publish).toHaveBeenCalledTimes(1);
  // The give-up is explained to the person exactly once, not only logged.
  expect(onAbandoned).toHaveBeenCalledOnce();
});

it("stops observing once the server settles the turn as failed", async () => {
  vi.useFakeTimers();
  const failed = { ...pending, turnState: "failed" as const };
  vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [failed] });
  const publish = vi.fn();
  const onAbandoned = vi.fn();
  renderHook(() => useRestoredToolTurn(chat, [pending], false, publish, onAbandoned));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(publish).toHaveBeenLastCalledWith(failed, [failed]);
  const calls = vi.mocked(fetchChatMessages).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(vi.mocked(fetchChatMessages).mock.calls.length).toBe(calls);
  expect(onAbandoned).not.toHaveBeenCalled();
});
