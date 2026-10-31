import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { describe, expect, it, vi } from "vitest";
import { CODING_SAFE_ACTIVITY_MAX_REASONING_UTF8_BYTES } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import { OPENCODE_MODEL_VISIBLE_TOOL_NAMES } from "./opencodeToolSchemas.js";
import {
  createOpenCodeV2HistoryProjection,
  OPENCODE_V2_STEP_CHANGE_FILES_MAX,
  OpenCodeV2HistoryError,
  type OpenCodeV2ProjectionReuse,
  openCodeV2StepChanges,
} from "./opencodeV2History.js";
import { createOpenCodeReconciler } from "./opencodeReconciler.js";
import { recordCompactionActivity } from "./opencodeRuntimeAdapter.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

function historyMapCopies(): {
  readonly read: () => { readonly count: number; readonly entries: number };
  readonly restore: () => void;
} {
  const NativeMap = Map;
  let count = 0;
  let entries = 0;
  class CountedMap<Key, Value> extends NativeMap<Key, Value> {
    constructor(values?: Iterable<readonly [Key, Value]> | null) {
      super(values);
      if (!(values instanceof NativeMap)) return;
      const first: unknown = values.values().next().value;
      if (typeof first !== "object" || first === null || !("digest" in first)) return;
      count += 1;
      entries += values.size;
    }
  }
  vi.stubGlobal("Map", CountedMap);
  return {
    read: (): { readonly count: number; readonly entries: number } => ({ count, entries }),
    restore: (): void => {
      vi.stubGlobal("Map", NativeMap);
    },
  };
}

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

function failedIdleHistory(error: unknown): readonly Record<string, unknown>[] {
  return [
    { id: "msg_user", type: "user", time: { created: 1 }, text: "Run the failing turn." },
    {
      id: "msg_idle",
      type: "idle",
      time: { created: 3 },
      outcome: "failed",
      ...(error === undefined ? {} : { error }),
    },
  ];
}

describe("OpenCode 2.1.4 idle structured error (#3897)", () => {
  const structuredError = {
    type: "ProviderError",
    message: "PRIVATE_PROVIDER_MESSAGE",
    status: 502,
    response: { body: "PRIVATE_BODY" },
    retryAfterMs: 1_500,
  };

  it("projects a failed idle message carrying the producer's structured error as a body-free terminal failure", () => {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "idle-history-run",
      activityLog: undefined,
      toolProfile: "native",
    });
    const events = projection.project("ses_idle", failedIdleHistory(structuredError), undefined);
    const terminal = events.find((event) => event.kind === "terminal-failure");
    expect(terminal).toBeDefined();
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE_PROVIDER_MESSAGE|PRIVATE_BODY|ProviderError/u,
    );
  });

  it("still rejects an unknown idle field and a malformed structured error", () => {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "idle-history-run",
      activityLog: undefined,
      toolProfile: "native",
    });
    const safeCode = (messages: readonly Record<string, unknown>[]): string | undefined => {
      try {
        projection.project("ses_idle", messages, undefined);
        return undefined;
      } catch (error) {
        return error instanceof OpenCodeV2HistoryError ? error.safeCode : "unexpected";
      }
    };
    expect(safeCode([{ ...failedIdleHistory(undefined)[1], unexpected: true }])).toMatch(
      /role=idle:extraCount=1/u,
    );
    for (const malformed of [
      "PRIVATE_STRING",
      { type: "ProviderError" },
      { ...structuredError, extra: 1 },
      { ...structuredError, status: 42 },
      { ...structuredError, retryAfterMs: -1 },
      { ...structuredError, response: { body: "x", headers: {} } },
    ]) {
      expect(safeCode(failedIdleHistory(malformed))).toMatch(/error-shape=unsupported/u);
    }
  });
});

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

  // 2026-10-28 owner decision: a changeset edit carries file content up to the 8 MiB changeset cap,
  // so its history row may exceed the generic 256 KiB argument bound; every other tool keeps it.
  it.each([
    ["keiko_changeset_edit", true],
    ["keiko_workspace_read", false],
  ] as const)("bounds a %s history input above 256 KiB by its own tool limit", (name, accepted) => {
    const projection = createOpenCodeV2HistoryProjection();
    const history = [
      { id: "msg_user", type: "user", time: { created: 0 }, text: "Task" },
      {
        id: "msg_assistant",
        type: "assistant",
        time: { created: 1 },
        content: [
          {
            type: "tool",
            id: "call_large",
            name,
            time: { created: 1 },
            state: { status: "streaming", input: "x".repeat(300 * 1024) },
          },
        ],
      },
    ];
    const refusal = ((): unknown => {
      try {
        projection.project("ses_large", history, undefined);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    if (accepted) expect(refusal).toBeUndefined();
    else expect((refusal as OpenCodeV2HistoryError).safeCode).toMatch(/^reason=argument-bound:/u);
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

  // The pin (#3895) forbade copying the owned snapshot on top of the one staging copy. #4104 removed
  // the staging copy as well: a pass records only what it changed and adopts that at the checkpoint,
  // so no known history is copied per acknowledged live delta, however long the session.
  it("copies no known history for an acknowledged live delta, neither the owned snapshot nor a staging copy", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const completed = Array.from({ length: 24 }, (_, index) => [
      { id: `msg_user_${String(index)}`, type: "user", time: { created: 1 }, text: "Task" },
      {
        id: `msg_done_${String(index)}`,
        type: "assistant",
        time: { created: 2 },
        content: [part("text", "Completed answer.")],
      },
    ]).flat();
    const messages = [...completed, ...liveHistory([empty("text")])];
    const reconciler = createOpenCodeReconciler();
    const first = projection.project(SESSION, messages, undefined);
    expect(reconciler.ingest(first).ok).toBe(true);
    const data = { sessionID: SESSION, assistantMessageID: ASSISTANT, ordinal: 0 };
    projection.observeLiveEvent(SESSION, { id: "evt_start", type: "session.text.started", data });
    const copies = historyMapCopies();
    try {
      for (let index = 0; index < 12; index += 1) {
        projection.observeLiveEvent(SESSION, {
          id: `evt_delta_${String(index)}`,
          type: "session.text.delta",
          data: { ...data, delta: "word " },
        });
        const events = projection.project(SESSION, messages, reconciler.checkpoints()[SESSION]);
        expect(events).toHaveLength(1);
        expect(reconciler.ingest(events)).toMatchObject({ ok: true, applied: 1 });
        expect(
          growth(
            events.flatMap((event) => projection.takeSignal(event) ?? []),
            "text",
          ),
        ).toEqual(["word "]);
      }
      expect(copies.read()).toEqual({ count: 0, entries: 0 });
    } finally {
      copies.restore();
    }
  });

  it("keeps acknowledged state private while old pages are held and preserves replay after clearing signals", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const reconciler = createOpenCodeReconciler();
    const initialHistory = liveHistory([part("text", "Initial answer")]);
    const first = projection.project(SESSION, initialHistory, undefined);
    const firstSignals = first.flatMap((event) => projection.takeSignal(event) ?? []);
    expect(reconciler.ingest(first).ok).toBe(true);
    const before = reconciler.checkpoints()[SESSION];
    expect(projection.project(SESSION, initialHistory, before)).toEqual([]);

    // A held public page and its consumed signal cannot mutate the adopted private known-state map.
    Object.assign(first.at(-1) ?? {}, { digest: "e".repeat(64), sequence: 9_999 });
    Object.assign(first, { length: 0 });
    Object.assign(firstSignals.at(-1) ?? {}, { text: "Changed held signal" });
    const nextHistory = liveHistory([part("text", "Initial answer continued")]);
    const next = projection.project(SESSION, nextHistory, before);
    expect(next).toHaveLength(1);
    expect(projection.project(SESSION, nextHistory, before)).toBe(next);
    expect(() => projection.project(SESSION, nextHistory, 9_999)).toThrow(
      "opencode-v2-checkpoint-invalid",
    );
    const event = next[0];
    if (event === undefined) throw new Error("Expected a continued answer event");
    projection.clearSignals();
    expect(projection.takeSignal(event)).toBeUndefined();
    expect(projection.project(SESSION, nextHistory, before)).toBe(next);
    expect(projection.takeSignal(event)).toMatchObject({ kind: "text", text: " continued" });
    expect(projection.takeSignal(event)).toBeUndefined();
    expect(reconciler.ingest(next)).toMatchObject({ ok: true, applied: 1 });
    const after = reconciler.checkpoints()[SESSION];
    expect(projection.project(SESSION, nextHistory, after)).toEqual([]);
    Object.assign(next, { length: 0 });
    expect(projection.project(SESSION, nextHistory, after)).toEqual([]);
  });

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

    it("cuts a finished answer longer than the part bound where the stream stopped and never fails the read", () => {
      const captureMessages = vi.fn((): boolean => true);
      const live = streaming({ runId: "run-live", activityLog: undefined, captureMessages });
      live.start("text", 0);
      for (let sent = 0; sent < 7; sent += 1) live.delta("text", 0, "é".repeat(5_000));

      const shown = growth(live.pull([empty("text")]), "text").join("");
      const finished = "é".repeat(35_000);

      expect(Buffer.byteLength(shown, "utf8")).toBe(65_536);
      // The finished part is longer than the bound; the timeline shows the same prefix it showed
      // and adds nothing, while Coding History records the part the runtime persisted, whole.
      expect(live.pull([part("text", finished)])).toEqual([]);
      expect(captureMessages).toHaveBeenLastCalledWith([
        { messageId: "msg_user", role: "user", content: "Task" },
        { messageId: ASSISTANT, role: "assistant", content: finished },
      ]);
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

// OpenCode 2.0.10, b8cedc1a7a5e2916bbb65dc1d4b620729c261638:
// core/test/session-projector.test.ts "projects retry state and clears it at the next step or
// execution terminal" produces attempt=2, at=2000. message-updater.ts persists those facts;
// schema/session-message.ts encodes DateTimeUtcFromMillis as milliseconds. No backoff is inferred.
function nativeRetryHistory(retry: unknown): readonly Record<string, unknown>[] {
  return [
    { id: "msg_retry_user", type: "user", time: { created: 0 }, text: "Task" },
    {
      id: "msg_retry_first",
      type: "assistant",
      time: { created: 0 },
      content: [],
      ...(retry === undefined ? {} : { retry }),
    },
  ];
}

const NATIVE_RETRY = {
  attempt: 2,
  at: 2000,
  error: { type: "provider.transport", message: "PRIVATE_PROVIDER_FAILURE" },
};

describe("OpenCode V2 native retry history", () => {
  it("logs native schedule and clear counts once per committed page without provider bodies", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-native-retry",
      activityLog: sink,
    });
    let checkpoint: number | undefined;
    for (const retry of [NATIVE_RETRY, undefined]) {
      const history = nativeRetryHistory(retry);
      const events = projection.project("ses_retry", history, checkpoint);
      projection.project("ses_retry", history, checkpoint);
      checkpoint = events.at(-1)?.sequence;
    }
    const records = sink.events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.history-projection.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );
    expect(records.map((event) => event.nativeRetrySignalCount)).toEqual([1, 1]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_PROVIDER_FAILURE");
    expect(JSON.stringify(records)).not.toContain("provider.transport");
  });

  it("keeps durable assistant text when native retry metadata is projected separately", () => {
    const captureMessages = vi.fn().mockReturnValue(true);
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-retry-capture",
      activityLog: undefined,
      captureMessages,
    });
    const history = nativeRetryHistory(NATIVE_RETRY).map((message) =>
      message.type === "assistant"
        ? { ...message, content: [{ type: "text", text: "Persisted answer before retry" }] }
        : message,
    );
    projection.project("ses_retry", history, undefined);
    expect(captureMessages).toHaveBeenCalledWith([
      { messageId: "msg_retry_user", role: "user", content: "Task" },
      { messageId: "msg_retry_first", role: "assistant", content: "Persisted answer before retry" },
    ]);
  });

  it("commits repeated native schedule/clear episodes through the real reconciler", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const reconciler = createOpenCodeReconciler();
    let checkpoint: number | undefined;
    const identities = new Set<string>();
    for (const retry of [
      undefined,
      NATIVE_RETRY,
      undefined,
      { ...NATIVE_RETRY, attempt: 3 },
      undefined,
    ]) {
      const events = projection.project("ses_retry", nativeRetryHistory(retry), checkpoint);
      const result = reconciler.ingest(events);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Native retry reconciliation failed");
      expect(result.applied).toBe(events.length);
      for (const event of events) {
        expect(identities.has(event.id)).toBe(false);
        identities.add(event.id);
      }
      checkpoint = reconciler.checkpoints().ses_retry;
    }
  });

  it("projects the producer's physical attempt and schedule, then its authoritative clear", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const first = projection.project("ses_retry", nativeRetryHistory(NATIVE_RETRY), undefined);
    const signals = first.map((event) => projection.takeSignal(event)).filter(Boolean);
    expect(signals).toContainEqual(
      expect.objectContaining({
        kind: "message",
        messageId: "msg_retry_first",
        nativeRetry: { attempt: 2, scheduledAt: "1970-01-01T00:00:02.000Z" },
      }),
    );
    const checkpoint = first.at(-1)?.sequence;
    expect(
      projection.project(
        "ses_retry",
        nativeRetryHistory({
          ...NATIVE_RETRY,
          error: { type: "provider.transport", message: "DIFFERENT_PRIVATE_ERROR" },
        }),
        checkpoint,
      ),
    ).toEqual([]);
    const cleared = projection.project("ses_retry", nativeRetryHistory(undefined), checkpoint);
    expect(cleared).toHaveLength(1);
    const clear = cleared[0];
    if (clear === undefined) throw new Error("Expected native retry clear");
    expect(projection.takeSignal(clear)).toEqual({
      kind: "message",
      role: "assistant",
      messageId: "msg_retry_first",
      parentMessageId: "msg_retry_user",
      occurredAt: "1970-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify([first, signals, cleared])).not.toContain("PRIVATE");
  });

  it.each([
    { ...NATIVE_RETRY, attempt: 0 },
    { ...NATIVE_RETRY, attempt: 1.5 },
    { ...NATIVE_RETRY, at: -1 },
    { ...NATIVE_RETRY, at: Number.MAX_SAFE_INTEGER },
    { ...NATIVE_RETRY, at: "2000" },
    { ...NATIVE_RETRY, injected: "PRIVATE" },
    { ...NATIVE_RETRY, error: "PRIVATE" },
    null,
  ])("refuses malformed native retry without publishing partial history: %j", (retry) => {
    const projection = createOpenCodeV2HistoryProjection();
    expect(() => projection.project("ses_retry", nativeRetryHistory(retry), undefined)).toThrow(
      "opencode-v2-history-invalid",
    );
    expect(projection.project("ses_retry", nativeRetryHistory(undefined), undefined)).not.toEqual(
      [],
    );
  });
});

it("preserves only the original native execute parent in the captured inactive profile", () => {
  const activity = {
    runId: "code-mode-observer",
    activityLog: undefined,
    toolProfile: "code-mode" as "direct" | "code-mode",
  };
  const projection = createOpenCodeV2HistoryProjection(activity);
  activity.toolProfile = "direct";
  const events = projection.project(
    "ses_native_parent",
    toolHistory("execute", "running"),
    undefined,
  );
  const tools = events
    .map((event) => projection.takeSignal(event))
    .filter((signal) => signal?.kind === "tool");
  expect(tools).toEqual([
    {
      kind: "tool",
      messageId: "msg_assistant",
      callId: "call_question",
      tool: "execute",
      state: "running",
      occurredAt: "1970-01-01T00:00:00.002Z",
    },
  ]);
  expect(() =>
    createOpenCodeV2HistoryProjection().project(
      "ses_native_parent",
      toolHistory("execute", "running"),
      undefined,
    ),
  ).toThrow("opencode-v2-tool-invalid");
});

// OpenCode 2.1.4 message shapes (#3897). Every message below is a synthetic message that is valid
// against the pinned runtime's `Session.Message.*` schemas (upstream OpenAPI, raw digest in
// opencodeRuntimeVersions.ts), carrying no customer content. 2.1.4 renamed the provider replay
// state of an assistant message and of a compaction to `native`, dropped the compaction tail
// (`recent`, `providerContext`), and widened `Session.StructuredError` with `response` and
// `retryAfterMs`. The 2.0.10 npm runtime stays admitted, so both layouts are accepted, each strictly.
function historySafeCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof OpenCodeV2HistoryError
      ? error.safeCode
      : `unexpected:${error instanceof Error ? error.message : "non-error"}`;
  }
}

const USAGE_2_1_4 = { input: 11, output: 7, reasoning: 3, cache: { read: 5, write: 2 } };
const STRUCTURED_ERROR_2_1_4 = {
  type: "ProviderError",
  message: "PRIVATE_PROVIDER_MESSAGE",
  status: 429,
  response: { body: "PRIVATE_PROVIDER_BODY" },
  retryAfterMs: 1_500,
};

function compaction214(
  status: "running" | "completed" | "failed",
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const base = {
    id: "msg_PRIVATE_COMPACTION_ID",
    type: "compaction",
    time: { created: 2 },
    status,
    reason: "auto",
  };
  if (status === "running") return { ...base, summary: "", ...fields };
  if (status === "failed") {
    return { ...base, error: STRUCTURED_ERROR_2_1_4, cost: 0.001, tokens: USAGE_2_1_4, ...fields };
  }
  return {
    ...base,
    summary: "PRIVATE_COMPACTION_SUMMARY",
    model: { id: "PRIVATE_MODEL", providerID: "PRIVATE_PROVIDER", variant: "PRIVATE_VARIANT" },
    native: { PRIVATE_NATIVE: "PRIVATE_NATIVE_STATE" },
    cost: 0.0123,
    tokens: USAGE_2_1_4,
    metadata: { recent: "PRIVATE_MIGRATED_RECENT" },
    ...fields,
  };
}

describe("OpenCode 2.1.4 compaction history (#3897)", () => {
  it("projects a running and a completed compaction once each, without inventing a tail or exposing content", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection();
    const reconciler = createOpenCodeReconciler();
    let checkpoint: number | undefined;
    for (const message of [compaction214("running"), compaction214("completed")]) {
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
      // The summary streams into the running message; it never re-emits the observation.
      expect(
        projection.project(
          "ses_compaction",
          [{ ...message, summary: "PRIVATE_UPDATED_SUMMARY" }],
          checkpoint,
        ),
      ).toEqual([]);
    }
    const lines = sink.events.filter((line) => line.op === "coding-runtime.compaction");
    expect(lines.map((line) => line.extra?.event)).toEqual(["started", "completed"]);
    expect(new Set(lines.map((line) => line.extra?.compactionIdSha256)).size).toBe(1);
    for (const line of lines) {
      expectActivityLogProof(
        "coding-runtime.compaction.emitted-line",
        formatActivityLogProofLine(line),
      );
      expect(line.extra).not.toHaveProperty("overflow");
      expect(line.extra).not.toHaveProperty("tailStartIdSha256");
    }
    expect(lines[0]?.extra).toMatchObject({ auto: true, retainedTail: false });
    expect(JSON.stringify(lines)).not.toMatch(/PRIVATE_|summary|recent/u);
  });

  it("reads a manual compaction and a completed one that carries none of the optional payloads", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const bare = {
      id: "msg_bare_compaction",
      type: "compaction",
      time: { created: 2 },
      status: "completed",
      reason: "manual",
      summary: "",
    };
    const events = projection.project("ses_bare", [bare], undefined);
    expect(events.flatMap((event) => event.compaction?.event ?? [])).toEqual(["completed"]);
    const running = createOpenCodeV2HistoryProjection().project(
      "ses_manual",
      [compaction214("running", { reason: "manual" })],
      undefined,
    );
    expect(running.flatMap((event) => event.compaction ?? [])).toEqual([
      expect.objectContaining({ event: "started", auto: false, retainedTail: false }),
    ]);
  });

  it("records a failed compaction that carries the producer's full structured error as body-free", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection();
    const events = projection.project("ses_compaction", [compaction214("failed")], undefined);
    expect(events.find((event) => event.compaction !== undefined)).toMatchObject({
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
    expect(JSON.stringify([events, sink.events])).not.toMatch(/PRIVATE_|ProviderError/u);
    expect(
      events.some((event) => event.kind === "terminal" || event.kind === "terminal-failure"),
    ).toBe(false);
  });

  it("keeps a later history pull alive after a compaction, whatever the layout", () => {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-after-compaction",
      activityLog: undefined,
      toolProfile: "native",
    });
    const user = { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" };
    const answer = {
      id: "msg_answer",
      type: "assistant",
      time: { created: 4 },
      content: [{ type: "text", text: "Done" }],
    };
    const first = projection.project(
      "ses_after",
      [user, compaction214("running"), answer],
      undefined,
    );
    const second = projection.project(
      "ses_after",
      [user, compaction214("completed"), answer],
      first.at(-1)?.sequence,
    );
    expect(second.some((event) => event.compaction?.event === "completed")).toBe(true);
  });

  it.each([
    [
      "a running compaction carrying a completion payload",
      compaction214("running", { native: {} }),
    ],
    ["a running compaction carrying usage", compaction214("running", { tokens: USAGE_2_1_4 })],
    ["a running compaction without its summary", compaction214("running", { summary: undefined })],
    [
      "a completed compaction without its summary",
      compaction214("completed", { summary: undefined }),
    ],
    ["a completed compaction with a non-text summary", compaction214("completed", { summary: 42 })],
    [
      "a completed 2.1.4 compaction that also carries the 2.0.10 tail",
      compaction214("completed", { recent: "x" }),
    ],
    [
      "a completed 2.1.4 compaction that also carries provider state",
      compaction214("completed", { providerState: {} }),
    ],
    [
      "a completed 2.1.4 compaction that also carries provider context",
      compaction214("completed", { providerContext: {} }),
    ],
    ["a failed compaction carrying a summary", compaction214("failed", { summary: "x" })],
    ["a failed compaction without its error", compaction214("failed", { error: undefined })],
    ["a failed compaction with a bare error", compaction214("failed", { error: "PRIVATE" })],
    [
      "a failed compaction whose error is missing its message",
      compaction214("failed", { error: { type: "x" } }),
    ],
    [
      "a failed compaction with an unknown error field",
      compaction214("failed", { error: { ...STRUCTURED_ERROR_2_1_4, extra: 1 } }),
    ],
    [
      "a failed compaction with an out-of-range status",
      compaction214("failed", { error: { ...STRUCTURED_ERROR_2_1_4, status: 42 } }),
    ],
    [
      "a failed compaction with a negative retry delay",
      compaction214("failed", { error: { ...STRUCTURED_ERROR_2_1_4, retryAfterMs: -1 } }),
    ],
    [
      "a failed compaction whose response has an unknown field",
      compaction214("failed", {
        error: { ...STRUCTURED_ERROR_2_1_4, response: { body: "x", headers: {} } },
      }),
    ],
    ["a compaction of an unknown status", compaction214("running", { status: "paused" })],
    ["a compaction of an unknown reason", compaction214("running", { reason: "overflow" })],
  ])("still refuses %s", (_name, message) => {
    const projection = createOpenCodeV2HistoryProjection();
    expect(historySafeCode(() => projection.project("ses_compaction", [message], undefined))).toBe(
      "reason=compaction-shape-invalid",
    );
  });

  it.each(["running", "completed", "failed"] as const)(
    "refuses an unknown field on a %s compaction with the closed unknown-field code",
    (status) => {
      const projection = createOpenCodeV2HistoryProjection();
      const code = historySafeCode(() =>
        projection.project(
          "ses_compaction",
          [compaction214(status, { injected: "PRIVATE" })],
          undefined,
        ),
      );
      expect(code).toMatch(
        /^reason=event-unknown:eventSha256=[0-9a-f]{16}:role=compaction:extraCount=1:/u,
      );
      expect(code).not.toContain("PRIVATE");
    },
  );
});

function assistant214(fields: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "msg_assistant",
    type: "assistant",
    time: { created: 2, streamed: 3, completed: 4 },
    metadata: { PRIVATE_METADATA: true },
    agent: "build",
    model: { id: "PRIVATE_MODEL", providerID: "PRIVATE_PROVIDER", variant: "PRIVATE_VARIANT" },
    content: [],
    snapshot: { start: "snap_a", end: "snap_b", files: ["src/PRIVATE.ts"] },
    finish: "stop",
    rawFinish: "stop",
    native: { PRIVATE_NATIVE: "PRIVATE_NATIVE_STATE" },
    cost: 0.01,
    tokens: USAGE_2_1_4,
    ...fields,
  };
}

describe("OpenCode 2.1.4 assistant message history (#3897)", () => {
  const user = { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" };

  it("accepts the 2.1.4 provider replay state `native` and the 2.0.10 `providerState`, each on its own", () => {
    for (const state of [{ native: { opaque: true } }, { providerState: { opaque: true } }]) {
      const { native: _native, ...withoutState } = assistant214();
      const projection = createOpenCodeV2HistoryProjection();
      const events = projection.project(
        "ses_state",
        [user, { ...withoutState, ...state }],
        undefined,
      );
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain("opaque");
    }
  });

  it("refuses a message that mixes the two layouts and an unknown field, by count and key digest only", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const pattern =
      /^reason=event-unknown:eventSha256=[0-9a-f]{16}:role=assistant:extraCount=1:extraKeySha256=[0-9a-f]{16}$/u;
    for (const fields of [{ providerState: { opaque: true } }, { PRIVATE_UNKNOWN: 1 }]) {
      const code = historySafeCode(() =>
        projection.project("ses_state", [user, assistant214(fields)], undefined),
      );
      expect(code).toMatch(pattern);
      expect(code).not.toContain("PRIVATE");
    }
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "refuses the inherited object name %s as a message type with the closed code",
    (type) => {
      const projection = createOpenCodeV2HistoryProjection();
      expect(
        historySafeCode(() =>
          projection.project("ses_type", [{ id: "msg_x", type, time: { created: 1 } }], undefined),
        ),
      ).toBe("reason=event-unknown:type=unsupported");
    },
  );
});

describe("OpenCode 2.1.4 message type coverage (#3897)", () => {
  const toolBase = { type: "tool", id: "call_1", name: "read", executed: true, native: {} };
  const tools = [
    {
      ...toolBase,
      id: "call_stream",
      time: { created: 5 },
      state: { status: "streaming", input: "{" },
    },
    {
      ...toolBase,
      id: "call_run",
      time: { created: 5, ran: 6 },
      state: { status: "running", input: { filePath: "a" }, metadata: { PRIVATE: 1 } },
    },
    {
      ...toolBase,
      id: "call_done",
      time: { created: 5, ran: 6, completed: 7 },
      state: {
        status: "completed",
        input: { filePath: "a" },
        content: [
          { type: "text", text: "PRIVATE_OUTPUT" },
          { type: "file", uri: "file:///PRIVATE", mime: "text/plain", name: null },
        ],
        metadata: { PRIVATE: 1 },
      },
    },
    {
      ...toolBase,
      id: "call_failed",
      time: { created: 5, ran: 6, completed: 7 },
      state: {
        status: "error",
        input: { filePath: "a" },
        error: STRUCTURED_ERROR_2_1_4,
        content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
        metadata: { PRIVATE: 1 },
      },
    },
  ];

  // One message of every `Session.Message.Info` variant, each with every optional field set.
  const history: readonly Record<string, unknown>[] = [
    {
      id: "msg_agent",
      type: "agent-switched",
      time: { created: 0 },
      metadata: {},
      agent: "plan",
      previous: "build",
    },
    {
      id: "msg_model",
      type: "model-switched",
      time: { created: 0 },
      metadata: {},
      model: { id: "m2", providerID: "p", variant: "v" },
      previous: { id: "m1", providerID: "p" },
    },
    {
      id: "msg_location",
      type: "location-switched",
      time: { created: 0 },
      metadata: {},
      projectID: "prj_1",
      subpath: "packages/a",
      location: { directory: "/workspace" },
      previous: { location: { directory: "/other" }, projectID: "prj_0", subpath: "b" },
    },
    {
      id: "msg_user",
      type: "user",
      time: { created: 1 },
      metadata: {},
      text: "Task",
      files: [
        {
          data: "AAAA",
          mime: "text/plain",
          source: { type: "inline" },
          name: "a",
          description: "d",
          mention: { start: 0, end: 1, text: "a" },
        },
      ],
      agents: [{ name: "build", mention: { start: 0, end: 1, text: "a" } }],
      skills: [{ id: "s", name: "skill", text: "t", mention: { start: 0, end: 1, text: "a" } }],
    },
    {
      id: "msg_synthetic",
      type: "synthetic",
      time: { created: 1 },
      metadata: {},
      text: "note",
      description: "d",
    },
    {
      id: "msg_system",
      type: "system",
      time: { created: 1 },
      metadata: {},
      text: "note",
      description: "d",
    },
    {
      id: "msg_skill",
      type: "skill",
      time: { created: 1 },
      metadata: {},
      skill: "s",
      name: "skill",
      text: "t",
    },
    {
      id: "msg_shell",
      type: "shell",
      time: { created: 1, completed: 2 },
      metadata: {},
      shellID: "sh_1",
      command: "ls",
      status: "exited",
      exit: "NaN",
      output: { output: "PRIVATE_SHELL_OUTPUT", cursor: 0, size: 4, truncated: false },
    },
    compaction214("completed"),
    assistant214({
      content: [
        {
          type: "reasoning",
          text: "Thinking",
          native: {},
          time: { created: 2, completed: 3 },
        },
        { type: "text", text: "Answer", native: {} },
        ...tools,
      ],
      error: STRUCTURED_ERROR_2_1_4,
      retry: { attempt: 2, at: 2_000, error: STRUCTURED_ERROR_2_1_4 },
    }),
    {
      id: "msg_idle",
      type: "idle",
      time: { created: 9 },
      metadata: {},
      outcome: "failed",
      error: STRUCTURED_ERROR_2_1_4,
    },
  ];

  it("projects a history holding one message of every 2.1.4 type, body-free", () => {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-coverage",
      activityLog: undefined,
      toolProfile: "native",
    });
    const events = projection.project("ses_coverage", history, undefined);
    const signals = events.map((event) => projection.takeSignal(event));
    expect(
      signals.flatMap((signal) => (signal?.kind === "tool" ? [[signal.callId, signal.state]] : [])),
    ).toEqual([
      ["call_stream", "pending"],
      ["call_run", "running"],
      ["call_done", "succeeded"],
      ["call_failed", "failed"],
    ]);
    expect(signals).toContainEqual(expect.objectContaining({ kind: "text", text: "Answer" }));
    expect(events.at(-1)?.kind).toBe("terminal-failure");
    expect(JSON.stringify({ events, signals })).not.toContain("PRIVATE");
  });

  it.each(history.map((message) => [message.type as string, message] as const))(
    "refuses an unknown field on a %s message with the closed unknown-field code",
    (type, message) => {
      const projection = createOpenCodeV2HistoryProjection({
        runId: "run-coverage",
        activityLog: undefined,
        toolProfile: "native",
      });
      const code = historySafeCode(() =>
        projection.project(
          "ses_coverage",
          [history[3] ?? message, { ...message, injected: 1 }],
          undefined,
        ),
      );
      expect(code).toMatch(new RegExp(`:role=${type}:extraCount=1:`, "u"));
    },
  );
});

describe("OpenCode V2 assistant text over the part bound (#3897)", () => {
  const user = { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" };
  const answer = (text: string): Record<string, unknown> => ({
    id: "msg_assistant",
    type: "assistant",
    time: { created: 2 },
    content: [{ type: "text", text }],
  });

  it.each([
    ["two-byte", "é"],
    ["three-byte", "€"],
    ["four-byte", "𝒳"],
  ])(
    "projects a long answer of %s characters up to the bound and never fails the read",
    (_name, character) => {
      const captureMessages = vi.fn((): boolean => true);
      const projection = createOpenCodeV2HistoryProjection({
        runId: "run-long-answer",
        activityLog: undefined,
        captureMessages,
      });
      const long = character.repeat(70_000);

      const events = projection.project("ses_long", [user, answer(long)], undefined);
      const text = events
        .map((event) => projection.takeSignal(event))
        .find((signal) => signal?.kind === "text" && signal.messageId === "msg_assistant");

      const bytes = text?.kind === "text" ? Buffer.byteLength(text.text, "utf8") : 0;
      expect(bytes).toBeLessThanOrEqual(65_536);
      expect(bytes).toBeGreaterThan(65_536 - Buffer.byteLength(character, "utf8"));
      expect(text?.kind === "text" && text.text.length % character.length).toBe(0);
      // The stored conversation is the part the runtime persisted, whole.
      expect(captureMessages).toHaveBeenLastCalledWith([
        { messageId: "msg_user", role: "user", content: "Task" },
        { messageId: "msg_assistant", role: "assistant", content: long },
      ]);
      // A longer answer shows the same prefix: the cut is stable, nothing is emitted again.
      expect(
        projection.project("ses_long", [user, answer(`${long}more`)], events.at(-1)?.sequence),
      ).toEqual([]);
    },
  );

  it("grows a long answer to the bound and then holds it", () => {
    const projection = createOpenCodeV2HistoryProjection();
    let checkpoint: number | undefined;
    const shown: string[] = [];
    for (const length of [10_000, 65_000, 65_536, 90_000]) {
      const events = projection.project("ses_grow", [user, answer("a".repeat(length))], checkpoint);
      for (const event of events) {
        const signal = projection.takeSignal(event);
        if (signal?.kind === "text" && signal.messageId === "msg_assistant")
          shown.push(signal.text);
      }
      checkpoint = events.at(-1)?.sequence ?? checkpoint;
    }
    expect(shown.map((text) => text.length)).toEqual([10_000, 55_000, 536]);
  });

  it("still refuses a user message over the part bound, which Keiko itself never sends", () => {
    const projection = createOpenCodeV2HistoryProjection();
    const oversized = { ...user, text: "u".repeat(65_537) };
    expect(() => projection.project("ses_user", [oversized], undefined)).toThrow(
      "opencode-v2-text-oversized",
    );
  });
});

// OpenCode 2.1.4 Code Mode (#3897): the producer catches a JavaScript exception thrown inside the
// `execute` program, or by a nested `tools.opencode.*` call the program did not catch, and returns a
// COMPLETED tool part whose `state.metadata.error` is `true` (the thrown message is the part's
// content). The part's `status` alone says only that the tool returned. These are the shapes the
// reviewers reproduced against the pinned executable (PR #4064): a program that throws, and the
// arithmetic control `return 1 + 1`, which completes with `metadata.error` false.
describe("OpenCode 2.1.4 Code Mode execute outcome (#3897)", () => {
  const THROWN = "PRIVATE_THROWN_MESSAGE";

  function executePart(
    callId: string,
    status: string,
    metadata: unknown,
    code = "return 1 + 1;",
  ): Record<string, unknown> {
    return {
      type: "tool",
      id: callId,
      name: "execute",
      executed: true,
      native: {},
      time: { created: 5, ran: 6, completed: 7 },
      state: {
        status,
        input: { code },
        content: [{ type: "text", text: THROWN }],
        ...(metadata === undefined ? {} : { metadata }),
      },
    };
  }

  function codeModeHistory(
    parts: readonly Record<string, unknown>[],
  ): readonly Record<string, unknown>[] {
    return [
      { id: "msg_user", type: "user", time: { created: 1 }, text: "Run the program." },
      { id: "msg_assistant", type: "assistant", time: { created: 2 }, content: parts },
    ];
  }

  function createProjection(
    activityLog?: ReturnType<typeof createBufferedServerLogSink>,
  ): ReturnType<typeof createOpenCodeV2HistoryProjection> {
    return createOpenCodeV2HistoryProjection({
      runId: "code-mode-outcome",
      activityLog,
      toolProfile: "native",
    });
  }

  function toolStates(
    projection: ReturnType<typeof createOpenCodeV2HistoryProjection>,
    messages: readonly Record<string, unknown>[],
    checkpoint?: number,
  ): {
    readonly states: readonly (readonly [string, string])[];
    readonly last: number | undefined;
  } {
    const events = projection.project("ses_execute", messages, checkpoint);
    const states = events.flatMap((event) => {
      const signal = projection.takeSignal(event);
      return signal?.kind === "tool" ? [[signal.callId, signal.state] as const] : [];
    });
    return { states, last: events.at(-1)?.sequence ?? checkpoint };
  }

  it("projects a completed execute part with metadata.error true as a failed tool without its body", () => {
    const projection = createProjection();
    const messages = codeModeHistory([
      executePart("call_throw", "completed", { error: true }, `throw new Error("${THROWN}");`),
    ]);
    const events = projection.project("ses_execute", messages, undefined);
    const signals = events.map((event) => projection.takeSignal(event));
    expect(signals).toContainEqual({
      kind: "tool",
      messageId: "msg_assistant",
      callId: "call_throw",
      tool: "execute",
      state: "failed",
      occurredAt: "1970-01-01T00:00:00.005Z",
    });
    expect(JSON.stringify({ events, signals })).not.toContain("PRIVATE_");
  });

  it("projects a nested tools.opencode.* call that failed inside the program as a failed execute", () => {
    // A hook or the tool itself throws inside `tools.opencode.worktree_create`; the program does not
    // catch it, so the outer execute part completes with the error flag and the thrown message as
    // its result. The nested call is not a part of its own: it reuses the outer call's id.
    const states = toolStates(
      createProjection(),
      codeModeHistory([
        executePart(
          "call_nested",
          "completed",
          { error: true },
          'return await tools.opencode.worktree_create({ name: "wt" });',
        ),
      ]),
    ).states;
    expect(states).toEqual([["call_nested", "failed"]]);
  });

  it.each([
    ["metadata.error is false", { error: false }],
    ["metadata has no error", {}],
    ["the part has no metadata", undefined],
  ])("keeps a completed execute part succeeded when %s (positive control)", (_label, metadata) => {
    const { states } = toolStates(
      createProjection(),
      codeModeHistory([executePart("call_sum", "completed", metadata)]),
    );
    expect(states).toEqual([["call_sum", "succeeded"]]);
  });

  it.each([
    ["the string true", "true"],
    ["the number 1", 1],
    ["an object", { message: THROWN }],
    ["an array", [true]],
    ["null", null],
    ["a string", THROWN],
  ])(
    "treats metadata.error that is %s as no failure (only the boolean true marks one)",
    (_l, v) => {
      const { states } = toolStates(
        createProjection(),
        codeModeHistory([executePart("call_loose", "completed", { error: v })]),
      );
      expect(states).toEqual([["call_loose", "succeeded"]]);
    },
  );

  it("does not read metadata that is not an object or belongs to another tool or status", () => {
    const read = { ...executePart("call_read", "completed", { error: true }), name: "read" };
    const states = toolStates(
      createProjection(),
      codeModeHistory([
        executePart("call_scalar", "completed", true),
        executePart("call_list", "completed", [{ error: true }]),
        read,
        executePart("call_running", "running", { error: true }),
        executePart("call_status_error", "error", { error: false }),
      ]),
    ).states;
    expect(states).toEqual([
      ["call_scalar", "succeeded"],
      ["call_list", "succeeded"],
      ["call_read", "succeeded"],
      ["call_running", "running"],
      ["call_status_error", "failed"],
    ]);
  });

  it("shows a failed execution and a valid recovery as separate outcomes", () => {
    const { states } = toolStates(
      createProjection(),
      codeModeHistory([
        executePart("call_failed", "completed", { error: true }, 'throw new Error("x");'),
        executePart("call_recovered", "completed", { error: false }, "return 1 + 1;"),
      ]),
    );
    expect(states).toEqual([
      ["call_failed", "failed"],
      ["call_recovered", "succeeded"],
    ]);
  });

  it("settles a running execute as failed on the next live read of the same part", () => {
    // The live timeline is the history read the runtime's event stream triggers: the first read
    // sees the program running, the next one the part settled with the error flag.
    const projection = createProjection();
    const first = toolStates(
      projection,
      codeModeHistory([executePart("call_live", "running", undefined)]),
    );
    projection.observeLiveEvent("ses_execute", {
      id: "evt_execution_finished",
      type: "session.execution.succeeded",
      data: { sessionID: "ses_execute" },
    });
    const second = toolStates(
      projection,
      codeModeHistory([executePart("call_live", "completed", { error: true })]),
      first.last,
    );
    expect([first.states, second.states]).toEqual([
      [["call_live", "running"]],
      [["call_live", "failed"]],
    ]);
  });

  it("keeps the history-projection line body-free for a failed execution", () => {
    const sink = createBufferedServerLogSink();
    const projection = createProjection(sink);
    const events = projection.project(
      "ses_execute",
      codeModeHistory([executePart("call_throw", "completed", { error: true })]),
      undefined,
    );
    const signals = events.flatMap((event) => projection.takeSignal(event) ?? []);
    expect(signals).toContainEqual(expect.objectContaining({ kind: "tool", state: "failed" }));
    const lines = sink.events.filter((event) => event.op === "coding-runtime.history-projection");
    expect(lines).toHaveLength(1);
    const [line] = lines;
    if (line === undefined) throw new TypeError("expected one history-projection line");
    const record = expectActivityLogProof(
      "coding-runtime.history-projection.emitted-line",
      formatActivityLogProofLine(line),
    );
    expect(record).toMatchObject({
      correlationId: "code-mode-outcome",
      eventCount: events.length,
      signalCount: signals.length,
    });
    expect(JSON.stringify(sink.events)).not.toContain("PRIVATE_");
  });
});

// OpenCode 2.1.4 runs a subagent launched with `background: true` after its parent went idle and
// tells the parent when it ended with a synthetic message; the parent then runs a turn to read it
// (https://opencode.ai/v2/docs/tools/#subagent, PR #4064). The idle message that ends the parent's
// first execution is therefore not the end of the run's work while that report is owed.
describe("OpenCode 2.1.4 background subagent reports (#3897, PR #4064)", () => {
  const user = { id: "msg_user", type: "user", time: { created: 1 }, text: "Launch a child" };

  function launch(
    child: string,
    fields: {
      readonly id?: string;
      readonly background?: boolean;
      readonly status?: string;
      readonly sessionID?: unknown;
    } = {},
  ): Record<string, unknown> {
    const { id = "msg_launch", background = true, status = "completed" } = fields;
    return assistant214({
      id,
      content: [
        {
          type: "tool",
          id: `call_${id}`,
          name: "subagent",
          executed: false,
          time: { created: 2, ran: 2, completed: 3 },
          state: {
            status,
            input: { ...(background ? { background: true } : {}), agent: "explore", prompt: "p" },
            content: [],
            metadata: { sessionID: "sessionID" in fields ? fields.sessionID : child },
          },
        },
      ],
    });
  }

  const answer = (id: string): Record<string, unknown> =>
    assistant214({ id, content: [{ type: "text", text: "Launched." }] });
  const idle = (id: string, outcome = "succeeded"): Record<string, unknown> => ({
    id,
    type: "idle",
    time: { created: 5 },
    outcome,
  });
  const report = (child: string, id = `msg_report_${child}`): Record<string, unknown> => ({
    id,
    type: "synthetic",
    time: { created: 6 },
    metadata: { source: "subagent", childID: child, agent: "Explore", state: "completed" },
    text: `<subagent sessionID="${child}" state="completed">done</subagent>`,
    description: "Synthetic read",
  });

  function kinds(messages: readonly Record<string, unknown>[]): readonly string[] {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "background-run",
      activityLog: undefined,
      toolProfile: "native",
    });
    return projection.project("ses_parent", messages, undefined).map((event) => event.kind);
  }

  it("does not end the run's work on the idle message of a parent that owes a background report", () => {
    const owed = kinds([user, launch("ses_child"), answer("msg_a1"), idle("msg_idle1")]);
    expect(owed).not.toContain("terminal");
    expect(owed).not.toContain("terminal-failure");
  });

  it("ends the run's work on the idle message after the report, not on the one before it", () => {
    const delivered = kinds([
      user,
      launch("ses_child"),
      answer("msg_a1"),
      idle("msg_idle1"),
      report("ses_child"),
      answer("msg_a2"),
      idle("msg_idle2"),
    ]);
    expect(delivered.filter((kind) => kind === "terminal")).toHaveLength(1);
    expect(delivered.at(-1)).toBe("terminal");
  });

  it("keeps waiting while any of several background children has not reported", () => {
    const first = launch("ses_child_a", { id: "msg_launch_a" });
    const second = launch("ses_child_b", { id: "msg_launch_b" });
    const oneReported = kinds([
      user,
      first,
      second,
      idle("msg_idle1"),
      report("ses_child_a"),
      idle("msg_idle2"),
    ]);
    expect(oneReported).not.toContain("terminal");
    const bothReported = kinds([
      user,
      first,
      second,
      idle("msg_idle1"),
      report("ses_child_a"),
      report("ses_child_b"),
      idle("msg_idle2"),
    ]);
    expect(bothReported.at(-1)).toBe("terminal");
  });

  it("owes nothing for a foreground subagent, a launch that failed or a launch naming no child", () => {
    for (const launched of [
      launch("ses_child", { background: false }),
      launch("ses_child", { status: "error" }),
      launch("ses_child", { sessionID: undefined }),
      launch("ses_child", { sessionID: "not-a-session" }),
    ])
      expect(kinds([user, launched, idle("msg_idle1")]).at(-1)).toBe("terminal");
  });

  it("ignores a report that does not come from a subagent or names no child", () => {
    const forged = { ...report("ses_child"), metadata: { source: "other", childID: "ses_child" } };
    const nameless = { ...report("ses_child"), metadata: { source: "subagent" } };
    for (const message of [forged, nameless])
      expect(
        kinds([user, launch("ses_child"), idle("msg_idle1"), message, idle("msg_idle2")]),
      ).not.toContain("terminal");
  });

  it("keeps a failed or interrupted idle message a terminal failure whatever is owed", () => {
    for (const outcome of ["failed", "interrupted"])
      expect(kinds([user, launch("ses_child"), idle("msg_idle1", outcome)]).at(-1)).toBe(
        "terminal-failure",
      );
  });

  it("is stable: the idle message held in one pass stays held when the report arrives", () => {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "background-run",
      activityLog: undefined,
      toolProfile: "native",
    });
    const parent = [user, launch("ses_child"), idle("msg_idle1")];
    const held = projection.project("ses_parent", parent, undefined);
    const next = projection.project(
      "ses_parent",
      [...parent, report("ses_child"), answer("msg_a2"), idle("msg_idle2")],
      held.length - 1,
    );
    // Only what is new is returned: the report, the answer and the idle message that ends the work.
    expect(held.map((event) => event.kind)).not.toContain("terminal");
    expect(next.map((event) => event.kind).filter((kind) => kind === "terminal")).toHaveLength(1);
    expect(next.at(-1)?.kind).toBe("terminal");
    expect(next[0]?.sequence).toBe(held.length);
  });

  it("counts the idle messages it held on the projection line, never a session id", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection({
      runId: "background-run",
      activityLog: sink,
      toolProfile: "native",
    });
    projection.project("ses_parent", [user, launch("ses_child"), idle("msg_idle1")], undefined);
    const line = sink.events.find((event) => event.op === "coding-runtime.history-projection");
    expect(line?.extra).toMatchObject({ heldIdleCount: 1 });
    expect(JSON.stringify(sink.events)).not.toContain("ses_child");
    expectActivityLogProof(
      "coding-runtime.history-projection.emitted-line",
      formatActivityLogProofLine(line ?? {}),
    );
  });

  it("leaves the held count out of a pass that held nothing", () => {
    const sink = createBufferedServerLogSink();
    const projection = createOpenCodeV2HistoryProjection({
      runId: "background-run",
      activityLog: sink,
      toolProfile: "native",
    });
    projection.project("ses_parent", [user, idle("msg_idle1")], undefined);
    const line = sink.events.find((event) => event.op === "coding-runtime.history-projection");
    expect(line?.extra).not.toHaveProperty("heldIdleCount");
  });
});

// C02 (ADR-0137 D10): the runtime stores a slash command's expanded template as the turn's user
// message and marks no command on it. The presentation hook shows what the operator typed instead.
describe("OpenCode V2 slash command presentation", () => {
  const TEMPLATE = "You are a code reviewer. TEMPLATE-CANARY-BODY\n\nInput: main\n";
  const history = (userText = TEMPLATE): readonly Record<string, unknown>[] => [
    { id: "msg_old", type: "user", time: { created: 1 }, text: "an earlier task" },
    { id: "msg_cmd", type: "user", time: { created: 2 }, text: userText },
  ];

  function project(
    userMessageDisplay: ((messageId: string, isNew: boolean) => string | undefined) | undefined,
    messages = history(),
  ): {
    readonly signals: readonly CodingSafeActivitySignal[];
    readonly captured: readonly unknown[];
  } {
    const captured: unknown[] = [];
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-command",
      activityLog: undefined,
      toolProfile: "native",
      captureMessages: (conversation): boolean => {
        captured.push(conversation);
        return true;
      },
      userMessageDisplay,
    });
    const events = projection.project("ses_command", messages, undefined);
    const signals = events.flatMap((event) => {
      const signal = projection.takeSignal(event);
      return signal === undefined ? [] : [signal];
    });
    return { signals, captured };
  }

  it("presents a command's message by what the operator typed in the timeline and in Coding History", () => {
    const seen: [string, boolean][] = [];
    const { signals, captured } = project((id, isNew) => {
      seen.push([id, isNew]);
      return id === "msg_cmd" ? "/review main" : undefined;
    });

    expect(seen).toEqual([
      ["msg_old", true],
      ["msg_cmd", true],
    ]);
    expect(JSON.stringify(signals)).toContain("/review main");
    expect(JSON.stringify(signals)).toContain("an earlier task");
    expect(JSON.stringify(signals)).not.toContain("TEMPLATE-CANARY-BODY");
    expect(captured.at(-1)).toEqual([
      { messageId: "msg_old", role: "user", content: "an earlier task" },
      { messageId: "msg_cmd", role: "user", content: "/review main" },
    ]);
    expect(JSON.stringify(captured)).not.toContain("TEMPLATE-CANARY-BODY");
  });

  it("presents every user message by its own text when no command is presented", () => {
    for (const hook of [undefined, (): undefined => undefined]) {
      const { signals, captured } = project(hook);
      expect(JSON.stringify(signals)).toContain("TEMPLATE-CANARY-BODY");
      expect(captured.at(-1)).toEqual([
        { messageId: "msg_old", role: "user", content: "an earlier task" },
        { messageId: "msg_cmd", role: "user", content: TEMPLATE },
      ]);
    }
  });

  it("says whether the history had shown a message before, so a later read is not new", () => {
    const seen: [string, boolean][] = [];
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-command",
      activityLog: undefined,
      toolProfile: "native",
      userMessageDisplay: (id, isNew) => {
        seen.push([id, isNew]);
        return undefined;
      },
    });
    const messages = history();
    const first = projection.project("ses_command", messages, undefined);
    const checkpoint = first.at(-1)?.sequence;
    seen.length = 0;

    projection.project("ses_command", messages, checkpoint);

    expect(seen).toEqual([
      ["msg_old", false],
      ["msg_cmd", false],
    ]);
  });

  it("asks nothing about a message that is not a user message", () => {
    const seen: string[] = [];
    project(
      (id) => {
        seen.push(id);
        return undefined;
      },
      [
        { id: "msg_user", type: "user", time: { created: 1 }, text: "task" },
        {
          id: "msg_assistant",
          type: "assistant",
          time: { created: 2 },
          content: [{ type: "text", text: "answer" }],
        },
      ],
    );

    expect(seen).toEqual(["msg_user"]);
  });
});

// #3897 (T19): OpenCode 2.1.4 registers one plan tool, `todowrite`, behind its opt-in
// `experimental.todo` (`opencodeNativeQualification.real.test.ts`). Its completed part is the
// governed plan snapshot and never productive tool activity (#2480); a part that has not completed
// carries no final step list and shows nothing.
describe("OpenCode V2 plan carrier tool parts (#3897)", () => {
  const todos = [
    { content: "Read the module", status: "completed", priority: "high" },
    { content: "Write the fix", status: "in_progress", priority: "medium" },
    { content: "Run the checks", status: "pending", priority: "low" },
    { content: "Drop the idea", status: "cancelled", priority: "low" },
  ];

  function planHistory(
    name: string,
    state: Readonly<Record<string, unknown>>,
  ): readonly Record<string, unknown>[] {
    return [
      { id: "msg_user", type: "user", time: { created: 1 }, text: "Plan the work." },
      {
        id: "msg_assistant",
        type: "assistant",
        time: { created: 2 },
        content: [{ type: "tool", id: "call_plan", name, time: { created: 2 }, state }],
      },
    ];
  }

  function toolAndPlanSignals(history: readonly Record<string, unknown>[]): readonly unknown[] {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-plan",
      activityLog: undefined,
      toolProfile: "native",
    });
    return projection
      .project("ses_plan", history, undefined)
      .flatMap((event) => projection.takeSignal(event) ?? [])
      .filter((signal) => signal.kind === "plan" || signal.kind === "tool");
  }

  it.each(["todowrite", "todo"])(
    "projects a completed %s part as the plan snapshot and not as a tool",
    (name) => {
      expect(
        toolAndPlanSignals(planHistory(name, { status: "completed", input: { todos } })),
      ).toEqual([
        {
          kind: "plan",
          anchorMessageId: "msg_assistant",
          steps: [
            { text: "Read the module", state: "completed" },
            { text: "Write the fix", state: "active" },
            { text: "Run the checks", state: "pending" },
            { text: "Drop the idea", state: "cancelled" },
          ],
          occurredAt: new Date(2).toISOString(),
        },
      ]);
    },
  );

  it.each([
    ["streaming", "PRIVATE_PARTIAL_ARGUMENT"],
    ["running", { todos }],
    ["error", { todos }],
  ])("shows nothing for a %s plan part", (status, input) => {
    expect(toolAndPlanSignals(planHistory("todowrite", { status, input }))).toEqual([]);
  });

  it("keeps an unreadable completed plan visible as the tool it is rather than losing it", () => {
    const malformed = [{ content: "No priority", status: "pending" }];
    expect(
      toolAndPlanSignals(
        planHistory("todowrite", { status: "completed", input: { todos: malformed } }),
      ),
    ).toEqual([expect.objectContaining({ kind: "tool", tool: "todowrite", state: "succeeded" })]);
  });
});

// #3901 (#3897 review): the pinned runtime completes a shell call whatever its command returned and
// reports the command's exit status as `metadata.exit` (observed on the 2.1.4 executable:
// `{ status: "completed", metadata: { status: "completed", truncated: false, exit: 3 } }`).
describe("OpenCode V2 native shell exit status (#3901)", () => {
  function shellHistory(
    state: Readonly<Record<string, unknown>>,
  ): readonly Record<string, unknown>[] {
    return [
      { id: "msg_user", type: "user", time: { created: 1 }, text: "Run the tests." },
      {
        id: "msg_assistant",
        type: "assistant",
        time: { created: 2 },
        content: [{ type: "tool", id: "call_shell", name: "shell", time: { created: 2 }, state }],
      },
    ];
  }

  function toolSignals(history: readonly Record<string, unknown>[]): readonly unknown[] {
    const projection = createOpenCodeV2HistoryProjection({
      runId: "run-shell",
      activityLog: undefined,
      toolProfile: "native",
    });
    return projection
      .project("ses_shell", history, undefined)
      .flatMap((event) => projection.takeSignal(event) ?? [])
      .filter((signal) => signal.kind === "tool");
  }

  const completed = (exit: unknown, command = "npm test"): Readonly<Record<string, unknown>> => ({
    status: "completed",
    input: { command },
    content: [{ type: "text", text: "PRIVATE_SHELL_OUTPUT" }],
    metadata: { status: "completed", truncated: false, exit },
  });

  it("projects a command that exited non-zero as a failed call carrying its exit status", () => {
    expect(toolSignals(shellHistory(completed(3)))).toEqual([
      expect.objectContaining({ kind: "tool", callId: "call_shell", state: "failed", exitCode: 3 }),
    ]);
  });

  it("projects a command that exited zero as succeeded with its exit status", () => {
    expect(toolSignals(shellHistory(completed(0)))).toEqual([
      expect.objectContaining({ state: "succeeded", exitCode: 0 }),
    ]);
  });

  // #3897 review: the permission check sees `npm test; cd .` as two commands; the finished line
  // shows that `cd .` decided the zero, so the status speaks for no check.
  it("names the check an exit status speaks for only when the whole line keeps it", () => {
    const check = (command: string): unknown =>
      (toolSignals(shellHistory(completed(0, command)))[0] as Record<string, unknown>)
        .exitStatusCheck;
    expect(check("npm test")).toBe("test");
    expect(check("cd app && npx tsc --noEmit")).toBe("typecheck");
    for (const command of ["npm test; cd .", "npm test || cd .", "npm test | cat", "ls"])
      expect(check(command)).toBeUndefined();
    const background = { status: "completed", input: { command: "npm test", background: true } };
    expect(toolSignals(shellHistory(background))[0]).not.toHaveProperty("exitStatusCheck");
  });

  // Keiko 1.3.1 qualification: a passing check line also proves the checks its package scripts ran,
  // read at admission from the session directory's package.json. A call that named another working
  // directory ran that directory's scripts, so the settlement says so.
  it("says when a check line ran in a working directory the call named itself", () => {
    const signal = (input: Readonly<Record<string, unknown>>): Record<string, unknown> =>
      toolSignals(
        shellHistory({ ...completed(0), input: { command: "npm run check", ...input } }),
      )[0] as Record<string, unknown>;
    expect(signal({})).not.toHaveProperty("ownWorkdir");
    expect(signal({ workdir: "." })).not.toHaveProperty("ownWorkdir");
    expect(signal({ workdir: "  " })).not.toHaveProperty("ownWorkdir");
    expect(signal({ workdir: "packages/web" })).toEqual(
      expect.objectContaining({ exitStatusCheck: "test", ownWorkdir: true }),
    );
    // A line that is no check carries no evidence, wherever it ran.
    const listing = toolSignals(
      shellHistory({ ...completed(0), input: { command: "ls", workdir: "packages/web" } }),
    )[0];
    expect(listing).not.toHaveProperty("ownWorkdir");
  });

  it("carries no exit status for a job moved to the background or a malformed one", () => {
    const background = { status: "completed", input: { command: "npm run dev", background: true } };
    for (const state of [background, completed("3"), completed(1.5)]) {
      const [signal] = toolSignals(shellHistory(state));
      expect(signal).toMatchObject({ state: "succeeded" });
      expect(signal).not.toHaveProperty("exitCode");
    }
    expect(JSON.stringify(toolSignals(shellHistory(completed(3))))).not.toContain(
      "PRIVATE_SHELL_OUTPUT",
    );
  });
});

// #3901: the files a finished step changed, as the runtime's snapshot names them.
describe("native step changes from the runtime's snapshot", () => {
  const step = (fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
    id: "msg_step",
    type: "assistant",
    finish: "tool-calls",
    content: [
      { type: "tool", id: "call_1", name: "shell" },
      { type: "text", text: "done" },
      { type: "tool", id: "call_2", name: "edit" },
    ],
    snapshot: { start: "a", end: "b", files: ["src/a.ts", "gen/new.txt"] },
    ...fields,
  });

  it("reads the changed files and the step's tool calls of a finished assistant step", () => {
    expect(openCodeV2StepChanges([step({})])).toEqual([
      {
        messageId: "msg_step",
        files: ["src/a.ts", "gen/new.txt"],
        callIds: ["call_1", "call_2"],
        truncated: false,
      },
    ]);
  });

  it.each([
    ["an unfinished step", { finish: undefined }],
    ["a step that changed nothing", { snapshot: { start: "a", end: "a", files: [] } }],
    ["a step without a snapshot", { snapshot: undefined }],
    ["a user message", { type: "user" }],
    ["a step without an id", { id: 7 }],
  ])("ignores %s", (_label, fields) => {
    expect(openCodeV2StepChanges([step(fields)])).toEqual([]);
  });

  it("bounds the list and marks it truncated when it held more or something other than a path", () => {
    const many = Array.from(
      { length: OPENCODE_V2_STEP_CHANGE_FILES_MAX + 1 },
      (_, i) => `f${String(i)}`,
    );
    const [bounded] = openCodeV2StepChanges([step({ snapshot: { files: many } })]);
    expect(bounded?.files).toHaveLength(OPENCODE_V2_STEP_CHANGE_FILES_MAX);
    expect(bounded?.truncated).toBe(true);
    const [odd] = openCodeV2StepChanges([step({ snapshot: { files: ["a.ts", 7] } })]);
    expect(odd).toMatchObject({ files: ["a.ts"], truncated: true });
  });
});

// Audit finding 4: every history sync re-projected the whole session. A settled assistant message
// whose serialized form is unchanged, with no live text being fed into it, is now reused from the
// previous projection; the output stays identical to a projection that rebuilds everything.
describe("OpenCode V2 history projection reuse", () => {
  const SESSION = "ses_reuse";
  const LIVE = "msg_live";

  function turn(index: number, text: string): readonly Record<string, unknown>[] {
    return [
      { id: `msg_user_${String(index)}`, type: "user", time: { created: 1 }, text: "Task" },
      {
        id: `msg_done_${String(index)}`,
        type: "assistant",
        time: { created: 2 },
        content: [
          { type: "text", text },
          {
            type: "tool",
            id: `call_${String(index)}`,
            name: "question",
            time: { created: 2 },
            state: { status: "completed", input: { questions: ["q"] }, output: "x".repeat(2_000) },
          },
        ],
      },
    ];
  }

  function session(
    turns: number,
    changedIndex?: number,
    liveText?: string,
  ): readonly Record<string, unknown>[] {
    const settled = Array.from({ length: turns }, (_, index) =>
      turn(
        index,
        index === changedIndex ? "Completed answer. And one more thing." : "Completed answer.",
      ),
    ).flat();
    return liveText === undefined
      ? settled
      : [
          ...settled,
          { id: "msg_user_live", type: "user", time: { created: 3 }, text: "Next" },
          {
            id: LIVE,
            type: "assistant",
            time: { created: 4 },
            content: [{ type: "text", text: liveText }],
          },
        ];
  }

  // The same pulls, replayed against a projection that rebuilds everything every time.
  function pair(): {
    readonly pull: (messages: readonly Record<string, unknown>[]) => {
      readonly reused: OpenCodeV2ProjectionReuse;
    };
    readonly live: (event: Record<string, unknown>) => void;
  } {
    const reusing = createOpenCodeV2HistoryProjection();
    const rebuilding = createOpenCodeV2HistoryProjection(undefined, { reuseMessages: false });
    let checkpoint: number | undefined;
    return {
      live: (event): void => {
        reusing.observeLiveEvent(SESSION, event);
        rebuilding.observeLiveEvent(SESSION, event);
      },
      pull: (messages): { readonly reused: OpenCodeV2ProjectionReuse } => {
        const events = reusing.project(SESSION, structuredClone(messages), checkpoint);
        const baseline = rebuilding.project(SESSION, structuredClone(messages), checkpoint);
        expect(events).toEqual(baseline);
        expect(events.map((event) => reusing.takeSignal(event))).toEqual(
          baseline.map((event) => rebuilding.takeSignal(event)),
        );
        checkpoint = events.at(-1)?.sequence ?? checkpoint;
        return { reused: reusing.lastReuse() };
      },
    };
  }

  it("reuses every unchanged settled assistant message and projects only what changed", () => {
    const both = pair();
    expect(both.pull(session(20)).reused).toEqual({
      reusedMessageCount: 0,
      projectedMessageCount: 20,
    });
    expect(both.pull(session(20)).reused).toEqual({
      reusedMessageCount: 20,
      projectedMessageCount: 0,
    });
    expect(both.pull(session(20, 7)).reused).toEqual({
      reusedMessageCount: 19,
      projectedMessageCount: 1,
    });
    expect(both.pull(session(21, 7)).reused).toEqual({
      reusedMessageCount: 20,
      projectedMessageCount: 1,
    });
  });

  it("never reuses a message that live text is being fed into, and stays identical to a rebuild", () => {
    const both = pair();
    const data = { sessionID: SESSION, assistantMessageID: LIVE, ordinal: 0 };
    both.pull(session(3, undefined, ""));
    both.live({ id: "evt_1", type: "session.text.started", data });
    for (const [index, delta] of ["Hel", "lo ", "wor", "ld"].entries()) {
      both.live({
        id: `evt_d${String(index)}`,
        type: "session.text.delta",
        data: { ...data, delta },
      });
      const { reused } = both.pull(session(3, undefined, ""));
      expect(reused).toEqual({ reusedMessageCount: 3, projectedMessageCount: 1 });
    }
    // The history catches up with the complete part: the live text retires and the message is final.
    both.pull(session(3, undefined, "Hello world"));
    expect(both.pull(session(3, undefined, "Hello world")).reused).toEqual({
      reusedMessageCount: 4,
      projectedMessageCount: 0,
    });
  });

  it("projects a settled message again when live text starts for it after it was reused", () => {
    const both = pair();
    both.pull(session(2, undefined, "Hello world"));
    expect(both.pull(session(2, undefined, "Hello world")).reused.reusedMessageCount).toBe(3);
    both.live({
      id: "evt_late",
      type: "session.text.started",
      data: { sessionID: SESSION, assistantMessageID: LIVE, ordinal: 0 },
    });
    expect(both.pull(session(2, undefined, "Hello world")).reused).toEqual({
      reusedMessageCount: 2,
      projectedMessageCount: 1,
    });
  });
});

describe("OpenCode V2 history window", () => {
  const messages = [
    { id: "msg_user", type: "user", time: { created: 1 }, text: "Task" },
    {
      id: "msg_assistant",
      type: "assistant",
      time: { created: 2 },
      content: [{ type: "text", text: "Answer" }],
    },
  ];

  it("projects a truncated window but never replaces the captured conversation with it", () => {
    const captureMessages = vi.fn().mockReturnValue(true);
    const projection = createOpenCodeV2HistoryProjection({
      runId: "window-run",
      activityLog: undefined,
      captureMessages,
    });

    const events = projection.project("ses_window", messages, undefined, { truncated: true });

    expect(events.length).toBeGreaterThan(0);
    expect(captureMessages).not.toHaveBeenCalled();
    // Once the checkpoint is committed, a complete read captures the conversation as before.
    projection.project("ses_window", messages, events.at(-1)?.sequence);
    expect(captureMessages).toHaveBeenCalledOnce();
  });
});
