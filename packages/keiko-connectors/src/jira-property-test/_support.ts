import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export const BASE = "https://jira.example.test/context";
export const ISSUE = { id: "10002", key: "SYN-2", fields: { summary: "Synthetic issue" } };
export interface PropertyScenario {
  readonly prefix: string;
  readonly args: CatalogJsonObject;
  readonly admission: readonly Record<string, unknown>[];
  readonly admissionPaths: readonly string[];
  readonly path: string;
  readonly context: CatalogJsonObject;
  readonly agile?: boolean;
}
export const PROPERTY_CASES: readonly PropertyScenario[] = [
  { prefix: "board", args: { boardId: "7" }, admission: [{ id: 7, name: "Board", type: "scrum" }],
    admissionPaths: ["board/7"], path: "board/7/properties", context: { boardId: "7" }, agile: true },
  { prefix: "sprint", args: { sprintId: "8" }, admission: [{ id: 8, name: "Sprint", state: "future" }],
    admissionPaths: ["sprint/8"], path: "sprint/8/properties", context: { sprintId: "8" }, agile: true },
  { prefix: "comment", args: { issueIdOrKey: "syn-2", commentId: "9" }, admission: [ISSUE,
      { id: "9", body: "Comment", self: `${BASE}/rest/api/2/issue/10002/comment/9` }],
    admissionPaths: ["issue/syn-2?fields=summary", "issue/10002/comment/9"], path: "comment/9/properties",
    context: { issueId: "10002", issueKey: "SYN-2", commentId: "9" } },
  { prefix: "dashboard-item", args: { dashboardId: "10", itemId: "20" },
    admission: [{ id: "10", name: "Dashboard", self: "https://untrusted.invalid/dashboard" }],
    admissionPaths: ["dashboard/10"], path: "dashboard/10/items/20/properties",
    context: { dashboardId: "10", selectedItemId: "20" } },
  { prefix: "issue", args: { issueIdOrKey: "syn-2" }, admission: [ISSUE],
    admissionPaths: ["issue/syn-2?fields=summary"], path: "issue/10002/properties", context: { issueId: "10002", issueKey: "SYN-2" } },
  { prefix: "issue-type", args: { issueTypeId: "11" }, admission: [{ id: "11", name: "Story" }],
    admissionPaths: ["issuetype/11"], path: "issuetype/11/properties", context: { issueTypeId: "11" } },
  { prefix: "project", args: { projectIdOrKey: "syn" }, admission: [{ id: "10000", key: "SYN", name: "Synthetic project" }],
    admissionPaths: ["project/syn"], path: "project/10000/properties", context: { projectId: "10000", projectKey: "SYN" } },
  { prefix: "user", args: { username: "Synthetic User" }, admission: [{ key: "user-key", name: "synthetic user" }],
    admissionPaths: ["user?username=Synthetic+User"], path: "user/properties?userKey=user-key",
    context: { userKey: "user-key", username: "synthetic user" } },
];
