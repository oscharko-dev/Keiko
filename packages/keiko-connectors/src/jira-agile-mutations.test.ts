import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
// Exercise the production managed router as well as the native adapter.
import { checkJiraManagedMutation, executeJiraManagedMutation } from "./jira-managed-mutations.js";

interface Fixture {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly context: Parameters<typeof executeJiraManagedMutation>[2];
  readonly connection: Parameters<typeof executeJiraManagedMutation>[3];
  readonly run: (
    name: Parameters<typeof executeJiraManagedMutation>[0],
    args: Parameters<typeof executeJiraManagedMutation>[1],
  ) => ReturnType<typeof executeJiraManagedMutation>;
}
afterEach(() => vi.restoreAllMocks());
const BOARD = { id: 7, name: "Team", type: "scrum" };
const SPRINT = { id: 9, name: "Sprint one", state: "future", originBoardId: 7 };
const EPIC = { id: 11, key: "APP-11", name: "Delivery", summary: "Delivery epic", done: false };
function response(status: number, body?: unknown): AtlassianHttpBodyResult {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  };
}
function fixture(replies: readonly AtlassianHttpBodyResult[]): Fixture {
  let index = 0;
  const http = vi.fn<AtlassianHttpBodyPort>(() =>
    Promise.resolve(replies[index++] ?? { kind: "network-error" }),
  );
  const context = {
    invocationId: "agile-write",
    correlationId: "agile-proof",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
  };
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    http,
  };
  return {
    http,
    context,
    connection,
    run: (
      name: Parameters<typeof executeJiraManagedMutation>[0],
      args: Parameters<typeof executeJiraManagedMutation>[1],
    ): ReturnType<typeof executeJiraManagedMutation> =>
      executeJiraManagedMutation(name, args, context, connection),
  };
}

describe("native Agile writes and authoritative readback", () => {
  it("creates a sprint once and confirms its fields on the returned resource", async () => {
    const f = fixture([response(200, BOARD), response(201, SPRINT), response(200, SPRINT)]);
    expect(await f.run("jira.sprint-create", { name: "Sprint one", originBoardId: "7" })).toEqual({
      ok: true,
      receipt: { sprintId: "9" },
    });
    expect(f.http.mock.calls.map(([r]) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/context/rest/agile/1.0/board/7"],
      ["POST", "/context/rest/agile/1.0/sprint"],
      ["GET", "/context/rest/agile/1.0/sprint/9"],
    ]);
    expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
      name: "Sprint one",
      originBoardId: 7,
    });
  });
  it("retains the acknowledged sprint receipt when readback conflicts", async () => {
    const f = fixture([
      response(200, BOARD),
      response(201, SPRINT),
      response(200, { ...SPRINT, name: "Other" }),
    ]);
    expect(await f.run("jira.sprint-create", { name: "Sprint one", originBoardId: "7" })).toEqual({
      ok: false,
      reason: "conflict",
      receipt: { sprintId: "9" },
    });
    expect(f.http.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
  });
  it("partially updates a sprint without clearing omitted fields", async () => {
    const changed = { ...SPRINT, goal: "A clear goal" };
    const f = fixture([response(200, SPRINT), response(200, changed), response(200, changed)]);
    expect(await f.run("jira.sprint-update", { sprintId: "9", goal: "A clear goal" })).toEqual({
      ok: true,
      receipt: { sprintId: "9" },
    });
    expect(f.http.mock.calls[1]?.[0].method).toBe("POST");
    expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
      goal: "A clear goal",
    });
  });
  it("starts a future sprint only when its dates are present", async () => {
    const f = fixture([response(200, SPRINT)]);
    expect(await f.run("jira.sprint-update", { sprintId: "9", state: "active" })).toMatchObject({
      ok: false,
      reason: "invalid-transition",
    });
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it("does not reopen or edit a closed sprint", async () => {
    const f = fixture([response(200, { ...SPRINT, state: "closed" })]);
    expect(await f.run("jira.sprint-update", { sprintId: "9", goal: "Changed" })).toMatchObject({
      ok: false,
      reason: "invalid-transition",
    });
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it("creates a board and verifies its configured filter", async () => {
    const board = { id: 7, name: "Team", type: "scrum" };
    const f = fixture([
      response(200, { id: "42" }),
      response(201, board),
      response(200, { ...board, filter: { id: "42" }, columnConfig: { columns: [] } }),
    ]);
    expect(
      await f.run("jira.board-create", { name: "Team", type: "scrum", filterId: "42" }),
    ).toEqual({ ok: true, receipt: { boardId: "7" } });
    expect(f.http.mock.calls[2]?.[0].url).toContain("/board/7/configuration");
  });
  it("updates an epic and verifies the same key", async () => {
    const changed = { ...EPIC, done: true, color: { key: "color_2" } };
    const f = fixture([response(200, EPIC), response(200, changed), response(200, changed)]);
    expect(
      await f.run("jira.epic-update", { epicIdOrKey: "APP-11", done: true, color: "color_2" }),
    ).toEqual({ ok: true, receipt: { epicKey: "APP-11" } });
    expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
      done: true,
      color: { key: "color_2" },
    });
  });
  it("moves sprint membership once, then reads each exact issue", async () => {
    const f = fixture([
      response(200, SPRINT),
      response(204),
      response(200, { id: "12", key: "APP-12", fields: { sprint: { id: 9, state: "future" } } }),
    ]);
    expect(await f.run("jira.sprint-move-issues", { sprintId: "9", issues: ["APP-12"] })).toEqual({
      ok: true,
      receipt: { sprintId: "9", issueKeys: ["APP-12"] },
    });
    expect(f.http.mock.calls[2]?.[0].url).toContain("/issue/APP-12?fields=sprint");
  });
  it("never calls a missing sprint field proof of removal to the backlog", async () => {
    const f = fixture([response(204), response(200, { id: "12", key: "APP-12", fields: {} })]);
    expect(await f.run("jira.backlog-move-issues", { issues: ["APP-12"] })).toEqual({
      ok: false,
      reason: "malformed-payload",
      receipt: { issueKeys: ["APP-12"] },
    });
  });
  it("confirms epic membership with the resolved epic identity", async () => {
    const f = fixture([
      response(200, EPIC),
      response(204),
      response(200, { id: "12", key: "APP-12", fields: { epic: { id: 11, key: "APP-11" } } }),
    ]);
    expect(await f.run("jira.epic-move-issues", { epicIdOrKey: "11", issues: ["APP-12"] })).toEqual(
      { ok: true, receipt: { epicKey: "APP-11", issueKeys: ["APP-12"] } },
    );
  });
  it.each([
    ["jira.sprint-create", { name: "Sprint", originBoardId: "9007199254740992" }],
    ["jira.sprint-update", { sprintId: "9", completeDate: "2026-11-07T10:00:00Z" }],
    ["jira.sprint-move-issues", { sprintId: "9", issues: ["APP-1", "APP-1"] }],
    ["jira.backlog-move-issues", { issues: [] }],
    ["jira.epic-update", { epicIdOrKey: "../board", done: true }],
  ] as const)("refuses invalid arguments for %s before transport", async (name, args) => {
    const f = fixture([]);
    expect(await f.run(name, args)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("does not retry an ambiguous sprint create", async () => {
    const f = fixture([response(200, BOARD), { kind: "timeout" }]);
    expect(
      await f.run("jira.sprint-create", { name: "Sprint one", originBoardId: "7" }),
    ).toMatchObject({ ok: false });
    expect(f.http).toHaveBeenCalledTimes(2);
  });
});

describe("Agile create prerequisites and confirmed identities", () => {
  it.each([
    [
      "jira.board-create",
      { name: "Team", type: "scrum", filterId: "42" },
      response(404),
      "not-found",
    ],
    [
      "jira.board-create",
      { name: "Team", type: "scrum", filterId: "42" },
      response(403),
      "permission-denied",
    ],
    ["jira.sprint-create", { name: "Sprint one", originBoardId: "7" }, response(404), "not-found"],
    [
      "jira.sprint-create",
      { name: "Sprint one", originBoardId: "7" },
      response(200, { ...BOARD, type: "kanban" }),
      "field-validation",
    ],
  ] as const)(
    "refuses inaccessible or incompatible %s prerequisites before approval and effects",
    async (operation, args, reply, reason) => {
      const f = fixture([reply]);
      expect(
        await checkJiraManagedMutation(operation, args, f.context, f.connection),
      ).toMatchObject({ ok: false, reason });
      expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
      const execution = fixture([reply]);
      expect(await execution.run(operation, args)).toMatchObject({ ok: false, reason });
      expect(execution.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
    },
  );
  it.each([null, undefined])("confirms a cleared goal represented as %s", async (goal) => {
    const f = fixture([
      response(200, { ...SPRINT, goal: "Before" }),
      response(200, SPRINT),
      response(200, { ...SPRINT, goal }),
    ]);
    expect(await f.run("jira.sprint-update", { sprintId: "9", goal: "" })).toEqual({
      ok: true,
      receipt: { sprintId: "9" },
    });
  });
  it.each([
    [
      "jira.board-create",
      { name: "Team", type: "scrum", filterId: "42" },
      { id: "42" },
      BOARD,
      { boardId: "7" },
    ],
    [
      "jira.sprint-create",
      { name: "Sprint one", originBoardId: "7" },
      BOARD,
      SPRINT,
      { sprintId: "9" },
    ],
  ] as const)(
    "retains a valid identity from an unexpected create status for %s",
    async (operation, args, prerequisite, created, receipt) => {
      const f = fixture([response(200, prerequisite), response(202, created), response(403, {})]);
      expect(await f.run(operation, args)).toEqual({
        ok: false,
        reason: "permission-denied",
        receipt,
      });
      expect(f.http.mock.calls.at(-1)?.[0].method).toBe("GET");
      expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
    },
  );
  it.each([
    [
      "jira.board-create",
      { name: "Team", type: "scrum", filterId: "42" },
      { id: "42" },
      { ...BOARD, filter: { id: "42" }, columnConfig: { columns: [] } },
      { boardId: "7" },
    ],
    [
      "jira.sprint-create",
      { name: "Sprint one", originBoardId: "7" },
      BOARD,
      SPRINT,
      { sprintId: "9" },
    ],
  ] as const)(
    "independently confirms a readable 200 creation for %s",
    async (operation, args, prerequisite, observed, receipt) => {
      const f = fixture([
        response(200, prerequisite),
        response(200, { id: observed.id }),
        response(200, observed),
      ]);
      expect(await f.run(operation, args)).toEqual({ ok: true, receipt });
      expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST", "GET"]);
    },
  );
  it("keeps a sprint without independent originBoardId evidence unconfirmed", async () => {
    const f = fixture([
      response(200, BOARD),
      response(201, SPRINT),
      response(200, { id: 9, name: "Sprint one", state: "future" }),
    ]);
    expect(await f.run("jira.sprint-create", { name: "Sprint one", originBoardId: "7" })).toEqual({
      ok: false,
      reason: "conflict",
      receipt: { sprintId: "9" },
    });
  });
  it("starts a fresh bounded readback after the pre-effect phase expires", async () => {
    const phases: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      phases.push(controller);
      return controller.signal;
    });
    const f = fixture([]);
    f.http.mockImplementation((request) => {
      if (request.method === "POST") {
        phases[0]?.abort();
        return Promise.resolve(response(204));
      }
      return Promise.resolve(response(200, { id: "12", key: "APP-12", fields: { sprint: null } }));
    });
    expect(await f.run("jira.backlog-move-issues", { issues: ["APP-12"] })).toEqual({
      ok: true,
      receipt: { issueKeys: ["APP-12"] },
    });
    expect(phases).toHaveLength(2);
    expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  });
  it("preserves the acknowledged receipt when the readback budget expires", async () => {
    let count = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      if (++count === 2) controller.abort();
      return controller.signal;
    });
    const f = fixture([response(204)]);
    expect(await f.run("jira.backlog-move-issues", { issues: ["APP-12"] })).toEqual({
      ok: false,
      reason: "timeout",
      receipt: { issueKeys: ["APP-12"] },
    });
    expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["POST"]);
  });
});

it("bounds concurrent membership evidence reads without repeating the native batch", async () => {
  const f = fixture([]);
  let active = 0;
  let peak = 0;
  const keys = Array.from({ length: 9 }, (_, index) => `APP-${String(index + 1)}`);
  f.http.mockImplementation(async (request) => {
    if (request.method === "POST") return response(204);
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return response(200, {
      id: "12",
      key: new URL(request.url).pathname.split("/").at(-1),
      fields: { sprint: null },
    });
  });
  expect(await f.run("jira.backlog-move-issues", { issues: keys })).toEqual({
    ok: true,
    receipt: { issueKeys: keys },
  });
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(f.http.mock.calls.filter(([request]) => request.method === "POST")).toHaveLength(1);
  expect(f.http.mock.calls.filter(([request]) => request.method === "GET")).toHaveLength(
    keys.length,
  );
});
