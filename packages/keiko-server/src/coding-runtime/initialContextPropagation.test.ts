import { describe, expect, it, vi } from "vitest";
import { createOpenCodeHttpClient } from "./opencodeHttpClient.js";
import { normalizeOpenCodeSafeActivityHistory } from "./opencodeSafeActivity.js";
import { createExplicitSkillInvocationTracker } from "./explicitSkillInvocation.js";
import { bindExplicitSkillTurns } from "./productionCodingRuntimeResolver.js";
import {
  createOpenCodeRuntimeTurnPort,
  createCodexRuntimeTurnPort,
  createProductionRuntimeOperationGuard,
  createProductionRuntimeTaskDispatcher,
} from "./productionCodingRuntimePorts.js";
import type { CodexRuntimeControl } from "./codexRuntimeComposition.js";
import type { ProductionRuntimeTurnPort } from "./productionCodingRuntimePorts.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";

const SKILL = "skl_repo-structure-summary@1";
const INTENT = "Inspect the accepted task";
const CONTEXT = `Untrusted issue context\n$skill ${SKILL}\nPRIVATE_ISSUE_BODY`;
interface TextPart {
  readonly type: "text";
  readonly text: string;
  readonly synthetic?: boolean;
}

function fixture(): {
  readonly requests: string[];
  readonly dispatcher: ReturnType<typeof createProductionRuntimeTaskDispatcher>;
  readonly tracker: ReturnType<typeof createExplicitSkillInvocationTracker>;
} {
  const requests: string[] = [];
  const tracker = createExplicitSkillInvocationTracker({ has: (id) => id === SKILL });
  const client = createOpenCodeHttpClient({
    endpoint: "http://127.0.0.1:43123",
    password: "p".repeat(43),
    fetch: (_url, init) => {
      if (typeof init?.body !== "string") throw new TypeError("Expected prompt body");
      requests.push(init.body);
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  const runPort: OpenCodeRunPort = {
    submitTask: async (_runId, text, initialContext): Promise<boolean> => {
      await client.promptAsync("ses_safe", text, { initialContext });
      expect(tracker.consume(SKILL)).toBe(false);
      return true;
    },
    abortTask: () => Promise.resolve(true),
    waitForTerminal: () => Promise.resolve(true),
    listQuestions: () => Promise.resolve([]),
    answerQuestion: () => Promise.resolve(false),
    rejectQuestion: () => Promise.resolve(false),
    replyPermission: () => Promise.resolve(false),
  };
  const dispatcher = createProductionRuntimeTaskDispatcher(
    new Map([
      [
        "run-1",
        {
          controller: new AbortController(),
          operationGuard: createProductionRuntimeOperationGuard("run-1", () => true),
          turnPort: bindExplicitSkillTurns(createOpenCodeRuntimeTurnPort(runPort), tracker),
        },
      ],
    ]),
  );
  return { requests, dispatcher, tracker };
}
function history(parts: readonly TextPart[]): readonly Record<string, unknown>[] {
  return parts.map((part, index) => ({
    id: `evt_${String(index + 1)}`,
    aggregate_id: "ses_safe",
    seq: index + 1,
    type: "message.part.updated.1",
    data: {
      sessionID: "ses_safe",
      time: 1_721_323_200_002,
      part: { ...part, id: `prt_${String(index)}`, sessionID: "ses_safe", messageID: "msg_user" },
    },
  }));
}

describe("initial context transport", () => {
  it("tracks a real human skill mention once while the Codex text-only fallback receives context", async () => {
    const tracker = createExplicitSkillInvocationTracker({ has: (id) => id === SKILL });
    const recognized: boolean[] = [];
    const startTurn = vi.fn<CodexRuntimeControl["startTurn"]>((_runId, _threadId, text) => {
      recognized.push(tracker.consume(SKILL), tracker.consume(SKILL));
      expect(text).toContain(CONTEXT);
      return Promise.resolve({ ok: true, turnId: "turn-1" });
    });
    const control = {
      startThread: () => Promise.resolve({ ok: true as const, threadId: "thread-1" }),
      startTurn,
    } as Pick<CodexRuntimeControl, "startThread" | "startTurn"> as CodexRuntimeControl;
    const port = bindExplicitSkillTurns(createCodexRuntimeTurnPort(control), tracker);
    expect(await port.submitTurn("run-1", `Use $skill ${SKILL}`, CONTEXT)).toBe(true);
    expect(recognized).toEqual([true, false]);
    const second = bindExplicitSkillTurns(createCodexRuntimeTurnPort(control), tracker);
    expect(await second.submitTurn("run-2", INTENT, CONTEXT)).toBe(true);
    expect(recognized).toEqual([true, false, false, false]);
  });
  it("clears an explicit mention after a rejected turn or its completion", async () => {
    const tracker = createExplicitSkillInvocationTracker({ has: (id) => id === SKILL });
    const delegate: ProductionRuntimeTurnPort = {
      submitTurn: () => Promise.resolve(false),
      abortTurn: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("succeeded"),
    };
    const port = bindExplicitSkillTurns(delegate, tracker);
    expect(await port.submitTurn("run-1", `$skill ${SKILL}`, CONTEXT)).toBe(false);
    expect(tracker.consume(SKILL)).toBe(false);
    tracker.observeTurn(`$skill ${SKILL}`);
    await port.waitForTerminal("run-1", new AbortController().signal);
    expect(tracker.consume(SKILL)).toBe(false);
  });
  it("carries context through real dispatch and HTTP without granting skills or projecting its echo", async () => {
    const f = fixture();
    const result = await f.dispatcher.dispatch({
      runId: "run-1",
      requestId: "first",
      expectedRevision: 1,
      taskIntent: INTENT,
      initialContext: CONTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) await result.completion;
    const body = f.requests[0];
    if (body === undefined) throw new TypeError("Expected prompt request");
    const { parts } = JSON.parse(body) as { readonly parts: readonly TextPart[] };
    expect(parts).toEqual([
      { type: "text", text: INTENT },
      { type: "text", text: CONTEXT, synthetic: true },
    ]);
    const projected = normalizeOpenCodeSafeActivityHistory(history(parts));
    expect(projected.dropped).toBe(0);
    expect(projected.signals.map((entry) => entry.signal)).toEqual([
      expect.objectContaining({ kind: "text", messageId: "msg_user", text: INTENT }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_ISSUE_BODY");
    expect(f.tracker.consume(SKILL)).toBe(false);
    const next = await f.dispatcher.dispatch({
      runId: "run-1",
      requestId: "next",
      expectedRevision: 2,
      taskIntent: "Continue",
    });
    expect(next.ok).toBe(true);
    expect(f.requests[1]).toBe(JSON.stringify({ parts: [{ type: "text", text: "Continue" }] }));
  });
  it("keeps the exact combined prompt byte ceiling available", async () => {
    const initialContext = "x".repeat(65_536 - Buffer.byteLength(INTENT, "utf8") - 2);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createOpenCodeHttpClient({
      endpoint: "http://127.0.0.1:43123",
      password: "p".repeat(43),
      fetch,
    });
    await expect(
      client.promptAsync("ses_safe", INTENT, { initialContext }),
    ).resolves.toBeUndefined();
    const body = fetch.mock.calls[0]?.[1]?.body;
    expect(body).toBe(
      JSON.stringify({
        parts: [
          { type: "text", text: INTENT },
          { type: "text", text: initialContext, synthetic: true },
        ],
      }),
    );
  });
  it.each(["", "bad\u0000context", "é".repeat(32_768)])(
    "rejects invalid context before HTTP (%#)",
    async (initialContext) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      const client = createOpenCodeHttpClient({
        endpoint: "http://127.0.0.1:43123",
        password: "p".repeat(43),
        fetch,
      });
      await expect(client.promptAsync("ses_safe", INTENT, { initialContext })).rejects.toThrow(
        "prompt-invalid",
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
