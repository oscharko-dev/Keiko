import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraAgilePlanningPorts } from "../../packages/keiko-connectors/src/jira-managed-agile-planning.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";
import { settleSync } from "./jira-fixture-settle.js";

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

type PlanningRoot = "agile" | "issue";
type PlanningFields = Record<string, unknown>;
interface PlanningIssue {
  id: string;
  key: string;
  readonly fields: PlanningFields;
}
interface PlanningControls {
  lostAck: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  partialRank: boolean;
  omitEpic: boolean;
  omitEstimate: boolean;
  partialBoard: boolean;
  epicsOffBoard: boolean;
  cancelledReadback: boolean;
}
interface PlanningCall {
  readonly root: PlanningRoot;
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly expect: unknown;
}
interface PlanningState {
  actor: { key: string; name: string; active: boolean };
  readonly board: Record<string, unknown>;
  readonly catalog: Record<string, unknown>[];
  readonly issues: Map<string, PlanningIssue>;
  readonly controls: PlanningControls;
  readonly calls: PlanningCall[];
  readonly controller: AbortController;
  readback: boolean;
}
type PlanningBody = Parameters<JiraMutationRequest>[2];

function planningBoard(): Record<string, unknown> {
  return {
    id: 7,
    name: "Synthetic board",
    ranking: { rankCustomFieldId: 10019 },
    estimation: {
      type: "field",
      field: { fieldId: "customfield_10016", displayName: "Synthetic estimate" },
    },
  };
}

function planningCatalog(): Record<string, unknown>[] {
  return [
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
}

function planningFields(rank: string): PlanningFields {
  return {
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
  };
}

function planningIssues(): Map<string, PlanningIssue> {
  return new Map([
    ["10001", { id: "10001", key: "SYN-1", fields: planningFields("0|first:") }],
    ["10002", { id: "10002", key: "SYN-2", fields: planningFields("0|anchor:") }],
    ["10003", { id: "10003", key: "SYN-3", fields: planningFields("0|epic:") }],
  ]);
}

function planningControls(): PlanningControls {
  return {
    lostAck: false,
    denyReadback: false,
    throwReadback: false,
    partialRank: false,
    omitEpic: false,
    omitEstimate: false,
    partialBoard: false,
    epicsOffBoard: false,
    cancelledReadback: false,
  };
}

function ok(body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}

function notFound(): AtlassianWriteHttpOutcome {
  return { ok: false, reason: "not-found", httpStatus: 404 };
}

function estimationFieldId(board: Record<string, unknown>): string {
  return (board.estimation as { field: { fieldId: string } }).field.fieldId;
}

function issueAt(state: PlanningState, selector: string): PlanningIssue | undefined {
  return (
    state.issues.get(selector) ??
    [...state.issues.values()].find(({ key }) => key.toLowerCase() === selector.toLowerCase())
  );
}

function platformRead(state: PlanningState, path: string): AtlassianWriteHttpOutcome {
  if (path === "myself") return ok(state.actor);
  if (path === "field") return { ok: true, status: 200, body: undefined, items: state.catalog };
  const selected = /^issue\/([^?]+)\?/u.exec(path)?.[1];
  const issue = selected === undefined ? undefined : issueAt(state, decodeURIComponent(selected));
  return issue === undefined
    ? notFound()
    : ok({ id: issue.id, key: issue.key, fields: { ...issue.fields } });
}

function boardIssuesRead(state: PlanningState): AtlassianWriteHttpOutcome {
  // Live Jira keeps epics out of the board issue list, so an epic subset query returns no rows.
  const count = state.controls.epicsOffBoard ? 0 : state.controls.partialBoard ? 1 : 2;
  return ok({
    startAt: 0,
    maxResults: 100,
    total: count,
    issues: [...state.issues.values()].slice(0, count).map(({ id, key }) => ({ id, key })),
  });
}

function epicRead(state: PlanningState, epic: string): AtlassianWriteHttpOutcome {
  const issue = state.issues.get(epic);
  return issue === undefined
    ? notFound()
    : ok({
        id: Number(issue.id),
        key: issue.key,
        name: "Synthetic epic",
        summary: "Synthetic epic",
        done: false,
      });
}

function epicFieldRead(state: PlanningState, issue: PlanningIssue): AtlassianWriteHttpOutcome {
  return ok({
    id: issue.id,
    key: issue.key,
    fields: state.controls.omitEpic
      ? {}
      : { epic: issue.fields.customfield_10014 === null ? null : { id: 10003, key: "SYN-3" } },
  });
}

function issueScopedRead(state: PlanningState, path: string): AtlassianWriteHttpOutcome {
  const id = /^issue\/(\d+)/u.exec(path)?.[1];
  const issue = id === undefined ? undefined : state.issues.get(id);
  if (issue === undefined) return notFound();
  if (path.endsWith("/estimation?boardId=7")) {
    const field = estimationFieldId(state.board);
    return ok({
      fieldId: field,
      ...(state.controls.omitEstimate ? {} : { value: issue.fields[field] }),
    });
  }
  if (path.endsWith("?fields=epic&updateHistory=false")) return epicFieldRead(state, issue);
  throw new TypeError("Unexpected synthetic planning read");
}

function agileRead(state: PlanningState, path: string): AtlassianWriteHttpOutcome {
  if (path === "board/7/configuration") return ok(state.board);
  if (path.startsWith("board/7/issue?")) return boardIssuesRead(state);
  const epic = /^epic\/(\d+)$/u.exec(path)?.[1];
  if (epic !== undefined) return epicRead(state, epic);
  return issueScopedRead(state, path);
}

function applyRank(first: PlanningIssue, path: string, raw: Record<string, unknown>): void {
  assert.equal(raw.rankCustomFieldId, 10019);
  assert.equal(path === "issue/rank" ? raw.rankBeforeIssue : raw.rankBeforeEpic, "10002");
  first.fields.customfield_10019 = "0|native-new:";
}

function applyEstimation(
  state: PlanningState,
  first: PlanningIssue,
  raw: Record<string, unknown>,
): void {
  assert.equal(typeof raw.value, "string");
  const field = estimationFieldId(state.board);
  first.fields[field] = Number(raw.value) * (field === "timeoriginalestimate" ? 60 : 1);
}

function applyEffect(
  state: PlanningState,
  first: PlanningIssue,
  path: string,
  method: string,
  raw: Record<string, unknown>,
): void {
  if (path === "epic/none/issue" && method === "POST") {
    assert.deepEqual(raw, { issues: ["10001"] });
    first.fields.customfield_10014 = null;
  } else if ((path === "issue/rank" || path === "epic/10001/rank") && method === "PUT") {
    applyRank(first, path, raw);
  } else if (path === "issue/10001/estimation?boardId=7" && method === "PUT") {
    applyEstimation(state, first, raw);
  } else throw new TypeError("Unexpected synthetic planning effect");
}

function effect(
  state: PlanningState,
  path: string,
  method: string,
  body: PlanningBody,
): AtlassianWriteHttpOutcome {
  const raw = asRecord(body);
  assert.ok(raw);
  const first = state.issues.get("10001");
  assert.ok(first);
  applyEffect(state, first, path, method, raw);
  return state.controls.lostAck
    ? { ok: false, reason: "timeout" }
    : {
        ok: true,
        status: state.controls.partialRank && path === "issue/rank" ? 207 : 204,
        body: undefined,
      };
}

function readbackFault(state: PlanningState): AtlassianWriteHttpOutcome | undefined {
  if (!state.readback) return undefined;
  if (state.controls.throwReadback) throw new Error("Synthetic planning readback defect");
  if (state.controls.denyReadback)
    return { ok: false, reason: "permission-denied", httpStatus: 403 };
  if (state.controls.cancelledReadback) throw state.controller.signal.reason;
  return undefined;
}

function planningResponse(
  state: PlanningState,
  root: PlanningRoot,
  path: string,
  method: string,
  body: PlanningBody,
): AtlassianWriteHttpOutcome {
  const fault = readbackFault(state);
  if (fault !== undefined) return fault;
  if (method !== "GET") {
    assert.equal(root, "agile");
    return effect(state, path, method, body);
  }
  return root === "issue" ? platformRead(state, path) : agileRead(state, path);
}

function planningRequest(state: PlanningState, root: PlanningRoot): JiraMutationRequest {
  return (path, method = "GET", body, expect) =>
    settleSync(() => {
      state.calls.push({ root, path, method, body, expect });
      return planningResponse(state, root, path, method, body);
    });
}

export interface AgilePlanningFixture {
  readonly ports: JiraAgilePlanningPorts;
  readonly calls: PlanningCall[];
  readonly controls: PlanningControls;
  readonly actor: PlanningState["actor"];
  readonly board: Record<string, unknown>;
  readonly catalog: Record<string, unknown>[];
  readonly issues: Map<string, PlanningIssue>;
  readonly snapshot: () => CatalogJsonObject;
}

export function agilePlanningFixture(): AgilePlanningFixture {
  const state: PlanningState = {
    actor: { key: ACTOR, name: "synthetic-user", active: true },
    board: planningBoard(),
    catalog: planningCatalog(),
    issues: planningIssues(),
    controls: planningControls(),
    calls: [],
    controller: new AbortController(),
    readback: false,
  };
  const phase = {
    issue: planningRequest(state, "issue"),
    agile: planningRequest(state, "agile"),
    signal: state.controller.signal,
  };
  const ports: JiraAgilePlanningPorts = {
    requests: {
      ...phase,
      readback: () => {
        state.readback = true;
        if (state.controls.cancelledReadback)
          state.controller.abort(new Error("Synthetic cancelled readback"));
        return phase;
      },
    },
  };
  const { issues } = state;
  return {
    ports,
    calls: state.calls,
    controls: state.controls,
    actor: state.actor,
    board: state.board,
    catalog: state.catalog,
    issues,
    snapshot: (): CatalogJsonObject => ({
      issueEpic: issues.get("10001")?.fields.customfield_10014 === null ? null : "SYN-3",
      issueRank: String(issues.get("10001")?.fields.customfield_10019),
      estimate: Number(issues.get("10001")?.fields.customfield_10016),
    }),
  };
}
