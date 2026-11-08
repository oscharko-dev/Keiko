import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraAgilePlanningPorts } from "../../packages/keiko-connectors/src/jira-managed-agile-planning.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

const ACTOR = "synthetic-actor";
const BOARD = { expectedActorKey: ACTOR, boardId: "7", expectedBoardName: "Synthetic board" };
const RANK = {
  ...BOARD,
  rankCustomFieldId: "10019",
  direction: "before",
  expectedAnchorRank: "0|anchor:",
} as const;
export const AGILE_PLANNING_FIXTURE_CASES = [
  {
    name: "jira.epic-remove-issues",
    method: "POST",
    path: "epic/none/issue",
    args: {
      expectedActorKey: ACTOR,
      issues: [{ issueIdOrKey: "SYN-1", expectedEpic: { id: "10003", key: "SYN-3" } }],
    },
    receipt: { userKey: ACTOR, issueIds: ["10001"], issueKeys: ["SYN-1"], epicPresent: false },
  },
  {
    name: "jira.rank-epic",
    method: "PUT",
    path: "epic/10001/rank",
    args: {
      ...RANK,
      epicIdOrKey: "SYN-1",
      expectedRank: "0|first:",
      anchorEpicIdOrKey: "SYN-2",
    },
    receipt: {
      userKey: ACTOR,
      boardId: "7",
      fieldId: "customfield_10019",
      issueIds: ["10001"],
      issueKeys: ["SYN-1"],
      anchorIssueId: "10002",
      anchorIssueKey: "SYN-2",
      rankDirection: "before",
    },
  },
  {
    name: "jira.rank-issues",
    method: "PUT",
    path: "issue/rank",
    args: {
      ...RANK,
      issues: [{ issueIdOrKey: "SYN-1", expectedRank: "0|first:" }],
      anchorIssueIdOrKey: "SYN-2",
    },
    receipt: {
      userKey: ACTOR,
      boardId: "7",
      fieldId: "customfield_10019",
      issueIds: ["10001"],
      issueKeys: ["SYN-1"],
      anchorIssueId: "10002",
      anchorIssueKey: "SYN-2",
      rankDirection: "before",
    },
  },
  {
    name: "jira.set-issue-estimation",
    method: "PUT",
    path: "issue/10001/estimation?boardId=7",
    args: {
      ...BOARD,
      issueIdOrKey: "SYN-1",
      fieldId: "customfield_10016",
      expectedValue: 3,
      unit: "board-number",
      value: "5",
    },
    receipt: {
      userKey: ACTOR,
      boardId: "7",
      fieldId: "customfield_10016",
      issueId: "10001",
      issueKey: "SYN-1",
      estimationValue: 5,
      estimationUnit: "board-number",
    },
  },
] as const;

export function agilePlanningFixture() {
  const actor = { key: ACTOR, name: "synthetic-user", active: true };
  const board: Record<string, unknown> = {
    id: 7,
    name: "Synthetic board",
    ranking: { rankCustomFieldId: 10019 },
    estimation: {
      type: "field",
      field: { fieldId: "customfield_10016", displayName: "Synthetic estimate" },
    },
  };
  const catalog: Record<string, unknown>[] = [
    {
      id: "customfield_10014",
      name: "Epic Link",
      schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
    },
    {
      id: "customfield_10019",
      name: "Rank",
      schema: { custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" },
    },
    {
      id: "customfield_10016",
      name: "Synthetic estimate",
      schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" },
    },
    {
      id: "timeoriginalestimate",
      name: "Original Estimate",
      schema: { type: "number", system: "timeoriginalestimate" },
    },
  ];
  const fields = (rank: string): Record<string, unknown> => ({
    summary: "Synthetic issue",
    description: null,
    labels: [],
    project: { id: "10000", key: "SYN" },
    issuetype: { id: "10001", name: "Story" },
    customfield_10014: "SYN-3",
    customfield_10019: rank,
    customfield_10016: 3,
    timeoriginalestimate: 60,
    timetracking: { originalEstimateSeconds: 60, remainingEstimateSeconds: 60 },
    timeestimate: 60,
    parent: null,
  });
  const issues = new Map([
    ["10001", { id: "10001", key: "SYN-1", fields: fields("0|first:") }],
    ["10002", { id: "10002", key: "SYN-2", fields: fields("0|anchor:") }],
    ["10003", { id: "10003", key: "SYN-3", fields: fields("0|epic:") }],
  ]);
  const controls = {
    lostAck: false,
    denyReadback: false,
    throwReadback: false,
    partialRank: false,
    omitEpic: false,
    omitEstimate: false,
    partialBoard: false,
    cancelledReadback: false,
  };
  const calls: {
    readonly root: "agile" | "issue";
    readonly path: string;
    readonly method: string;
    readonly body: unknown;
    readonly expect: unknown;
  }[] = [];
  const controller = new AbortController();
  let readback = false;
  const ok = (body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome => ({
    ok: true,
    status: 200,
    body,
  });
  function issueAt(selector: string) {
    return (
      issues.get(selector) ??
      [...issues.values()].find(({ key }) => key.toLowerCase() === selector.toLowerCase())
    );
  }
  function platformRead(path: string): AtlassianWriteHttpOutcome {
    if (path === "myself") return ok(actor);
    if (path === "field") return { ok: true, status: 200, body: undefined, items: catalog };
    const selected = /^issue\/([^?]+)\?/u.exec(path)?.[1];
    const issue = selected === undefined ? undefined : issueAt(decodeURIComponent(selected));
    return issue === undefined
      ? { ok: false, reason: "not-found", httpStatus: 404 }
      : ok({ id: issue.id, key: issue.key, fields: { ...issue.fields } });
  }
  function agileRead(path: string): AtlassianWriteHttpOutcome {
    if (path === "board/7/configuration") return ok(board);
    if (path.startsWith("board/7/issue?"))
      return ok({
        startAt: 0,
        maxResults: 100,
        total: controls.partialBoard ? 1 : 2,
        issues: [...issues.values()]
          .slice(0, controls.partialBoard ? 1 : 2)
          .map(({ id, key }) => ({ id, key })),
      });
    const epic = /^epic\/(\d+)$/u.exec(path)?.[1];
    if (epic !== undefined) {
      const issue = issues.get(epic);
      return issue === undefined
        ? { ok: false, reason: "not-found", httpStatus: 404 }
        : ok({
            id: Number(issue.id),
            key: issue.key,
            name: "Synthetic epic",
            summary: "Synthetic epic",
            done: false,
          });
    }
    const id = /^issue\/(\d+)/u.exec(path)?.[1];
    const issue = id === undefined ? undefined : issues.get(id);
    if (issue === undefined) return { ok: false, reason: "not-found", httpStatus: 404 };
    if (path.endsWith("/estimation?boardId=7")) {
      const field = (board.estimation as { field: { fieldId: string } }).field.fieldId;
      return ok({
        fieldId: field,
        ...(controls.omitEstimate ? {} : { value: issue.fields[field] }),
      });
    }
    if (path.endsWith("?fields=epic&updateHistory=false"))
      return ok({
        id: issue.id,
        key: issue.key,
        fields: controls.omitEpic
          ? {}
          : { epic: issue.fields.customfield_10014 === null ? null : { id: 10003, key: "SYN-3" } },
      });
    throw new TypeError("Unexpected synthetic planning read");
  }
  function effect(
    path: string,
    method: string,
    body: Parameters<JiraMutationRequest>[2],
  ): AtlassianWriteHttpOutcome {
    const raw = asRecord(body);
    assert.ok(raw);
    const first = issues.get("10001");
    assert.ok(first);
    if (path === "epic/none/issue" && method === "POST") {
      assert.deepEqual(raw, { issues: ["10001"] });
      first.fields.customfield_10014 = null;
    } else if ((path === "issue/rank" || path === "epic/10001/rank") && method === "PUT") {
      assert.equal(raw.rankCustomFieldId, 10019);
      assert.equal(path === "issue/rank" ? raw.rankBeforeIssue : raw.rankBeforeEpic, "10002");
      first.fields.customfield_10019 = "0|native-new:";
    } else if (path === "issue/10001/estimation?boardId=7" && method === "PUT") {
      assert.equal(typeof raw.value, "string");
      const field = (board.estimation as { field: { fieldId: string } }).field.fieldId;
      first.fields[field] = Number(raw.value) * (field === "timeoriginalestimate" ? 60 : 1);
    } else throw new TypeError("Unexpected synthetic planning effect");
    return controls.lostAck
      ? { ok: false, reason: "timeout" }
      : {
          ok: true,
          status: controls.partialRank && path === "issue/rank" ? 207 : 204,
          body: undefined,
        };
  }
  function request(root: "agile" | "issue"): JiraMutationRequest {
    return async (path, method = "GET", body, expect) => {
      calls.push({ root, path, method, body, expect });
      if (readback && controls.throwReadback) throw new Error("Synthetic planning readback defect");
      if (readback && controls.denyReadback)
        return { ok: false, reason: "permission-denied", httpStatus: 403 };
      if (readback && controls.cancelledReadback) throw controller.signal.reason;
      if (method !== "GET") {
        assert.equal(root, "agile");
        return effect(path, method, body);
      }
      return root === "issue" ? platformRead(path) : agileRead(path);
    };
  }
  const phase = { issue: request("issue"), agile: request("agile"), signal: controller.signal };
  const ports: JiraAgilePlanningPorts = {
    requests: {
      ...phase,
      readback: () => {
        readback = true;
        if (controls.cancelledReadback) controller.abort(new Error("Synthetic cancelled readback"));
        return phase;
      },
    },
  };
  return {
    ports,
    calls,
    controls,
    actor,
    board,
    catalog,
    issues,
    snapshot: (): CatalogJsonObject => ({
      issueEpic: issues.get("10001")?.fields.customfield_10014 === null ? null : "SYN-3",
      issueRank: String(issues.get("10001")?.fields.customfield_10019),
      estimate: Number(issues.get("10001")?.fields.customfield_10016),
    }),
  };
}
