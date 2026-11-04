import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  plantDirectoryRedirect,
  plantSymlinkOrSkip,
  WINDOWS_HOST,
} from "../../../../tests/support/symlink-fixture.js";
import {
  beginOpenCodeTurnImages,
  createOpenCodeRevertRunPort,
  newestTurnBoundary,
  noteOpenCodeEditTargets,
  openCodeNativeCallKey,
  openCodeRevertBlocksTurn,
  recordOpenCodeEditSettled,
  recordOpenCodeTurnImage,
  recordRevertTurnBlocked,
  type OpenCodeRevertRun,
} from "./opencodeRevert.js";
import type { OpenCodeV2FileDiff } from "./opencodeV2HttpClient.js";

const RUN_ID = "run-340282366920938463463374607431768211455";
const SESSION_ID = "ses_revert_unit";
const CORRELATION_ID = "corr-revert-unit-0001";
const SECRET = "the-model-wrote-this-secret";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-revert-unit-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function diff(file: string, additions = 2, deletions = 1): OpenCodeV2FileDiff {
  return { file, status: "modified", additions, deletions };
}

const TURN: readonly Readonly<Record<string, unknown>>[] = [
  { id: "msg_old_user", type: "user" },
  { id: "msg_old_reply", type: "assistant" },
  { id: "msg_old_idle", type: "idle" },
  { id: "msg_turn_user", type: "user" },
  { id: "msg_turn_reply", type: "assistant" },
  { id: "msg_turn_idle", type: "idle" },
];

interface Subject {
  readonly run: OpenCodeRevertRun;
  readonly client: {
    readonly [Name in keyof OpenCodeRevertRun["client"]]: ReturnType<typeof vi.fn>;
  };
  readonly abortTask: ReturnType<typeof vi.fn<(runId: string) => Promise<boolean>>>;
  readonly port: ReturnType<typeof createOpenCodeRevertRunPort>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly order: string[];
  /** Resolves once the image the settled turn left behind is recorded. */
  readonly settled: Promise<unknown>;
}

function subject(
  input: {
    readonly root?: string;
    readonly files?: readonly OpenCodeV2FileDiff[];
    readonly staged?: readonly OpenCodeV2FileDiff[];
    readonly messages?: readonly Readonly<Record<string, unknown>>[];
    readonly busy?: boolean;
    readonly abort?: boolean;
    readonly available?: boolean;
    readonly stage?: () => Promise<never>;
    readonly clear?: () => Promise<never>;
    readonly commit?: () => Promise<never>;
    readonly diffFails?: boolean;
    /** `false`: the turn's settlement recorded no image of its files. */
    readonly image?: boolean;
    /** The run is torn down (server stop) while the runtime is still answering the diff. */
    readonly disposedDuringDiff?: boolean;
    /**
     * A stop interrupts the session while the runtime answers the diff: `begun` leaves the
     * interrupt running, `settled` has it finished before the read fails (`abortTask`).
     */
    readonly interruptedDuringDiff?: "begun" | "settled";
  } = {},
): Subject {
  const order: string[] = [];
  let available = input.available !== false;
  const files = input.files ?? [diff("a.txt")];
  const client = {
    active: vi.fn(() => {
      order.push("active");
      return Promise.resolve(input.busy === true ? { [SESSION_ID]: { type: "running" } } : {});
    }),
    messages: vi.fn(() => Promise.resolve(input.messages ?? TURN)),
    sessionDiff: vi.fn(() => {
      order.push("diff");
      if (input.disposedDuringDiff === true) {
        available = false;
        return Promise.reject(new Error(`runtime gone ${SECRET}`));
      }
      if (input.interruptedDuringDiff !== undefined) {
        run.interruptSeq =
          (run.interruptSeq ?? 0) + (input.interruptedDuringDiff === "begun" ? 1 : 2);
        return Promise.reject(new Error(`session interrupted ${SECRET}`));
      }
      return input.diffFails === true
        ? Promise.reject(new Error(`diff failed ${SECRET}`))
        : Promise.resolve(files);
    }),
    stageRevert: vi.fn((_session: string, messageId: string) => {
      order.push("stage");
      if (input.stage !== undefined) return input.stage();
      return Promise.resolve({ messageId, files: input.staged ?? files });
    }),
    clearRevert: vi.fn(() => {
      order.push("clear");
      return input.clear === undefined ? Promise.resolve() : input.clear();
    }),
    commitRevert: vi.fn(() => {
      order.push("commit");
      return input.commit === undefined ? Promise.resolve() : input.commit();
    }),
  };
  const run: OpenCodeRevertRun = {
    runId: RUN_ID,
    workspaceRoot: input.root ?? workspace({ "a.txt": "turn result\n" }),
    sessionId: SESSION_ID,
    client,
  };
  const abortTask = vi.fn((_runId: string) => {
    order.push("abort");
    return Promise.resolve(input.abort ?? true);
  });
  const log = createBufferedServerLogSink();
  const port = createOpenCodeRevertRunPort({
    readyRun: (runId) => (runId === RUN_ID && available ? run : undefined),
    abortTask,
    activityLog: log,
  });
  // The turn settled before the test begins: the composition records its image at that moment.
  if (
    input.image !== false &&
    input.diffFails !== true &&
    input.disposedDuringDiff !== true &&
    input.interruptedDuringDiff === undefined
  )
    recordOpenCodeTurnImage(run, log);
  client.sessionDiff.mockClear();
  order.length = 0;
  return { run, client, abortTask, port, log, order, settled: Promise.resolve(run.turnImage) };
}

/** One of the turn's own native edits wrote `files` and settled, as the composition reports it. */
async function agentWrote(
  run: OpenCodeRevertRun,
  files: readonly string[],
  call = "call_edit",
): Promise<void> {
  const key = openCodeNativeCallKey("msg_turn_reply", call);
  noteOpenCodeEditTargets(run, key, files);
  recordOpenCodeEditSettled(run, key, undefined);
  await run.agentImages?.work;
}

describe("newestTurnBoundary", () => {
  it("names the first user message of the newest turn", () => {
    expect(newestTurnBoundary(TURN)).toBe("msg_turn_user");
  });

  it("skips the markers that end the newest turn, a restore appends one more", () => {
    expect(newestTurnBoundary([...TURN, { id: "msg_extra_idle", type: "idle" }])).toBe(
      "msg_turn_user",
    );
  });

  it("names the turn still in flight, which has no idle marker yet", () => {
    expect(newestTurnBoundary([...TURN, { id: "msg_busy_user", type: "user" }])).toBe(
      "msg_busy_user",
    );
  });

  it("takes the earliest user message of a turn a later prompt was steered into", () => {
    const steered = [
      { id: "msg_old_idle", type: "idle" },
      { id: "msg_first", type: "user" },
      { id: "msg_reply", type: "assistant" },
      { id: "msg_steer", type: "user" },
      { id: "msg_reply_two", type: "assistant" },
      { id: "msg_idle", type: "idle" },
    ];
    expect(newestTurnBoundary(steered)).toBe("msg_first");
  });

  it("does not cross into the previous turn through an agent switch recorded between them", () => {
    const switched = [
      { id: "msg_old_user", type: "user" },
      { id: "msg_old_idle", type: "idle" },
      { id: "msg_switch", type: "agent-switched" },
      { id: "msg_user", type: "user" },
      { id: "msg_idle", type: "idle" },
    ];
    expect(newestTurnBoundary(switched)).toBe("msg_user");
  });

  // r4368344091: Keiko's automatic verification continuation is a turn of its own in the runtime,
  // but it continues the human's request, so the undo boundary reaches back to that request.
  const CONTINUED = [
    ...TURN,
    {
      id: "msg_continue",
      type: "user",
      metadata: { keikoTurnOriginV1: "verification-continuation" },
    },
    { id: "msg_continue_reply", type: "assistant" },
    { id: "msg_continue_idle", type: "idle" },
  ];

  it("reaches back across Keiko's verification continuations to the human's request", () => {
    expect(newestTurnBoundary(CONTINUED)).toBe("msg_turn_user");
    const twice = [
      ...CONTINUED,
      {
        id: "msg_again",
        type: "user",
        metadata: { keikoTurnOriginV1: "verification-continuation" },
      },
      { id: "msg_again_idle", type: "idle" },
    ];
    expect(newestTurnBoundary(twice)).toBe("msg_turn_user");
  });

  it("stops at the human's newest request and treats any other metadata as human", () => {
    expect(
      newestTurnBoundary([
        ...CONTINUED,
        { id: "msg_human", type: "user", metadata: { keikoTurnOriginV1: "other" } },
        { id: "msg_human_idle", type: "idle" },
      ]),
    ).toBe("msg_human");
  });

  it.each([
    ["no messages", []],
    ["only idle markers", [{ id: "msg_idle", type: "idle" }]],
    ["no user message in the newest turn", [{ id: "msg_reply", type: "assistant" }]],
    ["a user message without a string id", [{ id: 7, type: "user" }]],
  ])("finds no boundary for %s", (_name, messages) => {
    expect(newestTurnBoundary(messages)).toBeUndefined();
  });
});

describe("undo of the newest turn", () => {
  it("stages the revert at the turn's first user message and counts what it restored", async () => {
    const { port, run, client, abortTask, log } = subject({
      staged: [diff("a.txt", 3, 1), diff("b.txt", 0, 4)],
      root: workspace({ "a.txt": "x", "b.txt": "y" }),
    });

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toEqual({
      ok: true,
      fileCount: 2,
      additions: 3,
      deletions: 5,
    });

    expect(client.stageRevert).toHaveBeenCalledExactlyOnceWith(SESSION_ID, "msg_turn_user");
    expect(abortTask).not.toHaveBeenCalled();
    expect(run.revert).toMatchObject({ fileCount: 2, files: ["a.txt", "b.txt"] });
    expect(log.events).toMatchObject([
      {
        level: "info",
        op: "coding-runtime.revert.applied",
        correlationId: CORRELATION_ID,
        extra: {
          runId: RUN_ID,
          action: "undo",
          fileCount: 2,
          additions: 3,
          deletions: 5,
          interrupted: false,
        },
      },
    ]);
  });

  it("stops the turn in flight before it stages, never the other way round", async () => {
    const { port, order, log, run } = subject({ busy: true });
    await agentWrote(run, ["a.txt"]);

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });

    expect(order.indexOf("abort")).toBeGreaterThan(-1);
    expect(order.indexOf("abort")).toBeLessThan(order.indexOf("stage"));
    expect(log.events).toMatchObject([
      { op: "coding-runtime.revert.applied", extra: { interrupted: true } },
    ]);
  });

  it("refuses without staging when the turn in flight cannot be stopped", async () => {
    const { port, client, run, log } = subject({ busy: true, abort: false });
    await agentWrote(run, ["a.txt"]);

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "interrupt-failed",
    });

    expect(client.stageRevert).not.toHaveBeenCalled();
    expect(run.revert).toBeUndefined();
    expect(log.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.revert.refused",
        errorKind: "conflict",
        extra: { operation: "undo", reason: "interrupt-failed" },
      },
    ]);
  });

  it("refuses a turn that changed nothing before it interrupts anything", async () => {
    const { port, client, abortTask } = subject({ busy: true, files: [] });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "nothing-to-undo",
    });

    expect(abortTask).not.toHaveBeenCalled();
    expect(client.stageRevert).not.toHaveBeenCalled();
  });

  it("refuses a session that names no turn boundary before it interrupts anything", async () => {
    const { port, abortTask, client } = subject({
      busy: true,
      messages: [{ id: "msg_reply", type: "assistant" }],
    });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "turn-boundary-missing",
    });

    expect(abortTask).not.toHaveBeenCalled();
    expect(client.stageRevert).not.toHaveBeenCalled();
  });

  it("refuses to undo a settled turn whose file a human changed after it", async () => {
    const root = workspace({ "a.txt": "as the turn left it\n" });
    const { port, client, run, settled, log } = subject({ root });
    await settled;
    writeFileSync(join(root, "a.txt"), "a human edited this after the turn\n");

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "workspace-changed",
    });

    expect(client.stageRevert).not.toHaveBeenCalled();
    expect(run.revert).toBeUndefined();
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.revert.refused",
        extra: { operation: "undo", reason: "workspace-changed" },
      },
    ]);
  });

  it("refuses to undo a settled turn when nothing recorded the files it left", async () => {
    const { port, client } = subject({ image: false });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "workspace-changed",
    });
    expect(client.stageRevert).not.toHaveBeenCalled();
  });

  it("undoes a turn in flight whose changed files its own native edits wrote", async () => {
    const { port, client, run } = subject({ busy: true, image: false });
    await agentWrote(run, ["a.txt"]);

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
    expect(client.stageRevert).toHaveBeenCalledOnce();
  });

  it("refuses, without stopping it, a turn in flight whose changed file none of its edits wrote", async () => {
    const { port, client, abortTask } = subject({ busy: true, image: false });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "workspace-changed",
    });
    expect(abortTask).not.toHaveBeenCalled();
    expect(client.stageRevert).not.toHaveBeenCalled();
  });

  it("never overwrites a human edit made while the turn waits for its next model reply", async () => {
    const root = workspace({ "a.txt": "the native edit\n" });
    const { port, client, abortTask, run } = subject({ root, busy: true, image: false });
    await agentWrote(run, ["a.txt"]);
    writeFileSync(join(root, "a.txt"), "a human edit while the turn runs\n");

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "workspace-changed",
    });
    expect(abortTask).not.toHaveBeenCalled();
    expect(client.stageRevert).not.toHaveBeenCalled();
  });

  it("proves the files again once the turn stopped: an edit during the interrupt is kept", async () => {
    const root = workspace({ "a.txt": "the native edit\n" });
    const { port, client, abortTask, run } = subject({ root, busy: true, image: false });
    await agentWrote(run, ["a.txt"]);
    abortTask.mockImplementation(() => {
      writeFileSync(join(root, "a.txt"), "a human edit during the interrupt\n");
      return Promise.resolve(true);
    });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "workspace-changed",
    });
    expect(abortTask).toHaveBeenCalledOnce();
    expect(client.stageRevert).not.toHaveBeenCalled();
  });

  it("proves a native edit by its own image even after the turn settled over a later human edit", async () => {
    const root = workspace({ "a.txt": "the native edit\n" });
    const { port, client, run } = subject({ root, image: false });
    await agentWrote(run, ["a.txt"]);
    writeFileSync(join(root, "a.txt"), "a human edit before the turn settled\n");
    recordOpenCodeTurnImage(run, undefined);
    await run.turnImage;

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({
      reason: "workspace-changed",
    });
    expect(client.stageRevert).not.toHaveBeenCalled();
  });

  it("forgets the last turn's images when a new turn starts", async () => {
    const { port, run } = subject();
    await agentWrote(run, ["a.txt"]);
    beginOpenCodeTurnImages(run);

    expect(run.turnImage).toBeUndefined();
    expect(run.agentImages?.files.size).toBe(0);
    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({
      reason: "workspace-changed",
    });
  });

  it("refuses an edit whose image could not be taken, and says why on the log", async () => {
    const root = workspace({ "a.txt": "x\n" });
    const { port, run, log } = subject({ root, busy: true, image: false });
    const key = openCodeNativeCallKey("msg_turn_reply", "call_edit");
    noteOpenCodeEditTargets(run, key, ["a.txt"]);
    // A file as the workspace root makes the probe fail with ENOTDIR on POSIX. Windows reports a
    // path through a file as ENOENT, i.e. "absent", so there a NUL byte makes the probe throw.
    const broken = { ...run, workspaceRoot: WINDOWS_HOST ? `${root}\0` : join(root, "a.txt") };
    recordOpenCodeEditSettled(broken, key, log);
    await run.agentImages?.work;

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({
      reason: "workspace-changed",
    });
    expect(log.events.some((event) => event.extra?.reason === "revert-failed")).toBe(true);
  });

  it("undoes, restores and undoes again while the files stay as the turn left them", async () => {
    const { port, client } = subject();

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({ ok: true });
    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
    expect(client.stageRevert).toHaveBeenCalledTimes(2);
    expect(client.clearRevert).toHaveBeenCalledOnce();
  });

  it("refuses a second undo while one is staged and does not touch the runtime", async () => {
    const { port, client } = subject();
    await port.revertTurn(RUN_ID, "undo");
    client.sessionDiff.mockClear();

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "already-staged",
    });

    expect(client.sessionDiff).not.toHaveBeenCalled();
    expect(client.stageRevert).toHaveBeenCalledOnce();
  });

  it("refuses a run that is not ready", async () => {
    const { port, log } = subject({ available: false });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "run-unavailable",
    });
    expect(log.events).toMatchObject([
      { errorKind: "unavailable", extra: { reason: "run-unavailable" } },
    ]);
  });

  it("answers a failing runtime with a refusal that carries frames, never the error text", async () => {
    const { port, run, log } = subject({
      stage: () => Promise.reject(new Error(`stage failed ${SECRET}`)),
    });

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    expect(run.revert).toBeUndefined();
    expect(log.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.revert.refused",
        correlationId: CORRELATION_ID,
        extra: { runId: RUN_ID, operation: "undo", reason: "revert-failed" },
      },
    ]);
    expect(Array.isArray(log.events[0]?.extra?.frames)).toBe(true);
    expect(Array.isArray(log.events[0]?.extra?.causeChain)).toBe(true);
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });

  it("falls back to the run id as the correlation key when the request carries none", async () => {
    const { port, log } = subject();

    await port.revertTurn(RUN_ID, "undo");

    expect(log.events).toMatchObject([{ correlationId: RUN_ID }]);
  });
});

describe("restore of an undo", () => {
  it("clears the staged revert and reports what it brought back", async () => {
    const { port, run, client, log } = subject({ staged: [diff("a.txt", 4, 2)] });
    await port.revertTurn(RUN_ID, "undo");
    log.events.length = 0;

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: true,
      fileCount: 1,
      additions: 4,
      deletions: 2,
    });

    expect(client.clearRevert).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(run.revert).toBeUndefined();
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.revert.applied",
        extra: { action: "restore", fileCount: 1, additions: 4, deletions: 2, interrupted: false },
      },
    ]);
  });

  it("refuses when no undo is staged", async () => {
    const { port, client, log } = subject();

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "nothing-staged",
    });
    expect(client.clearRevert).not.toHaveBeenCalled();
    expect(log.events).toMatchObject([
      { extra: { operation: "restore", reason: "nothing-staged" } },
    ]);
  });

  it("refuses to write the turn's files over a file a human changed after the undo", async () => {
    const root = workspace({ "a.txt": "as the undo left it\n" });
    const { port, run, client, log } = subject({ root });
    await port.revertTurn(RUN_ID, "undo");
    writeFileSync(join(root, "a.txt"), "a human edited this after the undo\n");
    log.events.length = 0;

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "workspace-changed",
    });

    expect(client.clearRevert).not.toHaveBeenCalled();
    expect(run.revert).toBeDefined();
    expect(log.events).toMatchObject([
      { extra: { operation: "restore", reason: "workspace-changed" } },
    ]);
  });

  it("notices a same-size edit that puts the old modification time back", async () => {
    const root = workspace({ "a.txt": "same size\n" });
    const target = join(root, "a.txt");
    // Whole seconds, so the timestamp put back is exactly the one the undo saw, to the nanosecond.
    utimesSync(target, 1_700_000_000, 1_700_000_000);
    const { port, client } = subject({ root });
    await port.revertTurn(RUN_ID, "undo");
    const before = statSync(target, { bigint: true });
    writeFileSync(target, "diff size\n");
    utimesSync(target, 1_700_000_000, 1_700_000_000);
    const after = statSync(target, { bigint: true });
    expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
      reason: "workspace-changed",
    });
    expect(client.clearRevert).not.toHaveBeenCalled();
  });

  it("never proves a file a link replaced, even one pointing at identical bytes", async (context) => {
    const root = workspace({
      "a.txt": "as the undo left it\n",
      "copy.txt": "as the undo left it\n",
    });
    const { port, client } = subject({ root });
    await port.revertTurn(RUN_ID, "undo");
    rmSync(join(root, "a.txt"));
    plantSymlinkOrSkip(context, join(root, "copy.txt"), join(root, "a.txt"));

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
      reason: "workspace-changed",
    });
    expect(client.clearRevert).not.toHaveBeenCalled();
  });

  // The directory form: a junction on Windows (no privilege), a directory symlink elsewhere.
  it("never proves a file a directory redirection replaced", async () => {
    const root = workspace({ "a.txt": "as the undo left it\n", "elsewhere/b.txt": "b\n" });
    const { port, client } = subject({ root });
    await port.revertTurn(RUN_ID, "undo");
    rmSync(join(root, "a.txt"));
    plantDirectoryRedirect(join(root, "elsewhere"), join(root, "a.txt"));

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
      reason: "workspace-changed",
    });
    expect(client.clearRevert).not.toHaveBeenCalled();
  });

  it("notices a file the undo removed coming back, and one it restored going missing", async () => {
    const root = workspace({ "kept.txt": "kept\n" });
    const { port } = subject({
      root,
      staged: [diff("kept.txt"), { file: "gone.txt", status: "added", additions: 1, deletions: 0 }],
    });
    await port.revertTurn(RUN_ID, "undo");
    writeFileSync(join(root, "gone.txt"), "a human recreated it\n");

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
      reason: "workspace-changed",
    });

    rmSync(join(root, "gone.txt"));
    rmSync(join(root, "kept.txt"));
    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
      reason: "workspace-changed",
    });
  });

  it("restores when a file the undo removed is still absent", async () => {
    const root = workspace();
    const { port, client } = subject({
      root,
      staged: [{ file: "gone.txt", status: "added", additions: 1, deletions: 0 }],
    });
    await port.revertTurn(RUN_ID, "undo");

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({ ok: true });
    expect(client.clearRevert).toHaveBeenCalledOnce();
  });

  it.each(["../outside.txt", "/etc/passwd", "a\\b", ""])(
    "never proves a path outside the portable workspace grammar (%j)",
    async (file) => {
      const { port, client } = subject({ staged: [{ ...diff("a.txt"), file }] });
      await port.revertTurn(RUN_ID, "undo");

      await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
        reason: "workspace-changed",
      });
      expect(client.clearRevert).not.toHaveBeenCalled();
    },
  );

  it("keeps the undo staged when the runtime fails to clear it", async () => {
    const { port, run, log } = subject({
      clear: () => Promise.reject(new Error(`clear failed ${SECRET}`)),
    });
    await port.revertTurn(RUN_ID, "undo");
    log.events.length = 0;

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    expect(run.revert).toBeDefined();
    expect(log.events).toMatchObject([
      { op: "coding-runtime.revert.refused", extra: { operation: "restore" } },
    ]);
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });
});

describe("revert state", () => {
  it("counts the newest turn's files while nothing is staged", async () => {
    const { port } = subject({ files: [diff("a.txt", 5, 0), diff("b.txt", 1, 1)] });

    await expect(port.revertState(RUN_ID)).resolves.toEqual({
      staged: false,
      fileCount: 2,
      additions: 6,
      deletions: 1,
    });
  });

  it("counts from the human's request on, across Keiko's verification continuation", async () => {
    const { port, client } = subject({
      messages: [
        ...TURN,
        {
          id: "msg_continue",
          type: "user",
          metadata: { keikoTurnOriginV1: "verification-continuation" },
        },
        { id: "msg_continue_idle", type: "idle" },
      ],
    });

    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ staged: false, fileCount: 1 });
    expect(client.sessionDiff).toHaveBeenCalledWith(SESSION_ID, undefined, "msg_turn_user");
  });

  it("stages the undo at the human's request across Keiko's continuation", async () => {
    const { port, run, client } = subject({
      messages: [
        ...TURN,
        {
          id: "msg_continue",
          type: "user",
          metadata: { keikoTurnOriginV1: "verification-continuation" },
        },
        { id: "msg_continue_idle", type: "idle" },
      ],
    });
    await agentWrote(run, ["a.txt"]);

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
    expect(client.stageRevert).toHaveBeenCalledWith(SESSION_ID, "msg_turn_user");
    expect(client.sessionDiff).toHaveBeenCalledWith(SESSION_ID, undefined, "msg_turn_user");
  });

  it("reports the staged counts without asking the runtime again", async () => {
    const { port, client } = subject({ staged: [diff("a.txt", 4, 2)] });
    await port.revertTurn(RUN_ID, "undo");
    client.sessionDiff.mockClear();

    await expect(port.revertState(RUN_ID)).resolves.toEqual({
      staged: true,
      fileCount: 1,
      additions: 4,
      deletions: 2,
    });
    expect(client.sessionDiff).not.toHaveBeenCalled();
  });

  it("is absent for a run that is not ready", async () => {
    await expect(subject({ available: false }).port.revertState(RUN_ID)).resolves.toBeUndefined();
  });

  it("is absent, and says why on the log, when the runtime cannot report the diff", async () => {
    const { port, log } = subject({ diffFails: true });

    await expect(port.revertState(RUN_ID)).resolves.toBeUndefined();

    expect(log.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.revert.refused",
        extra: { runId: RUN_ID, operation: "state", reason: "revert-failed" },
      },
    ]);
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });

  it("is absent without a revert-failed warning when the run is torn down during the read (#4119)", async () => {
    const { port, log, client } = subject({ disposedDuringDiff: true });

    await expect(port.revertState(RUN_ID)).resolves.toBeUndefined();

    expect(client.sessionDiff).toHaveBeenCalledTimes(1);
    expect(log.events).toEqual([]);
  });

  it.each(["begun", "settled"] as const)(
    "is absent without a revert-failed warning when a stop interrupts the session during the read (%s, #3907)",
    async (interruptedDuringDiff) => {
      const { port, log, client } = subject({ interruptedDuringDiff });

      await expect(port.revertState(RUN_ID)).resolves.toBeUndefined();

      expect(client.sessionDiff).toHaveBeenCalledTimes(1);
      expect(log.events).toEqual([]);
    },
  );

  it("still warns when a read fails on a run that was interrupted before the read began", async () => {
    const { port, log, run } = subject({ diffFails: true });
    run.interruptSeq = 2;

    await expect(port.revertState(RUN_ID)).resolves.toBeUndefined();

    expect(log.events).toMatchObject([
      { level: "warn", op: "coding-runtime.revert.refused", extra: { operation: "state" } },
    ]);
  });

  it("records no turn image, and says why on the log, when the runtime cannot report the diff", async () => {
    const { run, log } = subject({ diffFails: true });

    recordOpenCodeTurnImage(run, log);

    await expect(run.turnImage).resolves.toBeUndefined();
    expect(log.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.revert.refused",
        extra: { runId: RUN_ID, operation: "state", reason: "revert-failed" },
      },
    ]);
    expect(Array.isArray(log.events[0]?.extra?.frames)).toBe(true);
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });
});

describe("the staged-undo turn guard", () => {
  it("blocks a new turn exactly while an undo is staged", async () => {
    const { port, run } = subject();
    expect(openCodeRevertBlocksTurn(run)).toBe(false);
    await port.revertTurn(RUN_ID, "undo");
    expect(openCodeRevertBlocksTurn(run)).toBe(true);
    await port.revertTurn(RUN_ID, "restore");
    expect(openCodeRevertBlocksTurn(run)).toBe(false);
  });

  it("records the refused submission under the run id", () => {
    const log = createBufferedServerLogSink();

    recordRevertTurnBlocked(log, RUN_ID);

    expect(log.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.revert.refused",
        correlationId: RUN_ID,
        extra: { runId: RUN_ID, operation: "submit", reason: "turn-blocked" },
      },
    ]);
  });
});

// The registered proofs run the persisted line through the real formatter, which needs the op in the
// generated registry: they go green once `npm run generate:op-catalog` has been run for these ops.
// #3904 AC3: the post-completion undo window commits an undo the human left staged when it closes.
describe("commit of a staged undo when the undo window closes", () => {
  it("commits the staged undo, forgets it and records what it made final", async () => {
    const { run, port, client, log } = subject();
    await port.revertTurn(RUN_ID, "undo");
    log.events.length = 0;

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("committed");

    expect(client.commitRevert).toHaveBeenCalledWith(SESSION_ID);
    expect(run.revert).toBeUndefined();
    expect(log.events).toMatchObject([
      { op: "coding-runtime.revert.applied", extra: { action: "commit", fileCount: 1 } },
    ]);
  });

  it("answers none without asking the runtime when nothing is staged", async () => {
    const { port, client } = subject();

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("none");
    expect(client.commitRevert).not.toHaveBeenCalled();
  });

  it("answers none for a run that is not ready", async () => {
    const { port, client } = subject({ available: false });

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("none");
    expect(client.commitRevert).not.toHaveBeenCalled();
  });

  it("keeps the undo staged and says why on the log when the runtime fails to commit it", async () => {
    const { run, port, log } = subject({
      commit: () => Promise.reject(new Error(`commit failed ${SECRET}`)),
    });
    await port.revertTurn(RUN_ID, "undo");
    log.events.length = 0;

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("failed");

    expect(run.revert).toBeDefined();
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.revert.refused",
        extra: { operation: "commit", reason: "revert-failed" },
      },
    ]);
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });
});

describe("registered Activity Log proofs", () => {
  it("proves coding-runtime.revert.applied", async () => {
    const { port, log } = subject();
    await port.revertTurn(RUN_ID, "undo", CORRELATION_ID);
    const [line] = log.events;
    if (line === undefined) throw new Error("expected revert.applied line");

    expect(
      expectActivityLogProof(
        "coding-runtime.revert.applied.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({ runId: RUN_ID, action: "undo", fileCount: 1, interrupted: false });
  });

  it("proves coding-runtime.revert.refused", async () => {
    const { port, log } = subject({
      stage: () => Promise.reject(new Error("stage failed")),
    });
    await port.revertTurn(RUN_ID, "undo", CORRELATION_ID);
    const [line] = log.events;
    if (line === undefined) throw new Error("expected revert.refused line");

    expect(
      expectActivityLogProof(
        "coding-runtime.revert.refused.emitted-line",
        formatActivityLogProofLine(line),
      ),
    ).toMatchObject({ runId: RUN_ID, operation: "undo", reason: "revert-failed" });
  });
});
