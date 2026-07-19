import { describe, expect, it } from "vitest";

import { normalizeOpenCodeSafeActivityHistory } from "./opencodeSafeActivity.js";

function row(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `evt_${String(sequence)}`,
    aggregate_id: "ses_safe",
    seq: sequence,
    type,
    data,
  };
}

function assistantInfo(): Record<string, unknown> {
  return {
    id: "msg_assistant",
    sessionID: "ses_safe",
    role: "assistant",
    time: { created: 1_721_323_200_001 },
    parentID: "msg_user",
    modelID: "coding",
    providerID: "keiko",
    mode: "build",
    agent: "build",
    path: { cwd: "/private/workspace", root: "/private/workspace" },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

describe("OpenCode safe-activity normalization", () => {
  it("normalizes admitted message and tool parts while discarding raw arguments and results", () => {
    const canary = "RAW_TOOL_CANARY_2479";
    const normalized = normalizeOpenCodeSafeActivityHistory([
      row(1, "message.updated.1", { sessionID: "ses_safe", info: assistantInfo() }),
      row(2, "message.part.updated.1", {
        sessionID: "ses_safe",
        part: {
          id: "prt_text",
          sessionID: "ses_safe",
          messageID: "msg_assistant",
          type: "text",
          text: "Visible answer",
        },
        time: 1_721_323_200_002,
      }),
      row(3, "message.part.updated.1", {
        sessionID: "ses_safe",
        part: {
          id: "prt_tool",
          sessionID: "ses_safe",
          messageID: "msg_assistant",
          type: "tool",
          callID: "call_safe",
          tool: "keiko_workspace_read",
          state: { status: "pending", input: { relativePath: canary }, raw: canary },
        },
        time: 1_721_323_200_003,
      }),
      row(4, "message.part.updated.1", {
        sessionID: "ses_safe",
        part: {
          id: "prt_tool",
          sessionID: "ses_safe",
          messageID: "msg_assistant",
          type: "tool",
          callID: "call_safe",
          tool: "keiko_workspace_read",
          state: {
            status: "completed",
            input: { relativePath: canary },
            output: canary,
            title: canary,
            metadata: { canary },
            time: { start: 1_721_323_200_003, end: 1_721_323_200_004 },
          },
        },
        time: 1_721_323_200_004,
      }),
    ]);

    expect(normalized.dropped).toBe(0);
    expect(normalized.signals.map(({ signal }) => signal)).toMatchObject([
      { kind: "message", role: "assistant", occurredAt: "2024-07-18T17:20:00.001Z" },
      { kind: "text", text: "Visible answer", occurredAt: "2024-07-18T17:20:00.002Z" },
      { kind: "tool", state: "pending", tool: "keiko_workspace_read" },
    ]);
    expect(JSON.stringify(normalized)).not.toContain(canary);
  });

  it("counts malformed relevant events and ignores admitted non-activity observations", () => {
    const normalized = normalizeOpenCodeSafeActivityHistory([
      row(1, "session.status", { sessionID: "ses_safe", status: "busy" }),
      row(2, "message.part.updated.1", {
        sessionID: "ses_safe",
        part: { type: "text", text: "hostile but malformed" },
        time: 2,
      }),
    ]);
    expect(normalized).toEqual({ signals: [], dropped: 1 });
  });

  it("normalizes engine timestamps to strict UTC millisecond form", () => {
    const normalized = normalizeOpenCodeSafeActivityHistory([
      row(1, "message.updated.1", { sessionID: "ses_safe", info: assistantInfo() }),
    ]);
    expect(normalized.signals[0]?.signal.occurredAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
  });

  it("normalizes user, running-part, and called-tool signals while ignoring hidden text", () => {
    const normalized = normalizeOpenCodeSafeActivityHistory([
      row(1, "message.updated.1", {
        sessionID: "ses_safe",
        info: {
          id: "msg_user",
          sessionID: "ses_safe",
          role: "user",
          time: { created: 1_721_323_200_000 },
          agent: "build",
          model: { providerID: "keiko", modelID: "coding" },
        },
      }),
      row(2, "message.part.updated.1", {
        sessionID: "ses_safe",
        part: {
          id: "prt_ignored",
          sessionID: "ses_safe",
          messageID: "msg_user",
          type: "text",
          text: "hidden",
          ignored: true,
        },
        time: 1_721_323_200_001,
      }),
      row(3, "message.part.updated.1", {
        sessionID: "ses_safe",
        part: {
          id: "prt_running",
          sessionID: "ses_safe",
          messageID: "msg_assistant",
          type: "tool",
          callID: "call_safe",
          tool: "keiko_workspace_read",
          state: {
            status: "running",
            input: {},
            title: "read",
            metadata: {},
            time: { start: 1_721_323_200_002 },
          },
        },
        time: 1_721_323_200_002,
      }),
      row(4, "session.next.tool.called", {
        timestamp: "2024-07-18T17:20:00Z",
        sessionID: "ses_safe",
        assistantMessageID: "msg_assistant",
        callID: "call_safe",
        tool: "keiko_workspace_read",
        provider: "keiko",
      }),
    ]);

    expect(normalized.dropped).toBe(0);
    expect(normalized.signals.map(({ signal }) => signal)).toMatchObject([
      { kind: "message", role: "user", messageId: "msg_user" },
      { kind: "tool", state: "running", messageId: "msg_assistant" },
      { kind: "tool", state: "running", callId: "call_safe" },
    ]);
    expect(JSON.stringify(normalized)).not.toContain("hidden");
  });

  it("counts malformed relevant rows and remains total for non-array input", () => {
    expect(normalizeOpenCodeSafeActivityHistory({ rows: [] })).toEqual({
      signals: [],
      dropped: 1,
    });
    const normalized = normalizeOpenCodeSafeActivityHistory([
      row(1, "message.updated.1", {
        sessionID: "ses_safe",
        info: { id: "msg_bad", role: "assistant", time: { created: -1 } },
      }),
      row(2, "message.part.updated.1", {
        sessionID: "ses_safe",
        part: {
          id: "prt_empty",
          sessionID: "ses_safe",
          messageID: "msg_user",
          type: "text",
          text: "",
        },
        time: 2,
      }),
      row(3, "session.next.tool.called", {
        timestamp: "not-a-time",
        sessionID: "ses_safe",
        assistantMessageID: "msg_assistant",
        callID: "call_safe",
        tool: "keiko_workspace_read",
        provider: "keiko",
      }),
    ]);
    expect(normalized).toEqual({ signals: [], dropped: 3 });
  });
});
