import { describe, expect, it, vi } from "vitest";
import { projectAgileArguments } from "../testing/jira-chat-lab/browser-project-agile.mjs";
import { nativePages, oneNewProject, unchangedProjects, exactIssue, epicRelation,
  exactSprint, exactMembership, completedOperation, permissionRefusal, projectAgileWitness,
  oneObservedEffect } from "../testing/jira-chat-lab/project-agile-oracles.mjs";

const PROJECT = { id: "10000", key: "ZQ1234ABCD", name: "Synthetic project" };
const ISSUE = { id: "10001", key: "ZQ1234ABCD-1", fields: {
  project: { key: PROJECT.key }, summary: "Synthetic requirement", description: "Readable requirement.",
  issuetype: { id: "10004", name: "Epic" },
} };
const SPRINT = { id: 7, originBoardId: 8, name: "Synthetic sprint", state: "future" };
const RESPONSE = { kind: "response", status: 201, bodyText: "{}", bodyBytes: 2, truncated: false };
const TARGET = { method: "POST", path: "/rest/api/2/project", admit: (body) => body?.key === PROJECT.key };
const REQUEST = { method: "POST", url: "https://127.0.0.1:18443/rest/api/2/project", bodyJson: JSON.stringify({ key: PROJECT.key }) };
const operation = (name, data) => ({ call: { name }, result: { status: "completed", data } });

describe("AC5/AC6 independent live-browser oracles", () => {
  it("accepts only explicit distinct private PAT files and the separate read-only reconciliation shape", () => {
    expect(projectAgileArguments(["/private/session", "gemma-4-31b-it", "/private/permitted", "/private/denied"]))
      .toMatchObject({ reconcile: false, modelId: "gemma-4-31b-it" });
    expect(projectAgileArguments(["/private/session", "--reconcile", "/private/permitted"]))
      .toEqual({ directory: "/private/session", reconcile: true, permittedToken: "/private/permitted" });
  });
  it.each([
    ["relative", "model", "/a", "/b"], ["/s", "model", "relative", "/b"],
    ["/s", "model", "/a", "/a"], ["/s", "model", "/a", "/b", "--reset"],
    ["/s", "model\nsecret", "/a", "/b"], ["/s", "--reconcile"],
    ["/s", "--reconcile", "/a", "/b"],
  ].map((args) => ({ args })))("refuses ambiguous or unsafe CLI input %#", ({ args }) => {
    expect(() => projectAgileArguments(args)).toThrow();
  });

  it("credits one independently observed new project only, never an existing or foreign project", () => {
    expect(oneNewProject([], [PROJECT], PROJECT)).toEqual(PROJECT);
    expect(() => oneNewProject([PROJECT], [PROJECT], PROJECT)).toThrow();
    expect(() => oneNewProject([], [PROJECT, { ...PROJECT, id: "10002" }], PROJECT)).toThrow();
    expect(() => oneNewProject([], [{ ...PROJECT, key: "OTHER" }], PROJECT)).toThrow();
    expect(() => unchangedProjects([], [PROJECT])).toThrow();
    expect(() => unchangedProjects([PROJECT], [PROJECT])).not.toThrow();
  });

  it("follows native cursors and retains an explicit empty terminal collection", async () => {
    const read = vi.fn().mockResolvedValueOnce({ startAt: 0, total: 2, issues: [{ id: "1" }] })
      .mockResolvedValueOnce({ startAt: 1, total: 2, issues: [{ id: "2" }] });
    await expect(nativePages(read, "/rest/api/2/search?jql=x", "issues")).resolves.toEqual([{ id: "1" }, { id: "2" }]);
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      "/rest/api/2/search?jql=x&startAt=0&maxResults=50", "/rest/api/2/search?jql=x&startAt=1&maxResults=50",
    ]);
    await expect(nativePages(async () => ({ startAt: 0, values: [], isLast: true }), "/board", "values")).resolves.toEqual([]);
  });
  it.each([
    [{ startAt: 0, total: 1, issues: [] }],
    [{ startAt: 4, total: 1, issues: [{ id: "1" }] }],
    [{ startAt: 0, total: 2, issues: [{ id: "1" }] }, { startAt: 1, total: 2, issues: [{ id: "1" }] }],
    [{ startAt: 0, total: 2, issues: [{ id: "1" }] }, { startAt: 1, total: 3, issues: [{ id: "2" }] }],
    [{ startAt: 0, total: 1, issues: [{ id: 9007199254740992 }] }],
    [{ startAt: 0, total: 1 }],
    [{ startAt: 0, total: 2, isLast: true, issues: [{ id: "1" }] }],
    [{ startAt: 0, total: 1, isLast: false, issues: [{ id: "1" }] }],
  ].map((pages) => ({ pages })))("refuses partial, duplicated, changed or imprecise native pages %#", async ({ pages }) => {
    let index = 0;
    await expect(nativePages(async () => pages[index++], "/search", "issues")).rejects.toThrow();
  });

  it("requires the exact native project, issue type, description and intended Epic relation", () => {
    const expected = { projectKey: PROJECT.key, issueType: "Epic", summary: ISSUE.fields.summary };
    expect(exactIssue(ISSUE, expected)).toMatchObject({ key: ISSUE.key, typeId: "10004" });
    expect(() => exactIssue({ ...ISSUE, fields: { ...ISSUE.fields, issuetype: { id: "1", name: "Task" } } }, expected)).toThrow();
    expect(() => exactIssue({ ...ISSUE, fields: { ...ISSUE.fields, description: null } }, expected)).toThrow();
    const fields = [{ id: "customfield_10000", schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } }];
    const epic = { id: "10001", key: ISSUE.key };
    expect(() => epicRelation({ fields: { customfield_10000: epic.key } }, epic, fields)).not.toThrow();
    expect(() => epicRelation({ fields: { customfield_10000: "ZQ1234ABCD-9" } }, epic, fields)).toThrow();
    expect(() => epicRelation({ fields: { parent: { key: epic.key } } }, epic, [])).not.toThrow();
    expect(() => epicRelation({ fields: {} }, epic, fields)).toThrow();
  });

  it("checks real sprint parent/state/dates and exact membership, including unwanted extra issues", () => {
    const expected = { id: "7", boardId: "8", name: SPRINT.name, state: "future" };
    expect(() => exactSprint(SPRINT, expected)).not.toThrow();
    expect(() => exactSprint({ ...SPRINT, originBoardId: 9 }, expected)).toThrow();
    expect(() => exactSprint({ ...SPRINT, state: "closed" }, { ...expected, state: "closed" })).toThrow();
    expect(() => exactMembership([{ key: ISSUE.key }], [ISSUE.key])).not.toThrow();
    expect(() => exactMembership([{ key: ISSUE.key }, { key: "OTHER-1" }], [ISSUE.key])).toThrow();
  });

  it("does not credit model prose, unrelated permission failures, unknown writes or duplicate calls", () => {
    expect(() => permissionRefusal({ answer: "Permission denied", exchanges: [] })).toThrow();
    expect(() => permissionRefusal({ answer: "Permission denied", exchanges: [operation("jira_projects", { reason: "permission-denied" })] })).toThrow();
    expect(() => permissionRefusal({ answer: "Ask a Jira administrator", exchanges: [operation("jira_create_project", { outcome: "rejected", reason: "permission-denied" })] })).not.toThrow();
    const success = operation("jira_board_create", { outcome: "succeeded", boardId: "8" });
    expect(completedOperation({ exchanges: [success] }, "jira.board-create").boardId).toBe("8");
    expect(() => completedOperation({ exchanges: [success, success] }, "jira.board-create")).toThrow();
    expect(() => completedOperation({ exchanges: [operation("jira_board_create", { outcome: "unknown" })] }, "jira.board-create")).toThrow();
  });
});

describe("AC5/AC6 pass-through native write witness", () => {
  it("preserves the real port/ACK and blocks a second mutation before forwarding", async () => {
    const witness = projectAgileWitness();
    witness.arm(TARGET);
    const native = vi.fn(async () => RESPONSE);
    const factory = vi.fn(() => native);
    const lifecycle = { beforeDispatch: vi.fn() };
    const port = witness.decorate(factory)({}, "correlation", lifecycle);
    expect(await port(REQUEST)).toBe(RESPONSE);
    expect(factory).toHaveBeenCalledWith({}, "correlation", lifecycle);
    expect(() => oneObservedEffect(witness.snapshot())).not.toThrow();
    await expect(port(REQUEST)).rejects.toThrow();
    expect(native).toHaveBeenCalledOnce();
    expect(() => oneObservedEffect(witness.snapshot())).toThrow();
  });
  it.each([
    { ...REQUEST, method: "DELETE" }, { ...REQUEST, url: "https://127.0.0.1:18443/rest/api/2/project/OTHER" },
    { ...REQUEST, bodyJson: JSON.stringify({ key: "OTHER" }) },
    { ...REQUEST, url: `${REQUEST.url}?unexpected=true` },
    { ...REQUEST, url: "https://elsewhere.invalid/rest/api/2/project" },
  ])("blocks unrelated native writes without manufacturing success %#", async (request) => {
    const witness = projectAgileWitness(); witness.arm(TARGET);
    const native = vi.fn();
    await expect(witness.decorate(() => native)({}, "id")(request)).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();
  });
  it("allows ordinary reads but cannot turn a native refusal or lost response into a successful effect", async () => {
    const witness = projectAgileWitness(); witness.arm(TARGET);
    const native = vi.fn(async () => ({ ...RESPONSE, status: 403 }));
    const port = witness.decorate(() => native)({}, "id");
    await port({ method: "GET", url: "https://127.0.0.1:18443/rest/api/2/myself" });
    expect(witness.snapshot().attempted).toBe(0);
    await port(REQUEST);
    expect(witness.snapshot().statuses).toEqual([403]);
    expect(() => oneObservedEffect(witness.snapshot())).toThrow();
    witness.arm(TARGET);
    await witness.decorate(() => async () => ({ kind: "network-error" }))({}, "id")(REQUEST);
    expect(() => oneObservedEffect(witness.snapshot())).toThrow();
  });
});
