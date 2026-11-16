import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createGeneratedOpenCodeNativeContextPlugin } from "./opencodeNativeContext.js";

const model = { providerID: "keiko", id: "thinking" };
interface Message {
  readonly id: string;
  readonly role: string;
  readonly content: readonly {
    readonly type: string;
    readonly id?: string;
    readonly text?: string;
  }[];
}
interface Event {
  readonly sessionID: string;
  readonly model: typeof model;
  readonly system: unknown[];
  messages: Message[];
}
type Hook = (event: Event) => Promise<void> | void;

async function hook(
  history: unknown,
  required = true,
): Promise<{ run: Hook; context: ReturnType<typeof vi.fn> }> {
  const context = vi.fn((): Promise<unknown> =>
    history instanceof Error ? Promise.reject(history) : Promise.resolve(history),
  );
  const source =
    createGeneratedOpenCodeNativeContextPlugin().replace("export default", "const plugin =") +
    "\nplugin;";
  const plugin = new Script(source).runInNewContext({
    process: {
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          providers: {
            keiko: {
              models: {
                thinking: {
                  compatibility: required
                    ? { reasoningField: "reasoning_content", requireReasoning: true }
                    : {},
                },
              },
            },
          },
        }),
      },
    },
  }) as {
    setup: (ctx: {
      session: { context: typeof context; hook: (name: string, callback: Hook) => Promise<void> };
    }) => Promise<void>;
  };
  let run: Hook | undefined;
  await plugin.setup({
    session: {
      context,
      hook: (_name, callback): Promise<void> => {
        run = callback;
        return Promise.resolve();
      },
    },
  });
  if (run === undefined) throw new Error("context hook missing");
  return { run, context };
}

function raw(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    type: "assistant",
    model,
    time: { created: 1, completed: 2 },
    finish: "stop",
    content: [{ type: "reasoning", text: "private reasoning", time: { completed: 2 } }],
    ...overrides,
  };
}

function event(ids: readonly string[]): Event {
  return {
    sessionID: "session",
    model,
    system: [],
    messages: [
      { id: "user", role: "user", content: [{ type: "text", text: "task" }] },
      ...ids.map((id) => ({ id, role: "assistant", content: [{ type: "text", text: "answer" }] })),
    ],
  };
}

describe("required native reasoning history projection (#4059)", () => {
  it("preserves completed tool/answer/length rounds and removes aborted, unfinished and foreign rounds", async () => {
    const histories = [
      raw("answer"),
      raw("length", { finish: "length" }),
      raw("aborted", { error: { code: "aborted" } }),
      raw("pending", { time: { created: 1 } }),
      raw("partial", { content: [{ type: "reasoning", text: "partial", time: {} }] }),
      raw("foreign", { model: { ...model, id: "other" } }),
      raw("filtered", { finish: "content-filter" }),
      raw("failed", { finish: "error" }),
    ];
    const input = event(histories.map((item) => String(item.id)));
    const original = JSON.stringify(histories);
    const { run, context } = await hook(histories);
    await run(input);
    expect(input.messages.map((message) => message.id)).toEqual(["user", "answer", "length"]);
    expect(context).toHaveBeenCalledWith({ sessionID: "session" });
    expect(JSON.stringify(histories)).toBe(original);
    expect(input.system).toHaveLength(1);
  });

  it("removes orphaned results for refused native calls while preserving other tool results", async () => {
    const histories = [
      raw("tool", {
        finish: "tool-calls",
        content: [{ type: "tool", id: "kept-call", state: { status: "completed" } }],
      }),
      raw("pending", {
        content: [{ type: "tool", id: "pending-call", state: { status: "running" } }],
      }),
    ];
    const input = event(["tool", "pending"]);
    input.messages.push(
      {
        id: "results",
        role: "tool",
        content: [
          { type: "tool-result", id: "kept-call" },
          { type: "tool-result", id: "pending-call" },
        ],
      },
      { id: "orphan", role: "tool", content: [{ type: "tool-result", id: "pending-call" }] },
    );
    await (await hook(histories)).run(input);
    expect(input.messages.map((message) => message.id)).toEqual(["user", "tool", "results"]);
    expect(input.messages[2]?.content).toEqual([{ type: "tool-result", id: "kept-call" }]);
  });

  it("preserves compaction checkpoints and leaves default routes on their existing path", async () => {
    const input = event([]);
    const messages = input.messages;
    await (await hook([{ type: "user", id: "checkpoint", content: [] }])).run(input);
    expect(input.messages).toEqual(messages);
    const ordinary = await hook(new Error("must not read history"), false);
    const next = event(["ordinary"]);
    await ordinary.run(next);
    expect(ordinary.context).not.toHaveBeenCalled();
    expect(next.messages).toHaveLength(2);
  });

  it.each([new Error("sensitive upstream body"), null, {}])(
    "fails closed when canonical native history is unavailable (%s)",
    async (history) => {
      const { run } = await hook(history);
      await expect(run(event(["answer"]))).rejects.toThrow(
        /Required model continuation history is (unavailable|invalid)\./u,
      );
    },
  );
});
