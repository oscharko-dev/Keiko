import { describe, expect, it } from "vitest";

import {
  OPENCODE_APPROVED_ENDPOINTS,
  createOpenCodeSseDecoder,
  classifyOpenCodeLiveControl,
  parseOpenCodeHistory,
  parseOpenCodeSse,
  validateOpenCodeHealth,
} from "./opencodeProtocol.js";

describe("OpenCode v1.17.17 protocol boundary", () => {
  it("enforces the exact 64 KiB SSE cap per complete frame, not a bounded batch", () => {
    const frame = boundedSseFrame(32 * 1024);

    const parsed = parseOpenCodeSse(`${frame}${frame}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected bounded SSE frames");
    expect(parsed.value).toHaveLength(2);
    expect(parseOpenCodeSse(boundedSseFrame(64 * 1024)).ok).toBe(true);
    expect(parseOpenCodeSse(boundedSseFrame(64 * 1024 + 1))).toEqual({
      ok: false,
      reason: "frame-oversized",
    });
  });

  it("accepts only the settled HTTP endpoint allowlist", () => {
    expect(OPENCODE_APPROVED_ENDPOINTS).toContain("POST /sync/history");
    expect(OPENCODE_APPROVED_ENDPOINTS).toContain("GET /session/status");
    expect(OPENCODE_APPROVED_ENDPOINTS).not.toContain("POST /sync/replay");
  });

  it("fails closed on health schema drift", () => {
    expect(validateOpenCodeHealth({ healthy: true, version: "1.17.17" })).toEqual({
      ok: true,
      value: { healthy: true, version: "1.17.17" },
    });
    expect(validateOpenCodeHealth({ healthy: true, version: "1.17.17", extra: true })).toEqual({
      ok: false,
      reason: "schema-invalid",
    });
  });

  it("normalizes the real GlobalEvent wrapper while rejecting stale flat or critical-tool drift", () => {
    const event = {
      id: "evt_1",
      type: "server.connected",
      properties: {},
    };
    expect(parseOpenCodeSse(`data: ${JSON.stringify({ payload: event })}\n\n`)).toEqual({
      ok: true,
      value: [{ event: "message", data: event }],
    });
    expect(
      parseOpenCodeSse(
        `event: message\ndata: ${JSON.stringify({
          directory: "/private/customer-repository",
          project: "private-project",
          workspace: "private-workspace",
          payload: event,
        })}\n\n`,
      ),
    ).toEqual({
      ok: true,
      value: [{ event: "message", data: event }],
    });
    for (const envelope of [
      { payload: { type: "server.connected", properties: {} } },
      { payload: { id: "evt_1", properties: {} } },
      { payload: { id: "evt_1", type: "server.connected" } },
      { payload: { ...event, unexpected: true } },
      { payload: { ...event, properties: [] } },
      { payload: event, unexpected: true },
      { project: "orphan-project", payload: event },
      { workspace: "orphan-workspace", payload: event },
    ]) {
      expect(parseOpenCodeSse(`data: ${JSON.stringify(envelope)}\n\n`)).toEqual({
        ok: false,
        reason: "frame-invalid",
      });
    }
    expect(
      parseOpenCodeSse(
        'event: message\ndata: {"id":"evt_1","type":"server.connected","properties":{}}\n\n',
      ),
    ).toEqual({ ok: false, reason: "frame-invalid" });
    expect(
      parseOpenCodeSse(
        'id: evt_1\ndata: {"payload":{"id":"evt_1","type":"server.connected","properties":{}}}\n\n',
      ),
    ).toEqual({ ok: false, reason: "frame-invalid" });
    for (const tool of ["bash", "keiko_repository_read", "keiko_submit_changeset"]) {
      expect(
        parseOpenCodeSse(
          `data: ${JSON.stringify({
            payload: {
              id: "evt_1",
              type: "session.next.tool.called",
              properties: { tool },
            },
          })}\n\n`,
        ),
      ).toEqual({ ok: false, reason: "event-unknown" });
    }
    expect(parseOpenCodeSse("retry: 100\n\n")).toEqual({ ok: false, reason: "frame-invalid" });
  });

  it("rejects duplicate SSE JSON keys at every nesting before canonicalization", () => {
    const event = '{"id":"evt_1","type":"server.connected","properties":{}}';
    expect(parseOpenCodeSse(`data: {"payload":${event},"payload":${event}}\n\n`)).toEqual({
      ok: false,
      reason: "frame-invalid",
    });
    expect(
      parseOpenCodeSse(
        'data: {"payload":{"id":"evt_1","type":"server.connected","properties":{},"properties":{}}}\n\n',
      ),
    ).toEqual({ ok: false, reason: "frame-invalid" });
    expect(
      parseOpenCodeSse(
        'data: {"\\u0070ayload":{"id":"evt_1","type":"server.connected","properties":{}}}\n\n',
      ).ok,
    ).toBe(true);
  });

  it("accepts multiline data across partial chunks and bounds an incomplete frame", () => {
    const decoder = createOpenCodeSseDecoder();
    expect(decoder.push('data: {"payload":{"id":"evt_1","type":"session.idle",\n')).toEqual({
      ok: true,
      value: [],
    });
    expect(decoder.push('data: "properties":{"sessionID":"ses_1"}}}\n\n')).toMatchObject({
      ok: true,
      value: [{ data: { type: "session.idle" } }],
    });
    expect(createOpenCodeSseDecoder(4).push("data:")).toEqual({
      ok: false,
      reason: "frame-oversized",
    });
  });

  it("normalizes only the reviewed exact session.created.1 sync bridge event", () => {
    const syncEvent = {
      type: "session.created.1",
      id: "evt_created",
      seq: 0,
      aggregateID: "ses_1",
      data: { sessionID: "ses_1", info: { id: "ses_1", title: "private title" } },
    };
    const frame = (payload: unknown): string => `data: ${JSON.stringify({ payload })}\n\n`;

    expect(parseOpenCodeSse(frame({ type: "sync", id: "evt_created", syncEvent }))).toEqual({
      ok: true,
      value: [
        {
          event: "message",
          data: { id: "evt_created", type: "sync", properties: {} },
        },
      ],
    });
    for (const payload of [
      { type: "sync", id: "evt_mismatch", syncEvent },
      { type: "sync", id: "evt_created", syncEvent: { ...syncEvent, extra: true } },
      {
        type: "sync",
        id: "evt_created",
        syncEvent: { ...syncEvent, type: "session.updated.1" },
      },
      { type: "sync", id: "evt_created", syncEvent, extra: true },
    ]) {
      expect(parseOpenCodeSse(frame(payload)).ok).toBe(false);
    }
  });

  it("maps only exact-key safe and critical event projections", () => {
    expect(
      parseOpenCodeHistory([
        {
          id: "evt_1",
          aggregate_id: "ses_1",
          seq: 0,
          type: "session.idle",
          data: { sessionID: "ses_1" },
        },
      ]),
    ).toMatchObject({ ok: true, value: [{ kind: "terminal", aggregateId: "ses_1", sequence: 0 }] });
    expect(
      parseOpenCodeHistory([
        { id: "evt_2", aggregate_id: "ses_1", seq: 1, type: "unknown.critical", data: {} },
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
  });

  it("admits the fixed session's strict seq0 session.created.1 checkpoint content-free", () => {
    const created = {
      id: "evt_created",
      aggregate_id: "ses_1",
      seq: 0,
      type: "session.created.1",
      data: { sessionID: "ses_1", info: { id: "ses_1", title: "private title" } },
    };

    expect(parseOpenCodeHistory([created])).toMatchObject({
      ok: true,
      value: [{ id: "evt_created", aggregateId: "ses_1", sequence: 0, kind: "observation" }],
    });
    expect(
      parseOpenCodeHistory([
        { ...created, data: { sessionID: "ses_1", info: { id: "ses_other" } } },
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
    expect(
      parseOpenCodeHistory([{ ...created, data: { ...created.data, unexpected: true } }]),
    ).toEqual({ ok: false, reason: "event-unknown" });
  });

  it("preserves the pinned readiness lifecycle sequence and marks only completion terminal", () => {
    const rows = [
      syncRow(1, "session.updated.1", sessionData()),
      syncRow(2, "message.updated.1", { sessionID: "ses_1", info: userMessage() }),
      syncRow(3, "message.part.updated.1", {
        sessionID: "ses_1",
        part: textPart("private readiness prompt"),
        time: 3,
      }),
      syncRow(4, "session.updated.1", sessionData()),
      syncRow(5, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage(),
      }),
      syncRow(6, "session.updated.1", sessionData({ summary: sessionSummary() })),
      syncRow(7, "message.part.updated.1", {
        sessionID: "ses_1",
        part: {
          id: "prt_start",
          sessionID: "ses_1",
          messageID: "msg_assistant",
          type: "step-start",
        },
        time: 7,
      }),
      syncRow(8, "message.part.updated.1", {
        sessionID: "ses_1",
        part: stepFinishPart("stop"),
        time: 8,
      }),
      syncRow(9, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({ finish: "stop" }),
      }),
      syncRow(10, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({ finish: "stop", time: { created: 1, completed: 10 } }),
      }),
      syncRow(11, "session.updated.1", sessionData({ summary: sessionSummary() })),
    ];

    expect(parseOpenCodeHistory(rows)).toMatchObject({
      ok: true,
      value: [
        { sequence: 1, kind: "observation" },
        { sequence: 2, kind: "observation" },
        { sequence: 3, kind: "observation" },
        { sequence: 4, kind: "observation" },
        { sequence: 5, kind: "observation" },
        { sequence: 6, kind: "observation" },
        { sequence: 7, kind: "observation" },
        { sequence: 8, kind: "observation" },
        { sequence: 9, kind: "observation" },
        { sequence: 10, kind: "terminal" },
        { sequence: 11, kind: "observation" },
      ],
    });
  });

  it("keeps productive tool-loop lifecycle events content-free and non-terminal", () => {
    const sentinel = "SENTINEL_PRIVATE_TOOL_INPUT_AND_OUTPUT";
    const parsed = parseOpenCodeHistory([
      syncRow(1, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({ finish: "tool-calls" }),
      }),
      syncRow(2, "message.part.updated.1", {
        sessionID: "ses_1",
        part: toolPart("pending", sentinel),
        time: 2,
      }),
      syncRow(3, "message.part.updated.1", {
        sessionID: "ses_1",
        part: toolPart("running", sentinel),
        time: 3,
      }),
      syncRow(4, "message.part.updated.1", {
        sessionID: "ses_1",
        part: toolPart("completed", sentinel),
        time: 4,
      }),
      syncRow(5, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({ finish: "tool-calls", time: { created: 1, completed: 5 } }),
      }),
    ]);

    expect(parsed).toMatchObject({
      ok: true,
      value: Array.from({ length: 5 }, () => ({ kind: "observation" })),
    });
    expect(JSON.stringify(parsed)).not.toContain(sentinel);
  });

  it("admits exact bounded question tool lifecycle parts as content-free observations", () => {
    const input = {
      questions: [
        {
          question: "Proceed?",
          header: "Proceed",
          options: [{ label: "Yes", description: "Continue" }],
        },
      ],
    };
    const base = {
      id: "prt_question",
      sessionID: "ses_1",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_question",
      tool: "question",
    };
    const states = [
      { status: "pending", input, raw: "question-sensitive-sentinel" },
      { status: "running", input, title: "Questions", metadata: {}, time: { start: 1 } },
      {
        status: "completed",
        input,
        output: "answer-sensitive-sentinel",
        title: "Questions",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    ] as const;

    for (const [index, state] of states.entries()) {
      const parsed = parseOpenCodeHistory([
        syncRow(27 + index, "message.part.updated.1", {
          sessionID: "ses_1",
          part: { ...base, state },
          time: 27 + index,
        }),
      ]);
      expect(parsed).toMatchObject({ ok: true, value: [{ kind: "observation" }] });
      expect(JSON.stringify(parsed)).not.toMatch(/sensitive-sentinel|Proceed\?|Continue/u);
    }
  });

  it("rejects unsafe question tool lifecycle drift and unapproved built-ins", () => {
    const input = {
      questions: [
        {
          question: "Proceed?",
          header: "Proceed",
          options: [{ label: "Yes", description: "Continue" }],
        },
      ],
    };
    const part = {
      id: "prt_question",
      sessionID: "ses_1",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_question",
      tool: "question",
      state: { status: "pending", input, raw: "bounded" },
    };
    for (const invalid of [
      { ...part, tool: "bash" },
      { ...part, unexpected: true },
      { ...part, state: { ...part.state, unexpected: true } },
      { ...part, state: { ...part.state, raw: "x".repeat(64 * 1024 + 1) } },
    ]) {
      expect(
        parseOpenCodeHistory([
          syncRow(27, "message.part.updated.1", {
            sessionID: "ses_1",
            part: invalid,
            time: 27,
          }),
        ]),
      ).toEqual({ ok: false, reason: "event-unknown" });
    }
  });

  it("fails closed on malformed, content-oversized, cross-session, and unsafe completion shapes", () => {
    const base = syncRow(1, "message.updated.1", {
      sessionID: "ses_1",
      info: assistantMessage({ finish: "stop", time: { created: 1, completed: 2 } }),
    });
    for (const row of [
      syncRow(1, "message.updated.1", {
        sessionID: "ses_other",
        info: assistantMessage({ finish: "stop", time: { created: 1, completed: 2 } }),
      }),
      syncRow(1, "message.updated.1", {
        sessionID: "ses_1",
        info: { ...assistantMessage(), role: "user" },
      }),
      syncRow(1, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({ finish: "unreviewed-finish" }),
      }),
      syncRow(1, "message.updated.1", {
        sessionID: "ses_1",
        info: {
          ...assistantMessage(),
          error: { name: "UnknownError", data: { message: "secret" } },
        },
      }),
      { ...base, data: { ...base.data, unexpected: true } },
      syncRow(1, "message.part.updated.1", {
        sessionID: "ses_1",
        part: textPart("x".repeat(64 * 1024 + 1)),
        time: 1,
      }),
    ]) {
      expect(parseOpenCodeHistory([row])).toEqual({ ok: false, reason: "event-unknown" });
    }
  });

  it("classifies exact live session controls without projecting them through history", () => {
    for (const [type, properties, expected] of [
      ["session.status", { sessionID: "ses_1", status: { type: "busy" } }, "activity"],
      [
        "session.status",
        {
          sessionID: "ses_1",
          status: { type: "retry", attempt: 2, message: "retrying", next: 1234 },
        },
        "activity",
      ],
      ["session.status", { sessionID: "ses_1", status: { type: "idle" } }, "terminal"],
      ["session.idle", { sessionID: "ses_1" }, "terminal"],
    ] as const) {
      const parsed = parseOpenCodeSse(
        `data: ${JSON.stringify({ payload: { id: "evt_control", type, properties } })}\n\n`,
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("expected exact live control");
      expect(classifyOpenCodeLiveControl(parsed.value[0]?.data)).toEqual({
        sessionId: "ses_1",
        state: expected,
      });
    }
    expect(
      parseOpenCodeSse(
        `data: ${JSON.stringify({
          payload: {
            id: "evt_control",
            type: "session.status",
            properties: { sessionID: "ses_1", status: { type: "unknown" } },
          },
        })}\n\n`,
      ),
    ).toEqual({ ok: false, reason: "frame-invalid" });
  });

  it("fails closed when history reports an upstream built-in tool invocation", () => {
    expect(
      parseOpenCodeHistory([
        {
          id: "evt_3",
          aggregate_id: "ses_1",
          seq: 0,
          type: "session.next.tool.called",
          data: {
            timestamp: "2026-07-12T00:00:00.000Z",
            sessionID: "ses_1",
            assistantMessageID: "msg_1",
            callID: "call_1",
            tool: "bash",
            input: {},
            provider: "keiko-runtime",
          },
        },
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
  });

  it("admits only canonical productive tool invocations", () => {
    for (const tool of ["keiko_workspace_read", "keiko_changeset_edit"]) {
      expect(
        parseOpenCodeHistory([
          {
            id: "evt_4",
            aggregate_id: "ses_1",
            seq: 0,
            type: "session.next.tool.called",
            data: {
              timestamp: "2026-07-12T00:00:00.000Z",
              sessionID: "ses_1",
              assistantMessageID: "msg_1",
              callID: "call_1",
              tool,
              input: {},
              provider: "keiko-runtime",
            },
          },
        ]),
      ).toMatchObject({ ok: true, value: [{ kind: "tool" }] });
    }
  });

  it("classifies exact question calls as critical without exposing their input", () => {
    const sentinel = "question-sensitive-sentinel";
    const parsed = parseOpenCodeHistory([
      {
        id: "evt_question",
        aggregate_id: "ses_1",
        seq: 0,
        type: "session.next.tool.called",
        data: {
          timestamp: "2026-07-12T00:00:00.000Z",
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          callID: "call_1",
          tool: "question",
          input: { prompt: sentinel },
          provider: "keiko-runtime",
        },
      },
    ]);
    expect(parsed).toMatchObject({ ok: true, value: [{ kind: "question" }] });
    expect(JSON.stringify(parsed)).not.toContain(sentinel);
  });
});

function boundedSseFrame(size: number): string {
  const prefix =
    'data: {"payload":{"id":"evt_1","type":"server.heartbeat","properties":{"padding":"';
  const suffix = '"}}}';
  return `${prefix}${"x".repeat(size - prefix.length - suffix.length)}${suffix}\n\n`;
}

function syncRow(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): {
  readonly id: string;
  readonly aggregate_id: string;
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
} {
  return {
    id: `evt_${String(sequence)}`,
    aggregate_id: "ses_1",
    seq: sequence,
    type,
    data,
  };
}

function sessionData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionID: "ses_1",
    info: {
      id: "ses_1",
      slug: "fixed-session",
      projectID: "global",
      directory: "/private/workspace",
      path: "private/workspace",
      cost: 0,
      tokens: tokens(),
      title: "private title",
      agent: "build",
      model: { id: "coding", providerID: "keiko-runtime", variant: "default" },
      version: "1.17.17",
      time: { created: 1, updated: 2 },
      ...extra,
    },
  };
}

function sessionSummary(): Record<string, number> {
  return { additions: 0, deletions: 0, files: 0 };
}

function userMessage(): Record<string, unknown> {
  return {
    id: "msg_user",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "keiko-runtime", modelID: "coding" },
  };
}

function assistantMessage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_assistant",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_user",
    modelID: "coding",
    providerID: "keiko-runtime",
    mode: "build",
    agent: "build",
    path: { cwd: "/private/workspace", root: "/" },
    cost: 0,
    tokens: tokens(),
    ...extra,
  };
}

function textPart(text: string): Record<string, unknown> {
  return { id: "prt_text", sessionID: "ses_1", messageID: "msg_user", type: "text", text };
}

function stepFinishPart(reason: string): Record<string, unknown> {
  return {
    id: "prt_finish",
    sessionID: "ses_1",
    messageID: "msg_assistant",
    type: "step-finish",
    reason,
    cost: 0,
    tokens: tokens(),
  };
}

function toolPart(
  status: "pending" | "running" | "completed",
  content: string,
): Record<string, unknown> {
  const state =
    status === "pending"
      ? { status, input: { relativePath: content }, raw: content }
      : status === "running"
        ? { status, input: { relativePath: content }, title: content, time: { start: 1 } }
        : {
            status,
            input: { relativePath: content },
            output: content,
            title: content,
            metadata: {},
            time: { start: 1, end: 2 },
          };
  return {
    id: "prt_tool",
    sessionID: "ses_1",
    messageID: "msg_assistant",
    type: "tool",
    callID: "call_1",
    tool: "keiko_workspace_read",
    state,
  };
}

function tokens(): Record<string, unknown> {
  return { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}
