import { describe, expect, it } from "vitest";

import { validateCodingWorkbenchPermissionRequest } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-validation";

import {
  OPENCODE_APPROVED_ENDPOINTS,
  createOpenCodeSseDecoder,
  classifyOpenCodeLiveControl,
  isOpenCodeFacadeDispatchedTool,
  parseOpenCodeHistory,
  parseOpenCodeSse,
  projectOpenCodePermissionEvent,
  projectOpenCodePermissionRequestId,
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
    expect(OPENCODE_APPROVED_ENDPOINTS).not.toContain("GET /session/{sessionID}/message");
    // #2480 decision: the plan surface is admitted through the todowrite tool parts only.
    expect(OPENCODE_APPROVED_ENDPOINTS).not.toContain("GET /session/{sessionID}/todo");
    expect(OPENCODE_APPROVED_ENDPOINTS.some((endpoint) => endpoint.includes("todo"))).toBe(false);
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
    expect(
      parseOpenCodeSse(
        `data: ${JSON.stringify({
          payload: {
            type: "permission.asked",
            properties: {
              id: "per_legacy",
              sessionID: "ses_1",
              permission: "keiko_governed_action",
              patterns: ["src/example.ts"],
              metadata: {},
              always: [],
            },
          },
        })}\n\n`,
      ),
    ).toMatchObject({
      ok: true,
      value: [{ data: { id: "evt_per_legacy", type: "permission.asked" } }],
    });
    for (const payload of [
      { type: "server.connected", properties: {} },
      {
        type: "permission.asked",
        properties: {
          id: "bad id",
          sessionID: "ses_1",
          permission: "keiko_governed_action",
          patterns: ["src/example.ts"],
          metadata: {},
          always: [],
        },
      },
    ]) {
      expect(parseOpenCodeSse(`data: ${JSON.stringify({ payload })}\n\n`)).toEqual({
        ok: false,
        reason: "frame-invalid",
      });
    }
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

  it("normalizes reviewed sync bridge envelopes as content-free pull triggers", () => {
    const syncEvent = {
      type: "session.created.1",
      id: "evt_created",
      seq: 0,
      aggregateID: "ses_1",
      data: { sessionID: "ses_1", info: { id: "ses_1", title: "private title" } },
    };
    const frame = (payload: unknown): string => `data: ${JSON.stringify({ payload })}\n\n`;
    const trigger = (id: string): unknown => ({
      ok: true,
      value: [{ event: "message", data: { id, type: "sync", properties: {} } }],
    });

    expect(parseOpenCodeSse(frame({ type: "sync", id: "evt_created", syncEvent }))).toEqual(
      trigger("evt_created"),
    );
    // Every other durable sync envelope stays a data-blind pull trigger — the private payload
    // never survives normalization; row admission happens behind POST /sync/history.
    const updated = {
      type: "sync",
      id: "evt_updated",
      syncEvent: {
        ...syncEvent,
        id: "evt_updated",
        type: "message.updated.1",
        seq: 7,
        data: { secret: "PRIVATE_SYNC_BODY" },
      },
    };
    expect(parseOpenCodeSse(frame(updated))).toEqual(trigger("evt_updated"));
    // The real v1.17.17 wraps session-scoped frames with routing keys.
    expect(
      parseOpenCodeSse(
        `data: ${JSON.stringify({ directory: "/w", project: "global", payload: updated })}\n\n`,
      ),
    ).toEqual(trigger("evt_updated"));
    expect(JSON.stringify(parseOpenCodeSse(frame(updated)))).not.toContain("PRIVATE_SYNC_BODY");
    for (const payload of [
      { type: "sync", id: "evt_mismatch", syncEvent },
      { type: "sync", id: "evt_created", syncEvent: { ...syncEvent, extra: true } },
      { type: "sync", id: "evt_created", syncEvent: { ...syncEvent, type: "" } },
      { type: "sync", id: "evt_created", syncEvent: { ...syncEvent, seq: -1 } },
      { type: "sync", id: "evt_created", syncEvent: { ...syncEvent, aggregateID: "prj_1" } },
      { type: "sync", id: "evt_created", syncEvent: { ...syncEvent, seq: 1 } },
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
    ).toMatchObject({
      ok: true,
      value: [{ kind: "terminal-control", aggregateId: "ses_1", sequence: 0 }],
    });
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

  // #2475 first-contact regression: OpenCode 1.17.17 reports `path: ""` for a session whose
  // working directory is the project root (every git-worktree task workspace). The pinned
  // projection must admit the empty string while still rejecting an absent or non-string path.
  it("admits the real child's empty session path and stays closed for absent or invalid paths", () => {
    const emptyPath = sessionData({ path: "" });
    expect(parseOpenCodeHistory([syncRow(1, "session.updated.1", emptyPath)])).toMatchObject({
      ok: true,
      value: [{ sequence: 1, kind: "observation" }],
    });
    const withoutPath = sessionData();
    delete (withoutPath.info as Record<string, unknown>).path;
    expect(parseOpenCodeHistory([syncRow(1, "session.updated.1", withoutPath)])).toEqual({
      ok: false,
      reason: "event-unknown",
    });
    expect(
      parseOpenCodeHistory([syncRow(1, "session.updated.1", sessionData({ path: 7 }))]),
    ).toEqual({ ok: false, reason: "event-unknown" });
    expect(
      parseOpenCodeHistory([
        syncRow(1, "session.updated.1", sessionData({ path: "x".repeat(4097) })),
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
  });

  it("admits only the boolean assistant summary marker used by compaction", () => {
    const row = (summary: unknown): Record<string, unknown> =>
      syncRow(56, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({ summary }),
      });

    expect(parseOpenCodeHistory([row(true)])).toMatchObject({
      ok: true,
      value: [{ sequence: 56, kind: "observation" }],
    });
    expect(parseOpenCodeHistory([row(false)])).toMatchObject({ ok: true });
    for (const invalid of ["private summary", { text: "private summary" }, 1]) {
      expect(parseOpenCodeHistory([row(invalid)])).toEqual({
        ok: false,
        reason: "event-unknown",
      });
    }
    expect(JSON.stringify(parseOpenCodeHistory([row(true)]))).not.toContain("summary");
  });

  // A full assistant response routinely exceeds the uniform 4096-character per-string bound. The
  // real v1.17.17 persists it as ONE durable text part; rejecting it would throw the whole history
  // pull (opencode-history-invalid) and collapse the session's reconciliation. Text stays capped by
  // the 64 KiB part byte budget; every other field keeps the tight bound.
  it("admits a long assistant text part while keeping the byte cap and the tight non-text bound", () => {
    const textRow = (length: number): Record<string, unknown> =>
      syncRow(3, "message.part.updated.1", {
        sessionID: "ses_1",
        part: { ...textPart("x".repeat(length)), messageID: "msg_assistant" },
        time: 3,
      });
    expect(parseOpenCodeHistory([textRow(4097)])).toMatchObject({
      ok: true,
      value: [{ sequence: 3, kind: "observation" }],
    });
    expect(parseOpenCodeHistory([textRow(60_000)])).toMatchObject({ ok: true });
    // Over the 64 KiB part byte budget still fails closed (the DoS guard).
    expect(parseOpenCodeHistory([textRow(66_000)])).toEqual({ ok: false, reason: "event-unknown" });
    // The relaxation is text-only: a non-text field over the per-string bound is still rejected.
    expect(
      parseOpenCodeHistory([
        syncRow(3, "message.part.updated.1", {
          sessionID: "ses_1",
          part: {
            id: "prt_text",
            sessionID: "ses_1",
            messageID: "msg_assistant",
            type: "text",
            text: "ok",
            metadata: { note: "n".repeat(4097) },
          },
          time: 3,
        }),
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
    // No admitted body content survives into the reconciliation projection.
    expect(JSON.stringify(parseOpenCodeHistory([textRow(5000)]))).not.toContain("xxxxx");
  });

  it("admits only the exact content-free compaction marker emitted after large tool reads", () => {
    const compactionPart = {
      id: "prt_compaction",
      sessionID: "ses_1",
      messageID: "msg_assistant",
      type: "compaction",
      auto: true,
      overflow: false,
    };
    const row = (part: unknown): Record<string, unknown> =>
      syncRow(61, "message.part.updated.1", {
        sessionID: "ses_1",
        part,
        time: 61,
      });

    expect(parseOpenCodeHistory([row(compactionPart)])).toMatchObject({
      ok: true,
      value: [{ sequence: 61, kind: "observation" }],
    });
    expect(
      parseOpenCodeHistory([row({ ...compactionPart, tail_start_id: "msg_retained_tail" })]),
    ).toMatchObject({ ok: true });
    for (const invalid of [
      { ...compactionPart, auto: "true" },
      { ...compactionPart, overflow: 0 },
      { ...compactionPart, tail_start_id: "private-tail" },
      { ...compactionPart, unexpected: true },
      { ...compactionPart, messageID: "other" },
    ]) {
      expect(parseOpenCodeHistory([row(invalid)])).toEqual({
        ok: false,
        reason: "event-unknown",
      });
    }
    expect(
      JSON.stringify(
        parseOpenCodeHistory([row({ ...compactionPart, tail_start_id: "msg_retained_tail" })]),
      ),
    ).not.toMatch(/auto|tail_start_id/u);
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

  it.each(["length", "content-filter", "error", "unknown"] as const)(
    "classifies completed assistant finish %s as a failed terminal",
    (finish) => {
      expect(
        parseOpenCodeHistory([
          syncRow(1, "message.updated.1", {
            sessionID: "ses_1",
            info: assistantMessage({ finish, time: { created: 1, completed: 2 } }),
          }),
        ]),
      ).toMatchObject({
        ok: true,
        value: [{ sequence: 1, kind: "terminal-failure" }],
      });
    },
  );

  it.each([
    { name: "ProviderAuthError", data: { providerID: "functional", message: "SENTINEL" } },
    { name: "UnknownError", data: { message: "SENTINEL", ref: "bounded-reference" } },
    { name: "MessageOutputLengthError", data: {} },
    { name: "MessageAbortedError", data: { message: "SENTINEL" } },
    { name: "StructuredOutputError", data: { message: "SENTINEL", retries: 2 } },
    { name: "ContextOverflowError", data: { message: "SENTINEL", responseBody: "SENTINEL" } },
    { name: "ContentFilterError", data: { message: "SENTINEL" } },
    {
      name: "APIError",
      data: {
        message: "SENTINEL",
        statusCode: 503,
        isRetryable: true,
        responseHeaders: { "retry-after": "1" },
        responseBody: "SENTINEL",
        metadata: { category: "upstream" },
      },
    },
  ])("classifies pinned assistant $name as a content-free failed terminal", (error) => {
    const parsed = parseOpenCodeHistory([
      syncRow(1, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({ error, time: { created: 1, completed: 2 } }),
      }),
    ]);

    expect(parsed).toMatchObject({
      ok: true,
      value: [{ sequence: 1, kind: "terminal-failure" }],
    });
    expect(JSON.stringify(parsed)).not.toContain("SENTINEL");
  });

  it("admits bounded pinned assistant structured output and variant metadata", () => {
    expect(
      parseOpenCodeHistory([
        syncRow(1, "message.updated.1", {
          sessionID: "ses_1",
          info: assistantMessage({ structured: { status: "ok" }, variant: "high" }),
        }),
      ]),
    ).toMatchObject({ ok: true, value: [{ kind: "observation" }] });
  });

  it("admits bounded completed tool output without relaxing metadata or row budgets", () => {
    const output = "x".repeat(20_000);
    const base = toolPart("completed", "packages/example.ts");
    const state = {
      status: "completed",
      input: { relativePath: "packages/example.ts" },
      output,
      title: "Read",
      metadata: {},
      time: { start: 1, end: 2 },
    };
    const completed = { ...base, state };
    const row = (part: unknown): Record<string, unknown> =>
      syncRow(4, "message.part.updated.1", {
        sessionID: "ses_1",
        part,
        time: 4,
      });

    const parsed = parseOpenCodeHistory([row(completed)]);
    expect(parsed).toMatchObject({ ok: true, value: [{ kind: "observation" }] });
    expect(JSON.stringify(parsed)).not.toContain("xxxxx");
    expect(
      parseOpenCodeHistory([
        row({ ...completed, state: { ...state, output: "x".repeat(66_000), title: "Read" } }),
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
    expect(
      parseOpenCodeHistory([
        row({
          ...completed,
          state: { ...state, output, title: "Read", metadata: { note: "n".repeat(4097) } },
        }),
      ]),
    ).toEqual({ ok: false, reason: "event-unknown" });
  });

  it("admits only exact bounded tool errors and keeps their messages out of reconciliation", () => {
    const sentinel = "SENTINEL_PRIVATE_TOOL_ERROR";
    const base = toolPart("pending", "delegated objective");
    const errorState = {
      status: "error",
      input: { objective: "delegated objective", maxToolCalls: 8 },
      error: sentinel,
      time: { start: 1, end: 2 },
    };
    const row = (state: unknown): Record<string, unknown> =>
      syncRow(32, "message.part.updated.1", {
        sessionID: "ses_1",
        part: { ...base, tool: "keiko_child_agent", state },
        time: 32,
      });

    const parsed = parseOpenCodeHistory([row(errorState)]);
    expect(parsed).toMatchObject({ ok: true, value: [{ kind: "observation" }] });
    expect(JSON.stringify(parsed)).not.toContain(sentinel);
    for (const invalid of [
      { ...errorState, error: "" },
      { ...errorState, error: "x".repeat(4097) },
      { ...errorState, time: { start: 1 } },
      { ...errorState, unexpected: true },
    ]) {
      expect(parseOpenCodeHistory([row(invalid)])).toEqual({
        ok: false,
        reason: "event-unknown",
      });
    }
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
          error: { name: "UnreviewedError", data: { message: "secret" } },
        },
      }),
      syncRow(1, "message.updated.1", {
        sessionID: "ses_1",
        info: assistantMessage({
          error: { name: "UnknownError", data: { message: "secret", unexpected: true } },
        }),
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

  it("admits todowrite plan parts while the unchosen plan surfaces stay fail-closed", () => {
    const todos = [{ content: "Read the entry point", status: "in_progress", priority: "high" }];
    const planPart = {
      id: "prt_plan",
      sessionID: "ses_1",
      messageID: "msg_assistant",
      type: "tool",
      callID: "call_plan",
      tool: "todowrite",
      state: {
        status: "completed",
        input: { todos },
        output: JSON.stringify(todos, null, 2),
        title: "1 todos",
        metadata: { todos, truncated: false },
        time: { start: 1, end: 2 },
      },
    };
    expect(
      parseOpenCodeHistory([
        syncRow(27, "message.part.updated.1", { sessionID: "ses_1", part: planPart, time: 27 }),
      ]),
    ).toMatchObject({ ok: true, value: [{ kind: "observation" }] });
    for (const rejected of [
      syncRow(27, "message.part.updated.1", {
        sessionID: "ses_1",
        part: { ...planPart, tool: "todoread" },
        time: 27,
      }),
      syncRow(27, "todo.updated", { sessionID: "ses_1", todos }),
    ]) {
      expect(parseOpenCodeHistory([rejected])).toEqual({ ok: false, reason: "event-unknown" });
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

  it("projects only exact run-bound governed edit and verification permissions", () => {
    const base = {
      id: "evt_permission",
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_1",
        permission: "keiko_governed_action",
        patterns: ["src/example.ts"],
        always: [],
        metadata: {
          kind: "workspace-write",
          actionClass: "workspace-write",
          reasonCode: "approval-required",
          expiresAt: "2026-07-23T14:05:00.000Z",
          actionKind: "file-edit",
          scopeLabel: "workspace-scope",
          risk: "medium",
          policyReason: "approval-required",
          targetPath: "src/example.ts",
          allowedRelativePaths: ["src/example.ts"],
          fileCount: 1,
          addedLines: 1,
          deletedLines: 1,
        },
      },
    };
    const projectedEdit = projectOpenCodePermissionEvent(base, "ses_1");
    expect(projectedEdit).toMatchObject({
      type: "permission-request",
      kind: "workspace-write",
      actionKind: "file-edit",
      scopeLabel: "workspace-scope",
    });
    expect(projectedEdit).toBeDefined();
    if (projectedEdit === undefined) throw new Error("expected governed edit projection");
    expect(projectedEdit.requestId).toMatch(/^permission-[0-9]+$/u);
    expect(
      validateCodingWorkbenchPermissionRequest({
        requestId: projectedEdit.requestId,
        kind: projectedEdit.kind,
        actionClass: projectedEdit.actionClass,
        reasonCode: projectedEdit.reasonCode,
        expiresAt: projectedEdit.expiresAt,
        actionKind: projectedEdit.actionKind,
        scopeLabel: projectedEdit.scopeLabel,
        risk: projectedEdit.risk,
        policyReason: projectedEdit.policyReason,
      }),
    ).toMatchObject({ ok: true });
    const projectedVerification = projectOpenCodePermissionEvent(
      {
        ...base,
        properties: {
          ...base.properties,
          patterns: ["typecheck"],
          metadata: {
            kind: "command-execution",
            actionClass: "command-execution",
            reasonCode: "approval-required",
            expiresAt: "2026-07-23T14:05:00.000Z",
            actionKind: "verification-command",
            scopeLabel: "workspace-scope",
            risk: "low",
            policyReason: "approval-required",
            commandLabel: "typecheck",
            actionId: "session:call",
            idempotencyKey: "session:call",
            approvalId: "session:call",
            approvalDigest: "a".repeat(64),
          },
        },
      },
      "ses_1",
    );
    expect(projectedVerification).toMatchObject({
      type: "permission-request",
      kind: "command-execution",
      actionKind: "verification-command",
    });
    expect(projectedVerification?.requestId).toMatch(/^permission-[0-9]+$/u);
    const projectedCiObservation = projectOpenCodePermissionEvent(
      {
        ...base,
        properties: {
          ...base.properties,
          patterns: ["ci"],
          metadata: {
            kind: "command-execution",
            actionClass: "command-execution",
            reasonCode: "approval-required",
            expiresAt: "2026-07-23T14:05:00.000Z",
            actionKind: "ci-observe",
            scopeLabel: "workspace-scope",
            risk: "low",
            policyReason: "approval-required",
            commandLabel: "ci",
            actionId: "session:ci-call",
            idempotencyKey: "session:ci-call",
            approvalId: "session:ci-call",
            approvalDigest: "b".repeat(64),
          },
        },
      },
      "ses_1",
    );
    expect(projectedCiObservation).toMatchObject({
      type: "permission-request",
      kind: "command-execution",
      actionKind: "ci-observe",
      commandLabel: "ci",
    });
    for (const rejected of [
      { ...base, extra: true },
      { ...base, properties: { ...base.properties, sessionID: "ses_foreign" } },
      {
        ...base,
        properties: {
          ...base.properties,
          metadata: { ...base.properties.metadata, rawPatch: "secret" },
        },
      },
      {
        ...base,
        properties: { ...base.properties, patterns: ["different.ts"] },
      },
      // Windows drive-qualified and NTFS alternate-data-stream targets must never project as
      // workspace-relative edit permissions (CWE-22 on win32 path resolution).
      {
        ...base,
        properties: {
          ...base.properties,
          patterns: ["C:/Users/evil.txt"],
          metadata: {
            ...base.properties.metadata,
            targetPath: "C:/Users/evil.txt",
            allowedRelativePaths: ["C:/Users/evil.txt"],
          },
        },
      },
      {
        ...base,
        properties: {
          ...base.properties,
          patterns: ["note.txt:ads"],
          metadata: {
            ...base.properties.metadata,
            targetPath: "note.txt:ads",
            allowedRelativePaths: ["note.txt:ads"],
          },
        },
      },
    ]) {
      expect(projectOpenCodePermissionEvent(rejected, "ses_1")).toBeUndefined();
    }
  });

  it("projects upstream permission ids into stable content-free aliases", () => {
    const first = projectOpenCodePermissionRequestId("per_upstream_1");
    expect(first).toMatch(/^permission-[0-9]+$/u);
    expect(projectOpenCodePermissionRequestId("per_upstream_1")).toBe(first);
    expect(projectOpenCodePermissionRequestId("per_upstream_2")).not.toBe(first);
    expect(projectOpenCodePermissionRequestId("permission-1")).toBeUndefined();
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

  it("classifies keiko_* tools as facade-dispatched and question/todowrite/unknown tools as not (#3390)", () => {
    expect(isOpenCodeFacadeDispatchedTool("keiko_workspace_discover")).toBe(true);
    expect(isOpenCodeFacadeDispatchedTool("keiko_workspace_read")).toBe(true);
    expect(isOpenCodeFacadeDispatchedTool("question")).toBe(false);
    expect(isOpenCodeFacadeDispatchedTool("todowrite")).toBe(false);
    expect(isOpenCodeFacadeDispatchedTool("not-a-real-tool")).toBe(false);
    expect(isOpenCodeFacadeDispatchedTool("")).toBe(false);
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
