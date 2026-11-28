import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runHumanWorkspaceWrite } from "./nativeWriteGate.js";

// What happens right after Restore changes reapplied the index, before the files are written: a
// person's edit lands in the window the index transaction opened.
const afterReapply = vi.hoisted(() => ({
  run: undefined as (() => void) | undefined,
  /** The calls (1-based, counted from the reset) that throw instead of answering. */
  throwOnCalls: [] as number[],
  calls: 0,
}));
vi.mock("./opencodeTurnIndex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opencodeTurnIndex.js")>();
  return {
    ...actual,
    reapplyTurnIndexMoves: async (
      ...args: Parameters<typeof actual.reapplyTurnIndexMoves>
    ): ReturnType<typeof actual.reapplyTurnIndexMoves> => {
      afterReapply.calls += 1;
      if (afterReapply.throwOnCalls.includes(afterReapply.calls))
        throw new Error("index transaction failed");
      const result = await actual.reapplyTurnIndexMoves(...args);
      afterReapply.run?.();
      return result;
    },
  };
});

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
  settleUncertainRevertOnTurn,
  recordOpenCodeEditSettled,
  recordOpenCodeTurnImage,
  recordRevertTurnBlocked,
  type OpenCodeRevertRun,
} from "./opencodeRevert.js";
import {
  AT_HEAD,
  noteGovernedIndexTransitions,
  resetGovernedIndexPaths,
} from "./governedIndexPaths.js";
import { captureTurnIndex } from "./opencodeTurnIndex.js";
import {
  awaitTurnIndexStart,
  beginTurnIndex,
  reopenTurnIndex,
  type IndexRead,
} from "./opencodeTurnIndex.js";
import { OpenCodeV2HttpStatusError, type OpenCodeV2FileDiff } from "./opencodeV2HttpClient.js";

/** A request the runtime refused with a client error: proven not applied, so a plain failure. */
class RefusedRequest extends OpenCodeV2HttpStatusError {
  constructor(note: string) {
    super(409);
    this.message = note;
  }
}

const RUN_ID = "run-340282366920938463463374607431768211455";
const SESSION_ID = "ses_revert_unit";
const CORRELATION_ID = "corr-revert-unit-0001";
const SECRET = "the-model-wrote-this-secret";

const roots: string[] = [];

afterEach(() => {
  afterReapply.run = undefined;
  afterReapply.throwOnCalls = [];
  afterReapply.calls = 0;
  resetGovernedIndexPaths(RUN_ID);
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

  // #4491: Keiko's delivery continuation continues the human's request the same way.
  it("reaches back across Keiko's delivery continuation to the human's request", () => {
    expect(
      newestTurnBoundary([
        ...TURN,
        {
          id: "msg_delivery",
          type: "user",
          metadata: { keikoTurnOriginV1: "delivery-continuation" },
        },
        { id: "msg_delivery_idle", type: "idle" },
      ]),
    ).toBe("msg_turn_user");
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

  // #4271: a server stop that disposes the runtime under an undo is no runtime failure.
  it("refuses an undo the run's teardown overtook as run-unavailable, without a revert-failed warning", async () => {
    const { port, log } = subject({ disposedDuringDiff: true });

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "run-unavailable",
    });
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.revert.refused",
        correlationId: CORRELATION_ID,
        errorKind: "unavailable",
        extra: { runId: RUN_ID, operation: "undo", reason: "run-unavailable" },
      },
    ]);
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });

  it("answers a failing runtime with a refusal that carries frames, never the error text", async () => {
    const { port, run, log } = subject({
      stage: () => Promise.reject(new RefusedRequest(`stage failed ${SECRET}`)),
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
    const gone = { file: "gone.txt", status: "added" as const, additions: 1, deletions: 0 };
    const { port, client } = subject({ root, files: [gone], staged: [gone] });
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
      clear: () => Promise.reject(new RefusedRequest(`clear failed ${SECRET}`)),
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
    expect(client.sessionDiff).toHaveBeenCalledWith(
      SESSION_ID,
      undefined,
      "msg_turn_user",
      "msg_continue",
    );
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
    expect(client.sessionDiff).toHaveBeenCalledWith(
      SESSION_ID,
      undefined,
      "msg_turn_user",
      "msg_continue",
    );
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
      stage: () => Promise.reject(new RefusedRequest("stage failed")),
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

const CONTINUED_TURN: readonly Readonly<Record<string, unknown>>[] = [
  ...TURN,
  {
    id: "msg_continue",
    type: "user",
    metadata: { keikoTurnOriginV1: "verification-continuation" },
  },
  { id: "msg_continue_reply", type: "assistant" },
  { id: "msg_continue_idle", type: "idle" },
];

function gitIn(root: string, ...args: string[]): string {
  const run = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (run.status !== 0) throw new Error(`fixture git ${args[0] ?? ""} failed`);
  return run.stdout;
}

/** What governed staging records after its mutation: the entry the index now holds per path. */
async function noteGoverned(root: string, paths: readonly string[]): Promise<void> {
  const image = await captureTurnIndex(root);
  if (typeof image !== "object") throw new Error("fixture index unreadable");
  noteGovernedIndexTransitions(
    RUN_ID,
    paths.map((path) => ({ path, before: AT_HEAD, after: image.staged.get(path) ?? AT_HEAD })),
  );
}

/** A committed repository whose `a.txt` the turn then stages, as the governed staging does. */
async function stagedTurn(options: { readonly editBeforeTurn?: boolean } = {}): Promise<{
  readonly root: string;
  readonly begun: ReturnType<typeof beginTurnIndex>;
}> {
  const root = workspace({ "a.txt": "original\n" });
  gitIn(root, "init", "-q");
  gitIn(root, "add", "-A");
  gitIn(
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  if (options.editBeforeTurn === true) writeFileSync(join(root, "a.txt"), "turn result\n");
  const begun = beginTurnIndex(root);
  await begun.start;
  writeFileSync(join(root, "a.txt"), "turn result\n");
  gitIn(root, "add", "a.txt");
  return { root, begun };
}

describe("a turn that continued (U-34)", () => {
  it("reports the whole turn: its range runs through Keiko's continuation, and the log counts the steps", async () => {
    const { port, client, log } = subject({ messages: CONTINUED_TURN });

    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ staged: false });
    expect(client.sessionDiff).toHaveBeenCalledWith(
      SESSION_ID,
      undefined,
      "msg_turn_user",
      "msg_continue",
    );
    await port.revertTurn(RUN_ID, "undo", CORRELATION_ID);

    expect(client.stageRevert).toHaveBeenCalledExactlyOnceWith(SESSION_ID, "msg_turn_user");
    expect(log.events).toMatchObject([
      { op: "coding-runtime.revert.applied", extra: { action: "undo", stepCount: 2 } },
    ]);
  });

  it("reads a single-step turn from its own request alone", async () => {
    const { port, client, log } = subject();

    await port.revertState(RUN_ID);
    await port.revertTurn(RUN_ID, "undo", CORRELATION_ID);

    expect(client.sessionDiff).toHaveBeenCalledWith(SESSION_ID, undefined, "msg_turn_user");
    expect(log.events).toMatchObject([{ extra: { stepCount: 1 } }]);
  });

  it("offers nothing to undo for a turn that changed no file", async () => {
    const { port } = subject({ files: [], messages: CONTINUED_TURN });

    await expect(port.revertState(RUN_ID)).resolves.toEqual({
      staged: false,
      fileCount: 0,
      additions: 0,
      deletions: 0,
    });
    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "nothing-to-undo",
    });
  });
});

describe("undo and the Git index (U-34b)", () => {
  it("keeps Undo for a turn that only staged an existing edit, and puts the index back with the bytes intact", async () => {
    const { root, begun } = await stagedTurn({ editBeforeTurn: true });
    const { port, run, log } = subject({ root, files: [] });
    run.turnIndex = begun;
    await noteGoverned(root, ["a.txt"]);
    recordOpenCodeTurnImage(run, log);
    await run.turnImage;

    await expect(port.revertState(RUN_ID)).resolves.toEqual({
      staged: false,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      indexPathCount: 1,
    });
    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toMatchObject({
      ok: true,
    });

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("turn result\n");
  });

  it("unstages what the turn staged and says so on the state and the log", async () => {
    const { root, begun } = await stagedTurn();
    const { port, run, log } = subject({ root });
    run.turnIndex = begun;
    await noteGoverned(root, ["a.txt"]);
    recordOpenCodeTurnImage(run, log);
    await run.turnImage;
    await agentWrote(run, ["a.txt"]);

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toMatchObject({
      ok: true,
    });

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({
      staged: true,
      index: "restored",
    });
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.revert.applied",
        extra: { action: "undo", indexOutcome: "restored", indexPathCount: 1 },
      },
    ]);
    expect(JSON.stringify(log.events)).not.toContain("a.txt");
  });

  it("does not claim the index restored when it changed after the turn", async () => {
    const { root, begun } = await stagedTurn();
    const { port, run, log } = subject({ root });
    run.turnIndex = begun;
    await noteGoverned(root, ["a.txt"]);
    recordOpenCodeTurnImage(run, log);
    await run.turnImage;
    await begun.settled;
    // A person stages other content for the same path after the turn settled.
    writeFileSync(join(root, "a.txt"), "edited after the turn\n");
    gitIn(root, "add", "a.txt");
    await agentWrote(run, ["a.txt"]);
    run.turnImage = Promise.resolve(new Map([["a.txt", "unverifiable"]]));

    await port.revertTurn(RUN_ID, "undo", CORRELATION_ID);

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("a.txt\n");
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({
      index: "changed-after-turn",
    });
  });

  it("reports the index unavailable and logs why when Git's index lock is held", async () => {
    const { root, begun } = await stagedTurn();
    const { port, run, log } = subject({ root });
    run.turnIndex = begun;
    await noteGoverned(root, ["a.txt"]);
    recordOpenCodeTurnImage(run, log);
    await run.turnImage;
    await begun.settled;
    writeFileSync(join(root, ".git", "index.lock"), "");
    await agentWrote(run, ["a.txt"]);

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toMatchObject({
      ok: true,
    });

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("a.txt\n");
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ index: "unavailable" });
    expect(log.events).toMatchObject([
      {
        op: "coding-runtime.revert.refused",
        extra: { operation: "undo", reason: "revert-failed" },
      },
      { op: "coding-runtime.revert.applied", extra: { indexOutcome: "unavailable" } },
    ]);
  });

  it.each([
    ["capture-timed-out", false],
    ["capture-aborted", true],
  ] as const)(
    "logs %s as the closed cause when the turn's index start was cut short",
    async (cause, aborted) => {
      const { root } = await stagedTurn();
      const { port, run, log } = subject({ root });
      // A capture that never answers, cut by the bound or by Stop.
      const hung = { start: new Promise<IndexRead>(() => undefined) };
      const stop = new AbortController();
      if (aborted) stop.abort();
      await awaitTurnIndexStart(hung, stop.signal, aborted ? 600_000 : 0);
      run.turnIndex = hung;
      await noteGoverned(root, ["a.txt"]);
      recordOpenCodeTurnImage(run, log);
      await run.turnImage;
      await agentWrote(run, ["a.txt"]);

      await port.revertTurn(RUN_ID, "undo", CORRELATION_ID);

      await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ index: "unavailable" });
      expect(log.events).toMatchObject([
        {
          op: "coding-runtime.revert.refused",
          correlationId: RUN_ID,
          extra: { operation: "undo", reason: "revert-failed", indexCaptureCause: cause },
        },
        { op: "coding-runtime.revert.applied", extra: { indexOutcome: "unavailable" } },
      ]);
    },
  );

  it("unstages what a continuation step staged after the turn last settled, on a busy undo", async () => {
    const { root, begun } = await stagedTurn();
    const { port, run, log } = subject({ root, busy: true });
    run.turnIndex = begun;
    recordOpenCodeTurnImage(run, log);
    await run.turnImage;
    await begun.settled;
    // Step two begins: the settled image is stale, and step two stages another file.
    reopenTurnIndex(run.turnIndex);
    writeFileSync(join(root, "b.txt"), "step two\n");
    gitIn(root, "add", "b.txt");
    await noteGoverned(root, ["a.txt", "b.txt"]);
    await agentWrote(run, ["a.txt"]);

    await expect(port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toMatchObject({
      ok: true,
    });

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ index: "restored" });
  });

  function refusals(
    events: readonly { readonly op: string }[],
  ): readonly { readonly op: string }[] {
    return events.filter((event) => event.op === "coding-runtime.revert.refused");
  }

  async function undoneIndexOnlyTurn(
    clear?: () => Promise<never>,
  ): Promise<Subject & { readonly root: string }> {
    const { root, begun } = await stagedTurn({ editBeforeTurn: true });
    const made = subject({ root, files: [], ...(clear === undefined ? {} : { clear }) });
    made.run.turnIndex = begun;
    await noteGoverned(root, ["a.txt"]);
    recordOpenCodeTurnImage(made.run, made.log);
    await made.run.turnImage;
    await made.port.revertTurn(RUN_ID, "undo", CORRELATION_ID);
    return { ...made, root };
  }

  it("makes Restore changes stage again what an index-only Undo unstaged, and says how many", async () => {
    const { port, root, log } = await undoneIndexOnlyTurn();
    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({
      staged: true,
      index: "restored",
      indexPathCount: 1,
    });

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toMatchObject({
      ok: true,
    });

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("a.txt\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("turn result\n");
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ staged: false });
    expect(log.events.at(-1)).toMatchObject({
      op: "coding-runtime.revert.applied",
      extra: { action: "restore", indexOutcome: "restored", indexPathCount: 1 },
    });
  });

  it("refuses Restore changes and keeps the person's staging when they staged the path after the Undo", async () => {
    const { port, root } = await undoneIndexOnlyTurn();
    writeFileSync(join(root, "a.txt"), "staged by the person\n");
    gitIn(root, "add", "a.txt");
    const personsEntry = gitIn(root, "ls-files", "-s", "a.txt");

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "index-changed",
    });

    expect(gitIn(root, "ls-files", "-s", "a.txt")).toBe(personsEntry);
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ staged: true });
  });

  it("refuses Restore changes with its own reason, and leaves the index alone, when HEAD moved since the Undo", async () => {
    const { port, root, log } = await undoneIndexOnlyTurn();
    gitIn(
      root,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "moved",
    );

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "index-changed",
    });

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    expect(log.events.at(-1)).toMatchObject({
      op: "coding-runtime.revert.refused",
      extra: { operation: "restore", reason: "index-changed" },
    });
  });

  it("classifies an index that cannot be changed as unavailable, not as a conflict", async () => {
    const { port, root, log } = await undoneIndexOnlyTurn();
    writeFileSync(join(root, "intent.txt"), "intent\n");
    gitIn(root, "add", "-N", "intent.txt");

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    expect(refusals(log.events)).toMatchObject([
      {
        errorKind: "unavailable",
        correlationId: CORRELATION_ID,
        extra: { operation: "restore", reason: "revert-failed" },
      },
    ]);
  });

  it("puts the index back to the undone state when clearing the runtime's revert fails", async () => {
    const { port, root, log } = await undoneIndexOnlyTurn(() =>
      Promise.reject(new RefusedRequest("clear failed")),
    );

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ staged: true });
    expect(refusals(log.events)).toMatchObject([
      { extra: { operation: "restore", reason: "revert-failed" } },
    ]);
  });

  it("logs, and keeps the person's entry, when they restage during a failed clear", async () => {
    let root = "";
    const made = await undoneIndexOnlyTurn(() => {
      writeFileSync(join(root, "a.txt"), "staged by the person\n");
      gitIn(root, "add", "a.txt");
      return Promise.reject(new RefusedRequest("clear failed"));
    });
    root = made.root;
    // The restore moved the entry back first; the person then replaced it before the rollback.

    await made.port.revertTurn(RUN_ID, "restore", CORRELATION_ID);

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("staged by the person\n");
    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("a.txt\n");
    expect(refusals(made.log.events)).toMatchObject([
      {
        correlationId: CORRELATION_ID,
        extra: { operation: "restore", reason: "index-changed" },
      },
      { extra: { operation: "restore", reason: "revert-failed" } },
    ]);
    // The rollback was refused, so the retained undo no longer claims the index is restored.
    await expect(made.port.revertState(RUN_ID)).resolves.toMatchObject({
      staged: true,
      index: "changed-after-turn",
    });
  });

  it("still restores the files after a refused rollback, without the index it no longer owns", async () => {
    let root = "";
    let clears = 0;
    const made = await undoneIndexOnlyTurn(() => {
      clears += 1;
      if (clears > 1) return Promise.resolve() as Promise<never>;
      writeFileSync(join(root, "a.txt"), "staged by the person\n");
      gitIn(root, "add", "a.txt");
      return Promise.reject(new RefusedRequest("clear failed"));
    });
    root = made.root;
    await made.port.revertTurn(RUN_ID, "restore", CORRELATION_ID);
    await expect(made.port.revertState(RUN_ID)).resolves.toMatchObject({
      staged: true,
      index: "changed-after-turn",
    });
    expect(refusals(made.log.events)).toHaveLength(2);

    await expect(made.port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toMatchObject({
      ok: true,
    });

    // The Restore of the files says the index part was not restored.
    expect(made.log.events.at(-1)).toMatchObject({
      op: "coding-runtime.revert.applied",
      extra: { action: "restore", indexOutcome: "changed-after-turn" },
    });
    expect(made.client.clearRevert).toHaveBeenCalledTimes(2);
    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("a.txt\n");
    expect(refusals(made.log.events)).toHaveLength(2);
    await expect(made.port.revertState(RUN_ID)).resolves.toMatchObject({ staged: false });
  });

  it("retries a rollback that failed once, and keeps the index moves when the retry holds", async () => {
    const made = await undoneIndexOnlyTurn(() =>
      Promise.reject(new RefusedRequest("clear failed")),
    );
    afterReapply.calls = 0;
    afterReapply.throwOnCalls = [2];

    await expect(made.port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    // Only the clear failed: the index is back at the undone state and a later Restore can retry.
    expect(gitIn(made.root, "diff", "--cached", "--name-only")).toBe("");
    await expect(made.port.revertState(RUN_ID)).resolves.toMatchObject({
      staged: true,
      index: "restored",
      indexPathCount: 1,
    });
    expect(refusals(made.log.events)).toHaveLength(1);
  });

  it("keeps the failure on the log and the index outcome unavailable when the rollback throws", async () => {
    const made = await undoneIndexOnlyTurn(() =>
      Promise.reject(new RefusedRequest("clear failed")),
    );
    afterReapply.calls = 0;
    afterReapply.throwOnCalls = [2, 3];

    await expect(made.port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    await expect(made.port.revertState(RUN_ID)).resolves.toMatchObject({
      staged: true,
      index: "unavailable",
    });
    expect(refusals(made.log.events)).toMatchObject([
      { correlationId: CORRELATION_ID, extra: { operation: "restore", reason: "revert-failed" } },
      { correlationId: CORRELATION_ID, extra: { operation: "restore", reason: "revert-failed" } },
    ]);
  });

  it("refuses to write the turn's files over an edit made while the index was reapplied, and undoes the index again", async () => {
    const { root, begun } = await stagedTurn();
    const made = subject({ root });
    made.run.turnIndex = begun;
    await noteGoverned(root, ["a.txt"]);
    recordOpenCodeTurnImage(made.run, made.log);
    await made.run.turnImage;
    await agentWrote(made.run, ["a.txt"]);
    await expect(made.port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toMatchObject({
      ok: true,
    });
    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    afterReapply.run = (): void => {
      writeFileSync(join(root, "a.txt"), "typed by the person during the index work\n");
    };

    await expect(made.port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "workspace-changed",
    });

    expect(made.client.clearRevert).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(
      "typed by the person during the index work\n",
    );
    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("");
    await expect(made.port.revertState(RUN_ID)).resolves.toMatchObject({ staged: true });
  });

  it("restores nothing in the index that governed staging did not stage, and says staged changes may remain", async () => {
    const { root, begun } = await stagedTurn();
    const { port, run, log } = subject({ root });
    run.turnIndex = begun;
    recordOpenCodeTurnImage(run, log);
    await run.turnImage;
    await agentWrote(run, ["a.txt"]);
    resetGovernedIndexPaths(RUN_ID);

    await port.revertTurn(RUN_ID, "undo", CORRELATION_ID);

    expect(gitIn(root, "diff", "--cached", "--name-only")).toBe("a.txt\n");
    // A record that names nothing cannot be told from the person's own staging: never "restored".
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ index: "partial" });
  });
});

const TURN_RESULT = "turn result\n";
const UNDONE = "as the undo left it\n";
const HUMAN = "a human typed this\n";
const HUMAN_LATER = "a human typed this after the runtime wrote\n";

/** A scripted answer for one call of a runtime double, whatever the double's own typing says. */
function scripted(double: ReturnType<typeof vi.fn>): {
  mockImplementationOnce: (script: (...args: string[]) => unknown) => void;
} {
  return double;
}

/** The turn's native edits of `names`: admitted while the files hold their start, then settled. */
async function admittedEdit(
  run: OpenCodeRevertRun,
  root: string,
  names: readonly string[],
  contents: Readonly<Record<string, string>>,
  call = "call_admitted",
): Promise<void> {
  const key = openCodeNativeCallKey("msg_turn_reply", call);
  noteOpenCodeEditTargets(run, key, names);
  for (const name of names) writeFileSync(join(root, name), contents[name] ?? TURN_RESULT);
  recordOpenCodeEditSettled(run, key, undefined);
  await run.agentImages?.work;
}

/** A run whose Undo restored every file to UNDONE and whose Restore the caller scripts. */
async function undoneRun(
  files: Readonly<Record<string, string>> = { "a.txt": TURN_RESULT },
): Promise<Subject & { readonly root: string }> {
  const names = Object.keys(files);
  // The turn started from UNDONE: the edits were admitted there, then wrote the turn's content.
  const root = workspace(Object.fromEntries(names.map((name) => [name, UNDONE])));
  const diffs = names.map((name) => diff(name));
  const made = subject({ root, files: diffs });
  await admittedEdit(made.run, root, names, files);
  scripted(made.client.stageRevert).mockImplementationOnce(
    (_session: string, messageId: string) => {
      for (const name of Object.keys(files)) writeFileSync(join(root, name), UNDONE);
      return Promise.resolve({ messageId, files: diffs });
    },
  );
  await expect(made.port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
  made.log.events.length = 0;
  return { ...made, root };
}

interface LoggedEvent {
  readonly op: string;
  readonly extra?: unknown;
}

function eventsOf(events: readonly LoggedEvent[], op: string): readonly LoggedEvent[] {
  return events.filter((event) => event.op === op);
}

function settlements(events: readonly LoggedEvent[]): (string | undefined)[] {
  return eventsOf(events, "coding-runtime.revert.applied").map(
    (event) => (event.extra as { settlement?: string }).settlement,
  );
}

const TWO_FILES = { "a.txt": TURN_RESULT, "b.txt": TURN_RESULT };

/** A Restore whose native write reached `a.txt` only: neither state, so it cannot be settled. */
async function partiallyRestored(): Promise<Subject & { readonly root: string }> {
  const made = await undoneRun(TWO_FILES);
  scripted(made.client.clearRevert).mockImplementationOnce(() => {
    writeFileSync(join(made.root, "a.txt"), TURN_RESULT);
    return Promise.reject(new Error("lost"));
  });
  await expect(made.port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
    ok: false,
    reason: "outcome-uncertain",
  });
  return made;
}

describe("the runtime's own file write is gated and settled from the files (#4491)", () => {
  it("lands a person's save made during the runtime's write after it, so the edit wins", async () => {
    const { port, client, root } = await undoneRun();
    let entered: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    scripted(client.clearRevert).mockImplementationOnce(async () => {
      entered();
      await release;
      writeFileSync(join(root, "a.txt"), TURN_RESULT);
    });

    const restoring = port.revertTurn(RUN_ID, "restore", CORRELATION_ID);
    await inFlight;
    const saved = runHumanWorkspaceWrite(root, () => {
      writeFileSync(join(root, "a.txt"), HUMAN);
      return Promise.resolve();
    });
    // The save is queued behind the runtime's write: nothing of the person's is on the file yet.
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(UNDONE);
    finish();
    await expect(restoring).resolves.toMatchObject({ ok: true });
    await saved;

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(HUMAN);
  });

  it("treats a Restore whose answer was lost after the write as applied, not as undone", async () => {
    const { port, run, client, root, log } = await undoneRun();
    scripted(client.clearRevert).mockImplementationOnce(() => {
      writeFileSync(join(root, "a.txt"), TURN_RESULT);
      return Promise.reject(new Error(`connection reset ${SECRET}`));
    });

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: true,
      fileCount: 1,
      additions: 2,
      deletions: 1,
    });

    expect(run.revert).toBeUndefined();
    expect(settlements(log.events)).toEqual(["response-lost"]);
    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
      reason: "nothing-staged",
    });
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "puts the closed kind of the last read failure on the unreadable refusal line",
    async () => {
      const { port, client, root, log } = await undoneRun();
      scripted(client.clearRevert).mockImplementationOnce(() => {
        chmodSync(join(root, "a.txt"), 0o000);
        return Promise.resolve();
      });

      await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
        ok: false,
        reason: "outcome-uncertain",
      });
      chmodSync(join(root, "a.txt"), 0o600);

      expect(eventsOf(log.events, "coding-runtime.revert.refused")).toMatchObject([
        {
          correlationId: CORRELATION_ID,
          errorKind: "unavailable",
          extra: {
            operation: "restore",
            reason: "outcome-uncertain",
            uncertainReason: "unreadable",
          },
        },
      ]);
    },
  );

  it("calls a Restore whose 200 reply wrote nothing uncertain: not applied, record kept", async () => {
    const { port, run, client, root, log } = await undoneRun();
    scripted(client.clearRevert).mockImplementationOnce(() => Promise.resolve());

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(UNDONE);
    expect(run.revert?.uncertain).toMatchObject({
      reason: "unexpected-content",
      during: "restore",
    });
    expect(settlements(log.events)).toEqual([]);
  });

  it("leaves a file the stage reply names but the proof did not cover unverifiable", async () => {
    const root = workspace({ "a.txt": TURN_RESULT, "extra.txt": "person's file\n" });
    const { port, run, client } = subject({ root });
    scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) =>
      Promise.resolve({ messageId, files: [diff("a.txt"), diff("extra.txt")] }),
    );

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });

    expect(run.revert?.witness?.get("a.txt")).toMatch(/^sha256:/u);
    expect(run.revert?.witness?.get("extra.txt")).toBe("unverifiable");
  });

  it("keeps the undo staged and the files untouched when the request failed before any write", async () => {
    const { port, run, client, root } = await undoneRun();
    scripted(client.clearRevert).mockImplementationOnce(() =>
      Promise.reject(new RefusedRequest("refused")),
    );

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(UNDONE);
    expect(run.revert).toBeDefined();
    scripted(client.clearRevert).mockImplementationOnce(() => {
      writeFileSync(join(root, "a.txt"), TURN_RESULT);
      return Promise.resolve();
    });
    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({ ok: true });
  });

  it("settles a partial write as uncertain, logs why, and never writes anything back", async () => {
    const { run, root, log } = await partiallyRestored();

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(TURN_RESULT);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe(UNDONE);
    expect(run.revert?.uncertain).toMatchObject({ reason: "partial-write", during: "restore" });
    expect(eventsOf(log.events, "coding-runtime.revert.refused")).toMatchObject([
      {
        extra: {
          operation: "restore",
          reason: "outcome-uncertain",
          uncertainReason: "partial-write",
        },
      },
    ]);
  });

  it("leaves the person's later save alone: human, native write, human again ends on the last", async () => {
    const { port, run, client, root } = await undoneRun();
    scripted(client.clearRevert).mockImplementationOnce(() => {
      writeFileSync(join(root, "a.txt"), HUMAN);
      writeFileSync(join(root, "a.txt"), TURN_RESULT);
      writeFileSync(join(root, "a.txt"), HUMAN_LATER);
      return Promise.resolve();
    });

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(HUMAN_LATER);
    expect(run.revert?.uncertain).toMatchObject({ reason: "unexpected-content" });
  });

  it("settles an uncertain Restore as applied when the files later show the turn's content", async () => {
    const { port, run, root, client } = await partiallyRestored();
    writeFileSync(join(root, "b.txt"), TURN_RESULT);

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({ ok: true });

    expect(run.revert).toBeUndefined();
    expect(client.clearRevert).toHaveBeenCalledTimes(1);
  });

  it("settles an uncertain Restore as not applied when the files went back, and restores again", async () => {
    const { port, run, root, client } = await partiallyRestored();
    writeFileSync(join(root, "a.txt"), UNDONE);
    scripted(client.clearRevert).mockImplementationOnce(() => {
      for (const name of ["a.txt", "b.txt"]) writeFileSync(join(root, name), TURN_RESULT);
      return Promise.resolve();
    });

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({ ok: true });

    expect(run.revert).toBeUndefined();
    expect(client.clearRevert).toHaveBeenCalledTimes(2);
  });

  it("refuses with workspace-changed while the files still show neither state, and writes nothing", async () => {
    const { port, run, root, client } = await partiallyRestored();

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });
    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });

    expect(client.clearRevert).toHaveBeenCalledTimes(1);
    expect(run.revert?.uncertain).toBeDefined();
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe(UNDONE);
  });

  it("settles an uncertain record as it is when a new turn begins, and logs it", async () => {
    const { run, log } = await partiallyRestored();
    log.events.length = 0;

    await settleUncertainRevertOnTurn(log, run, CORRELATION_ID);

    expect(run.revert).toBeUndefined();
    expect(openCodeRevertBlocksTurn(run)).toBe(false);
    expect(eventsOf(log.events, "coding-runtime.revert.refused")).toMatchObject([
      {
        extra: {
          operation: "submit",
          reason: "outcome-uncertain",
          uncertainReason: "partial-write",
        },
      },
    ]);
  });

  it("never commits an uncertain record blindly: the window reports it unsettled", async () => {
    const { port, run, client, log } = await partiallyRestored();
    log.events.length = 0;

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("unsettled");

    expect(client.commitRevert).not.toHaveBeenCalled();
    expect(run.revert?.uncertain).toBeDefined();
    expect(eventsOf(log.events, "coding-runtime.revert.refused")).toMatchObject([
      { extra: { operation: "commit", reason: "outcome-uncertain" } },
    ]);
  });

  it("commits at window close once the files show the undone state again", async () => {
    const { port, root, client } = await partiallyRestored();
    writeFileSync(join(root, "a.txt"), UNDONE);

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("committed");
    expect(client.commitRevert).toHaveBeenCalledTimes(1);
  });

  it("ends an uncertain record at window close when the files show the Restore happened", async () => {
    const { port, run, root, client } = await partiallyRestored();
    writeFileSync(join(root, "b.txt"), TURN_RESULT);

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("none");
    expect(client.commitRevert).not.toHaveBeenCalled();
    expect(run.revert).toBeUndefined();
  });
});

describe("the Undo's native write is gated and settled from the files (#4491)", () => {
  async function lostUndo(): Promise<Subject & { readonly root: string }> {
    const root = workspace({ "a.txt": TURN_RESULT });
    const made = subject({ root });
    scripted(made.client.stageRevert).mockImplementationOnce(() => {
      writeFileSync(join(root, "a.txt"), UNDONE);
      return Promise.reject(new Error(`connection reset ${SECRET}`));
    });
    await expect(made.port.revertTurn(RUN_ID, "undo", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });
    return { ...made, root };
  }

  it("reports an Undo whose answer was lost after the write as uncertain, with the reason", async () => {
    const { run, log } = await lostUndo();

    expect(run.revert?.uncertain).toMatchObject({
      reason: "call-failed-unknown",
      during: "undo",
    });
    expect(eventsOf(log.events, "coding-runtime.revert.refused")).toMatchObject([
      {
        extra: {
          operation: "undo",
          reason: "outcome-uncertain",
          uncertainReason: "call-failed-unknown",
        },
      },
    ]);
    expect(JSON.stringify(log.events)).not.toContain(SECRET);
  });

  it("refuses to restore or undo while the files show neither state, then settles on a new turn", async () => {
    const { port, run, log } = await lostUndo();

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });
    // An uncertain record never blocks by itself: the turn settles it or ends it as it is.
    expect(openCodeRevertBlocksTurn(run)).toBe(false);
    await settleUncertainRevertOnTurn(log, run, CORRELATION_ID);
    expect(run.revert).toBeUndefined();
  });

  it("lets a later Undo go on once the files show the state before the write", async () => {
    const { port, run, root, client } = await lostUndo();
    writeFileSync(join(root, "a.txt"), TURN_RESULT);
    scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) => {
      writeFileSync(join(root, "a.txt"), UNDONE);
      return Promise.resolve({ messageId, files: [diff("a.txt")] });
    });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
    expect(run.revert?.uncertain).toBeUndefined();
    // Nothing says what the runtime must leave in a file only a shell command changed, so a later
    // Restore refuses it rather than writing the turn's content over what may be a person's edit.
    expect(run.revert?.witness?.get("a.txt")).toBe("unverifiable");
  });

  it("commits nothing blindly and ends the record once the files went back", async () => {
    const { port, run, root, client } = await lostUndo();
    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("unsettled");
    writeFileSync(join(root, "a.txt"), TURN_RESULT);

    await expect(port.commitStagedRevert(RUN_ID)).resolves.toBe("none");
    expect(client.commitRevert).not.toHaveBeenCalled();
    expect(run.revert).toBeUndefined();
  });

  it("calls a file the turn added that is still there after the stage uncertain", async () => {
    const root = workspace({ "a.txt": TURN_RESULT });
    const { port, run, client } = subject({ root, files: [{ ...diff("a.txt"), status: "added" }] });
    scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) =>
      Promise.resolve({ messageId, files: [{ ...diff("a.txt"), status: "added" }] }),
    );

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });
    expect(run.revert?.uncertain).toMatchObject({ reason: "unexpected-content" });
  });

  it("clears the runtime's own staged revert before it drops an answered Undo whose files never moved", async () => {
    const root = workspace({ "a.txt": TURN_RESULT });
    const added = { ...diff("a.txt"), status: "added" as const };
    const { port, run, client, log } = subject({ root, files: [added] });
    scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) =>
      Promise.resolve({ messageId, files: [added] }),
    );
    await port.revertTurn(RUN_ID, "undo");
    expect(run.revert?.uncertain).toMatchObject({ runtimeStaged: true });
    log.events.length = 0;

    // The files still show the proven state, yet the runtime answered: it holds a staged revert.
    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "nothing-staged",
    });

    expect(client.clearRevert).toHaveBeenCalledTimes(1);
    expect(run.revert).toBeUndefined();
    expect(settlements(log.events)).toEqual(["clean"]);
    expect(eventsOf(log.events, "coding-runtime.revert.applied")).toMatchObject([
      {
        correlationId: CORRELATION_ID,
        extra: { action: "cleared", runId: RUN_ID, interrupted: false, settlement: "clean" },
      },
    ]);
  });

  it("keeps an answered Undo uncertain when the runtime's own clear fails", async () => {
    const root = workspace({ "a.txt": TURN_RESULT });
    const added = { ...diff("a.txt"), status: "added" as const };
    const { port, run, client, log } = subject({ root, files: [added] });
    scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) =>
      Promise.resolve({ messageId, files: [added] }),
    );
    await port.revertTurn(RUN_ID, "undo");
    scripted(client.clearRevert).mockImplementationOnce(() => Promise.reject(new Error("reset")));
    log.events.length = 0;

    await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });

    expect(run.revert?.uncertain).toBeDefined();
    const refused = eventsOf(log.events, "coding-runtime.revert.refused").map(
      (event) => event.extra as { operation?: string; reason?: string },
    );
    expect(refused.some((x) => x.operation === "restore" && x.reason === "outcome-uncertain")).toBe(
      true,
    );
    // The clear's own refusal line is the first one, under the request's correlation id.
    expect(eventsOf(log.events, "coding-runtime.revert.refused")[0]).toMatchObject({
      correlationId: CORRELATION_ID,
      extra: {
        operation: "restore",
        reason: "outcome-uncertain",
        uncertainReason: "unexpected-content",
      },
    });
    expect(eventsOf(log.events, "coding-runtime.revert.applied")).toEqual([]);
  });

  it("refuses to take an external edit for the stage when the turn's start is known", async () => {
    const root = workspace({ "a.txt": "original\n" });
    const { port, run, client } = subject({ root });
    await admittedEdit(run, root, ["a.txt"], { "a.txt": TURN_RESULT });
    scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) => {
      // The runtime answered, but an external editor's text is on the file, not the turn's start.
      writeFileSync(join(root, "a.txt"), "an external editor typed this\n");
      return Promise.resolve({ messageId, files: [diff("a.txt")] });
    });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });

    expect(run.revert?.uncertain).toMatchObject({
      reason: "unexpected-content",
      runtimeStaged: true,
    });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("an external editor typed this\n");
    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toMatchObject({
      reason: "outcome-uncertain",
    });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "keeps a file unverifiable when its start could not be read at admission, even if the stage left it untouched",
    async () => {
      const root = workspace({ "a.txt": "original\n" });
      const { port, run, client, log } = subject({ root });
      const path = join(root, "a.txt");
      const key = openCodeNativeCallKey("msg_turn_reply", "call_unreadable");
      // The edit is admitted while the file cannot be read: its start is unknown, not absent.
      chmodSync(path, 0o000);
      noteOpenCodeEditTargets(run, key, ["a.txt"]);
      chmodSync(path, 0o600);
      writeFileSync(path, TURN_RESULT);
      recordOpenCodeEditSettled(run, key, undefined);
      await run.agentImages?.work;
      // The stage answers and leaves the file as the turn did: with a known start that is a
      // mismatch; with an unknown one nothing can check it, so nothing may prove it for a Restore.
      scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) =>
        Promise.resolve({ messageId, files: [diff("a.txt")] }),
      );

      await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });
      expect(run.revert?.witness?.get("a.txt")).toBe("unverifiable");
      log.events.length = 0;

      await expect(port.revertTurn(RUN_ID, "restore", CORRELATION_ID)).resolves.toEqual({
        ok: false,
        reason: "workspace-changed",
      });
      expect(client.clearRevert).not.toHaveBeenCalled();
      expect(eventsOf(log.events, "coding-runtime.revert.refused")).toMatchObject([
        {
          correlationId: CORRELATION_ID,
          extra: { operation: "restore", reason: "workspace-changed" },
        },
      ]);
    },
  );

  it("proves a Restore of a file the stage left exactly as the turn started", async () => {
    const root = workspace({ "a.txt": "original\n" });
    const { port, run, client } = subject({ root });
    await admittedEdit(run, root, ["a.txt"], { "a.txt": TURN_RESULT });
    scripted(client.stageRevert).mockImplementationOnce((_session: string, messageId: string) => {
      writeFileSync(join(root, "a.txt"), "original\n");
      return Promise.resolve({ messageId, files: [diff("a.txt")] });
    });

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toMatchObject({ ok: true });

    expect(run.revert?.witness?.get("a.txt")).toMatch(/^sha256:/u);
  });

  it("calls an Undo request that timed out uncertain even though the files still equal the proven state, then settles a late sidecar write", async () => {
    const root = workspace({ "a.txt": "original\n" });
    const { port, run, client } = subject({ root });
    await admittedEdit(run, root, ["a.txt"], { "a.txt": TURN_RESULT });
    scripted(client.stageRevert).mockImplementationOnce(() =>
      Promise.reject(new Error("request timed out")),
    );

    // The runtime may still be writing: the files show nothing yet, and that is not proof.
    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });
    expect(run.revert?.uncertain).toMatchObject({
      reason: "call-failed-unknown",
      runtimeStaged: true,
    });

    // The late sidecar write lands; the files now show neither state the record knows.
    writeFileSync(join(root, "a.txt"), "original\n");
    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });
    // Back at the proven state, the runtime's own staged revert is cleared before the record ends.
    writeFileSync(join(root, "a.txt"), TURN_RESULT);
    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "nothing-staged",
    });
    expect(client.clearRevert).toHaveBeenCalledTimes(1);
  });

  it("calls a Restore request that timed out uncertain, keeping the index moves", async () => {
    const { port, run, client } = await undoneRun();
    scripted(client.clearRevert).mockImplementationOnce(() =>
      Promise.reject(new Error("request timed out")),
    );

    await expect(port.revertTurn(RUN_ID, "restore")).resolves.toEqual({
      ok: false,
      reason: "outcome-uncertain",
    });

    expect(run.revert?.uncertain).toMatchObject({
      reason: "call-failed-unknown",
      during: "restore",
    });
  });

  it("settles an uncertain record at the turn only after the files could not settle it", async () => {
    const { port, run, log } = await partiallyRestored();
    const { root } = { root: run.workspaceRoot };
    writeFileSync(join(root, "a.txt"), UNDONE);

    // The files went back: the record is an ordinary staged undo again and blocks the turn.
    await settleUncertainRevertOnTurn(log, run, CORRELATION_ID);

    expect(run.revert?.uncertain).toBeUndefined();
    expect(openCodeRevertBlocksTurn(run)).toBe(true);
    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ staged: true });
  });

  it("reports an uncertain record as nothing staged", async () => {
    const { port } = await partiallyRestored();

    await expect(port.revertState(RUN_ID)).resolves.toMatchObject({ staged: false, fileCount: 0 });
  });

  it("leaves nothing staged when an Undo request failed before any write", async () => {
    const root = workspace({ "a.txt": TURN_RESULT });
    const { port, run, client } = subject({ root });
    scripted(client.stageRevert).mockImplementationOnce(() =>
      Promise.reject(new RefusedRequest("refused")),
    );

    await expect(port.revertTurn(RUN_ID, "undo")).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe(TURN_RESULT);
    expect(run.revert).toBeUndefined();
  });
});
