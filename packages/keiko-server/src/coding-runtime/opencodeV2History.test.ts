import { describe, expect, it } from "vitest";
import { OPENCODE_MODEL_VISIBLE_TOOL_NAMES } from "./opencodeToolSchemas.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";
import { createBufferedServerLogSink } from "../observability/server-log.js";
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

  it("emits only new characters from cumulative native text parts", () => {
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
