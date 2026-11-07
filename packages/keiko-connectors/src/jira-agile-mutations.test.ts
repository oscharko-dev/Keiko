import { describe, expect, it, vi } from "vitest";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
// Exercise the production managed router as well as the native adapter.
import { executeJiraManagedMutation } from "./jira-managed-mutations.js";

interface Fixture {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly context: Parameters<typeof executeJiraManagedMutation>[2];
  readonly connection: Parameters<typeof executeJiraManagedMutation>[3];
  readonly run: (
    name: Parameters<typeof executeJiraManagedMutation>[0],
    args: Parameters<typeof executeJiraManagedMutation>[1],
  ) => ReturnType<typeof executeJiraManagedMutation>;
}
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
    const f = fixture([response(201, SPRINT), response(200, SPRINT)]);
    expect(await f.run("jira.sprint-create", { name: "Sprint one", originBoardId: "7" })).toEqual({
      ok: true,
      receipt: { sprintId: "9" },
    });
    expect(f.http.mock.calls.map(([r]) => [r.method, new URL(r.url).pathname])).toEqual([
      ["POST", "/context/rest/agile/1.0/sprint"],
      ["GET", "/context/rest/agile/1.0/sprint/9"],
    ]);
    expect(JSON.parse(f.http.mock.calls[0]?.[0].bodyJson ?? "null")).toEqual({
      name: "Sprint one",
      originBoardId: 7,
    });
  });
  it("retains the acknowledged sprint receipt when readback conflicts", async () => {
    const f = fixture([response(201, SPRINT), response(200, { ...SPRINT, name: "Other" })]);
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
      response(201, board),
      response(200, { ...board, filter: { id: "42" }, columnConfig: { columns: [] } }),
    ]);
    expect(
      await f.run("jira.board-create", { name: "Team", type: "scrum", filterId: "42" }),
    ).toEqual({ ok: true, receipt: { boardId: "7" } });
    expect(f.http.mock.calls[1]?.[0].url).toContain("/board/7/configuration");
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
    const f = fixture([{ kind: "timeout" }]);
    expect(
      await f.run("jira.sprint-create", { name: "Sprint one", originBoardId: "7" }),
    ).toMatchObject({ ok: false });
    expect(f.http).toHaveBeenCalledTimes(1);
  });
});
