import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  actorReadback,
  assertDispatchedWrite,
  readbackFault,
  type RecordedCall,
  type SharedFixtureControls,
} from "./jira-fixture-readback.js";
import { settleSync } from "./jira-fixture-settle.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type {
  JiraMaintenanceMutation,
  MaintenanceReceipt,
} from "../../packages/keiko-connectors/src/jira-maintenance-mutation-values.js";

const ACTOR = "synthetic-actor";
const COMMON = { expectedActorKey: ACTOR, confirmUnverifiedEffect: true } as const;
export const MAINTENANCE_NODE_REVIEW = {
  nodeId: "node-a",
  state: "ACTIVE",
  alive: false,
  nodeBuildNumber: 113003,
  nodeVersion: "11.3.3",
  lastStateChangeTimestamp: 0,
} as const;
export const MAINTENANCE_CLUSTER_REVIEW = {
  state: "READY_TO_UPGRADE",
  build: { buildNumber: 113003, version: "11.3.3" },
} as const;
export const MAINTENANCE_REINDEX_REVIEW = {
  taskState: "observed",
  type: "BACKGROUND",
  currentProgress: 100,
  success: true,
  finishTime: "native-finished",
} as const;
export const MAINTENANCE_UPGRADE_REVIEW = {
  upgradeState: "result",
  upgradeOutcome: "SUCCESS",
  duration: 0,
  startTime: "native-start",
  message: "",
} as const;
const FLAGS = { indexComments: false, indexChangeHistory: true, indexWorklogs: false } as const;
interface MaintenanceCase {
  readonly name: JiraMaintenanceMutation;
  readonly args: CatalogJsonObject;
  readonly method: "PUT" | "POST" | "DELETE";
  readonly path: string;
  readonly status: number;
  readonly receipt: MaintenanceReceipt;
}
/** Independent native paths/query/status literals; no expected request is derived from product code. */
export const MAINTENANCE_MUTATION_FIXTURE_CASES = [
  {
    name: "jira.request-cluster-index-snapshot",
    args: { ...COMMON, expectedNode: { ...MAINTENANCE_NODE_REVIEW, alive: true } },
    method: "PUT",
    path: "cluster/index-snapshot/node-a",
    status: 200,
    receipt: { userKey: ACTOR, nodeId: "node-a" },
  },
  {
    name: "jira.delete-cluster-node",
    args: { ...COMMON, expectedNode: { ...MAINTENANCE_NODE_REVIEW, state: "OFFLINE" } },
    method: "DELETE",
    path: "cluster/node/node-a",
    status: 204,
    receipt: { userKey: ACTOR, nodeId: "node-a" },
  },
  {
    name: "jira.mark-cluster-node-offline",
    args: { ...COMMON, expectedNode: MAINTENANCE_NODE_REVIEW },
    method: "PUT",
    path: "cluster/node/node-a/offline",
    status: 200,
    receipt: { userKey: ACTOR, nodeId: "node-a" },
  },
  {
    name: "jira.approve-cluster-upgrade",
    args: {
      ...COMMON,
      expectedClusterState: { ...MAINTENANCE_CLUSTER_REVIEW, state: "READY_TO_RUN_UPGRADE_TASKS" },
    },
    method: "POST",
    path: "cluster/zdu/approve",
    status: 200,
    receipt: { userKey: ACTOR },
  },
  {
    name: "jira.cancel-cluster-upgrade",
    args: { ...COMMON, expectedClusterState: MAINTENANCE_CLUSTER_REVIEW },
    method: "POST",
    path: "cluster/zdu/cancel",
    status: 201,
    receipt: { userKey: ACTOR },
  },
  {
    name: "jira.retry-cluster-upgrade",
    args: {
      ...COMMON,
      expectedClusterState: { ...MAINTENANCE_CLUSTER_REVIEW, state: "UPGRADE_TASKS_FAILED" },
    },
    method: "POST",
    path: "cluster/zdu/retryUpgrade",
    status: 200,
    receipt: { userKey: ACTOR },
  },
  {
    name: "jira.start-cluster-upgrade",
    args: { ...COMMON, expectedClusterState: { ...MAINTENANCE_CLUSTER_REVIEW, state: "STABLE" } },
    method: "POST",
    path: "cluster/zdu/start",
    status: 201,
    receipt: { userKey: ACTOR },
  },
  {
    name: "jira.create-index-snapshot",
    args: { ...COMMON, expectedRunning: false },
    method: "POST",
    path: "index-snapshot",
    status: 202,
    receipt: { userKey: ACTOR },
  },
  {
    name: "jira.start-reindex",
    args: {
      ...COMMON,
      expectedReindex: MAINTENANCE_REINDEX_REVIEW,
      type: "BACKGROUND_PREFERRED",
      ...FLAGS,
    },
    method: "POST",
    path: "reindex?type=BACKGROUND_PREFERRED&indexComments=false&indexChangeHistory=true&indexWorklogs=false",
    status: 202,
    receipt: { userKey: ACTOR },
  },
  {
    name: "jira.reindex-issues",
    args: {
      ...COMMON,
      expectedIssues: [
        { issueId: "10001", issueKey: "SYN-1" },
        { issueId: "9223372036854775807", issueKey: "SYN-2" },
      ],
      ...FLAGS,
    },
    method: "POST",
    path: "reindex/issue?issueId=10001&issueId=9223372036854775807&indexComments=false&indexChangeHistory=true&indexWorklogs=false",
    status: 200,
    receipt: { userKey: ACTOR, issueIds: ["10001", "9223372036854775807"] },
  },
  {
    name: "jira.process-reindex-requests",
    args: { ...COMMON, expectedReindex: MAINTENANCE_REINDEX_REVIEW },
    method: "POST",
    path: "reindex/request",
    status: 200,
    receipt: { userKey: ACTOR, reindexRequestIds: ["7", "9223372036854775807"] },
  },
  {
    name: "jira.run-upgrade",
    args: { ...COMMON, expectedUpgrade: MAINTENANCE_UPGRADE_REVIEW },
    method: "POST",
    path: "upgrade",
    status: 200,
    receipt: { userKey: ACTOR },
  },
] as const satisfies readonly MaintenanceCase[];

interface MaintenanceControls extends SharedFixtureControls {
  reject: boolean;
  noPriorReindex: boolean;
  upgradeRunning: boolean;
  noPriorUpgrade: boolean;
  wrongIssue: boolean;
  missingRequest: boolean;
  wrongRequest: boolean;
  ackIds: readonly unknown[];
  malformedAck: boolean;
}
type MaintenanceCall = RecordedCall;
interface MaintenanceState {
  readonly selected: MaintenanceCase;
  readonly actor: { key: string; name: string };
  readonly calls: MaintenanceCall[];
  readonly controls: MaintenanceControls;
  nodes: unknown[];
  cluster: unknown;
  reindex: unknown;
  upgrade: unknown;
  snapshot: unknown;
  effects: number;
}
export interface MaintenanceMutationFixture {
  readonly request: JiraMutationRequest;
  readonly calls: MaintenanceCall[];
  readonly actor: { key: string; name: string };
  readonly controls: MaintenanceControls;
  setNodes(value: readonly unknown[]): void;
  setCluster(value: unknown): void;
  setReindex(value: unknown): void;
  setUpgrade(value: unknown): void;
  setSnapshot(value: unknown): void;
  snapshot(): CatalogJsonObject;
}
const maintenanceOk = (body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body,
});
const maintenanceRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  const raw = asRecord(value);
  assert.ok(raw);
  return raw;
};
function maintenanceActorRead(state: MaintenanceState): AtlassianWriteHttpOutcome {
  const { controls } = state;
  const count = state.calls.filter((call) => call.path === "myself").length;
  return actorReadback(
    state.actor,
    "other-actor",
    (state.effects > 0 && controls.actorChangesAfter) || (count > 1 && controls.actorChangesBefore),
  );
}
function maintenanceUpgradeRead(state: MaintenanceState): AtlassianWriteHttpOutcome {
  if (state.controls.upgradeRunning) return { ok: true, status: 303, body: undefined };
  if (state.controls.noPriorUpgrade) return { ok: false, reason: "not-found", httpStatus: 404 };
  return maintenanceOk(maintenanceRecord(state.upgrade));
}
function maintenanceIssueRead(
  controls: MaintenanceControls,
  path: string,
): AtlassianWriteHttpOutcome {
  const url = new URL(path, "https://synthetic.invalid/");
  if (url.pathname === "/reindex/request/bulk") {
    const ids = url.searchParams.getAll("requestId");
    const items = controls.missingRequest
      ? []
      : ids.map((id) => ({
          id: controls.wrongRequest ? "99" : id,
          status: "COMPLETE",
          type: "IMMEDIATE",
        }));
    return { ok: true, status: 200, body: undefined, items };
  }
  assert.equal(url.searchParams.get("fields"), "summary");
  const id = url.pathname.slice("/issue/".length);
  assert.ok(id === "10001" || id === "9223372036854775807");
  return maintenanceOk({
    id: controls.wrongIssue ? "99" : id,
    key: id === "10001" ? "SYN-1" : "SYN-2",
    fields: { summary: "Synthetic" },
  });
}
function maintenanceStateRead(
  state: MaintenanceState,
  path: string,
): AtlassianWriteHttpOutcome | undefined {
  switch (path) {
    case "cluster/nodes":
      return { ok: true, status: 200, body: undefined, items: structuredClone(state.nodes) };
    case "cluster/zdu/state":
      return maintenanceOk(maintenanceRecord(state.cluster));
    case "index-snapshot/isRunning":
      return maintenanceOk(maintenanceRecord(state.snapshot));
    case "reindex":
      return state.controls.noPriorReindex
        ? { ok: false, reason: "not-found", httpStatus: 404 }
        : maintenanceOk(maintenanceRecord(state.reindex));
    case "upgrade":
      return maintenanceUpgradeRead(state);
    default:
      return undefined;
  }
}
function maintenanceRead(state: MaintenanceState, path: string): AtlassianWriteHttpOutcome {
  if (path === "myself") return maintenanceActorRead(state);
  return maintenanceStateRead(state, path) ?? maintenanceIssueRead(state.controls, path);
}
function maintenanceApply(state: MaintenanceState): void {
  const { selected } = state;
  if (selected.name === "jira.delete-cluster-node") state.nodes = [];
  if (selected.name === "jira.mark-cluster-node-offline")
    state.nodes = [{ ...MAINTENANCE_NODE_REVIEW, state: "OFFLINE" }];
  if (selected.path.startsWith("cluster/zdu/"))
    state.cluster = {
      state: "FUTURE_NATIVE_STATE",
      build: { buildNumber: 113003, version: "11.3.3" },
    };
  if (selected.name === "jira.create-index-snapshot") state.snapshot = { running: false };
}
function maintenanceReadbackFailure(
  state: MaintenanceState,
  path: string,
): AtlassianWriteHttpOutcome | undefined {
  return readbackFault(state.controls, state.effects, path, "Synthetic maintenance readback fault");
}
function maintenanceWrite(
  state: MaintenanceState,
  call: MaintenanceCall,
): AtlassianWriteHttpOutcome {
  const { selected, controls } = state;
  assertDispatchedWrite(selected, call, {
    body: undefined,
    expect: selected.name === "jira.process-reindex-requests" ? "json-array" : "none",
  });
  if (controls.reject) return { ok: false, reason: "conflict", httpStatus: 409 };
  assert.equal(++state.effects, 1);
  maintenanceApply(state);
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  return selected.name === "jira.process-reindex-requests" && !controls.malformedAck
    ? {
        ok: true,
        status: selected.status,
        body: undefined,
        items: structuredClone(controls.ackIds),
      }
    : { ok: true, status: selected.status, body: undefined };
}
function maintenanceRequest(
  state: MaintenanceState,
  call: MaintenanceCall,
): AtlassianWriteHttpOutcome {
  state.calls.push({ ...call, body: structuredClone(call.body) });
  const failure = maintenanceReadbackFailure(state, call.path);
  if (failure !== undefined) return failure;
  return call.method === "GET" ? maintenanceRead(state, call.path) : maintenanceWrite(state, call);
}
function maintenanceState(selected: MaintenanceCase): MaintenanceState {
  return {
    selected,
    actor: { key: ACTOR, name: "operator" },
    calls: [],
    controls: {
      lostAck: false,
      denyReadback: false,
      throwReadback: false,
      actorChangesAfter: false,
      actorChangesBefore: false,
      reject: false,
      noPriorReindex: false,
      upgradeRunning: false,
      noPriorUpgrade: false,
      wrongIssue: false,
      missingRequest: false,
      wrongRequest: false,
      ackIds: [7, "9223372036854775807"],
      malformedAck: false,
    },
    nodes: [structuredClone(selected.args.expectedNode ?? MAINTENANCE_NODE_REVIEW)],
    cluster: structuredClone(selected.args.expectedClusterState ?? MAINTENANCE_CLUSTER_REVIEW),
    reindex: {
      type: "BACKGROUND",
      currentProgress: 100,
      success: true,
      finishTime: "native-finished",
    },
    upgrade: { outcome: "SUCCESS", duration: 0, startTime: "native-start", message: "" },
    snapshot: { running: false },
    effects: 0,
  };
}
export function maintenanceMutationFixture(selected: MaintenanceCase): MaintenanceMutationFixture {
  const state = maintenanceState(selected);
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => maintenanceRequest(state, { path, method, body, expect }));
  return {
    request,
    calls: state.calls,
    actor: state.actor,
    controls: state.controls,
    setNodes(value: readonly unknown[]): void {
      state.nodes = [...value];
    },
    setCluster(value: unknown): void {
      state.cluster = value;
    },
    setReindex(value: unknown): void {
      state.reindex = value;
    },
    setUpgrade(value: unknown): void {
      state.upgrade = value;
    },
    setSnapshot(value: unknown): void {
      state.snapshot = value;
    },
    snapshot: (): CatalogJsonObject => ({ effects: state.effects, nodeCount: state.nodes.length }),
  };
}
