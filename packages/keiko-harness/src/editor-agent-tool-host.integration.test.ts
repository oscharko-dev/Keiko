import { describe, expect, it } from "vitest";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  type EditorAgentSessionSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  EditorAgentHttpClient,
  EditorAgentToolHost,
  type EditorAgentHttpTransport,
} from "@oscharko-dev/keiko-tools";
import { createSession } from "./session.js";
import { counterIdSource } from "./fingerprint.js";
import { MemoryEventSink } from "./sinks.js";
import { response, scriptedModel, stubClock } from "./_support.js";

const HASH = "a".repeat(64);

function snapshot(): EditorAgentSessionSnapshot {
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    sessionId: "session-1",
    windowId: "window-1",
    workspaceRoot: "/repo",
    activePaneId: null,
    panes: [],
    dirtyFiles: [],
    activeFile: null,
    cursor: null,
    selection: null,
    diagnosticsSummary: null,
    textMode: "none",
    updatedAt: 1,
  };
}

describe("EditorAgentToolHost harness invocation", () => {
  it("is genuinely invoked through an existing createSession ToolPort", async () => {
    let transportCalls = 0;
    const transport: EditorAgentHttpTransport = {
      request: (request) => {
        transportCalls += 1;
        return Promise.resolve({
          status: 200,
          body: new TextEncoder().encode(JSON.stringify({ sessions: [snapshot()] })),
          url: request.url,
          redirected: false,
        });
      },
    };
    const tools = new EditorAgentToolHost({
      client: new EditorAgentHttpClient({ baseUrl: "http://localhost:1983", transport }),
      authorityRef: { runId: "run-authority", envelopeDigest: HASH },
      nextActionId: (): string => "action-1",
      now: (): number => 0,
    });
    const model = scriptedModel([
      response({
        finishReason: "tool_calls",
        toolCalls: [{ id: "tool-1", name: "editor_list_sessions", arguments: {} }],
      }),
      response({ content: "inspection complete" }),
    ]);
    const session = createSession(
      { taskType: "investigate-bug", input: { description: "Inspect editor sessions" } },
      { model: "m", workingDirectory: "/repo" },
      {
        model: model.port,
        tools,
        sink: new MemoryEventSink(),
        clock: stubClock().clock,
        idSource: counterIdSource(),
      },
    );
    const result = await session.result;
    expect(result.outcome).toBe("completed");
    expect(transportCalls).toBe(1);
    expect(model.requests()[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "tool-1",
    });
    expect(model.requests()[1]?.messages.at(-1)?.content).toContain('"kind":"sessions"');
  });
});
