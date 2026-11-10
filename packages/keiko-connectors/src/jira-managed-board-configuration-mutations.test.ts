import { expect, it, vi, type Mock } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraAgileRequestPhase, JiraAgileRequests } from "./jira-agile-request.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { executeJiraBoardConfigurationMutation as execute } from "./jira-managed-board-configuration-mutations.js";

const CONTEXT = {
  boardId: "7",
  expectedActorKey: "actor-key",
  expectedBoardName: "Reviewed board",
  expectedBoardType: "scrum",
  expectedFilterId: "37",
};
const CONFIGURATION = {
  id: 7,
  name: "Reviewed board",
  type: "scrum",
  filter: { id: "37" },
  columnConfig: { columns: [{ name: "To do", statuses: [{ id: "1" }] }] },
};
interface BoardMemory {
  enabled: boolean;
  removed: boolean;
}
interface BoardFixture {
  readonly requests: JiraAgileRequests;
  readonly readback: Mock<() => JiraAgileRequestPhase>;
  readonly agile: Mock<JiraMutationRequest>;
  readonly issue: Mock<JiraMutationRequest>;
  readonly state: () => BoardMemory;
}
function boardOutcome(
  memory: BoardMemory,
  method: NonNullable<Parameters<JiraMutationRequest>[1]>,
): AtlassianWriteHttpOutcome | undefined {
  if (method === "DELETE") {
    memory.removed = true;
    return { ok: true, status: 204, body: undefined };
  }
  return method === "GET" ? { ok: false, reason: "not-found" } : undefined;
}
function velocityOutcome(
  memory: BoardMemory,
  method: NonNullable<Parameters<JiraMutationRequest>[1]>,
  body: Parameters<JiraMutationRequest>[2],
): AtlassianWriteHttpOutcome | undefined {
  if (method === "GET") return { ok: true, status: 200, body: { value: memory.enabled } };
  if (
    method === "PUT" &&
    body !== null &&
    typeof body === "object" &&
    "value" in body &&
    typeof body.value === "boolean"
  ) {
    memory.enabled = body.value;
    return { ok: true, status: 201, body: undefined };
  }
  return undefined;
}
function boardRoute(
  memory: BoardMemory,
  path: string,
  method: NonNullable<Parameters<JiraMutationRequest>[1]>,
  body: Parameters<JiraMutationRequest>[2],
): AtlassianWriteHttpOutcome {
  const outcome =
    path === "board/7/configuration" && method === "GET"
      ? ({ ok: true, status: 200, body: CONFIGURATION } as const)
      : path === "board/7"
        ? boardOutcome(memory, method)
        : path === "board/7/settings/refined-velocity"
          ? velocityOutcome(memory, method, body)
          : undefined;
  if (outcome === undefined) throw new TypeError("Unexpected board configuration request");
  return outcome;
}
function fixture(): BoardFixture {
  const memory: BoardMemory = { enabled: false, removed: false };
  const issue = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: { key: "actor-key", name: "native-actor" } });
  const agile = vi.fn<JiraMutationRequest>(
    (path, method = "GET", body) =>
      new Promise((resolve) => {
        resolve(boardRoute(memory, path, method, body));
      }),
  );
  const phase = { agile, issue, signal: new AbortController().signal };
  const readback = vi.fn(() => phase);
  const requests: JiraAgileRequests = { ...phase, readback };
  return {
    requests,
    readback,
    agile,
    issue,
    state: () => ({ enabled: memory.enabled, removed: memory.removed }),
  };
}
it("changes only the native boolean after reviewed configuration and independently confirms the same actor and board", async () => {
  const f = fixture();
  const result = await execute(
    "jira.set-board-refined-velocity",
    { ...CONTEXT, expectedValue: false, value: true },
    f.requests,
  );
  expect(result).toEqual({
    ok: true,
    receipt: {
      boardId: "7",
      filterId: "37",
      userKey: "actor-key",
      refinedVelocityEnabled: true,
    },
  });
  expect(f.agile.mock.calls.map(([path, method]) => [path, method])).toEqual([
    ["board/7/configuration", "GET"],
    ["board/7/settings/refined-velocity", "GET"],
    ["board/7/settings/refined-velocity", "PUT"],
    ["board/7/configuration", "GET"],
    ["board/7/settings/refined-velocity", "GET"],
  ]);
  expect(f.agile).toHaveBeenCalledWith(
    "board/7/settings/refined-velocity",
    "PUT",
    { value: true },
    "none",
  );
  expect(f.issue).toHaveBeenCalledTimes(2);
  expect(f.readback).toHaveBeenCalledOnce();
});
it("preserves false as a real target and reports an observed no-op without dispatch", async () => {
  const f = fixture();
  const result = await execute(
    "jira.set-board-refined-velocity",
    { ...CONTEXT, expectedValue: false, value: false },
    f.requests,
  );
  expect(result).toMatchObject({
    ok: false,
    reason: "conflict",
    detail: { unchanged: true },
    receipt: { refinedVelocityEnabled: false },
  });
  expect(f.agile.mock.calls.every(([, method]) => method === "GET")).toBe(true);
  expect(f.readback).not.toHaveBeenCalled();
});
it.each(["jira.delete-board", "jira.set-board-refined-velocity"] as const)(
  "checks %s without dispatch or readback",
  async (operation) => {
    const f = fixture();
    const args =
      operation === "jira.delete-board"
        ? CONTEXT
        : { ...CONTEXT, expectedValue: false, value: true };
    expect(await execute(operation, args, f.requests, true)).toEqual({ ok: true, receipt: {} });
    expect(f.agile.mock.calls.every(([, method]) => method === "GET")).toBe(true);
    expect(f.readback).not.toHaveBeenCalled();
  },
);
it("keeps deletion unconfirmed despite a selected404 after one acknowledged DELETE", async () => {
  const f = fixture();
  const result = await execute("jira.delete-board", CONTEXT, f.requests);
  expect(f.state().removed).toBe(true);
  expect(result).toMatchObject({
    ok: false,
    reason: "unavailable",
    receipt: {
      boardId: "7",
      filterId: "37",
      userKey: "actor-key",
      boardPresent: false,
    },
  });
  expect(f.agile.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
  expect(f.agile).toHaveBeenLastCalledWith("board/7", "GET", undefined, "json");
});
it.each([
  { expectedBoardName: "Another board" },
  { expectedBoardType: "kanban" },
  { expectedFilterId: "38" },
  { expectedActorKey: "another-actor" },
] satisfies readonly CatalogJsonObject[])(
  "refuses changed board/actor context before a write: %j",
  async (changed) => {
    const f = fixture();
    expect(
      await execute("jira.delete-board", { ...CONTEXT, ...changed }, f.requests),
    ).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.agile.mock.calls.every(([, method]) => method === "GET")).toBe(true);
  },
);
it.each([
  { boardId: 7 },
  { boardId: "07" },
  { boardId: "9007199254740992" },
  { expectedFilterId: 37 },
  { url: "https://untrusted.invalid" },
  { settingKey: "any" },
  { expectedActorKey: "" },
] satisfies readonly CatalogJsonObject[])(
  "rejects invalid target fields before any HTTP request: %j",
  async (changed) => {
    const f = fixture();
    expect(
      await execute("jira.delete-board", { ...CONTEXT, ...changed }, f.requests),
    ).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.agile).not.toHaveBeenCalled();
    expect(f.issue).not.toHaveBeenCalled();
  },
);
it("refuses a stale boolean before PUT and preserves its exact known board after denied readback", async () => {
  const f = fixture();
  expect(
    (
      await execute(
        "jira.set-board-refined-velocity",
        { ...CONTEXT, expectedValue: true, value: false },
        f.requests,
      )
    ).ok,
  ).toBe(false);
  expect(f.agile.mock.calls.every(([, method]) => method === "GET")).toBe(true);
  const denied = vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: false, reason: "permission-denied" });
  f.readback.mockReturnValue({ agile: denied, issue: f.issue, signal: f.requests.signal });
  const result = await execute(
    "jira.set-board-refined-velocity",
    { ...CONTEXT, expectedValue: false, value: true },
    f.requests,
  );
  expect(result).toMatchObject({
    ok: false,
    reason: "permission-denied",
    receipt: {
      boardId: "7",
      filterId: "37",
      userKey: "actor-key",
      refinedVelocityEnabled: true,
    },
  });
  expect(f.agile.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
});
it("stops after a lost native acknowledgement instead of rereading or repeating DELETE", async () => {
  const f = fixture();
  const original = f.agile.getMockImplementation();
  if (original === undefined) throw new TypeError("Expected native board fixture");
  f.agile.mockImplementation(async (...args) =>
    args[1] === "DELETE" ? { ok: false, reason: "timeout" } : original(...args),
  );
  expect(await execute("jira.delete-board", CONTEXT, f.requests)).toMatchObject({
    ok: false,
    reason: "timeout",
    receipt: { boardId: "7", boardPresent: false },
  });
  expect(f.readback).not.toHaveBeenCalled();
  expect(f.agile.mock.calls.filter(([, method]) => method === "DELETE")).toHaveLength(1);
});
it("keeps acknowledged-state wording when native board configuration changes before readback", async () => {
  const f = fixture();
  const changed = vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: true,
    status: 200,
    body: { ...CONFIGURATION, name: "Changed after ACK" },
  });
  f.readback.mockReturnValue({ agile: changed, issue: f.issue, signal: f.requests.signal });
  const result = await execute(
    "jira.set-board-refined-velocity",
    { ...CONTEXT, expectedValue: false, value: true },
    f.requests,
  );
  expect(result).toMatchObject({
    ok: false,
    reason: "conflict",
    receipt: { boardId: "7", refinedVelocityEnabled: true },
  });
  expect(JSON.stringify(result)).toContain("acknowledged");
  expect(JSON.stringify(result)).not.toContain("Nothing was written");
  expect(f.agile.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
});
