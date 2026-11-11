import { afterEach, expect, it, vi } from "vitest";
import { createNodeUiStore } from "./store/index.js";
import { processServerLogSink } from "./process-log-sink.js";
import { defaultServerDiagnosticSink } from "./diagnostics-log.js";
import {
  entriesFor,
  validateChatApprovalContinuation,
} from "./chat-approval-continuation-state.js";

afterEach(() => vi.restoreAllMocks());

it("aborts revoked continuation authority even when the activity sink throws, with body-free diagnostics", () => {
  const store = createNodeUiStore(":memory:", { redactString: (value) => value });
  try {
    store.createProject(process.cwd());
    const chat = store.createChat(process.cwd(), "Synthetic", "synthetic");
    const admitted = store.admitChatTurn("diagnostic-failure", {
      chatId: chat.id,
      role: "user",
      content: "Synthetic private request",
      timestamp: 1,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    });
    if (admitted.kind !== "admitted" || admitted.userMessage.canonicalTurnRef === undefined)
      throw new TypeError("Missing actual canonical turn");
    const controller = new AbortController();
    entriesFor(store).set(admitted.userMessage.canonicalTurnRef, {
      message: admitted.userMessage,
      controller,
      sessionId: "sess_111111111111111111111111",
      live: () => false,
      correlationId: "continuation-log-failure",
    });
    const error = new Error("private activity payload", { cause: new TypeError("private cause") });
    vi.spyOn(processServerLogSink(), "write").mockImplementation(() => {
      throw error;
    });
    const diagnostics = vi
      .spyOn(defaultServerDiagnosticSink, "record")
      .mockImplementation(() => undefined);
    expect(() => {
      validateChatApprovalContinuation(store, admitted.userMessage);
    }).not.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({
      correlationId: "continuation-log-failure",
      operation: "chat.approval-continuation.state",
      errorClass: "Error",
      causeChain: ["TypeError"],
    });
    expect(diagnostics.mock.calls[0]?.[0].frames?.length).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(
      /private activity|private cause|Synthetic private|sess_/u,
    );
  } finally {
    store.close();
  }
});
