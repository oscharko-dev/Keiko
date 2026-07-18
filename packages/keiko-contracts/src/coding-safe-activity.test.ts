import { describe, expect, it } from "vitest";

import {
  CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT,
  CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_TURNS,
  CODING_SAFE_ACTIVITY_TOOL_STATES,
  unavailableCodingSafeActivityFeed,
  validateCodingSafeActivityFeed,
  type CodingSafeActivityFeed,
} from "./coding-safe-activity.js";

function availableFeed(): CodingSafeActivityFeed {
  return {
    schemaVersion: "1",
    availability: "available",
    runId: "run-safe-activity-1",
    updatedAt: "2026-07-18T17:00:00.000Z",
    turns: [
      {
        turnId: "msg_user_1",
        messages: [
          {
            messageId: "msg_user_1",
            role: "user",
            occurredAt: "2026-07-18T17:00:00.000Z",
            segments: [{ kind: "text", text: "<script>untrusted</script>", truncated: false }],
            truncated: false,
          },
          {
            messageId: "msg_assistant_1",
            role: "assistant",
            occurredAt: "2026-07-18T17:00:00.001Z",
            segments: [{ kind: "text", text: "Rendered as text only.", truncated: false }],
            truncated: false,
          },
        ],
        tools: [
          {
            callId: "call_safe_1",
            tool: "keiko_workspace_read",
            state: "running",
            occurredAt: "2026-07-18T17:00:00.002Z",
          },
        ],
        truncated: false,
      },
    ],
    truncated: false,
    droppedEventCount: 0,
  };
}

describe("coding safe-activity contract", () => {
  it("accepts typed turns and the complete closed tool-state vocabulary", () => {
    for (const state of CODING_SAFE_ACTIVITY_TOOL_STATES) {
      const feed = availableFeed();
      const tool = feed.availability === "available" ? feed.turns[0]?.tools[0] : undefined;
      expect(tool).toBeDefined();
      expect(
        validateCodingSafeActivityFeed({
          ...feed,
          turns:
            feed.availability === "available" && tool !== undefined
              ? [{ ...feed.turns[0], tools: [{ ...tool, state }] }]
              : [],
        }).ok,
      ).toBe(true);
    }
  });

  it("keeps hostile display text as bounded untrusted text without interpreting it", () => {
    const feed = availableFeed();
    expect(validateCodingSafeActivityFeed(feed)).toEqual({ ok: true, value: feed });
  });

  it("rejects unsafe format characters at the wire boundary", () => {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new Error("expected available fixture");
    const turn = feed.turns[0];
    const message = turn?.messages[0];
    const segment = message?.segments[0];
    if (turn === undefined || message === undefined || segment === undefined) {
      throw new Error("expected nested fixture");
    }
    for (const text of ["\u202e", "safe\u200btext"]) {
      expect(
        validateCodingSafeActivityFeed({
          ...feed,
          turns: [
            {
              ...turn,
              messages: [{ ...message, segments: [{ ...segment, text }] }],
            },
          ],
        }).ok,
      ).toBe(false);
    }
  });

  it("requires explicit truncation marks and enforces message, text, counter, and exact-key bounds", () => {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new Error("expected available fixture");
    const turn = feed.turns[0];
    const message = turn?.messages[0];
    const segment = message?.segments[0];
    expect(turn).toBeDefined();
    expect(message).toBeDefined();
    expect(segment).toBeDefined();
    if (turn === undefined || message === undefined || segment === undefined) return;

    const invalid = [
      { ...feed, unexpected: true },
      { ...feed, droppedEventCount: CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT + 1 },
      {
        ...feed,
        turns: [
          {
            ...turn,
            messages: Array.from(
              { length: CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN + 1 },
              () => message,
            ),
          },
        ],
      },
      {
        ...feed,
        turns: [
          {
            ...turn,
            messages: [
              {
                ...message,
                segments: [
                  { ...segment, text: "x".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS + 1) },
                ],
              },
            ],
          },
        ],
      },
      {
        ...feed,
        turns: [
          {
            ...turn,
            messages: [{ ...message, segments: [{ kind: "text", text: "missing mark" }] }],
          },
        ],
      },
      { ...feed, updatedAt: "2026-07-18T17:00:00Z" },
    ];

    for (const value of invalid) expect(validateCodingSafeActivityFeed(value).ok).toBe(false);
  });

  it("represents restart/crash unavailability without reconstructing any turn content", () => {
    const unavailable = unavailableCodingSafeActivityFeed(
      "run-safe-activity-1",
      "2026-07-18T17:00:00.000Z",
    );
    expect(unavailable).toEqual({
      schemaVersion: "1",
      availability: "unavailable",
      runId: "run-safe-activity-1",
      updatedAt: "2026-07-18T17:00:00.000Z",
      droppedEventCount: 0,
    });
    expect(validateCodingSafeActivityFeed(unavailable).ok).toBe(true);
    expect(JSON.stringify(unavailable)).not.toMatch(/turns|messages|segments|tools/u);
  });

  it("rejects malformed feed and turn envelopes at every closed boundary", () => {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new Error("expected available fixture");
    const turn = feed.turns[0];
    if (turn === undefined) throw new Error("expected turn fixture");
    const duplicateTurn = { ...turn, messages: [], tools: [] };
    const invalid = [
      null,
      { ...feed, schemaVersion: "2" },
      { ...feed, availability: "future" },
      { ...feed, runId: "unsafe id" },
      { ...feed, droppedEventCount: -1 },
      { ...feed, droppedEventCount: 1.5 },
      { ...feed, turns: "not-an-array" },
      { ...feed, turns: Array.from({ length: CODING_SAFE_ACTIVITY_MAX_TURNS + 1 }, () => turn) },
      { ...feed, truncated: "false" },
      { ...feed, turns: [null] },
      { ...feed, turns: [{ ...turn, unexpected: true }] },
      { ...feed, turns: [{ ...turn, truncated: "false" }] },
      { ...feed, turns: [{ ...turn, messages: [{ ...turn.messages[0], truncated: true }] }] },
      { ...feed, turns: [duplicateTurn, { ...duplicateTurn }] },
    ];
    for (const value of invalid) expect(validateCodingSafeActivityFeed(value).ok).toBe(false);
  });

  it("rejects malformed messages, segments, and duplicate identities", () => {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new Error("expected available fixture");
    const turn = feed.turns[0];
    const message = turn?.messages[0];
    const segment = message?.segments[0];
    if (turn === undefined || message === undefined || segment === undefined) {
      throw new Error("expected nested fixture");
    }
    const messages = (value: unknown): CodingSafeActivityFeed => ({
      ...feed,
      turns: [{ ...turn, messages: value as never }],
    });
    const invalid = [
      messages("not-an-array"),
      messages([null]),
      messages([{ ...message, unexpected: true }]),
      messages([{ ...message, role: "system" }]),
      messages([{ ...message, occurredAt: "2026-02-30T00:00:00.000Z" }]),
      messages([{ ...message, truncated: "false" }]),
      messages([{ ...message, segments: [{ ...segment, truncated: true }] }]),
      messages([{ ...message }, { ...message }]),
      messages([{ ...message, segments: "not-an-array" }]),
      messages([
        {
          ...message,
          segments: Array.from(
            { length: CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE + 1 },
            () => segment,
          ),
        },
      ]),
      messages([{ ...message, segments: [null] }]),
      messages([{ ...message, segments: [{ ...segment, unexpected: true }] }]),
      messages([{ ...message, segments: [{ ...segment, kind: "markup" }] }]),
      messages([{ ...message, segments: [{ ...segment, text: "" }] }]),
      messages([{ ...message, segments: [{ ...segment, truncated: "false" }] }]),
      messages([
        {
          ...message,
          segments: Array.from({ length: 4 }, () => ({
            ...segment,
            text: "x".repeat(CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS),
          })),
        },
      ]),
    ];
    for (const value of invalid) expect(validateCodingSafeActivityFeed(value).ok).toBe(false);
  });

  it("rejects malformed tools and aggregate byte-budget overflow", () => {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new Error("expected available fixture");
    const turn = feed.turns[0];
    const tool = turn?.tools[0];
    if (turn === undefined || tool === undefined) throw new Error("expected tool fixture");
    const tools = (value: unknown): CodingSafeActivityFeed => ({
      ...feed,
      turns: [{ ...turn, tools: value as never }],
    });
    const invalidTools = [
      tools("not-an-array"),
      tools(Array.from({ length: CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN + 1 }, () => tool)),
      tools([null]),
      tools([{ ...tool, unexpected: true }]),
      tools([{ ...tool, callId: "unsafe id" }]),
      tools([{ ...tool, tool: "x".repeat(129) }]),
      tools([{ ...tool, state: "complete" }]),
      tools([{ ...tool, occurredAt: "invalid" }]),
      tools([{ ...tool }, { ...tool }]),
    ];
    for (const value of invalidTools) {
      expect(validateCodingSafeActivityFeed(value).ok).toBe(false);
    }

    const oversizedTurns = Array.from({ length: 5 }, (_, turnIndex) => ({
      turnId: `turn_${String(turnIndex)}`,
      messages: [
        {
          messageId: `message_${String(turnIndex)}`,
          role: "assistant" as const,
          occurredAt: "2026-07-18T17:00:00.000Z",
          segments: Array.from({ length: 4 }, () => ({
            kind: "text" as const,
            text: "x".repeat(3_500),
            truncated: false,
          })),
          truncated: false,
        },
      ],
      tools: [],
      truncated: false,
    }));
    expect(validateCodingSafeActivityFeed({ ...feed, turns: oversizedTurns }).ok).toBe(false);
  });
});
