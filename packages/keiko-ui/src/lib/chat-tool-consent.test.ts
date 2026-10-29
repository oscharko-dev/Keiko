import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import * as api from "./api";
import { watchChatToolConsent } from "./chat-tool-consent";
import * as diagnostics from "./client-diagnostics";
import { expectDiagnosticWireAccepted } from "@/test-utils/diagnostic-wire";
const chat = {
  id: "chat-1",
  jiraPodBinding: {
    podId: "11111111-1111-4111-8111-111111111111",
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
      podId: "11111111-1111-4111-8111-111111111111",
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
  it("records a correlated body-free observation failure and retries only the read", async () => {
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(diagnostics, "reportClientDiagnostic");
    const failure = new api.ApiError("INTERNAL", "synthetic-private-consent-token", 503);
    failure.correlationId = "jira-consent-request-1";
    const fetch = vi
      .spyOn(api, "fetchChatMessages")
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ messages: [message] });
    const publish = vi.fn();
    const stop = watchChatToolConsent(
      chat,
      "/repo",
      () => Promise.resolve("scoped-digest"),
      new AbortController().signal,
      publish,
    );
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledExactlyOnceWith(message);
    expect(diagnostic).toHaveBeenCalledWith(
      "Chat tool consent observation failed.",
      expect.objectContaining({
        correlationId: failure.correlationId,
        kind: "other",
      }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(failure.message);
    await expectDiagnosticWireAccepted(
      diagnostic.mock.calls.map(([message, meta]) => ({ message, meta })),
    );
  });
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

it("publishes write approvals and their outcomes even when a read grant is unchanged", async () => {
  vi.useFakeTimers();
  const approval = {
    kind: "jira-chat-write",
    approvalId: "approval-1",
    chatId: "chat-1",
    podId: "11111111-1111-4111-8111-111111111111",
    bindingGeneration: 1,
    authenticationGeneration: 1,
    invocationId: "action-1",
    operation: "jira.edit",
    actionDigest: "a".repeat(64),
    requestedAt: 1000,
    expiresAt: 2000,
    state: "pending",
  } as const;
  const call = {
    id: "call-1",
    name: "jira_edit",
    arguments: { issueKey: "LAB-1", fields: { summary: "Reviewed change" } },
  };
  const pending: ChatMessage = {
    ...message,
    toolTranscript: {
      ...message.toolTranscript,
      schemaVersion: 1,
      exchanges: [{ call, approval }],
    },
  };
  const claimed: ChatMessage = {
    ...message,
    toolTranscript: {
      ...pending.toolTranscript,
      schemaVersion: 1,
      exchanges: [{ call, approval: { ...approval, state: "claimed" } }],
    },
  };
  const succeeded: ChatMessage = {
    ...message,
    toolTranscript: {
      ...claimed.toolTranscript,
      schemaVersion: 1,
      exchanges: [
        { call, approval: { ...approval, state: "claimed" }, mutationOutcome: "succeeded" },
      ],
    },
  };
  vi.spyOn(api, "fetchChatMessages")
    .mockResolvedValueOnce({ messages: [pending] })
    .mockResolvedValueOnce({ messages: [claimed] })
    .mockResolvedValue({ messages: [succeeded] });
  const publish = vi.fn();
  const stop = watchChatToolConsent(
    chat,
    "/repo",
    () => Promise.resolve("scoped-digest"),
    new AbortController().signal,
    publish,
  );
  await vi.advanceTimersByTimeAsync(3500);
  expect(publish.mock.calls.map(([entry]) => entry)).toEqual([pending, claimed, succeeded]);
  stop();
});

it("observes configured MCP approvals in a buffered Chat without a Jira binding", async () => {
  vi.useFakeTimers();
  const mcpMessage: ChatMessage = {
    ...message,
    toolTranscript: {
      schemaVersion: 1,
      exchanges: [],
      readGrant: {
        kind: "mcp-chat-read",
        grantId: "mcp-read",
        chatId: chat.id,
        configurationDigest: "b".repeat(64),
        state: "pending",
        disclosureVersion: "mcp-chat-read-v1",
        requestedAt: 1000,
        expiresAt: 2000,
      },
    },
  };
  vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [mcpMessage] });
  const publish = vi.fn();
  const stop = watchChatToolConsent(
    { id: chat.id },
    "/repo",
    () => Promise.resolve("scoped-digest"),
    new AbortController().signal,
    publish,
  );
  await vi.advanceTimersByTimeAsync(500);
  stop();
  expect(publish).toHaveBeenCalledExactlyOnceWith(mcpMessage);
});

it("observes changes to either source and rejects a foreign Chat within the grant list", async () => {
  vi.useFakeTimers();
  const jira = message.toolTranscript?.readGrant;
  if (jira === undefined) throw new TypeError("Missing test grant");
  const mcp = {
    kind: "mcp-chat-read",
    grantId: "mcp-read",
    chatId: chat.id,
    configurationDigest: "b".repeat(64),
    state: "pending",
    disclosureVersion: "mcp-chat-read-v1",
    requestedAt: 1000,
    expiresAt: 2000,
  } as const;
  const pending: ChatMessage = {
    ...message,
    toolTranscript: {
      schemaVersion: 1,
      exchanges: [],
      readGrant: mcp,
      readGrants: [jira, mcp],
    },
  };
  const granted: ChatMessage = {
    ...message,
    toolTranscript: {
      schemaVersion: 1,
      exchanges: [],
      readGrant: mcp,
      readGrants: [{ ...jira, state: "granted" }, mcp],
    },
  };
  const foreign: ChatMessage = {
    ...message,
    toolTranscript: {
      schemaVersion: 1,
      exchanges: [],
      readGrant: mcp,
      readGrants: [{ ...jira, chatId: "other-chat" }, mcp],
    },
  };
  vi.spyOn(api, "fetchChatMessages")
    .mockResolvedValueOnce({ messages: [pending] })
    .mockResolvedValueOnce({ messages: [granted] })
    .mockResolvedValue({ messages: [foreign] });
  const publish = vi.fn();
  const stop = watchChatToolConsent(
    chat,
    "/repo",
    () => Promise.resolve("scoped-digest"),
    new AbortController().signal,
    publish,
  );
  await vi.advanceTimersByTimeAsync(3500);
  stop();
  expect(publish.mock.calls.map(([entry]) => entry)).toEqual([pending, granted]);
});
