import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  createCodingSessionContinuity,
  type CodingSessionContinuity,
  type ContinuityIntent,
  type ContinuityOutcome,
} from "./codingSessionContinuity.js";
import { OPENCODE_RUNTIME_READINESS_PROMPT } from "./opencodeLaunchProfile.js";
import { OPENCODE_PERSISTENCE_SCHEMAS } from "./opencodePersistenceContract.js";
import {
  bindContinuedSession,
  retainSettledRun,
  seedContinuation,
  withoutBaseline,
  type ContinuationClient,
  type RunContinuation,
  type SessionContinuationContext,
} from "./opencodeSessionContinuation.js";
import {
  createRetainedSessionStore,
  retainedSessionKey,
  type CheckoutResult,
  type RetainedSessionStore,
  type RetainResult,
} from "./opencodeSessionRetention.js";

const RUN = "run-continuation-1";
const WORKSPACE = "/work/space";
const TASK = "task-1";
const SESSION = "ses_retained_1";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-continuation-"));
  roots.push(root);
  return root;
}

interface StoreCalls {
  readonly checkouts: Parameters<RetainedSessionStore["checkout"]>[0][];
  readonly retains: Parameters<RetainedSessionStore["retain"]>[0][];
  readonly removed: string[];
}

function fakeStore(
  results: {
    checkout?: CheckoutResult | Error;
    retain?: RetainResult | Error;
    remove?: Error;
  } = {},
): {
  readonly store: RetainedSessionStore;
  readonly calls: StoreCalls;
} {
  const calls: StoreCalls = { checkouts: [], retains: [], removed: [] };
  const store: RetainedSessionStore = {
    checkout: (input) => {
      calls.checkouts.push(input);
      const result = results.checkout ?? {
        ok: true,
        sessionId: SESSION,
        databaseBytes: 2048,
        messageCount: 9,
        ageMs: 4000,
      };
      if (result instanceof Error) throw result;
      return result;
    },
    retain: (input) => {
      calls.retains.push(input);
      const result = results.retain ?? {
        ok: true,
        databaseBytes: 2048,
        messageCount: 9,
        entryCount: 2,
        prunedCount: 1,
      };
      if (result instanceof Error) throw result;
      return result;
    },
    remove: (taskId) => {
      calls.removed.push(taskId);
      if (results.remove !== undefined) throw results.remove;
    },
    prune: () => ({ expired: 0, orphaned: 0, invalid: 0, quota: 0, entryCount: 0 }),
  };
  return { store, calls };
}

interface Harness {
  readonly service: CodingSessionContinuity;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly context: SessionContinuationContext;
  readonly calls: StoreCalls;
  readonly outcomes: ContinuityOutcome[];
}

function harness(
  options: {
    store?: RetainedSessionStore | null;
    taskOfRun?: (runId: string) => string | undefined;
    results?: Parameters<typeof fakeStore>[0];
    workspaceId?: string;
  } = {},
): Harness {
  const fake = fakeStore(options.results);
  const store = options.store === null ? undefined : (options.store ?? fake.store);
  const service = createCodingSessionContinuity({
    store,
    taskOfRun:
      options.taskOfRun ?? ((runId): string | undefined => (runId === RUN ? TASK : undefined)),
  });
  const outcomes: ContinuityOutcome[] = [];
  const settle = service.settle.bind(service);
  service.settle = (runId, outcome): void => {
    outcomes.push(outcome);
    settle(runId, outcome);
  };
  const log = createBufferedServerLogSink();
  return {
    service,
    log,
    calls: fake.calls,
    outcomes,
    context: {
      service,
      workspaceId: options.workspaceId ?? "workspace-1",
      runtimeVersion: "2.1.4",
      maxInputTokens: 24_000,
      activityLog: log,
    },
  };
}

/** The continuity lines written so far, each with its envelope and its `extra` fields side by side. */
function lines(h: Harness): readonly Record<string, unknown>[] {
  return h.log.events
    .filter((event) => event.op === "coding-runtime.session-continuity")
    .map((event) => ({ ...event, ...(event.extra as Record<string, unknown>) }));
}

function location(runRoot = "/run/root"): {
  runId: string;
  runRoot: string;
  workspaceRoot: string;
} {
  return { runId: RUN, runRoot, workspaceRoot: WORKSPACE };
}

const RESUME: ContinuityIntent = { kind: "resume", taskId: TASK };

describe("seeding a run's database from a task's retained entry", () => {
  it("does nothing for a run that asked for nothing", () => {
    const h = harness();

    expect(seedContinuation(h.context, location())).toBeUndefined();
    expect(h.calls.checkouts).toEqual([]);
    expect(h.outcomes).toEqual([]);
    expect(lines(h)).toEqual([]);
  });

  it("checks the entry out for the run's own workspace, window and version and keeps its facts", () => {
    const h = harness();
    h.service.declare(RUN, RESUME);

    const continuation = seedContinuation(h.context, location("/run/root"));

    expect(continuation).toEqual({
      intent: RESUME,
      taskId: TASK,
      sessionId: SESSION,
      databaseBytes: 2048,
      messageCount: 9,
      ageMs: 4000,
    });
    expect(h.calls.checkouts).toEqual([
      {
        binding: {
          taskId: TASK,
          workspaceKey: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
          runtimeVersion: "2.1.4",
          maxInputTokens: 24_000,
        },
        directory: WORKSPACE,
        destinationDatabase: join("/run/root", "state", "opencode.db"),
      },
    ]);
    // Settled later, once the session is bound inside the started runtime.
    expect(h.outcomes).toEqual([]);
    expect(lines(h)).toEqual([]);
  });

  it("derives the workspace key from the workspace id and root, so either one changing refuses", () => {
    const keyOf = (workspaceId: string, workspaceRoot: string): string => {
      const h = harness({ workspaceId });
      h.service.declare(RUN, RESUME);
      seedContinuation(h.context, { ...location(), workspaceRoot });
      return h.calls.checkouts[0]?.binding.workspaceKey ?? "";
    };

    const base = keyOf("workspace-1", WORKSPACE);

    expect(keyOf("workspace-1", WORKSPACE)).toBe(base);
    expect(keyOf("workspace-2", WORKSPACE)).not.toBe(base);
    expect(keyOf("workspace-1", "/another/root")).not.toBe(base);
  });

  it("seeds a fork from its source task's entry", () => {
    const h = harness();
    h.service.declare(RUN, {
      kind: "fork",
      sourceTaskId: "source-task",
      boundary: { kind: "end" },
    });

    const continuation = seedContinuation(h.context, location());

    expect(continuation).toMatchObject({ taskId: "source-task", sessionId: SESSION });
    expect(h.calls.checkouts[0]?.binding.taskId).toBe("source-task");
  });

  it.each([["retention switched off", { store: null }, "disabled"]] as const)(
    "falls back to a fresh session for %s",
    (_name, options, reason) => {
      const h = harness(options);
      h.service.declare(RUN, RESUME);

      expect(seedContinuation(h.context, location())).toBeUndefined();

      expect(h.outcomes).toEqual([{ kind: "fresh", reason }]);
      expect(lines(h)).toMatchObject([{ action: "resume", outcome: "fresh", reason }]);
    },
  );

  it.each([
    ["no-retained-state", "fresh"],
    ["expired", "refused"],
    ["workspace-changed", "refused"],
    ["version-changed", "refused"],
    ["window-shrunk", "refused"],
    ["integrity-failed", "refused"],
    ["grant-present", "refused"],
    ["credential-present", "refused"],
    ["pending-input", "refused"],
    ["schema-unknown", "refused"],
    ["session-mismatch", "refused"],
  ] as const)("falls back with %s and records it as %s", (reason, outcome) => {
    const h = harness({ results: { checkout: { ok: false, reason, removed: false } } });
    h.service.declare(RUN, RESUME);

    expect(seedContinuation(h.context, location())).toBeUndefined();

    expect(h.outcomes).toEqual([{ kind: "fresh", reason }]);
    expect(h.service.outcome(RUN)).toEqual({ kind: "fresh", reason });
    expect(lines(h)).toMatchObject([
      { action: "resume", outcome, reason, taskDigest: retainedSessionKey(TASK) },
    ]);
  });

  it("names a fork's source and boundary on its fallback and the new task by digest", () => {
    const h = harness({
      results: { checkout: { ok: false, reason: "version-changed", removed: true } },
    });
    h.service.declare(RUN, {
      kind: "fork",
      sourceTaskId: "source-task",
      boundary: { kind: "turn", ordinal: 1, userTurnCount: 3 },
    });

    seedContinuation(h.context, location());

    expect(lines(h)).toMatchObject([
      {
        action: "fork",
        outcome: "refused",
        reason: "version-changed",
        taskDigest: retainedSessionKey(TASK),
        sourceTaskDigest: retainedSessionKey("source-task"),
        boundary: "turn",
      },
    ]);
  });

  it("starts fresh and records a checkout that throws with its error frames", () => {
    const h = harness({ results: { checkout: new Error("EIO: /secret/path") } });
    h.service.declare(RUN, RESUME);

    expect(() => seedContinuation(h.context, location())).not.toThrow();

    expect(h.outcomes).toEqual([{ kind: "fresh", reason: "copy-failed" }]);
    const [line] = lines(h);
    expect(line).toMatchObject({ outcome: "failed", reason: "copy-failed", level: "warn" });
    expect(Array.isArray((line as { frames?: unknown }).frames)).toBe(true);
    expect(JSON.stringify(line)).not.toContain("/secret/path");
  });

  it("seeds the database a real store retained and refuses it for another workspace", () => {
    const root = tempRoot();
    const real = createRetainedSessionStore({ root: join(root, "retained") });
    const settled = join(root, "settled-run");
    mkdirSync(join(settled, "state"), { recursive: true });
    realisticDatabase(join(settled, "state", "opencode.db"));
    const retaining = harness({ store: real });
    retainSettledRun(
      retaining.context,
      { runId: RUN, runRoot: settled, workspaceRoot: WORKSPACE, sessionId: SESSION },
      "succeeded",
    );
    expect(lines(retaining)).toMatchObject([{ outcome: "retained", messageCount: 1 }]);

    const resuming = harness({ store: real });
    const resumed = join(root, "resumed-run");
    mkdirSync(join(resumed, "state"), { recursive: true });
    resuming.service.declare(RUN, RESUME);
    expect(seedContinuation(resuming.context, location(resumed))).toMatchObject({
      sessionId: SESSION,
      messageCount: 1,
    });
    expect(
      new DatabaseSync(join(resumed, "state", "opencode.db"), { readOnly: true })
        .prepare("SELECT COUNT(*) AS n FROM session_message")
        .get(),
    ).toEqual({ n: 1 });

    const elsewhere = harness({ store: real, workspaceId: "another-workspace" });
    elsewhere.service.declare(RUN, RESUME);
    const refusedRoot = join(root, "refused-run");
    mkdirSync(join(refusedRoot, "state"), { recursive: true });
    expect(seedContinuation(elsewhere.context, location(refusedRoot))).toBeUndefined();
    expect(elsewhere.outcomes).toEqual([{ kind: "fresh", reason: "workspace-changed" }]);
    expect(lines(elsewhere)).toMatchObject([{ outcome: "refused", reason: "workspace-changed" }]);
  });
});

it.each(["workspace-changed", "version-changed"] as const)(
  "a fork refused for %s leaves the source's valid native history resumable",
  (reason) => {
    const root = tempRoot();
    const store = createRetainedSessionStore({ root: join(root, "retained") });
    const sourceRoot = join(root, "source");
    mkdirSync(join(sourceRoot, "state"), { recursive: true });
    realisticDatabase(join(sourceRoot, "state", "opencode.db"));
    const source = harness({ store });
    retainSettledRun(
      source.context,
      {
        runId: RUN,
        runRoot: sourceRoot,
        workspaceRoot: WORKSPACE,
        sessionId: SESSION,
      },
      "succeeded",
    );
    const fork = harness({ store });
    const changedContext = {
      ...fork.context,
      ...(reason === "workspace-changed"
        ? { workspaceId: "another-workspace" }
        : { runtimeVersion: "2.0.10" }),
    };
    fork.service.declare(RUN, {
      kind: "fork",
      sourceTaskId: TASK,
      boundary: { kind: "end" },
    });
    const destination = join(root, "refused-fork");
    mkdirSync(join(destination, "state"), { recursive: true });
    expect(seedContinuation(changedContext, location(destination))).toBeUndefined();
    expect(fork.outcomes).toEqual([{ kind: "fresh", reason }]);
    const restored = join(root, "source-resumed");
    mkdirSync(join(restored, "state"), { recursive: true });
    const resume = harness({ store });
    resume.service.declare(RUN, { kind: "resume", taskId: TASK });
    expect(seedContinuation(resume.context, location(restored))?.sessionId).toBe(SESSION);
  },
);

/**
 * A database with the runtime's persistence contract (`opencodePersistenceContract.ts`), holding
 * the one session `SESSION` in `WORKSPACE`.
 */
function realisticDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    for (const [table, columns] of Object.entries(OPENCODE_PERSISTENCE_SCHEMAS["2.1.4"] ?? {})) {
      database.exec(`CREATE TABLE "${table}" (${columns.map((name) => `"${name}"`).join(", ")})`);
    }
    database
      .prepare("INSERT INTO session_v2 (id, directory, version) VALUES (?, ?, ?)")
      .run(SESSION, WORKSPACE, "2.1.4");
    database
      .prepare("INSERT INTO session_message (id, session_id, data) VALUES ('msg_1', ?, 'x')")
      .run(SESSION);
  } finally {
    database.close();
  }
}

type SessionRecord = Readonly<Record<string, unknown>>;

interface FakeClient {
  readonly client: ContinuationClient;
  readonly calls: string[];
}

function session(id: string, overrides: SessionRecord = {}): SessionRecord {
  return { id, location: { directory: WORKSPACE }, ...overrides };
}

function message(id: string, type: string, text?: string): SessionRecord {
  return { id, type, ...(text === undefined ? {} : { text }) };
}

function fakeClient(
  options: {
    sessions?: (calls: string[]) => readonly SessionRecord[];
    messages?: Readonly<Record<string, readonly SessionRecord[] | Error>>;
    fork?: (source: string, before: string | undefined) => unknown;
    removeFails?: boolean;
    switchFails?: boolean;
  } = {},
): FakeClient {
  const calls: string[] = [];
  const client: ContinuationClient = {
    sessions: () => {
      calls.push("sessions");
      return Promise.resolve(options.sessions?.(calls) ?? [session(SESSION)]);
    },
    messages: (sessionId) => {
      calls.push(`messages:${sessionId}`);
      const found = options.messages?.[sessionId] ?? [];
      return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
    },
    forkSession: (source, before) => {
      calls.push(`fork:${source}:${before ?? "end"}`);
      const result = options.fork?.(source, before) ?? {
        id: "ses_fork_1",
        directory: WORKSPACE,
        sourceSessionId: source,
        boundary:
          before === undefined
            ? { type: "through", messageId: "msg_last" }
            : { type: "before", messageId: before },
      };
      return Promise.resolve(result as Awaited<ReturnType<ContinuationClient["forkSession"]>>);
    },
    removeSession: (sessionId) => {
      calls.push(`remove:${sessionId}`);
      return options.removeFails === true ? Promise.reject(new Error("remove")) : Promise.resolve();
    },
    switchAgent: (sessionId, agent) => {
      calls.push(`agent:${sessionId}:${agent}`);
      return options.switchFails === true ? Promise.reject(new Error("agent")) : Promise.resolve();
    },
    createSession: () => Promise.reject(new Error("not used")),
  };
  return { client, calls };
}

function continuation(intent: RunContinuation["intent"]): RunContinuation {
  return {
    intent,
    taskId: TASK,
    sessionId: SESSION,
    databaseBytes: 1,
    messageCount: 1,
    ageMs: 0,
  };
}

describe("binding a run to the retained session it resumes", () => {
  it("resumes the one retained session in the run's workspace and reads what it already holds", async () => {
    const fake = fakeClient({
      messages: { [SESSION]: [message("msg_a", "user", "one"), message("msg_b", "assistant")] },
    });

    const bound = await bindContinuedSession(
      fake.client,
      continuation(RESUME),
      WORKSPACE,
      undefined,
    );

    expect(bound).toEqual({
      ok: true,
      sessionId: SESSION,
      baselineIds: new Set(["msg_a", "msg_b"]),
    });
    expect(fake.calls).toEqual(["sessions", `messages:${SESSION}`]);
  });

  it.each([
    ["two sessions", (): readonly SessionRecord[] => [session(SESSION), session("ses_other")]],
    ["no session", (): readonly SessionRecord[] => []],
    ["another session", (): readonly SessionRecord[] => [session("ses_other")]],
    [
      "another workspace directory",
      (): readonly SessionRecord[] => [session(SESSION, { location: { directory: "/else" } })],
    ],
    ["no location", (): readonly SessionRecord[] => [{ id: SESSION }]],
  ])("refuses %s as a session mismatch", async (_name, sessions) => {
    const fake = fakeClient({ sessions });

    const bound = await bindContinuedSession(
      fake.client,
      continuation(RESUME),
      WORKSPACE,
      undefined,
    );

    expect(bound).toMatchObject({ ok: false, reason: "session-mismatch" });
    expect(fake.calls).toEqual(["sessions"]);
  });

  it("refuses a history the client will not read", async () => {
    const fake = fakeClient({
      messages: { [SESSION]: new Error("opencode-v2-history-oversized") },
    });

    expect(
      await bindContinuedSession(fake.client, continuation(RESUME), WORKSPACE, undefined),
    ).toMatchObject({ ok: false, reason: "history-oversized" });
  });

  it("propagates a runtime that cannot be asked instead of calling it a mismatch", async () => {
    const fake = fakeClient({
      sessions: () => {
        throw new Error("socket hang up");
      },
    });

    await expect(
      bindContinuedSession(fake.client, continuation(RESUME), WORKSPACE, undefined),
    ).rejects.toThrow("socket hang up");
  });

  it("starts under the default agent: a session left under plan is switched back, one under build is not", async () => {
    const plan = fakeClient({ sessions: () => [session(SESSION, { agent: "plan" })] });
    const build = fakeClient({ sessions: () => [session(SESSION, { agent: "build" })] });
    const none = fakeClient();

    for (const fake of [plan, build, none]) {
      expect(
        await bindContinuedSession(fake.client, continuation(RESUME), WORKSPACE, undefined),
      ).toMatchObject({ ok: true });
    }

    expect(plan.calls).toContain(`agent:${SESSION}:build`);
    expect(build.calls.some((call) => call.startsWith("agent:"))).toBe(false);
    expect(none.calls.some((call) => call.startsWith("agent:"))).toBe(false);
  });

  it("refuses the run when the agent cannot be reset", async () => {
    const fake = fakeClient({
      sessions: () => [session(SESSION, { agent: "plan" })],
      switchFails: true,
    });

    expect(
      await bindContinuedSession(fake.client, continuation(RESUME), WORKSPACE, undefined),
    ).toMatchObject({ ok: false, reason: "agent-reset-failed" });
  });
});

describe("binding a run to a fork of the retained session", () => {
  const FORK = (boundary: ContinuityIntent & { kind: "fork" }): RunContinuation =>
    continuation(boundary);
  const END: ContinuityIntent & { kind: "fork" } = {
    kind: "fork",
    sourceTaskId: TASK,
    boundary: { kind: "end" },
  };

  function turns(): readonly SessionRecord[] {
    return [
      message("msg_h", "user", OPENCODE_RUNTIME_READINESS_PROMPT),
      message("msg_h_a", "assistant"),
      message("msg_1", "user", "first"),
      message("msg_1_a", "assistant"),
      message("msg_2", "user", "second"),
      message("msg_2_a", "assistant"),
      message("msg_3", "user", "third"),
    ];
  }

  it("forks through the end, removes the source and answers with the fork alone", async () => {
    let removed = false;
    const fake = fakeClient({
      sessions: (calls) => {
        removed = calls.includes(`remove:${SESSION}`);
        return removed ? [session("ses_fork_1")] : [session(SESSION)];
      },
      messages: { ses_fork_1: [message("msg_f1", "user"), message("msg_f2", "assistant")] },
    });

    const bound = await bindContinuedSession(fake.client, FORK(END), WORKSPACE, undefined);

    expect(bound).toEqual({
      ok: true,
      sessionId: "ses_fork_1",
      baselineIds: new Set(["msg_f1", "msg_f2"]),
    });
    expect(fake.calls).toEqual([
      "sessions",
      `fork:${SESSION}:end`,
      `remove:${SESSION}`,
      "sessions",
      "messages:ses_fork_1",
    ]);
  });

  it("forks just before the user turn the boundary names, the runtime's handshake not counting", async () => {
    const fake = fakeClient({
      sessions: (calls) =>
        calls.includes(`remove:${SESSION}`) ? [session("ses_fork_1")] : [session(SESSION)],
      messages: { [SESSION]: turns() },
    });

    const bound = await bindContinuedSession(
      fake.client,
      FORK({
        kind: "fork",
        sourceTaskId: TASK,
        boundary: { kind: "turn", ordinal: 1, userTurnCount: 3 },
      }),
      WORKSPACE,
      undefined,
    );

    expect(bound).toMatchObject({ ok: true, sessionId: "ses_fork_1" });
    expect(fake.calls).toContain(`fork:${SESSION}:msg_2`);
  });

  it.each([
    ["more user turns than the runtime has", { ordinal: 1, userTurnCount: 4 }],
    ["fewer user turns than the runtime has", { ordinal: 1, userTurnCount: 2 }],
    ["a turn past the last one", { ordinal: 3, userTurnCount: 3 }],
  ])("does not guess a boundary when Coding History holds %s", async (_name, boundary) => {
    const fake = fakeClient({ messages: { [SESSION]: turns() } });

    const bound = await bindContinuedSession(
      fake.client,
      FORK({ kind: "fork", sourceTaskId: TASK, boundary: { kind: "turn", ...boundary } }),
      WORKSPACE,
      undefined,
    );

    expect(bound).toMatchObject({ ok: false, reason: "fork-boundary-unresolved" });
    expect(fake.calls.some((call) => call.startsWith("fork:"))).toBe(false);
    expect(fake.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  it.each([
    ["a fork of another session", { sourceSessionId: "ses_other" }],
    ["a fork in another directory", { directory: "/else" }],
    ["a boundary of the wrong kind", { boundary: { type: "before", messageId: "msg_x" } }],
  ])("refuses %s and leaves the source in place", async (_name, receipt) => {
    const fake = fakeClient({
      fork: (source) => ({
        id: "ses_fork_1",
        directory: WORKSPACE,
        sourceSessionId: source,
        boundary: { type: "through", messageId: "msg_last" },
        ...receipt,
      }),
    });

    expect(await bindContinuedSession(fake.client, FORK(END), WORKSPACE, undefined)).toMatchObject({
      ok: false,
      reason: "fork-failed",
    });
    expect(fake.calls.some((call) => call.startsWith("remove:"))).toBe(false);
  });

  it("refuses a fork whose source cannot be removed, and one the runtime refuses to make", async () => {
    const removal = fakeClient({ removeFails: true });
    expect(
      await bindContinuedSession(removal.client, FORK(END), WORKSPACE, undefined),
    ).toMatchObject({
      ok: false,
      reason: "fork-failed",
    });

    const refused = fakeClient({
      fork: () => {
        throw new Error("opencode-v2-response-invalid");
      },
    });
    expect(
      await bindContinuedSession(refused.client, FORK(END), WORKSPACE, undefined),
    ).toMatchObject({
      ok: false,
      reason: "fork-failed",
    });
  });

  it("refuses a database that still holds more than the fork once the source is gone", async () => {
    const fake = fakeClient({ sessions: () => [session("ses_fork_1"), session("ses_extra")] });
    // The first read sees the source only; afterwards two sessions remain.
    let reads = 0;
    const sessions = fake.client.sessions.bind(fake.client);
    fake.client.sessions = (signal): ReturnType<ContinuationClient["sessions"]> => {
      reads += 1;
      return reads === 1 ? Promise.resolve([session(SESSION)]) : sessions(signal);
    };

    expect(await bindContinuedSession(fake.client, FORK(END), WORKSPACE, undefined)).toMatchObject({
      ok: false,
      reason: "session-mismatch",
    });
  });
});

describe("keeping the earlier runs' messages out of a continued session's history", () => {
  const messages = [{ id: "msg_a" }, { id: "msg_b" }, { id: "msg_c" }, { text: "no id" }];

  it("removes the baseline and keeps everything else in order", () => {
    expect(withoutBaseline(messages, new Set(["msg_a", "msg_b"]))).toEqual([
      { id: "msg_c" },
      { text: "no id" },
    ]);
  });

  it("returns the messages as they are without a baseline or with an empty one", () => {
    expect(withoutBaseline(messages, undefined)).toBe(messages);
    expect(withoutBaseline(messages, new Set())).toBe(messages);
  });
});

describe("retaining a settled run", () => {
  const run = {
    runId: RUN,
    runRoot: "/run/root",
    workspaceRoot: WORKSPACE,
    sessionId: SESSION as string | undefined,
  };

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "audits and retains a reaped run that ended %s, recording counts only",
    (status) => {
      const h = harness();

      retainSettledRun(h.context, run, status);

      expect(h.calls.retains).toEqual([
        {
          binding: {
            taskId: TASK,
            workspaceKey: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
            runtimeVersion: "2.1.4",
            maxInputTokens: 24_000,
          },
          sessionId: SESSION,
          directory: WORKSPACE,
          sourceDatabase: join("/run/root", "state", "opencode.db"),
        },
      ]);
      expect(h.calls.removed).toEqual([]);
      expect(lines(h)).toMatchObject([
        {
          action: "retain",
          outcome: "retained",
          taskDigest: retainedSessionKey(TASK),
          databaseBytes: 2048,
          messageCount: 9,
          entryCount: 2,
          prunedCount: 1,
        },
      ]);
    },
  );

  it.each([
    ["running", "not-succeeded"],
    ["awaiting-approval", "not-succeeded"],
    [undefined, "not-succeeded"],
  ] as const)(
    "removes the task's entry instead of retaining when the run ended %s, so it never lags behind",
    (status, reason) => {
      const h = harness();

      retainSettledRun(h.context, run, status);

      expect(h.calls.retains).toEqual([]);
      expect(h.calls.removed).toEqual([TASK]);
      expect(lines(h)).toMatchObject([{ action: "retain", outcome: "skipped", reason }]);
    },
  );

  it("skips a run without a session or a task", () => {
    const noSession = harness();
    retainSettledRun(noSession.context, { ...run, sessionId: undefined }, "succeeded");
    expect(lines(noSession)).toMatchObject([{ outcome: "skipped", reason: "no-session" }]);
    expect(noSession.calls.removed).toEqual([TASK]);

    const noTask = harness({ taskOfRun: () => undefined });
    retainSettledRun(noTask.context, run, "succeeded");
    expect(lines(noTask)).toMatchObject([{ outcome: "skipped", reason: "no-task" }]);
    expect(noTask.calls.removed).toEqual([]);
  });

  it("keeps nothing and removes nothing when retention is switched off", () => {
    const h = harness({ store: null });

    retainSettledRun(h.context, run, "succeeded");

    expect(lines(h)).toMatchObject([{ outcome: "skipped", reason: "disabled" }]);
    expect(h.calls.retains).toEqual([]);
    expect(h.calls.removed).toEqual([]);
  });

  it.each([
    ["grant-present", "refused"],
    ["pending-input", "refused"],
    ["database-oversized", "refused"],
  ] as const)(
    "records a store refusal of %s as %s and drops the stale entry",
    (reason, outcome) => {
      const h = harness({ results: { retain: { ok: false, reason } } });

      retainSettledRun(h.context, run, "succeeded");

      expect(lines(h)).toMatchObject([{ action: "retain", outcome, reason }]);
      expect(h.calls.removed).toEqual([TASK]);
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "refuses unsafe state after %s rather than retaining or reusing an older entry",
    (status) => {
      const h = harness({ results: { retain: { ok: false, reason: "grant-present" } } });
      retainSettledRun(h.context, run, status);
      expect(h.calls.retains).toHaveLength(1);
      expect(h.calls.removed).toEqual([TASK]);
      expect(lines(h)).toMatchObject([
        { action: "retain", outcome: "refused", reason: "grant-present" },
      ]);
    },
  );

  it("names the audit check behind a schema-unknown retain refusal (#3904)", () => {
    const h = harness({
      results: { retain: { ok: false, reason: "schema-unknown", check: "workspace-rows" } },
    });

    retainSettledRun(h.context, run, "succeeded");

    const [line] = lines(h);
    expect(line).toMatchObject({
      action: "retain",
      outcome: "refused",
      reason: "schema-unknown",
      auditCheck: "workspace-rows",
    });
  });

  it("records a store that throws as one failed line and never throws itself", () => {
    const h = harness({ results: { retain: new Error("EACCES: /secret/path") } });

    expect(() => {
      retainSettledRun(h.context, run, "succeeded");
    }).not.toThrow();

    const [line] = lines(h);
    expect(line).toMatchObject({ outcome: "failed", reason: "copy-failed" });
    expect(JSON.stringify(line)).not.toContain("/secret/path");
    // The previous entry no longer describes the task once a later run could not be retained.
    expect(h.calls.removed).toEqual([TASK]);
  });

  it("records a removal that throws as its own failed line and still records the outcome", () => {
    const h = harness({
      results: { retain: { ok: false, reason: "grant-present" }, remove: new Error("EPERM") },
    });

    expect(() => {
      retainSettledRun(h.context, run, "succeeded");
    }).not.toThrow();

    expect(lines(h)).toMatchObject([
      { action: "retain", outcome: "failed", reason: "copy-failed" },
      { action: "retain", outcome: "refused", reason: "grant-present" },
    ]);
  });

  it("removes the entry of a skipped run without throwing when the removal fails", () => {
    const h = harness({ results: { remove: new Error("EPERM") } });

    expect(() => {
      retainSettledRun(h.context, run, undefined);
    }).not.toThrow();

    expect(lines(h)).toMatchObject([
      { outcome: "failed", reason: "copy-failed" },
      { outcome: "skipped", reason: "not-succeeded" },
    ]);
  });

  it("never writes the workspace path or the task id into the line", () => {
    const h = harness();

    retainSettledRun(h.context, run, "succeeded");

    expect(JSON.stringify(lines(h))).not.toContain(WORKSPACE);
    expect(JSON.stringify(lines(h))).not.toContain(TASK);
  });
});
