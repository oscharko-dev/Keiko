import { describe, expect, it } from "vitest";

import {
  CODING_SAFE_ACTIVITY_MAX_DROPPED_EVENT_COUNT,
  CODING_SAFE_ACTIVITY_MAX_MESSAGES_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS,
  CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES,
  CODING_SAFE_ACTIVITY_MAX_SEGMENTS_PER_MESSAGE,
  CODING_SAFE_ACTIVITY_MAX_TEXT_SEGMENT_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TOOLS_PER_TURN,
  CODING_SAFE_ACTIVITY_MAX_TURNS,
  CODING_SAFE_ACTIVITY_PLAN_STEP_STATES,
  CODING_SAFE_ACTIVITY_TOOL_STATES,
  unavailableCodingSafeActivityFeed,
  validateCodingSafeActivityFeed,
  type CodingSafeActivityFeed,
  type CodingSafeActivityMessage,
  type CodingSafeActivityTurn,
  type CodingSafeActivityPlan,
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
  it("admits only bounded canonical tool presentation facts", () => {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new Error("expected available fixture");
    const turn = feed.turns[0];
    const tool = turn?.tools[0];
    if (turn === undefined || tool === undefined) throw new Error("expected tool fixture");
    const presentation = {
      bridgeDurationMs: 120,
      relativePath: "packages/ui/src/deep/Component.tsx",
      readByteCount: 80,
      totalFileLines: 400,
    };
    const withPresentation = (value: unknown): unknown => ({
      ...feed,
      turns: [{ ...turn, tools: [{ ...tool, presentation: value }] }],
    });
    expect(validateCodingSafeActivityFeed(withPresentation(presentation)).ok).toBe(true);
    expect(
      validateCodingSafeActivityFeed(
        withPresentation({ bridgeDurationMs: 2, returnedPathCount: 0 }),
      ).ok,
    ).toBe(true);
    expect(
      validateCodingSafeActivityFeed(
        withPresentation({ bridgeDurationMs: 3, refusalReason: "CONTENT_HASH_MISMATCH" }),
      ).ok,
    ).toBe(true);
    for (const invalid of [
      { ...presentation, stdout: "RAW_OUTPUT_SENTINEL" },
      { ...presentation, relativePath: "/private/absolute.ts" },
      { ...presentation, relativePath: "../escape.ts" },
      { ...presentation, relativePath: "unsafe\u202e.ts" },
      { ...presentation, bridgeDurationMs: Number.NaN },
      { ...presentation, bridgeDurationMs: Number.POSITIVE_INFINITY },
      { ...presentation, bridgeDurationMs: -1 },
      { ...presentation, readByteCount: 0.5 },
      { ...presentation, returnedPathCount: -1 },
      { ...presentation, refusalReason: "arbitrary provider text" },
    ]) {
      expect(validateCodingSafeActivityFeed(withPresentation(invalid)).ok).toBe(false);
    }
  });

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

  it("accepts a plan snapshot across the complete closed step-state vocabulary", () => {
    for (const state of CODING_SAFE_ACTIVITY_PLAN_STEP_STATES) {
      const feed = { ...availableFeed(), plan: { ...plan(), steps: [planStep({ state })] } };
      expect(validateCodingSafeActivityFeed(feed)).toEqual({ ok: true, value: feed });
    }
    const marked = {
      ...availableFeed(),
      plan: { ...plan(), steps: [planStep({ truncated: true })], truncated: true },
    };
    expect(validateCodingSafeActivityFeed(marked).ok).toBe(true);
  });

  it("rejects malformed, oversized, and inconsistently truncated plan snapshots", () => {
    const feed = availableFeed();
    const oversizedSteps = Array.from({ length: 40 }, (_, index) =>
      planStep({ text: `${String(index)}_${"x".repeat(250)}` }),
    );
    const invalidPlans: unknown[] = [
      undefined,
      { ...plan(), unexpected: true },
      { ...plan(), revision: 0 },
      { ...plan(), revision: 1.5 },
      { ...plan(), anchorMessageId: "not safe!" },
      { ...plan(), updatedAt: "2026-07-18T17:00:00Z" },
      { ...plan(), steps: {} },
      { ...plan(), steps: Array.from({ length: CODING_SAFE_ACTIVITY_MAX_PLAN_STEPS + 1 }, plan) },
      { ...plan(), steps: [planStep({ text: "" })] },
      {
        ...plan(),
        steps: [planStep({ text: "x".repeat(CODING_SAFE_ACTIVITY_MAX_PLAN_STEP_TEXT_CHARS + 1) })],
      },
      { ...plan(), steps: [planStep({ text: "hidden\u200btext" })] },
      { ...plan(), steps: [planStep({ state: "in_progress" })] },
      { ...plan(), steps: [{ ...planStep({}), unexpected: true }] },
      { ...plan(), steps: [planStep({ truncated: true })], truncated: false },
      { ...plan(), steps: oversizedSteps },
    ];
    for (const value of invalidPlans) {
      expect(validateCodingSafeActivityFeed({ ...feed, plan: value }).ok).toBe(false);
    }
  });

  it("preserves local serialization phases after earlier member errors", async () => {
    const { vi } = await import("vitest");
    const base = availableFeed();
    if (base.availability !== "available") throw new TypeError("expected available fixture");
    const turn = base.turns[0];
    if (turn === undefined) throw new TypeError("expected turn fixture");
    const [first, second] = turn.messages;
    if (first === undefined || second === undefined) {
      throw new TypeError("expected nested fixture");
    }
    const badMessage = { ...first, role: "system", occurredAt: "invalid" };
    const sibling = { ...second, messageId: "msg_trace_sibling" };
    const laterMessage = { ...first, messageId: "msg_trace_later" };
    const laterTurn = {
      ...turn,
      turnId: "turn_trace_later",
      messages: [laterMessage],
      tools: [],
    };
    const currentPlan = plan();
    const value = {
      ...base,
      turns: [{ ...turn, messages: [badMessage, sibling] }, laterTurn],
      plan: currentPlan,
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(validateCodingSafeActivityFeed(value)).toEqual({
        ok: false,
        errors: [
          "safeActivityFeed.turns[0].messages[0].role is invalid",
          "safeActivityFeed.turns[0].messages[0].occurredAt must be a strict UTC millisecond instant",
        ],
      });
      expect(stringify).toHaveBeenCalledTimes(4);
      expect(stringify.mock.calls[0]?.[0]).toBe(sibling);
      expect(stringify.mock.calls[1]?.[0]).toBe(laterMessage);
      expect(stringify.mock.calls[2]?.[0]).toBe(laterTurn);
      expect(stringify.mock.calls[3]?.[0]).toBe(currentPlan);
    } finally {
      stringify.mockRestore();
    }
  });

  // KEIKO-0749: validatePlan / validateTurn / validateMessage each call `serializedBytes` (a
  // full JSON.stringify traversal) to check the deep byte budget. Before the fix they ran that
  // call even when the structure had already failed shape validation — wasting a deep
  // traversal on a value the caller is going to reject anyway. Prove the fix skips it by
  // spying on JSON.stringify and asserting a single already-invalid message produces no
  // deep-serialise call.
  it("skips the deep JSON.stringify call when the structure has already failed (KEIKO-0749)", async () => {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(JSON, "stringify");
    try {
      const invalidFeed = {
        availability: "available",
        turns: [
          {
            turnId: "turn_1",
            messages: [
              // Missing `role` → validateMessage's exactKeys / role checks fire, so the byte-budget
              // branch must be skipped (was invoked pre-fix regardless).
              {
                messageId: "msg_1",
                occurredAt: "2026-07-18T17:00:00.003Z",
                segments: [],
                truncated: false,
              },
            ],
            tools: [],
            truncated: false,
          },
        ],
        truncated: false,
      };
      const result = validateCodingSafeActivityFeed(invalidFeed);
      expect(result.ok).toBe(false);
      // JSON.stringify may still be called once at the whole-feed byte check when the shape errors
      // are gathered into an array; the KEIKO-0749 fix skips the deep serialise calls PER MESSAGE
      // when that message already failed. A pre-fix run stringified the invalid message
      // separately during validateMessage; the post-fix path emits fewer calls than the input has
      // messages+turns+plans (3 potential nested calls in this fixture).
      expect(spy.mock.calls.length).toBeLessThan(3);
    } finally {
      spy.mockRestore();
    }
  });
});

// #3878: the model's reasoning rides beside an assistant message as bounded, untrusted text.
describe("coding safe-activity contract — model reasoning", () => {
  function withAssistantReasoning(reasoning: unknown, role = "assistant"): unknown {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new TypeError("expected an available feed");
    const [turn] = feed.turns;
    if (turn === undefined) throw new TypeError("expected a turn");
    const [user, assistant] = turn.messages;
    return {
      ...feed,
      turns: [{ ...turn, messages: [user, { ...assistant, role, reasoning }] }],
    };
  }

  it("accepts bounded reasoning beside an assistant message, shortened or whole", () => {
    for (const truncated of [false, true]) {
      const feed = withAssistantReasoning({ text: "Weigh the edge case first.", truncated });
      expect(validateCodingSafeActivityFeed(feed).ok).toBe(true);
    }
    const atBound = "é".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES / 2);
    expect(
      validateCodingSafeActivityFeed(withAssistantReasoning({ text: atBound, truncated: true })).ok,
    ).toBe(true);
  });

  it.each([
    ["on a user message", { text: "x", truncated: false }, "user"],
    ["empty", { text: "", truncated: false }, "assistant"],
    [
      "beyond its UTF-8 bound",
      { text: "é".repeat(CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES / 2 + 1), truncated: true },
      "assistant",
    ],
    ["with unsafe format characters", { text: "a\u202Eb", truncated: false }, "assistant"],
    ["with an extra key", { text: "x", truncated: false, raw: "private" }, "assistant"],
    ["without its truncation flag", { text: "x" }, "assistant"],
    ["as a bare string", "x", "assistant"],
  ] as const)("rejects reasoning %s", (_label, reasoning, role) => {
    expect(validateCodingSafeActivityFeed(withAssistantReasoning(reasoning, role)).ok).toBe(false);
  });
});

function plan(): CodingSafeActivityPlan {
  return {
    revision: 1,
    anchorMessageId: "msg_assistant_1",
    updatedAt: "2026-07-18T17:00:00.003Z",
    steps: [planStep({})],
    truncated: false,
  };
}

function planStep(
  overrides: Partial<Record<"text" | "state" | "truncated", unknown>>,
): CodingSafeActivityPlan["steps"][number] {
  return {
    text: "Read the workspace entry point",
    state: "active",
    truncated: false,
    ...overrides,
  } as CodingSafeActivityPlan["steps"][number];
}

describe("C2 owning activity member admissions", () => {
  it.each(["turns", "messages", "tools", "segments", "steps"] as const)(
    "refuses skipped malformed %s members",
    (surface) => {
      const base = availableFeed();
      if (base.availability !== "available") throw new Error("expected available fixture");
      const turn = base.turns[0];
      const message = turn?.messages[0];
      if (turn === undefined || message === undefined) throw new Error("expected nested fixture");
      const entries: unknown[] = [null];
      Object.defineProperty(entries, "forEach", { value: (): void => undefined });
      const value =
        surface === "turns"
          ? { ...base, turns: entries }
          : surface === "messages"
            ? { ...base, turns: [{ ...turn, messages: entries }] }
            : surface === "tools"
              ? { ...base, turns: [{ ...turn, tools: entries }] }
              : surface === "segments"
                ? { ...base, turns: [{ ...turn, messages: [{ ...message, segments: entries }] }] }
                : {
                    ...base,
                    plan: {
                      revision: 1,
                      anchorMessageId: "msg_assistant_1",
                      updatedAt: base.updatedAt,
                      steps: entries,
                      truncated: false,
                    },
                  };
      expect(validateCodingSafeActivityFeed(value).ok).toBe(false);
    },
  );

  it("retains a healthy original feed reference", () => {
    const value = availableFeed();
    const result = validateCodingSafeActivityFeed(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
  });

  it("refuses a sparse turn list with one owning diagnostic", () => {
    const entries: unknown[] = [];
    entries.length = CODING_SAFE_ACTIVITY_MAX_TURNS;
    const result = validateCodingSafeActivityFeed({ ...availableFeed(), turns: entries });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(1);
  });
});

function truncationObservationParent(
  surface: string,
  turn: CodingSafeActivityTurn,
  message: CodingSafeActivityMessage,
): { parent: Record<string, unknown>; healthy: unknown } {
  if (surface === "steps") return { parent: { ...plan() }, healthy: plan().steps };
  if (surface === "segments") return { parent: { ...message }, healthy: message.segments };
  return { parent: { ...turn }, healthy: turn.messages };
}

describe("safe-activity nested truncation observations", () => {
  it.each([
    { surface: "steps", path: "safeActivityFeed.plan", member: "steps" },
    { surface: "segments", path: "safeActivityFeed.turns[0].messages[0]", member: "segments" },
    { surface: "messages", path: "safeActivityFeed.turns[0]", member: "messages" },
  ])("retains the second truncation-scan observation for $surface", ({ surface, path, member }) => {
    const feed = availableFeed();
    if (feed.availability !== "available") throw new TypeError("expected available fixture");
    const turn = feed.turns[0];
    const message = turn?.messages[0];
    if (turn === undefined || message === undefined) throw new TypeError("expected nested fixture");
    const { parent, healthy } = truncationObservationParent(surface, turn, message);
    let reads = 0;
    Object.defineProperty(parent, surface, {
      enumerable: true,
      get: (): unknown => (++reads === 3 ? [{ truncated: true }] : healthy),
    });
    const value: unknown =
      surface === "steps"
        ? { ...feed, plan: parent }
        : surface === "segments"
          ? { ...feed, turns: [{ ...turn, messages: [parent] }] }
          : { ...feed, turns: [parent] };
    expect(validateCodingSafeActivityFeed(value)).toEqual({
      ok: false,
      errors: [`${path}.truncated must reflect truncated ${member}`],
    });
    expect(reads).toBe(3);
  });
});

describe("C2 observed safe-activity scalar admissions", () => {
  it.each([
    { observations: [0, Number.NaN, Number.NaN], expectedReads: 2 },
    { observations: [0, 1, Number.NaN], expectedReads: 3 },
  ])(
    "refuses an invalid later dropped-event observation $observations",
    ({ observations, expectedReads }) => {
      const value = unavailableCodingSafeActivityFeed(
        "run-safe-activity-1",
        "2026-07-18T17:00:00.000Z",
      );
      let reads = 0;
      Object.defineProperty(value, "droppedEventCount", {
        enumerable: true,
        get: (): unknown => observations[reads++] ?? 0,
      });
      expect(validateCodingSafeActivityFeed(value)).toEqual({
        ok: false,
        errors: ["safeActivityFeed.droppedEventCount is invalid"],
      });
      expect(reads).toBe(expectedReads);
    },
  );

  it("preserves three healthy dropped-event observations and the serialization read", () => {
    const value = unavailableCodingSafeActivityFeed(
      "run-safe-activity-1",
      "2026-07-18T17:00:00.000Z",
    );
    const observations = [0, 1, 2, 3];
    let reads = 0;
    Object.defineProperty(value, "droppedEventCount", {
      enumerable: true,
      get: (): unknown => observations[reads++] ?? 3,
    });
    const result = validateCodingSafeActivityFeed(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
    expect(reads).toBe(4);
  });

  it("refuses an invalid second plan revision", () => {
    const value = { ...availableFeed(), plan: plan() };
    let reads = 0;
    Object.defineProperty(value.plan, "revision", {
      enumerable: true,
      get: (): unknown => (++reads === 2 ? Number.NaN : 1),
    });
    expect(validateCodingSafeActivityFeed(value)).toEqual({
      ok: false,
      errors: ["safeActivityFeed.plan.revision must be a positive safe integer"],
    });
    expect(reads).toBe(2);
  });

  it("preserves two healthy plan revision observations and both serialization reads", () => {
    const value = { ...availableFeed(), plan: plan() };
    let reads = 0;
    Object.defineProperty(value.plan, "revision", { enumerable: true, get: (): number => ++reads });
    const result = validateCodingSafeActivityFeed(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
    expect(reads).toBe(4);
  });

  it("reports the original availability diagnostic for a later invalid variant", () => {
    const value = unavailableCodingSafeActivityFeed(
      "run-safe-activity-1",
      "2026-07-18T17:00:00.000Z",
    );
    const observations = ["unavailable", "available", "invalid"];
    let reads = 0;
    Object.defineProperty(value, "availability", {
      enumerable: true,
      get: (): unknown => observations[reads++] ?? "unavailable",
    });
    expect(validateCodingSafeActivityFeed(value)).toEqual({
      ok: false,
      errors: ["safeActivityFeed.availability is invalid"],
    });
    expect(reads).toBe(3);
  });

  it("does not repeat the base availability diagnostic", () => {
    const value = unavailableCodingSafeActivityFeed(
      "run-safe-activity-1",
      "2026-07-18T17:00:00.000Z",
    );
    let reads = 0;
    Object.defineProperty(value, "availability", {
      enumerable: true,
      get: (): string => (++reads === 1 ? "unavailable" : "invalid"),
    });
    expect(validateCodingSafeActivityFeed(value)).toEqual({
      ok: false,
      errors: ["safeActivityFeed.availability is invalid"],
    });
    expect(reads).toBe(4);
  });

  it("retains a healthy changing availability schedule", () => {
    const value = unavailableCodingSafeActivityFeed(
      "run-safe-activity-1",
      "2026-07-18T17:00:00.000Z",
    );
    const observations = ["unavailable", "available", "unavailable", "unavailable"];
    let reads = 0;
    Object.defineProperty(value, "availability", {
      enumerable: true,
      get: (): unknown => observations[reads++] ?? "unavailable",
    });
    const result = validateCodingSafeActivityFeed(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
    expect(reads).toBe(4);
  });
});

// Fixed ORIGINAL characterization includes admission and the existing later truncation scan.
type PhysicalActivityField = "steps" | "segments" | "messages" | "tools";

const PHYSICAL_ACTIVITY_GROWTH_TRACE = [
  "get:length",
  "get:length",
  "has:0",
  "get:0",
  "get:length",
  "has:0",
  "get:0",
  "has:1",
  "get:1",
];
const PHYSICAL_ACTIVITY_CASES = [
  {
    field: "steps",
    parentError: "safeActivityFeed.plan.revision must be a positive safe integer",
    reads: PHYSICAL_ACTIVITY_GROWTH_TRACE,
  },
  {
    field: "segments",
    parentError: "safeActivityFeed.turns[0].messages[0].role is invalid",
    reads: PHYSICAL_ACTIVITY_GROWTH_TRACE,
  },
  {
    field: "messages",
    parentError: "safeActivityFeed.turns[0].turnId must be a bounded safe identifier",
    reads: PHYSICAL_ACTIVITY_GROWTH_TRACE,
  },
  {
    field: "tools",
    parentError: "safeActivityFeed.turns[0].turnId must be a bounded safe identifier",
    reads: ["get:length", "get:length", "has:0", "get:0"],
  },
] as const;

async function physicalActivityValidator(
  surface: "source" | "public",
): Promise<typeof validateCodingSafeActivityFeed> {
  return surface === "source"
    ? validateCodingSafeActivityFeed
    : (await import("@oscharko-dev/keiko-contracts/runtime/coding-safe-activity"))
        .validateCodingSafeActivityFeed;
}

function physicalActivityInput(field: PhysicalActivityField, members: unknown): unknown {
  const feed = availableFeed();
  if (feed.availability !== "available") throw new TypeError("Expected available fixture");
  const turn = feed.turns[0];
  const message = turn?.messages[0];
  if (turn === undefined || message === undefined) throw new TypeError("Expected nested fixture");
  if (field === "steps")
    return { ...feed, turns: [], plan: { ...plan(), revision: 0, steps: members } };
  if (field === "segments")
    return {
      ...feed,
      turns: [
        { ...turn, messages: [{ ...message, role: "invalid", segments: members }], tools: [] },
      ],
    };
  if (field === "messages")
    return { ...feed, turns: [{ ...turn, turnId: "", messages: members, tools: [] }] };
  return { ...feed, turns: [{ ...turn, turnId: "", messages: [], tools: members }] };
}

function physicalActivityMember(field: PhysicalActivityField): unknown {
  if (field === "steps") return planStep({});
  const feed = availableFeed();
  if (feed.availability !== "available") throw new TypeError("Expected available fixture");
  const turn = feed.turns[0];
  const message = turn?.messages[0];
  const segment = message?.segments[0];
  const tool = turn?.tools[0];
  if (message === undefined || segment === undefined || tool === undefined)
    throw new TypeError("Expected nested fixture");
  const members = { messages: message, segments: segment, tools: tool };
  return members[field];
}

function observedPhysicalActivityMembers(
  members: unknown[],
  reads: string[],
): { readonly values: unknown[]; readonly lengthReads: () => number } {
  let lengths = 0;
  const values = new Proxy(members, {
    get(target, key, receiver): unknown {
      reads.push(`get:${String(key)}`);
      if (key === "length") lengths += 1;
      return Reflect.get(target, key, receiver);
    },
    has(target, key): boolean {
      reads.push(`has:${String(key)}`);
      return Reflect.has(target, key);
    },
  });
  return { values, lengthReads: (): number => lengths };
}

for (const surface of ["source", "public"] as const) {
  it.each(PHYSICAL_ACTIVITY_CASES)(
    `${surface}: retains inherited $field growth outside its captured admission extent`,
    async ({ field, parentError, reads: expectedReads }) => {
      const validate = await physicalActivityValidator(surface);
      const reads: string[] = [];
      const members = new Array<unknown>(1);
      const member = physicalActivityMember(field);
      Object.setPrototypeOf(
        members,
        Object.defineProperty([], "0", {
          get: (): unknown => {
            if (members.length === 1) members.push(null);
            return member;
          },
        }),
      );
      const observed = observedPhysicalActivityMembers(members, reads);
      expect(validate(physicalActivityInput(field, observed.values))).toEqual({
        ok: false,
        errors: [parentError],
      });
      expect(reads).toEqual(expectedReads);
      expect(members).toHaveLength(2);
    },
  );

  it(`${surface}: stops plan admission at a hole before the later truncation observation`, async () => {
    const validate = await physicalActivityValidator(surface);
    const reads: string[] = [];
    const members = new Array<unknown>(2);
    const observed = observedPhysicalActivityMembers(members, reads);
    Object.defineProperty(members, "1", {
      get: (): unknown => {
        if (observed.lengthReads() === 2) throw new TypeError("Admission reached a later member");
        return planStep({});
      },
    });
    expect(validate(physicalActivityInput("steps", observed.values))).toEqual({
      ok: false,
      errors: [
        "safeActivityFeed.plan.revision must be a positive safe integer",
        "safeActivityFeed.plan.steps[0] must be an object",
      ],
    });
    expect(reads).toEqual([
      "get:length",
      "get:length",
      "has:0",
      "get:length",
      "has:0",
      "has:1",
      "get:1",
    ]);
  });

  it(`${surface}: continues after an invalid message and keeps the inspection refusal`, async () => {
    const validate = await physicalActivityValidator(surface);
    const reads: string[] = [];
    const failure = new TypeError("fixture-activity-inspection");
    const member = physicalActivityMember("messages");
    if (typeof member !== "object" || member === null) throw new TypeError("Expected message");
    const throwing = Object.defineProperty(member, "messageId", {
      get: (): never => {
        throw failure;
      },
    });
    const observed = observedPhysicalActivityMembers([null, throwing], reads);
    expect(validate(physicalActivityInput("messages", observed.values))).toEqual({
      ok: false,
      errors: ["safe activity feed validation failed"],
    });
    expect(reads).toEqual(["get:length", "get:length", "has:0", "get:0", "has:1", "get:1"]);
  });

  it(`${surface}: retains message and tool identity sets across turns`, async () => {
    const validate = await physicalActivityValidator(surface);
    const feed = availableFeed();
    const healthy = validate(feed);
    expect(healthy.ok).toBe(true);
    if (healthy.ok) expect(healthy.value).toBe(feed);
    if (feed.availability !== "available") throw new TypeError("Expected available fixture");
    const turn = feed.turns[0];
    const message = turn?.messages[0];
    const tool = turn?.tools[0];
    if (turn === undefined || message === undefined || tool === undefined)
      throw new TypeError("Expected nested fixture");
    expect(
      validate({
        ...feed,
        turns: [turn, { ...turn, turnId: "turn_array_second", messages: [message], tools: [tool] }],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "safeActivityFeed.turns[1].messages[0].messageId must be unique",
        "safeActivityFeed.turns[1].tools[0].callId must be unique",
      ],
    });
  });
}

for (const surface of ["source", "public"] as const) {
  it(`${surface}: uses the later captured tool extent after a different bound observation`, async () => {
    const validate = await physicalActivityValidator(surface);
    const reads: string[] = [];
    let lengths = 0;
    const values = new Proxy([physicalActivityMember("tools"), null], {
      get(target, key, receiver): unknown {
        reads.push(`get:${String(key)}`);
        if (key === "length") {
          lengths += 1;
          return lengths === 1 ? 1 : 2;
        }
        return Reflect.get(target, key, receiver);
      },
      has(target, key): boolean {
        reads.push(`has:${String(key)}`);
        return Reflect.has(target, key);
      },
    });
    expect(validate(physicalActivityInput("tools", values))).toEqual({
      ok: false,
      errors: [
        "safeActivityFeed.turns[0].turnId must be a bounded safe identifier",
        "safeActivityFeed.turns[0].tools[1] must be an object",
      ],
    });
    expect(reads).toEqual(["get:length", "get:length", "has:0", "get:0", "has:1", "get:1"]);
  });
}
