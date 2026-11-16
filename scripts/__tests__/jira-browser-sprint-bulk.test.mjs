import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  send: vi.fn(),
  browser: vi.fn(),
  english: vi.fn(),
  mode: vi.fn(),
}));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  labRequest: ports.read,
}));

import { runSprintBulk } from "../testing/jira-chat-lab/browser-sprint-bulk.mjs";
import { canonicalToolId } from "../testing/jira-chat-lab/requirements/tool-exchanges.mjs";
import {
  projectAgileWitness,
  exactSprintBulkIssues,
  sprintBulkClosedIssues,
  sprintBulkLiveMembership,
  sprintBulkTurn,
} from "../testing/jira-chat-lab/project-agile-oracles.mjs";

const roots = [];
const clone = (value) => structuredClone(value);
const key = (number) => `LIM7-${number}`;
const status = (done = false) => ({
  id: done ? "100" : "1",
  statusCategory: { key: done ? "done" : "new" },
});
const exchange = (operation, args, data, denied = false) => ({
  call: { name: operation.replaceAll(/[.-]/gu, "_"), arguments: clone(args) },
  result: {
    toolRef: { canonicalId: canonicalToolId(operation) },
    status: denied ? "failed" : "completed",
    data,
  },
  ...(denied ? {} : { approval: { operation, state: "pending", actionDigest: "a".repeat(64) } }),
});

function memoryIntent(path, seed = {}) {
  let current = clone(seed);
  return {
    path,
    get state() {
      return clone(current);
    },
    record: vi.fn(async (step, value) => {
      current = { ...current, [step]: clone(value) };
    }),
    update: vi.fn(async (patch) => {
      current = { ...current, ...clone(patch) };
    }),
  };
}

function existingTasks(count, history) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(1001 + index),
    key: key(1001 + index),
    fields: {
      summary: `Existing hierarchy Task ${index + 1}`,
      description: "Existing task description.",
      project: { id: "10", key: "LIM7" },
      issuetype: { id: "3", name: "Task" },
      status: status(),
      customfield_10: "LIM7-2",
      customfield_20: history ? [{ id: 1 }, { id: 2 }] : [],
    },
  }));
}

function selectionFault(f, fault) {
  const faults = {
    insufficient: () => {
      f.tasks.splice(199);
    },
    "foreign-project": () => {
      f.tasks[0].fields.project = { id: "11", key: "OTHER" };
    },
    "duplicate-key": () => {
      f.tasks[1].key = f.tasks[0].key;
    },
    "duplicate-id": () => {
      f.tasks[1].id = f.tasks[0].id;
    },
    "done-existing": () => {
      for (const task of f.tasks.slice(0, 101)) task.fields.status = status(true);
    },
    "board-done-existing": () => {
      for (const task of f.tasks.slice(0, 101)) task.fields.status.id = "100";
    },
    "active-existing": () => {
      for (const task of f.tasks.slice(0, 101)) task.fields.customfield_20 = [{ id: 100 }];
    },
    "future-existing": () => {
      for (const task of f.tasks.slice(0, 101)) task.fields.customfield_20 = [{ id: 101 }];
    },
    "no-epic-existing": () => {
      for (const task of f.tasks.slice(0, 101)) task.fields.customfield_10 = null;
    },
    "mixed-existing": () => {
      f.tasks[0].fields.status = status(true);
      f.tasks[1].fields.status.id = "100";
      f.tasks[2].fields.customfield_20 = [{ id: 100 }];
      f.tasks[3].fields.customfield_20 = [{ id: 101 }];
      f.tasks[4].fields.customfield_10 = null;
    },
  };
  faults[fault]?.();
}

async function bindPrepared(f, taskRefs) {
  await f.ctx.intent.record("ac6-sprint-bulk", {
    schemaVersion: 1,
    projectKey: "LIM7",
    step: "ac6-sprint-bulk",
    phase: "prepared",
    revision: 0,
    resources: { taskRefs },
    counts: {},
  });
}

function fixture({
  fault,
  unconfirmed = false,
  history = false,
  witness = false,
  approvals = witness,
  requireApprovals = false,
  taskCount = 300,
} = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), "keiko-sprint-bulk-"));
  roots.push(sessionDir);
  const ctx = {
    sessionDir,
    session: { oracleAuthorization: "fixture-only", httpPort: 33001, httpsPort: 33002 },
    projectKey: "LIM7",
    page: {},
    locale: "en",
    modelId: "fixture-model",
    signal: new globalThis.AbortController().signal,
    chat: { id: "00000000-0000-4000-8000-000000000001" },
    turn: ports.send,
    requireApprovals,
    intent: memoryIntent(join(sessionDir, "limit-run.pending.json")),
  };
  const f = {
    ctx,
    tasks: existingTasks(taskCount, history),
    members: [],
    sprints: [],
    calls: [],
    pages: [],
    moves: 0,
    constraints: [],
  };
  selectionFault(f, fault);
  if (witness) ctx.witness = projectAgileWitness(ctx.session);
  const nativePort = ctx.witness?.decorate(
    () => async (request) =>
      fault === "wire-no-ack"
        ? { kind: "unavailable" }
        : { kind: "response", status: request.fixtureStatus },
  )(undefined, "fixture", {});
  f.native = async (method, path, body, responseStatus) => {
    if (nativePort === undefined) return;
    await nativePort({
      method,
      url: "https://127.0.0.1:33002" + path,
      bodyJson: JSON.stringify(body),
      fixtureStatus: responseStatus,
    });
  };
  ports.read.mockImplementation(async (_session, method, path) => {
    expect(method).toBe("GET");
    const url = new URL(path, "https://jira.example.invalid");
    const target = url.pathname;
    const routes = [
      [
        () => target === "/rest/api/2/project/LIM7",
        () => {
          return ok({
            id: "10",
            key: "LIM7",
            issueTypes: [{ id: "3", name: "Task", subtask: false }],
          });
        },
      ],
      [
        () => target === "/rest/api/2/field",
        () => {
          return ok([
            { id: "customfield_10", schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } },
            { id: "customfield_20", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
          ]);
        },
      ],
      [
        () => target === "/rest/api/2/search",
        () => {
          const values = url.searchParams.get("jql").includes("issuetype = Epic")
            ? [
                {
                  id: "2",
                  key: "LIM7-2",
                  fields: { project: { id: "10", key: "LIM7" }, issuetype: { name: "Epic" } },
                },
              ]
            : f.tasks;
          return ok(page(f, values, url, "issues"));
        },
      ],
      [
        () => target === "/rest/agile/1.0/board",
        () => {
          return ok(
            page(
              f,
              fault === "no-board"
                ? []
                : fault === "multiple-boards"
                  ? [
                      { id: 7, type: "scrum" },
                      { id: 8, type: "scrum" },
                    ]
                  : [{ id: 7, type: "scrum" }],
              url,
              "values",
            ),
          );
        },
      ],
      [
        () => target === "/rest/agile/1.0/board/7/project",
        () => {
          return ok(
            page(
              f,
              [{ id: "10", key: fault === "wrong-board-project" ? "OTHER" : "LIM7" }],
              url,
              "values",
            ),
          );
        },
      ],
      [
        () => target.endsWith("/configuration"),
        () => {
          return ok({
            id: 7,
            type: "scrum",
            columnConfig: { columns: [{ statuses: [{ id: "1" }] }, { statuses: [{ id: "100" }] }] },
          });
        },
      ],
      [
        () => target === "/rest/agile/1.0/board/7/sprint",
        () => {
          return ok(page(f, f.sprints, url, "values"));
        },
      ],
      [
        () => target === "/rest/agile/1.0/sprint/99",
        () => {
          return ok(f.sprints[0]);
        },
      ],
      [
        () => target === "/rest/agile/1.0/sprint/1" || target === "/rest/agile/1.0/sprint/2",
        () => {
          return ok({ id: target.endsWith("1") ? 1 : 2, state: "closed" });
        },
      ],
      [() => target === "/rest/agile/1.0/sprint/100", () => ok({ id: 100, state: "active" })],
      [() => target === "/rest/agile/1.0/sprint/101", () => ok({ id: 101, state: "future" })],
      [
        () => target === "/rest/agile/1.0/sprint/99/issue",
        () => {
          let values = f.members.map((selected) => f.tasks.find((task) => task.key === selected));
          if (fault === "wrong-membership" && values.length >= 200)
            values = [...values.slice(0, -1), { ...values.at(-1), key: "LIM7-999999" }];
          const result = page(f, values, url, "issues");
          if (values.length >= 200 && result.startAt === 50) {
            if (fault === "duplicate-page") result.issues[0] = clone(values[0]);
            if (fault === "missing-page") result.issues = [];
            if (fault === "changed-total") result.total += 1;
          }
          return ok(result);
        },
      ],
      [
        () => target === "/rest/agile/1.0/board/7/backlog",
        () => {
          let values = f.tasks.filter((issue) => issue.fields.status.statusCategory.key !== "done");
          if (fault === "backlog-missing") values = values.slice(1);
          return ok(page(f, values, url, "issues"));
        },
      ],
      [
        () => target.endsWith("/transitions"),
        () => {
          return ok({
            transitions: [{ id: "31", to: { id: "100", statusCategory: { key: "done" } } }],
          });
        },
      ],
    ];
    for (const [matches, reply] of routes) if (matches()) return reply();
    throw new TypeError("Unexpected native oracle path");
  });
  ports.send.mockImplementation(async (chat, prompt, options) => {
    expect(chat).toBe(ctx.chat);
    const review = async (entry) => {
      if (approvals) await options.beforeDecision(entry);
    };
    const operation = options.operations[0];
    expect(ctx.intent.state["ac6-sprint-bulk"].resources.taskRefs).toHaveLength(
      ctx.intent.state["ac6-sprint-bulk"].counts.size,
    );
    expect(ctx.intent.state["ac6-sprint-bulk"].phase).toBe("pending");
    f.calls.push({ operation, prompt });
    let args;
    let receipts;
    let denied = false;
    const actions = {
      "jira.sprint-create": async () => {
        args = { originBoardId: "7", name: JSON.parse(/name ("[^"]+")\./u.exec(prompt)[1]) };
        await review(exchange(operation, args, {}));
        await f.native(
          "POST",
          "/rest/agile/1.0/sprint",
          { name: args.name, originBoardId: 7 },
          201,
        );
        f.sprints.push({ id: 99, name: args.name, originBoardId: 7, state: "future" });
        if (fault === "wire-extra")
          await f.native("DELETE", "/rest/api/2/issue/LIM7-2", undefined, 204);
        receipts = [{ outcome: "succeeded", sprintId: "99" }];
      },
      "jira.sprint-move-issues": async () => {
        const keys = /bounded action: ([^.]+)\./u.exec(prompt)[1].split(", ");
        args = { sprintId: "99", issues: keys };
        const selected = keys.map((selectedKey) =>
          f.tasks.find((task) => task.key === selectedKey),
        );
        await review(exchange(operation, args, {}));
        await f.native("POST", "/rest/agile/1.0/sprint/99/issue", { issues: args.issues }, 204);
        f.moves += 1;
        f.members.push(...args.issues);
        for (const task of selected) task.fields.customfield_20.push({ id: 99 });
        if (fault === "dual-live" && f.members.length >= 200)
          selected[0].fields.customfield_20.push({ id: 100 });
        receipts = [
          {
            outcome: unconfirmed ? "succeeded-unconfirmed" : "succeeded",
            sprintId: "99",
            issueKeys: [...args.issues],
          },
        ];
        if (fault === "wrong-receipt") receipts[0].issueKeys[0] = "LIM7-999999";
      },
      "jira.transition": async () => {
        const selectedKeys = /Done column: ([^.]+)\./u.exec(prompt)[1].split(", ");
        const plans = selectedKeys.map((issueKey) => ({ issueKey, transitionId: "31" }));
        const exchanges = [];
        for (const plan of plans) {
          const entry = exchange(operation, plan, {
            outcome: "succeeded",
            issueKey: plan.issueKey,
          });
          await review(entry);
          await f.native(
            "POST",
            `/rest/api/2/issue/${plan.issueKey}/transitions`,
            { transition: { id: "31" } },
            204,
          );
          f.tasks.find((task) => task.key === plan.issueKey).fields.status = status(
            fault !== "not-done",
          );
          if (approvals) entry.approval.state = "approved";
          else delete entry.approval;
          exchanges.push(entry);
        }
        return { exchanges, decisions: approvals ? plans.length : 0 };
      },
      default: async () => {
        denied = prompt.startsWith("Attempt exactly once");
        if (denied) {
          const state = prompt.includes("to closed") ? "closed" : "active";
          args = { sprintId: "99", state };
          f.constraints.push({
            from: f.sprints[0].state,
            to: state,
            members: f.members.length,
          });
          if (fault === "constraint-dated") {
            args.startDate = "2026-01-01T09:00:00.000Z";
            args.endDate = "2026-01-15T09:00:00.000Z";
          }
          if (fault === "constraint-membership-change") f.members.pop();
          if (fault === "constraint-state-change") f.sprints[0].state = state;
          receipts = [{ outcome: "rejected", reason: "invalid-transition" }];
        } else if (prompt.startsWith("Rename only future sprint")) {
          args = await renameTurn(f, { prompt, operation, review, fault });
          receipts = [{ outcome: "succeeded", sprintId: "99" }];
        } else {
          const starting = prompt.startsWith("Start only future");
          args = { sprintId: "99", state: starting ? "active" : "closed" };
          if (starting) {
            const dates = /starting (\S+) and ending (\S+)\./u.exec(prompt);
            args.startDate = dates[1];
            args.endDate = dates[2];
          }
          await review(exchange(operation, args, {}));
          const { sprintId: _sprintId, ...changes } = args;
          await f.native("POST", "/rest/agile/1.0/sprint/99", changes, 200);
          Object.assign(f.sprints[0], args);
          if (args.state === "closed") f.sprints[0].completeDate = new Date().toISOString();
          receipts = [{ outcome: "succeeded", sprintId: "99" }];
        }
      },
    };
    const action = actions[operation] ?? actions.default;
    const result = await action();
    if (result !== undefined) return result;
    return settledModelTurn(operation, args, receipts, denied, approvals, fault);
  });
  return f;
}

function ok(value) {
  return { status: 200, value: clone(value) };
}
function page(f, values, url, field) {
  const startAt = Number(url.searchParams.get("startAt"));
  expect(url.searchParams.get("maxResults")).toBe("50");
  f.pages.push({ path: url.pathname, startAt });
  return {
    startAt,
    maxResults: 50,
    total: values.length,
    isLast: startAt + 50 >= values.length,
    [field]: clone(values.slice(startAt, startAt + 50)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AC6 normal-UI sprint bulk with independent native proof", () => {
  it.each([200, 225, 300])(
    "selects/moves %i existing Tasks in bounded batches and qualifies exact paged lifecycle",
    async (size) => {
      const f = fixture({ history: true });
      expect(await runSprintBulk(f.ctx, { size, batch: 50 })).toMatchObject({
        step: "ac6-sprint-bulk",
        status: "green",
        detail: "sprint-bulk-confirmed",
        counts: {
          size,
          batch: 50,
          created: 0,
          selected: size,
          moved: size,
          done: 5,
          createBatches: 0,
          moveBatches: Math.ceil(size / 50),
          decisions: 0,
          constraintRefusals: 2,
          membershipPages: Math.ceil(size / 50),
          unconfirmedReceipts: 0,
        },
      });
      expect(f.ctx.intent.state["ac6-sprint-bulk"].counts).not.toHaveProperty("wireWrites");
      expect(f.constraints).toEqual([
        { from: "future", to: "closed", members: size },
        { from: "closed", to: "active", members: size },
      ]);
      expect(f.calls.filter((call) => call.operation === "jira.create-issues")).toHaveLength(0);
      expect(f.calls.filter((call) => call.operation === "jira.create")).toHaveLength(0);
      expect(f.calls.filter((call) => call.operation === "jira.transition")).toHaveLength(1);
      expect(
        f.calls.filter((call) => call.prompt.startsWith("Rename only future sprint")),
      ).toHaveLength(1);
      expect(f.sprints[0].name).toMatch(/^Renamed LIM\d* [0-9a-f]{8}$/u);
      expect(
        f.pages.some(
          (item) => item.path === "/rest/agile/1.0/sprint/99/issue" && item.startAt === 150,
        ),
      ).toBe(true);
      expect(f.ctx.intent.state["ac6-sprint-bulk"].phase).toBe("completed");
      expect(readdirSync(f.ctx.sessionDir)).toEqual([]);
      expect(f.ctx.intent.record).toHaveBeenCalled();
      expect(JSON.stringify(f.ctx.intent.state)).not.toContain("Synthetic sprint acceptance.");
      for (const call of f.calls)
        expect(call.prompt).not.toMatch(/jira\.|confirmUnverifiedEffect|expectedActorKey/u);
    },
  );

  it.each([
    "insufficient",
    "foreign-project",
    "duplicate-key",
    "duplicate-id",
    "done-existing",
    "board-done-existing",
    "active-existing",
    "future-existing",
    "no-epic-existing",
  ])("never writes when an exact eligible set is unavailable: %s", async (fault) => {
    const f = fixture({ fault });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "unverified",
      detail: "sprint-bulk-native-unavailable",
      counts: { created: 0, selected: 0 },
    });
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("selects stable native IDs while excluding Done, live-Sprint and unlinked Tasks", async () => {
    const f = fixture({ taskCount: 305, fault: "mixed-existing" });
    f.tasks.reverse();
    expect(await runSprintBulk(f.ctx, { size: 300, batch: 50 })).toMatchObject({
      status: "green",
      counts: { selected: 300, created: 0 },
    });
    const refs = f.ctx.intent.state["ac6-sprint-bulk"].resources.taskRefs;
    expect(refs[0]).toEqual({ id: "1006", key: "LIM7-1006" });
    expect(refs.at(-1)).toEqual({ id: "1305", key: "LIM7-1305" });
    expect(
      f.members.some((member) => [1001, 1002, 1003, 1004, 1005].map(key).includes(member)),
    ).toBe(false);
  });

  it("uses only its previously bound Task set after a prepared restart", async () => {
    const f = fixture();
    const refs = f.tasks.slice(50, 250).map(({ id, key }) => ({ id, key }));
    await bindPrepared(f, refs);
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({ status: "green" });
    expect(f.ctx.intent.state["ac6-sprint-bulk"].resources.taskRefs).toEqual(refs);
    expect(new Set(f.members)).toEqual(new Set(refs.map((item) => item.key)));
  });

  it("refuses to replace a bound Task that became ineligible even when other Tasks are available", async () => {
    const f = fixture();
    const refs = f.tasks.slice(50, 250).map(({ id, key }) => ({ id, key }));
    await bindPrepared(f, refs);
    f.tasks[50].fields.status = status(true);
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "unverified",
    });
    expect(ports.send).not.toHaveBeenCalled();
    expect(f.ctx.intent.state["ac6-sprint-bulk"].resources.taskRefs).toEqual(refs);
  });

  it("requires all actual approvals when the optional role-control pin is true", async () => {
    const f = fixture({ requireApprovals: true, approvals: false });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({ status: "red" });
  });

  it("retains the role-control approval pin without requiring a transport witness", async () => {
    const f = fixture({ requireApprovals: true, approvals: true });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "green",
      counts: { decisions: 13 },
    });
  });

  it("does not require a second file path for an in-memory orchestrator intent", async () => {
    const f = fixture();
    delete f.ctx.intent.path;
    const result = await runSprintBulk(f.ctx, { size: 200, batch: 50 });
    expect(result).toMatchObject({ status: "green" });
    expect(result).not.toHaveProperty("evidenceFile");
    expect(readdirSync(f.ctx.sessionDir)).toEqual([]);
  });

  it("uses only the orchestrator turn and intent interfaces", () => {
    const source = readFileSync(
      new URL("../testing/jira-chat-lab/browser-sprint-bulk.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("run.ctx.turn(run.ctx.chat, prompt,");
    expect(source).not.toMatch(
      /sendBrowserTurn|resolveLimitBrowser|withEnglishLimitUi|selectAccessMode|privateJson|intent\.steps|jira\.create|issue\/bulk/u,
    );
  });

  it("observes optional wire writes without inventing approvals in Full access", async () => {
    const f = fixture({ witness: true, approvals: false });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "green",
      counts: { wireWrites: 13, decisions: 0 },
    });
  });

  it("arms the existing optional transport witness per turn and reports only observed wire writes", async () => {
    const f = fixture({ witness: true, requireApprovals: true });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "green",
      counts: { wireWrites: 13, decisions: 13 },
    });
    expect(f.ctx.witness.snapshot()).toEqual({
      attempted: 0,
      forwarded: 0,
      statuses: [],
      blocked: 0,
    });
  });

  it.each(["wire-extra", "wire-no-ack"])("refuses transport uncertainty: %s", async (fault) => {
    const f = fixture({ witness: true, fault });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({ status: "red" });
  });

  it("keeps unconfirmed runtime sprint receipts unverified despite exact independent effects", async () => {
    const f = fixture({ unconfirmed: true });
    expect(await runSprintBulk(f.ctx, { size: 300, batch: 50 })).toMatchObject({
      status: "unverified",
      detail: "sprint-bulk-receipt-unconfirmed",
      counts: {
        created: 0,
        selected: 300,
        moved: 300,
        done: 5,
        constraintRefusals: 2,
        membershipPages: 6,
        backlogPages: 6,
        unconfirmedReceipts: 6,
      },
    });
    ports.send.mockClear();
    f.ctx.intent = memoryIntent(f.ctx.intent.path, f.ctx.intent.state);
    expect(await runSprintBulk(f.ctx, { size: 300, batch: 50 })).toMatchObject({
      status: "unverified",
      detail: "sprint-bulk-receipt-unconfirmed",
    });
    expect(ports.send).not.toHaveBeenCalled();
  });

  it("reverifies completed evidence after restart without another UI write", async () => {
    const f = fixture();
    await runSprintBulk(f.ctx, { size: 200, batch: 50 });
    ports.send.mockClear();
    f.ctx.intent = memoryIntent(f.ctx.intent.path, f.ctx.intent.state);
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "green",
      detail: "sprint-bulk-reverified",
    });
    expect(ports.send).not.toHaveBeenCalled();
    f.tasks[0].fields.status = status();
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({ status: "red" });
  });

  it.each([199, 301, 200.5, undefined])(
    "refuses out-of-contract sizes before any port: %s",
    async (size) => {
      const f = fixture();
      await expect(runSprintBulk(f.ctx, { size, batch: 50 })).rejects.toThrow();
      expect(ports.read).not.toHaveBeenCalled();
      expect(ports.send).not.toHaveBeenCalled();
    },
  );

  it.each([1, 49, 51, undefined])("requires the actual bounded batch of 50: %s", async (batch) => {
    const f = fixture();
    await expect(runSprintBulk(f.ctx, { size: 200, batch })).rejects.toThrow();
    expect(ports.send).not.toHaveBeenCalled();
  });

  it.each([
    "constraint-membership-change",
    "constraint-state-change",
    "pending-approval",
    "wrong-receipt",
    "wrong-membership",
    "duplicate-page",
    "missing-page",
    "changed-total",
    "backlog-missing",
    "not-done",
    "dual-live",
    "extra-write",
    "rename-extra-field",
    "rename-not-applied",
  ])("fails closed for %s and never replays a pending run", async (fault) => {
    const f = fixture({ fault });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "red",
      detail: "sprint-bulk-verification-failed",
    });
    const calls = ports.send.mock.calls.length;
    f.ctx.intent = memoryIntent(f.ctx.intent.path, f.ctx.intent.state);
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "unverified",
      detail: "sprint-bulk-pending",
    });
    expect(ports.send).toHaveBeenCalledTimes(calls);
  });

  it("accepts a refused closed-to-active attempt that names the documented dates", async () => {
    const f = fixture({ history: true, fault: "constraint-dated" });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "green",
      counts: { constraintRefusals: 2 },
    });
  });

  it("requires an unambiguous native board unless its own secured intent binds it", async () => {
    const f = fixture({ fault: "multiple-boards" });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
      status: "unverified",
    });
    expect(ports.send).not.toHaveBeenCalled();
    await f.ctx.intent.record("ac6-sprint-bulk", {
      ...f.ctx.intent.state["ac6-sprint-bulk"],
      resources: { boardId: "7" },
    });
    expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({ status: "green" });
  });

  it.each(["no-board", "wrong-board-project"])(
    "reports unavailable native board proof without any setup mutation: %s",
    async (fault) => {
      const f = fixture({ fault });
      expect(await runSprintBulk(f.ctx, { size: 200, batch: 50 })).toMatchObject({
        status: "unverified",
        detail: "sprint-bulk-native-unavailable",
      });
      expect(ports.send).not.toHaveBeenCalled();
    },
  );
});

describe("sprint bulk oracle boundaries", () => {
  it("requires exact native ID/key pairs and rejects duplicated keys", () => {
    const refs = [
      { id: "1", key: "LIM7-1" },
      { id: "2", key: "LIM7-2" },
    ];
    expect(() =>
      exactSprintBulkIssues(
        [
          { id: "2", key: "LIM7-1" },
          { id: "1", key: "LIM7-2" },
        ],
        refs,
      ),
    ).toThrow();
    expect(() => exactSprintBulkIssues([refs[0], refs[0]], refs)).toThrow();
  });

  it("does not treat absent Sprint metadata as proof of no live membership", async () => {
    await expect(
      sprintBulkLiveMembership(vi.fn(), [{ fields: {} }], "customfield_20"),
    ).rejects.toThrow();
  });

  it("rejects extra operations and failed semantic receipts even if an expected success is present", () => {
    const selected = exchange(
      "jira.sprint-update",
      { sprintId: "99", state: "closed" },
      { outcome: "succeeded" },
    );
    const input = { operation: "jira.sprint-update", admit: () => true };
    expect(() =>
      sprintBulkTurn(
        {
          exchanges: [selected, exchange("jira.edit", {}, { outcome: "succeeded" })],
          decisions: 1,
        },
        input,
      ),
    ).toThrow();
    expect(() =>
      sprintBulkTurn(
        { exchanges: [exchange("jira.sprint-update", {}, { outcome: "rejected" })], decisions: 1 },
        input,
      ),
    ).toThrow();
  });

  it("refuses Done tasks still in backlog and missing unfinished tasks", () => {
    const refs = [
      { id: "1", key: "LIM7-1" },
      { id: "2", key: "LIM7-2" },
    ];
    const issues = refs.map((ref, index) => ({ ...ref, fields: { status: status(index === 0) } }));
    expect(() => sprintBulkClosedIssues(issues, refs, ["LIM7-1"], issues)).toThrow();
    expect(() => sprintBulkClosedIssues(issues, refs, ["LIM7-1"], [])).toThrow();
  });
});

/** The rename turn: only the name changes, unless a fault adds a field or loses the effect. */
async function renameTurn(f, { prompt, operation, review, fault }) {
  const name = JSON.parse(/ to ("[^"]+")\. /u.exec(prompt)[1]);
  const args = { sprintId: "99", name };
  if (fault === "rename-extra-field") args.goal = "Unrequested goal";
  await review(exchange(operation, args, {}));
  await f.native("POST", "/rest/agile/1.0/sprint/99", { name }, 200);
  if (fault !== "rename-not-applied") f.sprints[0].name = name;
  return args;
}

function settledModelTurn(operation, args, receipts, denied, approvals, fault) {
  const exchanges = receipts.map((receipt) => exchange(operation, args, receipt, denied));
  for (const entry of exchanges) {
    if (entry.approval !== undefined && approvals) entry.approval.state = "approved";
    if (!approvals) delete entry.approval;
  }
  if (fault === "pending-approval") exchanges[0].approval = { state: "pending" };
  if (fault === "extra-write")
    exchanges.push(exchange("jira.edit", { issueKey: "LIM7-2" }, { outcome: "succeeded" }));
  return { exchanges, decisions: denied || !approvals ? 0 : receipts.length };
}
