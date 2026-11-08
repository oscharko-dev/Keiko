import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { actorReadback } from "./jira-fixture-readback.js";
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

export function maintenanceMutationFixture(selected: MaintenanceCase) {
  const actor = { key: ACTOR, name: "operator" };
  let nodes: unknown[] = [structuredClone(selected.args.expectedNode ?? MAINTENANCE_NODE_REVIEW)];
  let cluster: unknown = structuredClone(
    selected.args.expectedClusterState ?? MAINTENANCE_CLUSTER_REVIEW,
  );
  let reindex: unknown = {
    type: "BACKGROUND",
    currentProgress: 100,
    success: true,
    finishTime: "native-finished",
  };
  let upgrade: unknown = {
    outcome: "SUCCESS",
    duration: 0,
    startTime: "native-start",
    message: "",
  };
  let snapshot: unknown = { running: false };
  let effects = 0;
  const calls: { path: string; method: string; body: unknown; expect: unknown }[] = [];
  const controls = {
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
    ackIds: [7, "9223372036854775807"] as readonly unknown[],
    malformedAck: false,
  };
  const ok = (body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome => ({
    ok: true,
    status: 200,
    body,
  });
  const record = (value: unknown): Readonly<Record<string, unknown>> => {
    const raw = asRecord(value);
    assert.ok(raw);
    return raw;
  };
  function read(path: string): AtlassianWriteHttpOutcome {
    if (path === "myself") {
      const count = calls.filter((call) => call.path === "myself").length;
      return actorReadback(
        actor,
        "other-actor",
        (effects > 0 && controls.actorChangesAfter) || (count > 1 && controls.actorChangesBefore),
      );
    }
    if (path === "cluster/nodes")
      return { ok: true, status: 200, body: undefined, items: structuredClone(nodes) };
    if (path === "cluster/zdu/state") return ok(record(cluster));
    if (path === "index-snapshot/isRunning") return ok(record(snapshot));
    if (path === "reindex")
      return controls.noPriorReindex
        ? { ok: false, reason: "not-found", httpStatus: 404 }
        : ok(record(reindex));
    if (path === "upgrade") {
      if (controls.upgradeRunning) return { ok: true, status: 303, body: undefined };
      if (controls.noPriorUpgrade) return { ok: false, reason: "not-found", httpStatus: 404 };
      return ok(record(upgrade));
    }
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
    return ok({
      id: controls.wrongIssue ? "99" : id,
      key: id === "10001" ? "SYN-1" : "SYN-2",
      fields: { summary: "Synthetic" },
    });
  }
  function apply(): void {
    if (selected.name === "jira.delete-cluster-node") nodes = [];
    if (selected.name === "jira.mark-cluster-node-offline")
      nodes = [{ ...MAINTENANCE_NODE_REVIEW, state: "OFFLINE" }];
    if (selected.path.startsWith("cluster/zdu/"))
      cluster = { state: "FUTURE_NATIVE_STATE", build: { buildNumber: 113003, version: "11.3.3" } };
    if (selected.name === "jira.create-index-snapshot") snapshot = { running: false };
  }
  const request: JiraMutationRequest = async (path, method = "GET", body, expect) => {
    calls.push({ path, method, body: structuredClone(body), expect });
    if (effects > 0 && controls.throwReadback)
      throw new Error("Synthetic maintenance readback fault");
    if (effects > 0 && controls.denyReadback)
      return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (method === "GET") return read(path);
    assert.equal(method, selected.method);
    assert.equal(path, selected.path);
    assert.equal(body, undefined);
    assert.equal(expect, selected.name === "jira.process-reindex-requests" ? "json-array" : "none");
    if (controls.reject) return { ok: false, reason: "conflict", httpStatus: 409 };
    assert.equal(++effects, 1);
    apply();
    if (controls.lostAck) return { ok: false, reason: "timeout" };
    return selected.name === "jira.process-reindex-requests" && !controls.malformedAck
      ? {
          ok: true,
          status: selected.status,
          body: undefined,
          items: structuredClone(controls.ackIds),
        }
      : { ok: true, status: selected.status, body: undefined };
  };
  return {
    request,
    calls,
    actor,
    controls,
    setNodes(value: readonly unknown[]): void {
      nodes = [...value];
    },
    setCluster(value: unknown): void {
      cluster = value;
    },
    setReindex(value: unknown): void {
      reindex = value;
    },
    setUpgrade(value: unknown): void {
      upgrade = value;
    },
    setSnapshot(value: unknown): void {
      snapshot = value;
    },
    snapshot: (): CatalogJsonObject => ({ effects, nodeCount: nodes.length }),
  };
}
