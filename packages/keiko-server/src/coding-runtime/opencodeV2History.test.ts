import { describe, expect, it } from "vitest";
import { OPENCODE_MODEL_VISIBLE_TOOL_NAMES } from "./opencodeToolSchemas.js";
import { createOpenCodeV2HistoryProjection } from "./opencodeV2History.js";

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
