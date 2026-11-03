import { describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";
import type { OpenCodeReconciliationEvent } from "./opencodeReconciler.js";
import {
  createOpenCodeV2HttpClient,
  type OpenCodeV2HttpClient,
  type OpenCodeV2MessageWindow,
} from "./opencodeV2HttpClient.js";
import {
  createOpenCodeV2HistoryProjection,
  type OpenCodeV2HistoryProjection,
  type OpenCodeV2HistoryProjectionOptions,
} from "./opencodeV2History.js";

const SESSION = "ses_incremental";

type Message = Record<string, unknown>;

/** A seeded generator: the property cases never read the wall clock or Math.random. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The runtime's message API for one session: newest first (`order=desc`), `limit` honored, an
 * opaque cursor, and a counter of what was served so a test can state what a sync read.
 */
class FakeSession {
  messages: Message[] = [];
  requests = 0;
  served = 0;
  private serialized: string[] = [];

  push(message: Message): void {
    this.messages.push(message);
    this.serialized.push(JSON.stringify(message));
  }

  replace(index: number, message: Message): void {
    this.messages[index] = message;
    this.serialized[index] = JSON.stringify(message);
  }

  truncate(length: number): void {
    this.messages.length = length;
    this.serialized.length = length;
  }

  readonly fetch: typeof globalThis.fetch = (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const limit = Number(url.searchParams.get("limit"));
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const page: string[] = [];
    for (let index = this.serialized.length - 1 - start; index >= 0 && page.length < limit; index--)
      page.push(this.serialized[index] ?? "null");
    this.requests += 1;
    this.served += page.length;
    // A full page names the next one, which may be empty: the end is a page shorter than the limit.
    const next = page.length === limit ? JSON.stringify(String(start + limit)) : "null";
    return Promise.resolve(
      new Response(`{"data":[${page.join(",")}],"cursor":{"next":${next}}}`, {
        headers: { "content-type": "application/json" },
      }),
    );
  };

  client(): OpenCodeV2HttpClient {
    return createOpenCodeV2HttpClient({
      endpoint: "http://127.0.0.1:1984/",
      password: "test-only",
      fetch: this.fetch,
    });
  }
}

let counter = 0;
const messageId = (kind: string): string =>
  `msg_${kind}_${String((counter += 1)).padStart(6, "0")}`;

function userMessage(): Message {
  return { id: messageId("u"), type: "user", time: { created: 1 }, text: "Task" };
}

function idleMessage(outcome: string): Message {
  return { id: messageId("i"), type: "idle", time: { created: 5 }, outcome };
}

/** What an assistant message holds at one point of its life; each level extends the one before. */
interface Progress {
  readonly id: string;
  readonly text: number;
  readonly reasoning: number;
  readonly tool: "none" | "running" | "completed";
  readonly launches?: string;
}

const WORDS = ["", "alpha ", "alpha beta ", "alpha beta gamma ", "alpha beta gamma delta."];

function assistantMessage(progress: Progress): Message {
  const content: Message[] = [{ type: "text", text: WORDS[progress.text] ?? "" }];
  if (progress.reasoning > 0)
    content.push({ type: "reasoning", text: WORDS[progress.reasoning] ?? "" });
  if (progress.tool !== "none")
    content.push({
      type: "tool",
      id: `call_${progress.id}`,
      name: "question",
      time: { created: 2 },
      state: {
        status: progress.tool,
        input: { questions: ["q"] },
        output: progress.tool === "completed" ? "answer" : "",
      },
    });
  if (progress.launches !== undefined)
    content.push({
      type: "tool",
      id: `call_launch_${progress.id}`,
      name: "subagent",
      executed: false,
      time: { created: 2, ran: 2, completed: 3 },
      state: {
        status: "completed",
        input: { background: true, agent: "explore", prompt: "p" },
        content: [],
        metadata: { sessionID: progress.launches },
      },
    });
  return { id: progress.id, type: "assistant", time: { created: 2 }, content };
}

function reportMessage(child: string): Message {
  return {
    id: messageId("r"),
    type: "synthetic",
    time: { created: 6 },
    metadata: { source: "subagent", childID: child, agent: "Explore", state: "completed" },
    text: `<subagent sessionID="${child}" state="completed">done</subagent>`,
    description: "Synthetic read",
  };
}

interface Pulled {
  readonly events: readonly OpenCodeReconciliationEvent[];
  readonly signals: readonly (CodingSafeActivitySignal | undefined)[];
}

/** One projection fed by the reader under test: the plan, the anchored read, the projection. */
class IncrementalReader {
  readonly captured: CodingHistoryMessage[][] = [];
  readonly projection: OpenCodeV2HistoryProjection;
  checkpoint: number | undefined;
  lastWindow: OpenCodeV2MessageWindow | undefined;

  constructor(
    private readonly session: FakeSession,
    options?: OpenCodeV2HistoryProjectionOptions,
    private readonly client: OpenCodeV2HttpClient = session.client(),
  ) {
    this.projection = createOpenCodeV2HistoryProjection(
      {
        runId: "incremental-run",
        activityLog: undefined,
        toolProfile: "native",
        captureMessages: (messages): boolean => {
          this.captured.push(structuredClone([...messages]));
          return this.captured.length % 5 !== 3;
        },
      },
      options,
    );
  }

  async sync(commit = true): Promise<Pulled> {
    const plan = this.projection.readPlan(this.checkpoint);
    const window = await this.client.recentMessages(SESSION, undefined, plan.anchorId);
    this.lastWindow = window;
    const events = this.projection.project(SESSION, window.messages, this.checkpoint, {
      truncated: window.truncated,
      anchored: window.anchored,
    });
    const signals = events.map((event) => this.projection.takeSignal(event));
    if (commit) this.checkpoint = events.at(-1)?.sequence ?? this.checkpoint;
    return { events, signals };
  }
}

/** The reference: every sync hands the projection the whole session and rebuilds everything. */
class FullReader {
  readonly captured: CodingHistoryMessage[][] = [];
  readonly projection: OpenCodeV2HistoryProjection;
  checkpoint: number | undefined;

  constructor(private readonly session: FakeSession) {
    this.projection = createOpenCodeV2HistoryProjection(
      {
        runId: "full-run",
        activityLog: undefined,
        toolProfile: "native",
        captureMessages: (messages): boolean => {
          this.captured.push(structuredClone([...messages]));
          return this.captured.length % 5 !== 3;
        },
      },
      { reuseMessages: false, incremental: false },
    );
  }

  sync(commit = true): Pulled {
    const events = this.projection.project(
      SESSION,
      structuredClone(this.session.messages),
      this.checkpoint,
    );
    const signals = events.map((event) => this.projection.takeSignal(event));
    if (commit) this.checkpoint = events.at(-1)?.sequence ?? this.checkpoint;
    return { events, signals };
  }
}

describe("OpenCode V2 tail message read (#4104)", () => {
  function session(total: number): FakeSession {
    const fake = new FakeSession();
    for (let index = 0; index < total; index += 1)
      fake.push({
        id: `msg_${String(index).padStart(6, "0")}`,
        type: index % 2 === 0 ? "user" : "assistant",
      });
    return fake;
  }

  it("stops at the anchor and returns the messages from it to the newest, oldest first", async () => {
    const fake = session(300);

    const window = await fake.client().recentMessages(SESSION, undefined, "msg_000280");

    expect(window.anchored).toBe(true);
    expect(window.truncated).toBe(false);
    expect(window.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `msg_${String(280 + index).padStart(6, "0")}`),
    );
    expect(fake.requests).toBe(1);
    expect(fake.served).toBeLessThan(100);
  });

  it("reads on past the first page for a burst of messages and still stops at the anchor", async () => {
    const fake = session(300);

    const window = await fake.client().recentMessages(SESSION, undefined, "msg_000100");

    expect(window.anchored).toBe(true);
    expect(window.messages).toHaveLength(200);
    expect(window.messages[0]?.id).toBe("msg_000100");
    expect(fake.requests).toBeGreaterThan(1);
    expect(fake.served).toBeLessThan(300);
  });

  it("returns the whole session, not anchored, when the anchor is no longer in it", async () => {
    const fake = session(120);

    const window = await fake.client().recentMessages(SESSION, undefined, "msg_gone");
    const complete = await fake.client().recentMessages(SESSION);

    expect(window.anchored).not.toBe(true);
    expect(window.truncated).toBe(false);
    expect(window.messages).toEqual(complete.messages);
    expect(window.messages).toHaveLength(120);
  });

  it("keeps the bound: a session past it with a lost anchor is the truncated newest window", async () => {
    const fake = session(5_000);

    const window = await fake.client().recentMessages(SESSION, undefined, "msg_gone");

    expect(window.anchored).not.toBe(true);
    expect(window.truncated).toBe(true);
    expect(window.messages.at(-1)?.id).toBe("msg_004999");
    expect(window.messages[0]?.type).toBe("user");
  });

  it("leaves the complete read exactly as strict as before", async () => {
    await expect(session(5_000).client().messages(SESSION)).rejects.toThrow(
      "opencode-v2-history-oversized",
    );
  });
});

describe("OpenCode V2 history read plan (#4104)", () => {
  function settledSession(turns: number): FakeSession {
    const fake = new FakeSession();
    fake.push(userMessage());
    for (let turn = 0; turn < turns; turn += 1)
      fake.push(assistantMessage({ id: messageId("a"), text: 4, reasoning: 0, tool: "completed" }));
    return fake;
  }

  it("plans no anchor before anything was projected, then anchors the tail", async () => {
    const fake = settledSession(10);
    const reader = new IncrementalReader(fake, { tailMargin: 4 });

    expect(reader.projection.readPlan(undefined).anchorId).toBeUndefined();
    await reader.sync();
    expect(reader.projection.lastSync()).toMatchObject({
      readMode: "full",
      readMessageCount: 11,
      retainedMessageCount: 0,
    });

    const plan = reader.projection.readPlan(reader.checkpoint);
    expect(plan.anchorId).toBe(fake.messages[7]?.id);
  });

  it("reads and projects only the tail of a quiet sync and says what it carried over", async () => {
    const fake = settledSession(120);
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    // The first pass stops at the event cap; the second catches up. The third is a tail read.
    await reader.sync();
    await reader.sync();
    const before = fake.served;

    await reader.sync();

    expect(reader.lastWindow?.messages).toHaveLength(4);
    expect(fake.served - before).toBeLessThanOrEqual(50);
    expect(reader.projection.lastSync()).toEqual({
      readMode: "tail",
      readMessageCount: 4,
      retainedMessageCount: 117,
    });
    expect(reader.projection.lastReuse()).toEqual({
      reusedMessageCount: 4,
      projectedMessageCount: 0,
    });
  });

  it("projects a changed existing part inside the tail and emits only that change", async () => {
    const fake = new FakeSession();
    fake.push(userMessage());
    const id = messageId("a");
    fake.push(assistantMessage({ id, text: 1, reasoning: 0, tool: "running" }));
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    await reader.sync();
    for (let turn = 0; turn < 30; turn += 1)
      fake.push(assistantMessage({ id: messageId("a"), text: 4, reasoning: 0, tool: "completed" }));
    await reader.sync();

    fake.replace(
      fake.messages.length - 1,
      assistantMessage({
        id: fake.messages.at(-1)?.id as string,
        text: 4,
        reasoning: 2,
        tool: "completed",
      }),
    );
    fake.replace(
      fake.messages.length - 2,
      assistantMessage({
        id: fake.messages.at(-2)?.id as string,
        text: 4,
        reasoning: 0,
        tool: "completed",
      }),
    );
    const pulled = await reader.sync();

    expect(reader.projection.lastSync().readMode).toBe("tail");
    expect(pulled.events.length).toBeGreaterThan(0);
    expect(pulled.signals.some((signal) => signal?.kind === "reasoning")).toBe(true);
  });

  it("falls back to a complete read when the anchor is gone and says so", async () => {
    const fake = settledSession(20);
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    await reader.sync();

    // A revert removed the newest messages, the anchor among them.
    fake.truncate(fake.messages.length - 8);
    await reader.sync();

    expect(reader.projection.lastSync()).toMatchObject({
      readMode: "anchor-lost",
      readMessageCount: fake.messages.length,
      retainedMessageCount: 0,
    });
  });

  it("reads the whole session again every verifyEvery syncs, picking up an old edit", async () => {
    const fake = settledSession(30);
    const reader = new IncrementalReader(fake, { tailMargin: 4, verifyEvery: 3 });
    await reader.sync();
    // A part older than the tail is edited after the fact: the tail never re-reads it.
    fake.replace(
      3,
      assistantMessage({ id: idOf(fake.messages[3]), text: 4, reasoning: 3, tool: "completed" }),
    );

    const modes: string[] = [];
    let changed = 0;
    await inSequence(4, async () => {
      const pulled = await reader.sync();
      modes.push(reader.projection.lastSync().readMode);
      changed += pulled.events.length;
    });

    expect(modes).toEqual(["tail", "tail", "tail", "verify"]);
    expect(changed).toBeGreaterThan(0);
    expect(reader.projection.lastSync().retainedMessageCount).toBe(0);
  });

  it("plans a complete read while the checkpoint of the last pass is not yet committed", async () => {
    const fake = settledSession(10);
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    const first = await reader.sync(false);
    expect(first.events.length).toBeGreaterThan(0);

    expect(reader.projection.readPlan(reader.checkpoint).anchorId).toBeUndefined();
  });

  it("plans a complete read after a pass that hit the event cap", async () => {
    const fake = settledSession(200);
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    const first = await reader.sync();
    expect(first.events).toHaveLength(256);

    expect(reader.projection.readPlan(reader.checkpoint).anchorId).toBeUndefined();
    await reader.sync();
    // The catch-up ends once a pass stays under the cap (the third); only then does the tail take over.
    const last = await reader.sync();
    expect(last.events.length).toBeLessThan(256);
    expect(reader.projection.readPlan(reader.checkpoint).anchorId).toBeDefined();
  });

  async function streamingOutsideTheTail(delta: string | undefined): Promise<{
    readonly reader: IncrementalReader;
    readonly fake: FakeSession;
    readonly id: string;
  }> {
    const fake = new FakeSession();
    fake.push(userMessage());
    const id = messageId("a");
    fake.push(assistantMessage({ id, text: 0, reasoning: 0, tool: "none" }));
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    await reader.sync();
    const data = { sessionID: SESSION, assistantMessageID: id, ordinal: 0 };
    reader.projection.observeLiveEvent(SESSION, {
      id: "evt_start",
      type: "session.text.started",
      data,
    });
    if (delta !== undefined)
      reader.projection.observeLiveEvent(SESSION, {
        id: "evt_delta",
        type: "session.text.delta",
        data: { ...data, delta },
      });
    for (let turn = 0; turn < 12; turn += 1)
      fake.push(assistantMessage({ id: messageId("a"), text: 4, reasoning: 0, tool: "completed" }));
    await reader.sync();
    return { reader, fake, id };
  }

  it("does not skip an older message that holds live text the history has not shown complete", async () => {
    const { reader, fake, id } = await streamingOutsideTheTail("alpha ");

    // The streaming message left the tail, so its overlay forces the complete read.
    expect(reader.projection.readPlan(reader.checkpoint).anchorId).toBeUndefined();

    // The history completes the part; the complete read retires the overlay and the tail resumes.
    fake.replace(1, assistantMessage({ id, text: 4, reasoning: 0, tool: "none" }));
    await reader.sync();
    expect(reader.projection.lastSync().readMode).toBe("full");
    expect(reader.projection.readPlan(reader.checkpoint).anchorId).toBeDefined();
  });

  it("keeps reading the tail when an older part was announced but never received any text", async () => {
    const { reader } = await streamingOutsideTheTail(undefined);

    expect(reader.projection.readPlan(reader.checkpoint).anchorId).toBeDefined();
  });

  it("refuses an anchored window that does not start at the planned anchor", async () => {
    const fake = settledSession(10);
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    await reader.sync();
    reader.projection.readPlan(reader.checkpoint);

    expect(() =>
      reader.projection.project(SESSION, fake.messages.slice(-2), reader.checkpoint, {
        anchored: true,
      }),
    ).toThrow("opencode-v2-tail-anchor-mismatch");
  });

  it("never replaces the captured conversation from the tail of a truncated session", async () => {
    const fake = settledSession(10);
    const reader = new IncrementalReader(fake, { tailMargin: 4 });
    const plan = reader.projection.readPlan(undefined);
    expect(plan.anchorId).toBeUndefined();
    const events = reader.projection.project(SESSION, fake.messages.slice(), undefined, {
      truncated: true,
    });
    reader.checkpoint = events.at(-1)?.sequence;
    fake.push(assistantMessage({ id: messageId("a"), text: 4, reasoning: 0, tool: "completed" }));

    const pulled = await reader.sync();

    expect(reader.projection.lastSync().readMode).toBe("tail");
    expect(pulled.events.length).toBeGreaterThan(0);
    expect(reader.captured).toEqual([]);
  });

  it("writes the read mode and counts on the projection line, body-free", async () => {
    const sink = createBufferedServerLogSink();
    const fake = settledSession(20);
    const client = fake.client();
    const projection = createOpenCodeV2HistoryProjection(
      { runId: "line-run", activityLog: sink, toolProfile: "native" },
      { tailMargin: 4 },
    );
    let checkpoint: number | undefined;
    const sync = async (): Promise<void> => {
      const plan = projection.readPlan(checkpoint);
      const window = await client.recentMessages(SESSION, undefined, plan.anchorId);
      const events = projection.project(SESSION, window.messages, checkpoint, {
        truncated: window.truncated,
        anchored: window.anchored,
      });
      checkpoint = events.at(-1)?.sequence ?? checkpoint;
    };
    await sync();
    fake.push(assistantMessage({ id: messageId("a"), text: 2, reasoning: 0, tool: "none" }));
    await sync();

    const lines = sink.events
      .filter((event) => event.op === "coding-runtime.history-projection")
      .map((event) =>
        expectActivityLogProof(
          "coding-runtime.history-projection.emitted-line",
          formatActivityLogProofLine(event),
        ),
      );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      readMode: "full",
      readMessageCount: 21,
      retainedMessageCount: 0,
    });
    expect(lines[1]).toMatchObject({
      readMode: "tail",
      readMessageCount: 5,
      retainedMessageCount: 17,
    });
    expect(JSON.stringify(sink.events)).not.toContain("alpha");
  });
});

/** Runs `run` for each index one after the other: a chain keeps the order without awaiting in a loop. */
function inSequence(count: number, run: (index: number) => Promise<void>): Promise<void> {
  return Array.from({ length: count }, (_, index) => index).reduce(
    (chain, index) => chain.then(() => run(index)),
    Promise.resolve(),
  );
}

function idOf(message: Message | undefined): string {
  if (typeof message?.id !== "string") throw new TypeError("expected a message with an id");
  return message.id;
}

describe("OpenCode V2 incremental history equals a full projection (#4104)", () => {
  const SEEDS = 20;
  const STEPS = 60;

  interface Config {
    readonly margin: number;
    readonly verifyEvery: number;
  }

  // The margin decides how much of the end a tail read re-projects; the verify cadence how often a
  // complete read replaces it. A tiny margin, the default shape and a frequent verification.
  const CONFIGS: readonly Config[] = [
    { margin: 1, verifyEvery: 10_000 },
    { margin: 4, verifyEvery: 10_000 },
    { margin: 9, verifyEvery: 10_000 },
    { margin: 4, verifyEvery: 7 },
  ];

  type ModeCounts = Record<string, number>;

  /** One randomized session, fed to the tail reader under test and to the full reference. */
  class RandomCase {
    readonly session = new FakeSession();
    private readonly assistants = new Map<string, Progress>();
    private readonly rng: () => number;
    private readonly incremental: IncrementalReader;
    private readonly reference = new FullReader(this.session);
    private children = 0;
    // The tail the next fresh pass re-projects starts at the anchor the last fresh pass chose: the
    // margin before the end of its window, and never earlier than the window's own start. The
    // runtime edits only what that tail holds (the in-flight messages).
    private anchorIndex = 0;
    private retrying = false;

    constructor(
      private readonly seed: number,
      private readonly config: Config,
      private readonly modes: ModeCounts,
    ) {
      this.rng = mulberry32(seed);
      this.incremental = new IncrementalReader(this.session, {
        tailMargin: config.margin,
        verifyEvery: config.verifyEvery,
      });
      this.session.push(userMessage());
      // Some cases open on a long history, so the first pass is capped and the catch-up spans passes.
      if (seed % 4 === 0) for (let turn = 0; turn < 100; turn += 1) this.appendAssistant();
    }

    private readonly operations: readonly (() => void)[] = [
      (): void => {
        this.appendAssistant();
      },
      (): void => {
        this.appendAssistant();
      },
      (): void => {
        this.appendAssistant();
      },
      (): void => {
        this.advance();
      },
      (): void => {
        this.advance();
      },
      (): void => {
        this.advance();
      },
      (): void => {
        this.session.push(userMessage());
      },
      (): void => {
        this.session.push(idleMessage(this.pick(4) === 0 ? "failed" : "succeeded"));
      },
      (): void => {
        this.launch();
      },
      (): void => {
        this.report();
      },
      (): void => {
        this.revert();
      },
      (): void => {
        this.burst();
      },
      (): void => {
        this.liveText();
      },
      (): void => undefined,
    ];

    private pick(count: number): number {
      return Math.floor(this.rng() * count);
    }

    private appendAssistant(launches?: string): void {
      const progress: Progress = {
        id: messageId("a"),
        text: this.pick(2),
        reasoning: this.pick(3) === 0 ? 1 : 0,
        tool: this.pick(3) === 0 ? "running" : "none",
        ...(launches === undefined ? {} : { launches }),
      };
      this.assistants.set(progress.id, progress);
      this.session.push(assistantMessage(progress));
    }

    /** Edits an assistant message the way the runtime does: every part only grows or completes. */
    private advance(): void {
      const { messages } = this.session;
      const indexes = messages.flatMap((message, index) =>
        index >= this.anchorIndex && message.type === "assistant" ? [index] : [],
      );
      const index = indexes[this.pick(indexes.length)];
      if (index === undefined) return;
      const current = this.assistants.get(idOf(messages[index]));
      if (current === undefined) return;
      const next: Progress = {
        ...current,
        text: Math.min(4, current.text + this.pick(3)),
        reasoning: current.reasoning === 0 ? 0 : Math.min(4, current.reasoning + this.pick(3)),
        tool: current.tool === "none" || this.pick(2) === 0 ? current.tool : "completed",
      };
      this.assistants.set(next.id, next);
      this.session.replace(index, assistantMessage(next));
    }

    private launch(): void {
      this.children += 1;
      this.appendAssistant(`ses_child_${String(this.children)}`);
    }

    private report(): void {
      if (this.children > 0)
        this.session.push(reportMessage(`ses_child_${String(1 + this.pick(this.children))}`));
    }

    // A revert removes the newest messages, the anchor among them when it removes enough.
    private revert(): void {
      const removed = 1 + this.pick(3 * this.config.margin);
      this.session.truncate(Math.max(1, this.session.messages.length - removed));
    }

    private burst(): void {
      for (let count = 40 + this.pick(40); count > 0; count -= 1) this.appendAssistant();
    }

    private liveText(): void {
      const target = [...this.assistants.values()].at(-1 - this.pick(2));
      if (target === undefined) return;
      const data = { sessionID: SESSION, assistantMessageID: target.id, ordinal: 0 };
      this.live({ id: `evt_${String(counter)}_s`, type: "session.text.started", data });
      this.live({
        id: `evt_${String(counter)}_d`,
        type: "session.text.delta",
        data: { ...data, delta: "alpha " },
      });
    }

    private live(event: Message): void {
      this.incremental.projection.observeLiveEvent(SESSION, event);
      this.reference.projection.observeLiveEvent(SESSION, event);
    }

    private get label(): string {
      return `seed ${String(this.seed)} margin ${String(this.config.margin)} verify ${String(this.config.verifyEvery)}`;
    }

    async step(step: number): Promise<void> {
      this.operations[this.pick(this.operations.length)]?.();
      if (step % 17 === 16) {
        this.incremental.projection.freezeLiveText();
        this.reference.projection.freezeLiveText();
      }
      // A sync whose checkpoint is not committed is retried with the same position.
      const commit = this.rng() >= 0.1;
      const got = await this.incremental.sync(commit);
      const want = this.reference.sync(commit);
      const at = `${this.label} step ${String(step)}`;
      expect(got.events, `${at} events`).toEqual(want.events);
      expect(got.signals, `${at} signals`).toEqual(want.signals);
      expect(this.incremental.captured.length, `${at} captures`).toBe(
        this.reference.captured.length,
      );
      this.track(commit, got.events.length);
    }

    // The anchor and the read mode follow fresh passes only: a retry returns the pending page.
    private track(commit: boolean, eventCount: number): void {
      if (!this.retrying) {
        const { lastWindow: window } = this.incremental;
        const start = window?.anchored === true ? this.anchorIndex : 0;
        this.anchorIndex = start + Math.max(0, (window?.messages.length ?? 0) - this.config.margin);
        const { readMode } = this.incremental.projection.lastSync();
        this.modes[readMode] = (this.modes[readMode] ?? 0) + 1;
      }
      this.retrying = !commit && (this.retrying || eventCount > 0);
    }

    verifyCaptured(): void {
      expect(this.incremental.captured, `${this.label} captured conversations`).toEqual(
        this.reference.captured,
      );
    }
  }

  it("matches the events, signals and captured conversation of a full projection on randomized sessions", async () => {
    const modes: ModeCounts = {};
    await inSequence(CONFIGS.length * SEEDS, async (index) => {
      const config = CONFIGS[Math.floor(index / SEEDS)];
      if (config === undefined) throw new TypeError("expected a configuration");
      const randomCase = new RandomCase((index % SEEDS) + 1, config, modes);
      await inSequence(STEPS, (step) => randomCase.step(step));
      randomCase.verifyCaptured();
    });
    // The equality is not trivial: tail reads, lost anchors and scheduled verifications all occurred.
    const passes = Object.values(modes).reduce((sum, count) => sum + count, 0);
    expect(modes.tail ?? 0).toBeGreaterThan(passes / 4);
    expect(modes["anchor-lost"] ?? 0).toBeGreaterThan(0);
    expect(modes.verify ?? 0).toBeGreaterThan(0);
  }, 240_000);
});

describe("OpenCode V2 history sync cost over a long session (#4104)", () => {
  const STEPS = 2_000;

  /** One step of a run: the message appears empty, its text completes, then its tool completes. */
  async function runSteps(
    reader: IncrementalReader,
    fake: FakeSession,
  ): Promise<{ readonly reads: number[]; readonly handed: number[] }> {
    const reads: number[] = [];
    const handed: number[] = [];
    const phases = [
      { text: 0, tool: "none" },
      { text: 4, tool: "running" },
      { text: 4, tool: "completed" },
    ] as const;
    let id = "";
    await inSequence(STEPS * phases.length, async (index) => {
      const progress = phases[index % phases.length];
      if (progress === undefined) throw new TypeError("expected a phase");
      if (progress.text === 0) id = messageId("a");
      const message = assistantMessage({ id, reasoning: 0, ...progress });
      if (progress.text === 0) fake.push(message);
      else fake.replace(fake.messages.length - 1, message);
      const before = fake.served;
      await reader.sync();
      reads.push(fake.served - before);
      handed.push(reader.lastWindow?.messages.length ?? 0);
    });
    return { reads, handed };
  }

  it("keeps the messages read and projected per event flat on a 2,000-step session", async () => {
    const fake = new FakeSession();
    fake.push(userMessage());
    const reader = new IncrementalReader(fake);

    const { reads, handed } = await runSteps(reader, fake);

    // Every sync but the periodic verification and the first reads a bounded tail, early or late.
    const verifications = Math.ceil((STEPS * 3) / 256) + 2;
    const settled = 400;
    const heavy = reads.slice(settled).filter((read) => read > 100);
    expect(heavy.length).toBeLessThanOrEqual(verifications);
    const tails = reads.slice(settled).filter((read) => read <= 100);
    expect(Math.max(...tails)).toBeLessThanOrEqual(100);
    expect(Math.max(...handed.slice(settled).filter((count) => count <= 100))).toBeLessThanOrEqual(
      60,
    );
    expect(reads.reduce((sum, read) => sum + read, 0)).toBeLessThan(
      verifications * STEPS * 1.1 + STEPS * 3 * 100,
    );
  }, 120_000);
});
