import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraSprintLifecyclePorts } from "../../packages/keiko-connectors/src/jira-managed-sprint-lifecycle.js";
import { asRecord } from "../../packages/keiko-connectors/src/atlassian-sync-classify.js";

export const SPRINT_LIFECYCLE_FIRST = { id: "11", originBoardId: "7", name: "Synthetic first", state: "future",
  startDate: "2027-01-01T09:00:00.000Z", endDate: "2027-01-15T09:00:00.000Z", goal: null,
  synced: false, autoStartStop: false, incompleteIssuesDestinationId: null } as const;
export const SPRINT_LIFECYCLE_SECOND = { ...SPRINT_LIFECYCLE_FIRST, id: "12", name: "Synthetic second", synced: true } as const;
const ACTOR = "synthetic-actor";
export const SPRINT_LIFECYCLE_FIXTURE_CASES = [
  { name: "jira.replace-sprint", method: "PUT", path: "sprint/11", args: { expectedActorKey: ACTOR, sprintId: "11", expectedSprint: SPRINT_LIFECYCLE_FIRST,
    replacement: { name: "Synthetic renamed", state: "future", startDate: null, endDate: null, goal: null, autoStartStop: false, incompleteIssuesDestinationId: null } } },
  { name: "jira.delete-sprint", method: "DELETE", path: "sprint/11", args: { expectedActorKey: ACTOR, sprintId: "11", expectedSprint: SPRINT_LIFECYCLE_FIRST } },
  { name: "jira.swap-sprints", method: "POST", path: "sprint/11/swap", args: { expectedActorKey: ACTOR, sprintId: "11", expectedSprint: SPRINT_LIFECYCLE_FIRST,
    swapSprintId: "12", expectedSwapSprint: SPRINT_LIFECYCLE_SECOND, expectedVisibleSprintIds: ["11", "12"] } },
  { name: "jira.unmap-sprints", method: "PUT", path: "sprint/unmap", args: { expectedActorKey: ACTOR, expectedSprints: [SPRINT_LIFECYCLE_SECOND] } },
  { name: "jira.unmap-all-sprints", method: "PUT", path: "sprint/unmap-all", args: { expectedActorKey: ACTOR, expectedSprints: [SPRINT_LIFECYCLE_SECOND], confirmInstanceWide: true } },
] as const;

/** Independent synthetic native state; source fixture only, never a real Jira request. */
export function sprintLifecycleFixture() {
  const sprints = new Map<string, Record<string, unknown>>([
    ["11", { ...SPRINT_LIFECYCLE_FIRST }], ["12", { ...SPRINT_LIFECYCLE_SECOND }],
  ]);
  let order = ["11", "12"];
  let readback = false;
  const calls: { readonly path: string; readonly method: string; readonly body: unknown }[] = [];
  const controls: { lostAck: boolean; denyReadback: boolean; malformedReadback: boolean; throwReadback: boolean; fields: readonly unknown[] } = {
    lostAck: false, denyReadback: false, malformedReadback: false, throwReadback: false, fields: [],
  };
  const actor = { key: ACTOR, name: "synthetic-user", active: true };
  const signal = new AbortController().signal;
  const request: JiraMutationRequest = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (readback && controls.throwReadback) throw new Error("Synthetic sprint readback defect");
    if (readback && controls.denyReadback) return { ok: false, reason: "permission-denied", httpStatus: 403 };
    if (method === "GET") {
      if (path === "myself") return { ok: true, status: 200, body: actor };
      if (path === "field") return { ok: true, status: 200, body: undefined, items: controls.fields };
      if (path === "board/7") return { ok: true, status: 200, body: { id: 7, name: "Synthetic board", type: "scrum" } };
      if (path === "board/7/sprint?startAt=0&maxResults=100") return { ok: true, status: 200, body: {
        startAt: 0, maxResults: 100, total: order.length, isLast: true,
        values: order.map((id) => sprints.get(id)),
      } };
      const match = /^sprint\/(11|12)$/u.exec(path);
      const value = match === null ? undefined : sprints.get(match[1] ?? "");
      if (value === undefined) return { ok: false, reason: "not-found", httpStatus: 404 };
      return { ok: true, status: 200, body: readback && controls.malformedReadback ? { id: value.id } : { ...value, id: Number(value.id), originBoardId: 7 } };
    }
    const raw = asRecord(body);
    if (path === "sprint/11" && method === "PUT") {
      assert.ok(raw);
      assert.equal(raw.id, 11);
      assert.equal(raw.originBoardId, 7);
      assert.equal(raw.synced, false);
      sprints.set("11", { ...raw, id: "11", originBoardId: "7" });
    } else if (path === "sprint/11" && method === "DELETE") {
      assert.equal(body, undefined); sprints.delete("11"); order = ["12"];
    } else if (path === "sprint/11/swap" && method === "POST") {
      assert.deepEqual(body, { sprintToSwapWith: 12 }); order = ["12", "11"];
    } else if (path === "sprint/unmap" && method === "PUT") {
      assert.deepEqual(body, { sprintIds: [12] });
      const second = sprints.get("12"); if (second !== undefined) second.synced = false;
    } else if (path === "sprint/unmap-all" && method === "PUT") {
      assert.equal(body, undefined);
      for (const sprint of sprints.values()) sprint.synced = false;
    } else throw new Error("Unexpected synthetic sprint effect");
    return controls.lostAck ? { ok: false, reason: "timeout" } : { ok: true, status: 204, body: undefined };
  };
  const phase = { agile: request, issue: request, signal };
  const ports: JiraSprintLifecyclePorts = {
    requests: { ...phase, readback: () => { readback = true; return phase; } }, experimentalAgile: request,
  };
  return { ports, calls, controls, actor, sprints, snapshot: (): CatalogJsonObject => ({
    visibleSprintIds: order, sprints: [...sprints.values()].map((sprint) => ({ id: String(sprint.id), synced: sprint.synced === true })),
  }) };
}
