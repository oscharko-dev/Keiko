import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { describe, expect, it, vi } from "vitest";
import { CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import { OPENCODE_MODEL_VISIBLE_TOOL_NAMES } from "./opencodeToolSchemas.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import { createOpenCodeReconciler } from "./opencodeReconciler.js";
import { recordCompactionActivity } from "./opencodeRuntimeAdapter.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

function toolHistory(name: string, status = "completed"): readonly Record<string, unknown>[] {
  return [
    { id: "msg_user", type: "user", time: { created: 1 }, text: "Ask me a question." },
    {
      id: "msg_assistant",
      type: "assistant",
      time: { created: 2 },
      content: [
        {
          type: "tool",
          id: "call_question",
          name,
          time: { created: 2 },
          state: {
            status,
            input:
              status === "streaming" ? "PRIVATE_ARGUMENT" : { questions: ["PRIVATE_ARGUMENT"] },
            output: "PRIVATE_ANSWER",
          },
        },
      ],
    },
  ];
}

describe("OpenCode V2 native tool history", () => {
  it("retries durable capture until accepted and skips unchanged acknowledged content", () => {
    const captureMessages = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const projection = createOpenCodeV2HistoryProjection({
      runId: "durable-history-run",
      activityLog: undefined,
      captureMessages,
    });
    const messages = toolHistory("question");
    const first = projection.project("ses_capture", messages, undefined);
    const checkpoint = first.at(-1)?.sequence;
    projection.project("ses_capture", messages, checkpoint);
    projection.project("ses_capture", messages, checkpoint);
    expect(captureMessages).toHaveBeenCalledTimes(2);
    expect(captureMessages).toHaveBeenLastCalledWith([
      { messageId: "msg_user", role: "user", content: "Ask me a question." },
      { messageId: "msg_assistant", role: "assistant", content: "" },
    ]);
  });

  it("records each native question transition once with body-free call identity", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection({
      runId: "question-history-run",
      activityLog: sink,
    });
    let checkpoint: number | undefined;
    for (const state of ["streaming", "running", "completed", "error"]) {
      const messages = toolHistory("question", state);
      const events = projection.project("ses_question", messages, checkpoint);
      // An unacknowledged page is replayed but must not double-log its transition.
      projection.project("ses_question", messages, checkpoint);
      checkpoint = events.at(-1)?.sequence;
    }
    const events = sink.events.filter(
      (event) => event.op === "coding-runtime.native-question.observed",
    );
    expect(events).toHaveLength(4);
    const records = events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.native-question.observed.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );
    expect(records.map((event) => event.state)).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
    ]);
    expect(new Set(records.map((event) => event.callDigest)).size).toBe(1);
    for (const event of records) {
      expect(event).toMatchObject({
        op: "coding-runtime.native-question.observed",
        correlationId: "question-history-run",
        callDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
      });
    }
    expect(records.at(-1)).toMatchObject({
      errorKind: "internal",
      failureReason: "native-tool-error",
    });
    expect(records.slice(0, -1).every((record) => record.errorKind === undefined)).toBe(true);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    expect(JSON.stringify(records)).not.toContain("call_question");
  });

  it("classifies a missing tool identity before malformed arguments", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const history = [
      { id: "msg_user", type: "user", time: { created: 0 }, text: "Task" },
      {
        id: "msg_assistant",
        type: "assistant",
        time: { created: 1 },
        content: [{ type: "tool", id: "call_1", state: { status: "streaming", input: 123 } }],
      },
    ];
    expect(() => projection.project("ses_invalid", history, undefined)).toThrow(
      "opencode-v2-tool-invalid",
    );
  });

  it.each(["Help", "He", ""])(
    "rejects a rewritten text prefix without advancing history: %s",
    (changed) => {
      const projection = createOpenCodeV2HistoryProjection();
      const user = { id: "msg_user", type: "user", time: { created: 1 }, text: "Hello" };
      const initial = projection.project("ses_stream", [user], undefined);
      const checkpoint = initial.at(-1)?.sequence;
      expect(() =>
        projection.project("ses_stream", [{ ...user, text: changed }], checkpoint),
      ).toThrow("opencode-v2-history-invalid");
      const resumed = projection.project(
        "ses_stream",
        [{ ...user, text: "Hello world" }],
        checkpoint,
      );
      expect(resumed.map((event) => projection.takeSignal(event))).toEqual([
        {
          kind: "text",
          messageId: "msg_user",
          text: " world",
          occurredAt: "1970-01-01T00:00:00.001Z",
        },
      ]);
    },
  );

  // A runtime whose history grows by suffix between pulls. The pinned 2.0.10 persists a streamed part
  // only empty and then complete, so this is the contract for a history that does grow, not what that
  // runtime produces: what it streams in between is pinned under "OpenCode V2 live streamed text".
  it("emits only new characters from a text part whose history grows by suffix", () => {
    const projection = createOpenCodeV2HistoryProjection();
    let checkpoint: number | undefined;
    const deltas: string[] = [];
    for (const text of ["", "Hello", "Hello world", "Hello world"]) {
      const events = projection.project(
        "ses_stream",
        [
          { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" },
          {
            id: "msg_assistant",
            type: "assistant",
            time: { created: 2 },
            content: [{ type: "text", text }],
          },
        ],
        checkpoint,
      );
      for (const event of events) {
        const signal = projection.takeSignal(event);
        if (signal?.kind === "text" && signal.messageId === "msg_assistant")
          deltas.push(signal.text);
      }
      checkpoint = events.at(-1)?.sequence ?? checkpoint;
    }
    expect(deltas).toEqual(["Hello", " world"]);
  });

  it.each(["user", "assistant"])("keeps an empty %s placeholder out of visible text", (role) => {
    const projection = createOpenCodeV2HistoryProjection();
    const user = {
      id: "msg_user",
      type: "user",
      time: { created: 1 },
      text: role === "user" ? "" : "Task",
    };
    const assistant = {
      id: "msg_assistant",
      type: "assistant",
      time: { created: 2 },
      content: [{ type: "text", text: "" }],
    };
    const messages = [user, assistant];
    const events = projection.project("ses_text", messages, undefined);
    const signals = events.map((event) => projection.takeSignal(event));
    expect(signals.filter((signal) => signal?.kind === "text" && signal.text === "")).toEqual([]);
    expect(signals.filter((signal) => signal?.kind === "message")).toHaveLength(2);
    expect(projection.project("ses_text", messages, undefined)).toEqual(events);
    const grown = projection.project(
      "ses_text",
      [user, { ...assistant, content: [{ type: "text", text: "Done" }] }],
      events.at(-1)?.sequence,
    );
    expect(grown).toHaveLength(1);
    expect(grown.map((event) => projection.takeSignal(event))).toEqual([
      {
        kind: "text",
        messageId: "msg_assistant",
        text: "Done",
        occurredAt: "1970-01-01T00:00:00.002Z",
      },
    ]);
  });

  it("logs reconciled placeholders once per checkpoint without classifying content loss", () => {
    const activityLog = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-native-history",
      activityLog,
    });
    const messages = [{ id: "msg_private", type: "user", time: { created: 1 }, text: "" }];
    const events = projection.project("ses_private", messages, undefined);
    projection.project("ses_private", messages, undefined);
    expect(projection.project("ses_private", messages, events.at(-1)?.sequence)).toEqual([]);
    expect(activityLog.events).toHaveLength(1);
    const event = activityLog.events[0];
    if (event === undefined) throw new Error("Expected the history projection event");
    const line = formatActivityLogProofLine(event);
    expect(
      expectActivityLogProof("coding-runtime.history-projection.emitted-line", line),
    ).toMatchObject({
      correlationId: "run-native-history",
      eventCount: 3,
      signalCount: 1,
      emptyTextCount: 1,
      completeness: "complete",
      loss: "none",
    });
    expect(line).not.toContain("private");
  });

  it.each([
    ["streaming", "pending"],
    ["running", "running"],
    ["completed", "succeeded"],
    ["error", "failed"],
  ])("projects a native question in state %s without exposing arguments", (status, state) => {
    const projection = createOpenCodeV2HistoryProjection();
    const events = projection.project("ses_question", toolHistory("question", status), undefined);
    const signals = events.map((event) => projection.takeSignal(event));
    expect(signals).toContainEqual({
      kind: "tool",
      messageId: "msg_assistant",
      callId: "call_question",
      tool: "question",
      state,
      occurredAt: "1970-01-01T00:00:00.002Z",
    });
    expect(JSON.stringify({ events, signals })).not.toContain("PRIVATE_");
  });

  it.each(OPENCODE_MODEL_VISIBLE_TOOL_NAMES)("admits the registered tool %s", (name) => {
    const projection = createOpenCodeV2HistoryProjection();
    expect(() => projection.project("ses_tools", toolHistory(name), undefined)).not.toThrow();
  });

  it.each(["keiko_undeclared", "bash", "todowrite"])(
    "rejects an undeclared or retired tool %s",
    (name) => {
      const projection = createOpenCodeV2HistoryProjection();
      expect(() => projection.project("ses_tools", toolHistory(name), undefined)).toThrow(
        "opencode-v2-tool-invalid",
      );
    },
  );
});

// #3878: OpenCode records the model's reasoning (`reasoning_content`) as a `reasoning` content
// part. It reaches the live timeline as its own growing signal and never Coding History. The pulls
// below model a history that grows by suffix; the pinned 2.0.10 persists the part empty and then
// complete, and its stream in between is pinned under "OpenCode V2 live streamed text".
describe("OpenCode V2 native reasoning history", () => {
  function reasoningHistory(
    reasoning: string,
    text?: string,
  ): readonly Readonly<Record<string, unknown>>[] {
    return [
      { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" },
      {
        id: "msg_assistant",
        type: "assistant",
        time: { created: 2 },
        content: [
          { type: "reasoning", text: reasoning },
          ...(text === undefined ? [] : [{ type: "text", text }]),
        ],
      },
    ];
  }

  it("emits reasoning as its own suffix signals and keeps it out of Coding History", () => {
    const activityLog = createBufferedServerLogSink();
    const captureMessages = vi.fn((): boolean => true);
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-reasoning-history",
      activityLog,
      captureMessages,
    });
    const pulls: [string, string | undefined][] = [
      ["", undefined],
      ["PRIVATE_THOUGHT look", undefined],
      ["PRIVATE_THOUGHT look closer", "Done"],
    ];
    let checkpoint: number | undefined;
    const signals: unknown[] = [];
    for (const [reasoning, text] of pulls) {
      const events = projection.project(
        "ses_reasoning",
        reasoningHistory(reasoning, text),
        checkpoint,
      );
      for (const event of events) signals.push(projection.takeSignal(event));
      checkpoint = events.at(-1)?.sequence ?? checkpoint;
    }

    const reasoningSignals = signals.filter(
      (signal): signal is { kind: "reasoning"; text: string } =>
        typeof signal === "object" &&
        signal !== null &&
        "kind" in signal &&
        signal.kind === "reasoning",
    );
    expect(reasoningSignals.map((signal) => signal.text)).toEqual([
      "PRIVATE_THOUGHT look",
      " closer",
    ]);
    expect(signals).toContainEqual({
      kind: "reasoning",
      messageId: "msg_assistant",
      text: " closer",
      occurredAt: "1970-01-01T00:00:00.002Z",
    });
    expect(captureMessages).toHaveBeenLastCalledWith([
      { messageId: "msg_user", role: "user", content: "Task" },
      { messageId: "msg_assistant", role: "assistant", content: "Done" },
    ]);
    expect(JSON.stringify(captureMessages.mock.calls)).not.toContain("PRIVATE_THOUGHT");
    const lines = activityLog.events.map((event) => formatActivityLogProofLine(event));
    expect(
      lines.map((line) =>
        expectActivityLogProof("coding-runtime.history-projection.emitted-line", line),
      ),
    ).toEqual([
      expect.objectContaining({ reasoningSignalCount: 0 }),
      expect.objectContaining({ reasoningSignalCount: 1 }),
      expect.objectContaining({ reasoningSignalCount: 1 }),
    ]);
    expect(lines.join("\n")).not.toContain("PRIVATE_THOUGHT");
  });

  it("reads a long reasoning part only up to its projection bound and never fails on it", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const long = "é".repeat(80_000);

    const events = projection.project("ses_long", reasoningHistory(long, "ok"), undefined);
    const reasoning = events
      .map((event) => projection.takeSignal(event))
      .find((signal) => signal?.kind === "reasoning");

    expect(reasoning?.kind === "reasoning" && reasoning.text.length).toBeGreaterThan(0);
    expect(
      reasoning?.kind === "reasoning" && Buffer.byteLength(reasoning.text, "utf8"),
    ).toBeLessThanOrEqual(2 * CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES);
    const grown = projection.project(
      "ses_long",
      reasoningHistory(`${long}more`, "ok"),
      events.at(-1)?.sequence,
    );
    expect(grown).toEqual([]);
  });
});

// OpenCode 2.0.10 persists a streamed text or reasoning part only empty and complete (#3873 review,
// PR #3876): between those two the history shows the part empty, and the model's words travel only as
// ephemeral `session.text.delta` / `session.reasoning.delta` events. The projection shows what
// streams from those events (`opencodeV2LiveText.ts`) and reconciles with the persisted part, so a
// streamed answer reaches the live timeline as it is written and is never shown twice.
describe("OpenCode V2 live streamed text", () => {
  const SESSION = "ses_live";
  const ASSISTANT = "msg_assistant";

  type Part = Readonly<Record<string, unknown>>;
  type Kind = "text" | "reasoning";
  const empty = (type: Kind): Part => ({ type, text: "" });
  const part = (type: Kind, text: string): Part => ({ type, text });

  function liveHistory(content: readonly Part[]): readonly Readonly<Record<string, unknown>>[] {
    return [
      { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" },
      { id: ASSISTANT, type: "assistant", time: { created: 2 }, content },
    ];
  }

  interface Streaming {
    readonly projection: ReturnType<typeof createOpenCodeV2HistoryProjection>;
    start(kind: Kind, ordinal: number): void;
    delta(kind: Kind, ordinal: number, text: string): void;
    pull(content: readonly Part[]): readonly CodingSafeActivitySignal[];
    pullMessages(
      messages: readonly Readonly<Record<string, unknown>>[],
    ): readonly CodingSafeActivitySignal[];
  }

  function streaming(
    activity?: Parameters<typeof createOpenCodeV2HistoryProjection>[0],
  ): Streaming {
    const projection = createOpenCodeV2HistoryProjection(activity);
    let checkpoint: number | undefined;
    let sequence = 0;
    const emit = (
      step: "started" | "delta",
      kind: Kind,
      ordinal: number,
      data: Readonly<Record<string, unknown>>,
    ): void => {
      sequence += 1;
      projection.observeLiveEvent(SESSION, {
        id: `evt_${String(sequence)}`,
        type: `session.${kind}.${step}`,
        data: { sessionID: SESSION, assistantMessageID: ASSISTANT, ordinal, ...data },
      });
    };
    const pullMessages = (
      messages: readonly Readonly<Record<string, unknown>>[],
    ): readonly CodingSafeActivitySignal[] => {
      const events = projection.project(SESSION, messages, checkpoint);
      checkpoint = events.at(-1)?.sequence ?? checkpoint;
      return events.flatMap((event) => {
        const signal = projection.takeSignal(event);
        return signal === undefined ? [] : [signal];
      });
    };
    return {
      projection,
      start: (kind, ordinal): void => {
        emit("started", kind, ordinal, {});
      },
      delta: (kind, ordinal, text): void => {
        emit("delta", kind, ordinal, { delta: text });
      },
      pull: (content): readonly CodingSafeActivitySignal[] => pullMessages(liveHistory(content)),
      pullMessages,
    };
  }

  function growth(
    signals: readonly CodingSafeActivitySignal[],
    kind: Kind,
    messageId = ASSISTANT,
  ): string[] {
    return signals.flatMap((signal) =>
      signal.kind === kind && signal.messageId === messageId ? [signal.text] : [],
    );
  }

  function projectionLines(
    sink: ReturnType<typeof createBufferedServerLogSink>,
  ): Record<string, unknown>[] {
    return sink.events
      .filter((event) => event.op === "coding-runtime.history-projection")
      .map((event) =>
        expectActivityLogProof(
          "coding-runtime.history-projection.emitted-line",
          formatActivityLogProofLine(event),
        ),
      );
  }

  it("shows an answer as it streams while the history holds the part empty", () => {
    const live = streaming();
    expect(growth(live.pull([empty("text")]), "text")).toEqual([]);

    live.start("text", 0);
    live.delta("text", 0, "The answer ");
    expect(growth(live.pull([empty("text")]), "text")).toEqual(["The answer "]);

    live.delta("text", 0, "is 42");
    live.delta("text", 0, ", slowly.");
    expect(growth(live.pull([empty("text")]), "text")).toEqual(["is 42, slowly."]);
    // A pull that sees no new delta changes nothing.
    expect(live.pull([empty("text")])).toEqual([]);
  });

  it("shows nothing twice when the history shows the part complete", () => {
    const live = streaming();
    live.pull([empty("text")]);
    live.start("text", 0);
    live.delta("text", 0, "The answer is 42.");
    live.pull([empty("text")]);

    expect(live.pull([part("text", "The answer is 42.")])).toEqual([]);
    // A delta still in flight when the history read overtook it is not shown either.
    live.delta("text", 0, " late");
    expect(live.pull([part("text", "The answer is 42.")])).toEqual([]);
  });

  it("adds only what the complete part has beyond the deltas that had arrived", () => {
    const live = streaming();
    live.pull([empty("text")]);
    live.start("text", 0);
    live.delta("text", 0, "Hello wor");
    expect(growth(live.pull([empty("text")]), "text")).toEqual(["Hello wor"]);

    // The history read overtook the last delta on the event stream.
    expect(growth(live.pull([part("text", "Hello world")]), "text")).toEqual(["ld"]);
    live.delta("text", 0, "ld");
    expect(live.pull([part("text", "Hello world")])).toEqual([]);
  });

  it("shows streamed reasoning the same way, as its own signals", () => {
    const live = streaming();
    live.pull([empty("reasoning")]);
    live.start("reasoning", 0);
    live.delta("reasoning", 0, "Let me ");
    live.delta("reasoning", 0, "think");

    const first = live.pull([empty("reasoning")]);
    live.delta("reasoning", 0, " about it.");
    const second = live.pull([empty("reasoning")]);

    expect(growth(first, "reasoning")).toEqual(["Let me think"]);
    expect(growth(second, "reasoning")).toEqual([" about it."]);
    expect(growth(second, "text")).toEqual([]);
    expect(live.pull([part("reasoning", "Let me think about it.")])).toEqual([]);
  });

  it("maps an ordinal to the n-th part of its kind, reasoning and text counted apart", () => {
    const live = streaming();
    const content = [empty("reasoning"), empty("text"), empty("text")];
    live.pull(content);
    live.start("reasoning", 0);
    live.start("text", 0);
    live.start("text", 1);
    live.delta("reasoning", 0, "think");
    live.delta("text", 0, "first");
    live.delta("text", 1, "second");

    const signals = live.pull(content);

    expect(growth(signals, "reasoning")).toEqual(["think"]);
    expect(growth(signals, "text")).toEqual(["first", "second"]);
  });

  it("keeps the deltas of one assistant message out of another", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const history = [
      { id: "msg_user_1", type: "user", time: { created: 1 }, text: "One" },
      { id: "msg_assistant_1", type: "assistant", time: { created: 2 }, content: [empty("text")] },
      { id: "msg_user_2", type: "user", time: { created: 3 }, text: "Two" },
      { id: "msg_assistant_2", type: "assistant", time: { created: 4 }, content: [empty("text")] },
    ];
    for (const [id, text] of [
      ["msg_assistant_1", "first answer"],
      ["msg_assistant_2", "second answer"],
    ] as const) {
      const data = { sessionID: SESSION, assistantMessageID: id, ordinal: 0 };
      projection.observeLiveEvent(SESSION, {
        id: `evt_s_${id}`,
        type: "session.text.started",
        data,
      });
      projection.observeLiveEvent(SESSION, {
        id: `evt_d_${id}`,
        type: "session.text.delta",
        data: { ...data, delta: text },
      });
    }

    const signals = projection
      .project(SESSION, history, undefined)
      .flatMap((event) => projection.takeSignal(event) ?? []);

    expect(growth(signals, "text", "msg_assistant_1")).toEqual(["first answer"]);
    expect(growth(signals, "text", "msg_assistant_2")).toEqual(["second answer"]);
  });

  it("waits for the history to list the part before it shows what streamed into it", () => {
    const live = streaming();
    live.start("text", 0);
    live.delta("text", 0, "early words");

    const before = live.pullMessages([
      { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" },
    ]);
    expect(growth(before, "text")).toEqual([]);

    expect(growth(live.pull([empty("text")]), "text")).toEqual(["early words"]);
  });

  it("does what it always did when the runtime's event stream carries no deltas", () => {
    const live = streaming();

    expect(growth(live.pull([empty("reasoning"), empty("text")]), "text")).toEqual([]);
    const complete = live.pull([part("reasoning", "Thought."), part("text", "The answer.")]);

    expect(growth(complete, "reasoning")).toEqual(["Thought."]);
    expect(growth(complete, "text")).toEqual(["The answer."]);
  });

  describe("Coding History", () => {
    it("records the part the runtime persisted, never the text that is still streaming", () => {
      const captureMessages = vi.fn((): boolean => true);
      const live = streaming({ runId: "run-live", activityLog: undefined, captureMessages });
      live.start("text", 0);
      live.delta("text", 0, "PRIVATE_PARTIAL answer");
      live.pull([empty("text")]);
      live.delta("text", 0, " grows");
      live.pull([empty("text")]);

      // The shown text changed on both pulls; the stored message did not, so nothing is rewritten.
      expect(captureMessages).toHaveBeenCalledTimes(1);
      expect(captureMessages).toHaveBeenLastCalledWith([
        { messageId: "msg_user", role: "user", content: "Task" },
        { messageId: ASSISTANT, role: "assistant", content: "" },
      ]);

      live.pull([part("text", "PRIVATE_PARTIAL answer grows")]);

      expect(captureMessages).toHaveBeenCalledTimes(2);
      expect(captureMessages).toHaveBeenLastCalledWith([
        { messageId: "msg_user", role: "user", content: "Task" },
        { messageId: ASSISTANT, role: "assistant", content: "PRIVATE_PARTIAL answer grows" },
      ]);
    });

    it("records a persisted part that is shorter than the text streamed past it", () => {
      const captureMessages = vi.fn((): boolean => true);
      const live = streaming({ runId: "run-live", activityLog: undefined, captureMessages });
      live.start("text", 0);
      live.delta("text", 0, "Hello wor");

      // A runtime whose history grows by suffix, while the event stream is ahead of it.
      const signals = live.pull([part("text", "Hello")]);

      expect(growth(signals, "text")).toEqual(["Hello wor"]);
      expect(captureMessages).toHaveBeenLastCalledWith([
        { messageId: "msg_user", role: "user", content: "Task" },
        { messageId: ASSISTANT, role: "assistant", content: "Hello" },
      ]);
    });

    it("never records streamed reasoning", () => {
      const captureMessages = vi.fn((): boolean => true);
      const live = streaming({ runId: "run-live", activityLog: undefined, captureMessages });
      live.start("reasoning", 0);
      live.delta("reasoning", 0, "PRIVATE_THOUGHT");
      live.pull([empty("reasoning"), empty("text")]);
      live.pull([part("reasoning", "PRIVATE_THOUGHT"), part("text", "Done")]);

      expect(JSON.stringify(captureMessages.mock.calls)).not.toContain("PRIVATE_THOUGHT");
    });
  });

  describe("bounds", () => {
    it.each([
      ["two-byte characters", "é"],
      ["three-byte characters", "€"],
    ])("cuts streamed reasoning where the finished part is cut: %s", (_name, character) => {
      const live = streaming();
      live.start("reasoning", 0);
      const chunk = character.repeat(2_000);
      for (let sent = 0; sent < 5; sent += 1) live.delta("reasoning", 0, chunk);

      const shown = growth(live.pull([empty("reasoning")]), "reasoning").join("");

      expect(Buffer.byteLength(shown, "utf8")).toBeLessThanOrEqual(
        2 * CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES,
      );
      expect(shown.length).toBeGreaterThan(5_000);
      // The projection reads the finished part up to its bound: it must add nothing to what was
      // shown, which only holds when both cut at the same character.
      expect(live.pull([part("reasoning", chunk.repeat(5))])).toEqual([]);
    });

    it("shows a streamed answer up to the part bound and accepts the finished part of that size", () => {
      const live = streaming();
      live.start("text", 0);
      for (let sent = 0; sent < 7; sent += 1) live.delta("text", 0, "a".repeat(10_000));

      const shown = growth(live.pull([empty("text")]), "text").join("");

      expect(Buffer.byteLength(shown, "utf8")).toBe(65_536);
      expect(live.pull([part("text", "a".repeat(65_536))])).toEqual([]);
    });
  });

  describe("a character split between two deltas", () => {
    it("never shows half of it", () => {
      const live = streaming();
      live.start("text", 0);
      live.delta("text", 0, "ok \ud83d");
      const first = growth(live.pull([empty("text")]), "text");
      live.delta("text", 0, "\ude00 done");
      const second = growth(live.pull([empty("text")]), "text");

      expect(first).toEqual(["ok "]);
      expect(second).toEqual(["\u{1f600} done"]);
      expect(JSON.stringify([first, second])).not.toContain("\\ud83d");
    });
  });

  describe("an interrupted event stream", () => {
    it("keeps what a part showed, and takes the rest from the history", () => {
      const live = streaming();
      live.pull([empty("text")]);
      live.start("text", 0);
      live.delta("text", 0, "Hel");
      expect(growth(live.pull([empty("text")]), "text")).toEqual(["Hel"]);

      live.projection.freezeLiveText();
      live.delta("text", 0, "lo wor");
      expect(live.pull([empty("text")])).toEqual([]);

      expect(growth(live.pull([part("text", "Hello world")]), "text")).toEqual(["lo world"]);
    });

    it("follows a part that starts on the stream that replaced it", () => {
      const live = streaming();
      live.start("text", 0);
      live.delta("text", 0, "old ");
      live.projection.freezeLiveText();

      live.start("text", 1);
      live.delta("text", 1, "new");

      const signals = live.pull([empty("text"), empty("text")]);
      expect(growth(signals, "text")).toEqual(["old ", "new"]);
    });
  });

  describe("a complete part that does not extend what streamed", () => {
    it("keeps what was shown, never fails the read, and is counted", () => {
      const activityLog = createBufferedServerLogSink();
      const live = streaming({ runId: "run-live", activityLog });
      live.pull([empty("text")]);
      live.start("text", 0);
      live.delta("text", 0, "Hello");
      expect(growth(live.pull([empty("text")]), "text")).toEqual(["Hello"]);

      // A second part changes in the same pass, so the pass writes its line.
      const signals = live.pull([part("text", "Goodbye"), part("text", "Next")]);

      expect(growth(signals, "text")).toEqual(["Next"]);
      expect(projectionLines(activityLog).at(-1)).toMatchObject({ liveDivergedCount: 1 });
      // Counted once, however often the history shows it.
      live.pull([part("text", "Goodbye"), part("text", "Next"), part("text", "Last")]);
      expect(projectionLines(activityLog).at(-1)).toMatchObject({ liveDivergedCount: 0 });
    });
  });

  describe("the projection line", () => {
    it("counts what streamed and what was dropped, since the previous line", () => {
      const activityLog = createBufferedServerLogSink();
      const live = streaming({ runId: "run-live", activityLog });
      // An event of another session is not this run's, so it is neither shown nor counted.
      live.projection.observeLiveEvent(SESSION, {
        id: "evt_other",
        type: "session.text.delta",
        data: { sessionID: "ses_other", assistantMessageID: ASSISTANT, ordinal: 0, delta: "x" },
      });
      live.delta("text", 0, "never started");
      live.start("text", 1);
      live.delta("text", 1, "one ");
      live.delta("text", 1, "two");

      live.pull([empty("text"), empty("text")]);

      expect(projectionLines(activityLog)).toEqual([
        expect.objectContaining({
          correlationId: "run-live",
          liveDeltaCount: 2,
          liveDroppedCount: 1,
          liveDivergedCount: 0,
        }),
      ]);
      expect(JSON.stringify(projectionLines(activityLog))).not.toContain("never started");
    });

    it("carries the counts of a pass that changed nothing to the next line", () => {
      const activityLog = createBufferedServerLogSink();
      const live = streaming({ runId: "run-live", activityLog });
      live.pull([empty("text")]);
      live.delta("text", 0, "dropped one");
      live.delta("text", 0, "dropped two");

      expect(live.pull([empty("text")])).toEqual([]);
      expect(projectionLines(activityLog)).toHaveLength(1);

      live.start("text", 0);
      live.delta("text", 0, "shown");
      live.pull([empty("text")]);

      expect(projectionLines(activityLog).at(-1)).toMatchObject({
        liveDeltaCount: 1,
        liveDroppedCount: 2,
      });
      live.pull([part("text", "shown plus more")]);
      expect(projectionLines(activityLog).at(-1)).toMatchObject({
        liveDeltaCount: 0,
        liveDroppedCount: 0,
      });
    });

    it("names the events the composition merged into earlier reads, and resets them", () => {
      const activityLog = createBufferedServerLogSink();
      let merged = 41;
      const live = streaming({
        runId: "run-live",
        activityLog,
        takeMergedEventCount: (): number => {
          const count = merged;
          merged = 0;
          return count;
        },
      });

      live.pull([empty("text")]);
      live.pull([part("text", "changed")]);

      expect(projectionLines(activityLog)).toEqual([
        expect.objectContaining({ mergedEventCount: 41 }),
        expect.objectContaining({ mergedEventCount: 0 }),
      ]);
    });

    it("leaves the merged count out when no stream feeds the projection", () => {
      const activityLog = createBufferedServerLogSink();
      const live = streaming({ runId: "run-live", activityLog });

      live.pull([empty("text")]);

      expect(projectionLines(activityLog)[0]).not.toHaveProperty("mergedEventCount");
    });
  });
});

// OpenCode 2.0.10 session-message.ts CompactionRunning/Completed/Failed; no V1 overflow field.
function nativeCompaction(status: string, recent = "", reason = "auto"): Record<string, unknown> {
  const base = {
    id: "msg_PRIVATE_COMPACTION_ID",
    type: "compaction",
    time: { created: 2 },
    status,
    reason,
  };
  return status === "failed"
    ? { ...base, error: { type: "PRIVATE_ERROR_TYPE", message: "PRIVATE_ERROR_BODY", status: 503 } }
    : { ...base, summary: "PRIVATE_COMPACTION_SUMMARY", recent };
}

describe("OpenCode V2 actual compaction history", () => {
  it("records admitted native lifecycle metadata once without inventing overflow or exposing content", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection();
    const reconciler = createOpenCodeReconciler();
    let checkpoint: number | undefined;
    for (const message of [
      nativeCompaction("running"),
      nativeCompaction("running", "[User]: PRIVATE_RECENT_BODY /private/raw-path"),
      nativeCompaction("completed", "[User]: PRIVATE_RECENT_BODY /private/raw-path"),
    ]) {
      const events = projection.project("ses_compaction", [message], checkpoint);
      for (let replay = 0; replay < 2; replay += 1) {
        const applied = reconciler.ingest(events);
        if (!applied.ok) throw new Error("expected admitted compaction observations");
        recordCompactionActivity(
          { activityLog: sink, correlationId: "run-v2-compaction" },
          applied.projections,
        );
      }
      checkpoint = reconciler.checkpoints().ses_compaction;
      expect(
        projection.project(
          "ses_compaction",
          [{ ...message, summary: "PRIVATE_UPDATED_SUMMARY" }],
          checkpoint,
        ),
      ).toEqual([]);
    }
    const lines = sink.events.filter((line) => line.op === "coding-runtime.compaction");
    expect(lines.map((line) => line.extra?.event)).toEqual([
      "started",
      "tail-retained",
      "completed",
    ]);
    expect(new Set(lines.map((line) => line.extra?.compactionIdSha256)).size).toBe(1);
    for (const line of lines) {
      expectActivityLogProof(
        "coding-runtime.compaction.emitted-line",
        formatActivityLogProofLine(line),
      );
      expect(line.extra).not.toHaveProperty("overflow");
      expect(line.extra).not.toHaveProperty("tailStartIdSha256");
    }
    expect(JSON.stringify(lines)).not.toMatch(/PRIVATE_|summary|recentID/);
  });

  it("records failed compaction without exposing error text or turning it into task settlement", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection();
    const events = projection.project("ses_compaction", [nativeCompaction("failed")], undefined);
    const compaction = events.find((event) => event.compaction !== undefined);
    expect(compaction).toMatchObject({
      kind: "observation",
      compaction: { event: "failed", finishReason: "error" },
    });
    const reconciler = createOpenCodeReconciler();
    const applied = reconciler.ingest(events);
    if (!applied.ok) throw new Error("expected admitted compaction failure observation");
    recordCompactionActivity(
      { activityLog: sink, correlationId: "run-v2-compaction" },
      applied.projections,
    );
    const failure = sink.events.find((line) => line.op === "coding-runtime.compaction");
    expect(failure).toMatchObject({
      errorKind: "internal",
      extra: {
        event: "failed",
        compactionErrorKind: "OpenCodeCompactionFailure",
        finishReason: "error",
      },
    });
    expect(JSON.stringify(sink.events)).not.toMatch(/PRIVATE_/);
    expect(
      events.some((event) => event.kind === "terminal" || event.kind === "terminal-failure"),
    ).toBe(false);
  });

  it.each([
    { status: "unknown" },
    { reason: "unknown" },
    { summary: undefined },
    { recent: undefined },
    { recent: 42 },
    { status: "failed", error: undefined },
    { status: "failed", error: { type: "failure" } },
    {
      status: "failed",
      error: { type: "failure", message: "PRIVATE_ERROR", stdout: "PRIVATE_BODY" },
    },
  ])("rejects unknown or partial native compaction shapes %j", (invalid) => {
    const projection = createOpenCodeV2HistoryProjection();
    expect(() =>
      projection.project(
        "ses_compaction",
        [{ ...nativeCompaction(invalid.status === "failed" ? "failed" : "running"), ...invalid }],
        undefined,
      ),
    ).toThrow("opencode-v2-history-invalid");
  });
});
