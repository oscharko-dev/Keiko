import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { CodingRuntimeQuestionAnswerRejectedError } from "./codingRuntimeQuestionPort.js";
import {
  createNativeQuestionPort,
  type NativeQuestionPortDeps,
} from "./opencodeNativeQuestions.js";

const WORKSPACE = "/workspace/repository";
const PRIMARY = "ses_primary";

type Record_ = Readonly<Record<string, unknown>>;

function form(id: string, sessionID: string): Record_ {
  return {
    id: `frm_${id}`,
    sessionID,
    title: "Colour",
    fields: [
      {
        key: "colour",
        title: "Colour",
        description: "Which colour?",
        type: "string",
        options: [
          { label: "Blue", value: "blue", description: "First" },
          { label: "Green", value: "green", description: "Second" },
        ],
      },
    ],
  };
}

function session(id: string, parentID?: string, directory = WORKSPACE): Record_ {
  return { id, ...(parentID === undefined ? {} : { parentID }), location: { directory } };
}

interface Fixture {
  readonly port: ReturnType<typeof createNativeQuestionPort>;
  readonly activityLog: ReturnType<typeof createBufferedServerLogSink>;
  readonly replies: {
    readonly sessionId: string;
    readonly formId: string;
    readonly body: unknown;
  }[];
  readonly cancels: { readonly sessionId: string; readonly formId: string }[];
  readonly failures: unknown[];
  readonly state: {
    forms: readonly Record_[];
    formDirectories: (string | undefined)[];
    formsByDirectory?: ReadonlyMap<string, readonly Record_[]>;
    locations: Set<string>;
    sessions: readonly Record_[];
    sessionReads: number;
    open: boolean;
    failForms: boolean;
    failSessions: boolean;
    failReply: boolean;
    /** Runs while the form list is being read, to model the run closing meanwhile. */
    onForms: () => void;
    /** Runs once a reply or a cancellation went out. */
    onSent: () => void;
  };
}

function fixture(forms: readonly Record_[], sessions: readonly Record_[]): Fixture {
  const state: Fixture["state"] = {
    forms,
    formDirectories: [],
    locations: new Set(),
    sessions,
    sessionReads: 0,
    open: true,
    failForms: false,
    failSessions: false,
    failReply: false,
    onForms: () => undefined,
    onSent: () => undefined,
  };
  const replies: Fixture["replies"][number][] = [];
  const cancels: Fixture["cancels"][number][] = [];
  const failures: unknown[] = [];
  const activityLog = createBufferedServerLogSink();
  const deps: NativeQuestionPortDeps = {
    runId: "run-questions",
    client: {
      forms: (directory) => {
        state.formDirectories.push(directory);
        state.onForms();
        return state.failForms
          ? Promise.reject(new Error("forms-unavailable"))
          : Promise.resolve(
              state.formsByDirectory === undefined
                ? state.forms
                : (state.formsByDirectory.get(directory ?? "") ?? []),
            );
      },
      sessions: () => {
        state.sessionReads += 1;
        return state.failSessions
          ? Promise.reject(new Error("sessions-unavailable"))
          : Promise.resolve(state.sessions);
      },
      replyForm: (sessionId, formId, body) => {
        if (state.failReply) return Promise.reject(new Error("reply-refused"));
        replies.push({ sessionId, formId, body });
        state.onSent();
        return Promise.resolve();
      },
      cancelForm: (sessionId, formId) => {
        cancels.push({ sessionId, formId });
        state.onSent();
        return Promise.resolve();
      },
    },
    tree: {
      sessionId: PRIMARY,
      workspaceRoot: WORKSPACE,
      children: new Set(),
      locations: state.locations,
    },
    open: () => state.open,
    activityLog,
    onFailure: (error) => failures.push(error),
    listed: {},
  };
  return { port: createNativeQuestionPort(deps), activityLog, replies, cancels, failures, state };
}

/** A form whose one field offers `count` options; the question lane shows at most 32. */
function formWithOptions(id: string, sessionID: string, count: number): Record_ {
  const base = form(id, sessionID);
  const options = Array.from({ length: count }, (_, index) => ({
    label: `Option ${String(index + 1)}`,
    value: `option-${String(index + 1)}`,
  }));
  return { ...base, fields: [{ key: "pick", title: "Pick", type: "string", options }] };
}

const routedLines = (fixtureValue: Fixture): readonly Record<string, unknown>[] =>
  fixtureValue.activityLog.events
    .filter((event) => event.op === "coding-runtime.native-question.routed")
    .map((event) => ({ ...event.extra, level: event.level }));

describe("a native run's questions across its session tree", () => {
  const sessions = [
    session("ses_child", PRIMARY),
    session("ses_grandchild", "ses_child"),
    session("ses_foreign"),
    session("ses_elsewhere", PRIMARY, "/elsewhere"),
  ];

  it("reads the workspace and admitted moved locations instead of the service cwd", async () => {
    // Stored as `admitNativeSessionLocation` stores an admitted move: resolved on the host.
    const moved = resolve(`${WORKSPACE}/moved`);
    const run = fixture([], [session("ses_child", PRIMARY, moved), session("ses_foreign")]);
    run.state.locations.add(moved);
    run.state.formsByDirectory = new Map([
      [WORKSPACE, [form("primary", PRIMARY), form("foreign", "ses_foreign")]],
      [moved, [form("child", "ses_child")]],
    ]);
    expect((await run.port.list()).map(({ id }) => id)).toEqual(["que_primary", "que_child"]);
    expect(run.state.formDirectories).toEqual([WORKSPACE, moved]);
    expect(routedLines(run)).toContainEqual(
      expect.objectContaining({
        action: "list",
        outcome: "listed",
        childFormCount: 1,
      }),
    );
  });

  it("lists the forms of the primary session and of its owned children, and no other", async () => {
    const run = fixture(
      [
        form("primary", PRIMARY),
        form("child", "ses_child"),
        form("grandchild", "ses_grandchild"),
        form("foreign", "ses_foreign"),
        form("elsewhere", "ses_elsewhere"),
        form("unknown", "ses_unknown"),
        { ...form("sessionless", PRIMARY), sessionID: undefined },
      ],
      sessions,
    );
    const questions = await run.port.list();
    expect(questions.map(({ id, sessionID }) => [id, sessionID])).toEqual([
      ["que_primary", PRIMARY],
      ["que_child", "ses_child"],
      ["que_grandchild", "ses_grandchild"],
    ]);
  });

  // #3897 review: the original runtime accepts a question with 33 options; the lane shows at most
  // 32. An owned form the lane cannot show is dismissed through the session that asked, so the
  // runtime settles it as a refusal instead of waiting for an answer nobody can give.
  it("dismisses an owned form the lane cannot show and keeps its valid siblings", async () => {
    const run = fixture(
      [
        formWithOptions("wide", PRIMARY, 33),
        formWithOptions("fits", PRIMARY, 32),
        { ...form("dated", "ses_child"), fields: [{ key: "when", title: "When", type: "date" }] },
        form("child", "ses_child"),
        formWithOptions("foreign", "ses_foreign", 33),
      ],
      sessions,
    );

    const questions = await run.port.list();

    expect(questions.map(({ id }) => id)).toEqual(["que_fits", "que_child"]);
    expect(questions[0]?.questions[0]?.options).toHaveLength(32);
    expect(run.cancels).toEqual([
      { sessionId: PRIMARY, formId: "frm_wide" },
      { sessionId: "ses_child", formId: "frm_dated" },
    ]);
    expect(run.failures).toEqual([]);
    const dismissals = routedLines(run).filter((line) => line.action === "dismiss");
    expect(dismissals).toEqual([
      expect.objectContaining({
        outcome: "refused",
        refusal: "form-unrepresentable",
        sessionRelation: "primary",
        level: "warn",
      }),
      expect.objectContaining({ outcome: "dismissed", sessionRelation: "primary" }),
      expect.objectContaining({ outcome: "refused", sessionRelation: "child" }),
      expect.objectContaining({ outcome: "dismissed", sessionRelation: "child" }),
    ]);
    const persisted = run.activityLog.events
      .filter((event) => event.extra?.action === "dismiss")
      .map((event) => formatActivityLogProofLine(event));
    expect(persisted).toHaveLength(4);
    for (const line of persisted) expect(line).not.toContain("Option");
  });

  it("surfaces a dismissal the runtime refuses instead of listing the form", async () => {
    const run = fixture([formWithOptions("wide", PRIMARY, 33)], sessions);
    run.state.onSent = (): void => {
      throw new Error("cancel-refused");
    };
    await expect(run.port.list()).rejects.toThrow("cancel-refused");
    expect(run.failures).toHaveLength(1);
  });

  it("reads the session list only when a form of a session not yet proven turns up", async () => {
    const run = fixture([form("primary", PRIMARY)], sessions);
    await run.port.list();
    expect(run.state.sessionReads).toBe(0);
    run.state.forms = [form("primary", PRIMARY), form("child", "ses_child")];
    await run.port.list();
    await run.port.list();
    expect(run.state.sessionReads).toBe(1);
  });

  it("answers a child's form through the child's own session", async () => {
    const run = fixture([form("child", "ses_child")], sessions);
    await expect(run.port.answer("que_child", [["Blue"]])).resolves.toBe(true);
    expect(run.replies).toEqual([
      { sessionId: "ses_child", formId: "frm_child", body: { colour: "blue" } },
    ]);
    expect(routedLines(run)).toEqual([
      expect.objectContaining({
        action: "answer",
        outcome: "answered",
        sessionRelation: "child",
        formCount: 1,
        childFormCount: 1,
      }),
    ]);
  });

  it("answers the primary's form through the primary session", async () => {
    const run = fixture([form("primary", PRIMARY), form("child", "ses_child")], sessions);
    await expect(run.port.answer("que_primary", [["Green"]])).resolves.toBe(true);
    expect(run.replies).toEqual([
      { sessionId: PRIMARY, formId: "frm_primary", body: { colour: "green" } },
    ]);
    expect(routedLines(run)[0]).toMatchObject({ sessionRelation: "primary", childFormCount: 1 });
  });

  it("rejects a child's form through the child's own session", async () => {
    const run = fixture([form("child", "ses_child")], sessions);
    await expect(run.port.reject("que_child")).resolves.toBe(true);
    expect(run.cancels).toEqual([{ sessionId: "ses_child", formId: "frm_child" }]);
    expect(routedLines(run)).toEqual([
      expect.objectContaining({ action: "reject", outcome: "rejected", sessionRelation: "child" }),
    ]);
  });

  it("refuses to answer or reject the form of a session that is not the run's", async () => {
    const run = fixture(
      [
        form("foreign", "ses_foreign"),
        form("elsewhere", "ses_elsewhere"),
        form("child", "ses_child"),
      ],
      sessions,
    );
    for (const id of ["que_foreign", "que_elsewhere"]) {
      await expect(run.port.answer(id, [["Blue"]])).resolves.toBe(false);
      await expect(run.port.reject(id)).resolves.toBe(false);
    }
    expect(run.replies).toEqual([]);
    expect(run.cancels).toEqual([]);
    const lines = routedLines(run);
    expect(lines).toHaveLength(4);
    for (const line of lines)
      expect(line).toMatchObject({
        outcome: "refused",
        refusal: "foreign-session",
        level: "warn",
        childFormCount: 1,
      });
    expect(lines[0]).not.toHaveProperty("sessionRelation");
    expectActivityLogProof(
      "coding-runtime.native-question.routed.emitted-line",
      formatActivityLogProofLine(
        run.activityLog.events.find(
          (event) => event.op === "coding-runtime.native-question.routed",
        ) ?? {},
      ),
    );
  });

  it("refuses a stale or malformed request id without reaching any session", async () => {
    const run = fixture([form("child", "ses_child")], sessions);
    for (const id of ["que_gone", "frm_child", "not-a-question", ""]) {
      await expect(run.port.answer(id, [["Blue"]])).resolves.toBe(false);
      await expect(run.port.reject(id)).resolves.toBe(false);
    }
    expect(run.replies).toEqual([]);
    expect(run.cancels).toEqual([]);
    for (const line of routedLines(run)) expect(line).toMatchObject({ refusal: "form-missing" });
  });

  it("raises the closed error for an answer that does not fit the questions", async () => {
    const run = fixture([form("child", "ses_child")], sessions);
    for (const answers of [[], [["Blue"], ["Green"]], [["Blue", "Green"]], [["Red"]]])
      await expect(run.port.answer("que_child", answers)).rejects.toBeInstanceOf(
        CodingRuntimeQuestionAnswerRejectedError,
      );
    expect(run.replies).toEqual([]);
    expect(run.failures).toEqual([]);
  });

  it("does not acknowledge an answer or a rejection once the run closed", async () => {
    const closedBefore = fixture([form("child", "ses_child")], sessions);
    closedBefore.state.onForms = (): void => {
      closedBefore.state.open = false;
    };
    await expect(closedBefore.port.answer("que_child", [["Blue"]])).resolves.toBe(false);
    expect(closedBefore.replies).toEqual([]);
    expect(routedLines(closedBefore)[0]).toMatchObject({ refusal: "run-closed" });

    // The reply goes out and the run closes meanwhile: the caller is not told it held.
    const closedDuring = fixture([form("child", "ses_child")], sessions);
    closedDuring.state.onSent = (): void => {
      closedDuring.state.open = false;
    };
    await expect(closedDuring.port.answer("que_child", [["Blue"]])).resolves.toBe(false);
    expect(closedDuring.replies).toHaveLength(1);

    const rejectedDuring = fixture([form("child", "ses_child")], sessions);
    rejectedDuring.state.onSent = (): void => {
      rejectedDuring.state.open = false;
    };
    await expect(rejectedDuring.port.reject("que_child")).resolves.toBe(false);
    expect(rejectedDuring.cancels).toHaveLength(1);
  });

  it("raises a failed read or reply after reporting it, and routes nothing unproven", async () => {
    const forms = fixture([form("child", "ses_child")], sessions);
    forms.state.failForms = true;
    await expect(forms.port.list()).rejects.toThrow("forms-unavailable");

    const unproven = fixture([form("child", "ses_child")], sessions);
    unproven.state.failSessions = true;
    await expect(unproven.port.list()).rejects.toThrow("sessions-unavailable");
    await expect(unproven.port.answer("que_child", [["Blue"]])).rejects.toThrow(
      "sessions-unavailable",
    );
    await expect(unproven.port.reject("que_child")).rejects.toThrow("sessions-unavailable");
    expect(unproven.replies).toEqual([]);
    expect(unproven.cancels).toEqual([]);
    expect(unproven.failures).toHaveLength(3);

    const reply = fixture([form("child", "ses_child")], sessions);
    reply.state.failReply = true;
    await expect(reply.port.answer("que_child", [["Blue"]])).rejects.toThrow("reply-refused");
    expect(reply.failures).toHaveLength(1);
    expect(routedLines(reply)).toEqual([]);
  });

  it("writes a list line when the forms the run owns change, not on every poll", async () => {
    const run = fixture([], sessions);
    await run.port.list();
    await run.port.list();
    expect(routedLines(run)).toEqual([]);
    run.state.forms = [form("child", "ses_child"), form("foreign", "ses_foreign")];
    for (let poll = 0; poll < 3; poll += 1) await run.port.list();
    run.state.forms = [];
    await run.port.list();
    expect(routedLines(run)).toEqual([
      expect.objectContaining({
        action: "list",
        outcome: "listed",
        formCount: 2,
        childFormCount: 1,
      }),
      expect.objectContaining({
        action: "list",
        outcome: "listed",
        formCount: 0,
        childFormCount: 0,
      }),
    ]);
    const line = run.activityLog.events.find(
      (event) => event.op === "coding-runtime.native-question.routed",
    );
    expect(JSON.stringify(run.activityLog.events)).not.toMatch(/ses_|frm_|que_|Which colour/u);
    expectActivityLogProof(
      "coding-runtime.native-question.routed.emitted-line",
      formatActivityLogProofLine(line ?? {}),
    );
  });
});
