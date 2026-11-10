import assert from "node:assert/strict";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { actorReadback, readbackFault, reviewedWriteRefusal } from "./jira-fixture-readback.js";
import { settleSync } from "./jira-fixture-settle.js";
import type { AtlassianWriteHttpOutcome } from "../../packages/keiko-connectors/src/atlassian-write-http.js";
import type { JiraMutationRequest } from "../../packages/keiko-connectors/src/jira-managed-mutation-metadata.js";
import type { JiraIssueLifecyclePorts } from "../../packages/keiko-connectors/src/jira-managed-issue-lifecycle.js";
import type {
  JiraIssueLifecycleMutation,
  IssueLifecycleReceipt,
} from "../../packages/keiko-connectors/src/jira-issue-lifecycle-values.js";

const ACTOR = "synthetic-actor";
const COMMON = { expectedActorKey: ACTOR, confirmUnverifiedEffect: true } as const;
export const ISSUE_LIFECYCLE_REVIEW = {
  id: "10001",
  key: "SYN-1",
  summary: "Reviewed parent",
  projectId: "10000",
  issueTypeId: "3",
} as const;
const ISSUE_LIFECYCLE_OTHER = {
  id: "9223372036854775807",
  key: "SYN-2",
  summary: "Reviewed second issue",
  projectId: "10000",
  issueTypeId: "3",
} as const;
export const ISSUE_LIFECYCLE_SUBTASKS = [
  { id: "10002", key: "SYN-3" },
  { id: "10003", key: "SYN-4" },
] as const;
interface LifecycleCase {
  readonly name: JiraIssueLifecycleMutation;
  readonly args: CatalogJsonObject;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly receipt: IssueLifecycleReceipt;
}
/** Literal native identities and wire bodies are independent of the executor's request builder. */
export const ISSUE_LIFECYCLE_FIXTURE_CASES = [
  {
    name: "jira.archive-issues",
    args: { ...COMMON, expectedIssues: [ISSUE_LIFECYCLE_REVIEW, ISSUE_LIFECYCLE_OTHER] },
    method: "POST",
    path: "issue/archive?notifyUsers=true",
    body: ["SYN-1", "SYN-2"],
    receipt: {
      userKey: ACTOR,
      issueIds: ["10001", "9223372036854775807"],
      issueKeys: ["SYN-1", "SYN-2"],
      issueArchivedRequested: true,
    },
  },
  {
    name: "jira.delete-issue",
    args: { ...COMMON, expectedIssue: ISSUE_LIFECYCLE_REVIEW, expectedSubtasks: [] },
    method: "DELETE",
    path: "issue/10001?deleteSubtasks=false",
    receipt: { userKey: ACTOR, issueId: "10001", issueKey: "SYN-1", issuePresent: false },
  },
  {
    name: "jira.archive-issue",
    args: { ...COMMON, expectedIssue: ISSUE_LIFECYCLE_REVIEW },
    method: "PUT",
    path: "issue/10001/archive?notifyUsers=true",
    receipt: { userKey: ACTOR, issueId: "10001", issueKey: "SYN-1", issueArchivedRequested: true },
  },
  {
    name: "jira.restore-issue",
    args: { ...COMMON, expectedIssue: ISSUE_LIFECYCLE_REVIEW },
    method: "PUT",
    path: "issue/10001/restore?notifyUsers=true",
    receipt: { userKey: ACTOR, issueId: "10001", issueKey: "SYN-1", issueArchivedRequested: false },
  },
  {
    name: "jira.move-subtask",
    args: {
      ...COMMON,
      expectedIssue: ISSUE_LIFECYCLE_REVIEW,
      expectedSubtasks: ISSUE_LIFECYCLE_SUBTASKS,
      originalPosition: 1,
      currentPosition: 2,
    },
    method: "POST",
    path: "issue/10001/subtask/move",
    body: { original: 1, current: 2 },
    receipt: {
      userKey: ACTOR,
      issueId: "10001",
      issueKey: "SYN-1",
      subtaskIds: ["10002", "10003"],
      originalPosition: 1,
      currentPosition: 2,
    },
  },
] as const satisfies readonly LifecycleCase[];

interface IssueLifecycleControls {
  lostAck: boolean;
  denyReadback: boolean;
  throwReadback: boolean;
  missingReadback: boolean;
  reject: boolean;
  actorChangesBefore: boolean;
  actorChangesAfter: boolean;
  issueDrift: boolean;
  canMove: boolean;
  formalRefusal: boolean;
}
interface IssueLifecycleCall {
  path: string;
  method: string;
  body: unknown;
  expect: unknown;
}
interface IssueLifecycleState {
  readonly selected: LifecycleCase;
  readonly actor: { key: string; name: string };
  readonly calls: IssueLifecycleCall[];
  readonly controls: IssueLifecycleControls;
  effects: number;
  formalCalls: number;
  subtasks: readonly unknown[];
}
export interface IssueLifecycleFixture {
  readonly request: JiraMutationRequest;
  readonly ports: JiraIssueLifecyclePorts;
  readonly actor: { key: string; name: string };
  readonly calls: IssueLifecycleCall[];
  readonly controls: IssueLifecycleControls;
  setSubtasks(value: readonly unknown[]): void;
  snapshot(): CatalogJsonObject;
}
const lifecycleOk = (body: Readonly<Record<string, unknown>>): AtlassianWriteHttpOutcome => ({
  ok: true,
  status: 200,
  body,
});
function lifecycleIssueRead(state: IssueLifecycleState, path: string): AtlassianWriteHttpOutcome {
  const url = new URL(path, "https://synthetic.invalid/");
  assert.equal(url.searchParams.get("fields"), "issuetype,project,summary");
  const issue = url.pathname === "/issue/10001" ? ISSUE_LIFECYCLE_REVIEW : ISSUE_LIFECYCLE_OTHER;
  assert.equal(url.pathname, `/issue/${issue.id}`);
  return lifecycleOk({
    id: issue.id,
    key: issue.key,
    fields: {
      summary: state.controls.issueDrift ? "Changed review" : issue.summary,
      project: { id: issue.projectId },
      issuetype: { id: issue.issueTypeId },
    },
  });
}
function lifecycleRead(state: IssueLifecycleState, path: string): AtlassianWriteHttpOutcome {
  const { controls } = state;
  if (path === "myself") {
    const count = state.calls.filter((call) => call.path === "myself").length;
    return actorReadback(
      state.actor,
      "different-actor",
      (state.effects > 0 && controls.actorChangesAfter) ||
        (count > 1 && controls.actorChangesBefore),
    );
  }
  if (path === "issue/10001/subtask")
    return { ok: true, status: 200, body: undefined, items: structuredClone(state.subtasks) };
  if (path === "issue/10001/subtask/move")
    return { ok: true, status: 200, body: undefined, scalar: controls.canMove };
  return lifecycleIssueRead(state, path);
}
function lifecycleRequest(
  state: IssueLifecycleState,
  call: IssueLifecycleCall,
): AtlassianWriteHttpOutcome {
  const { selected, controls } = state;
  const { path, method, body, expect } = call;
  state.calls.push({ path, method, body: structuredClone(body), expect });
  const fault = readbackFault(controls, state.effects, path, "Synthetic lifecycle readback fault");
  if (fault !== undefined) return fault;
  if (method === "GET") return lifecycleRead(state, path);
  const refusal = reviewedWriteRefusal(selected, controls, { path, method, body, expect });
  if (refusal !== undefined) return refusal;
  assert.equal(++state.effects, 1);
  if (controls.lostAck) return { ok: false, reason: "timeout" };
  return {
    ok: true,
    status: selected.name === "jira.archive-issues" ? 200 : 204,
    body: undefined,
  };
}
function lifecycleState(selected: LifecycleCase): IssueLifecycleState {
  return {
    selected,
    actor: { key: ACTOR, name: "operator" },
    calls: [],
    controls: {
      lostAck: false,
      denyReadback: false,
      throwReadback: false,
      missingReadback: false,
      reject: false,
      actorChangesBefore: false,
      actorChangesAfter: false,
      issueDrift: false,
      canMove: true,
      formalRefusal: false,
    },
    effects: 0,
    formalCalls: 0,
    subtasks: selected.name === "jira.move-subtask" ? ISSUE_LIFECYCLE_SUBTASKS : [],
  };
}
export function issueLifecycleFixture(selected: LifecycleCase): IssueLifecycleFixture {
  const state = lifecycleState(selected);
  const request: JiraMutationRequest = (path, method = "GET", body, expect) =>
    settleSync(() => lifecycleRequest(state, { path, method, body, expect }));
  const ports: JiraIssueLifecyclePorts = {
    deletionAdmission: () =>
      settleSync(() => {
        state.formalCalls++;
        return state.controls.formalRefusal
          ? {
              ok: false as const,
              reason: "field-validation" as const,
              detail: { messages: ["Synthetic incoming-reference rule cannot be proved."] },
            }
          : undefined;
      }),
  };
  return {
    request,
    ports,
    actor: state.actor,
    calls: state.calls,
    controls: state.controls,
    setSubtasks(value: readonly unknown[]): void {
      state.subtasks = value;
    },
    snapshot: (): CatalogJsonObject => ({
      effects: state.effects,
      formalCalls: state.formalCalls,
    }),
  };
}
