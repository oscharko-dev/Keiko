// Hermetic tests for the governed Jira write executors (Issue #2244). The transport port is a
// scripted fixture; assertions cover the exact endpoint URLs, deterministic request bodies,
// typed failures (including invalid-transition matched BY ID), and content-freedom.

import { describe, expect, it } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  addJiraIssueComment,
  createJiraIssue,
  transitionJiraIssue,
  updateJiraIssueFields,
  type JiraWriteActionDeps,
} from "./jira-write-actions.js";

const BASE = "https://example.atlassian.net";

function response(status: number, bodyText = "{}"): AtlassianHttpBodyResult {
  return { kind: "response", status, bodyText, bodyBytes: bodyText.length, truncated: false };
}

function scripted(results: readonly AtlassianHttpBodyResult[]): {
  deps: JiraWriteActionDeps;
  requests: AtlassianHttpBodyRequest[];
} {
  const requests: AtlassianHttpBodyRequest[] = [];
  const queue = [...results];
  const port: AtlassianHttpBodyPort = (request) => {
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted port exhausted");
    return Promise.resolve(next);
  };
  return { deps: { http: port, baseUrl: BASE }, requests };
}

describe("createJiraIssue", () => {
  it("POSTs /rest/api/3/issue with a deterministic ADF description and returns the created key", async () => {
    const { deps, requests } = scripted([response(201, '{"id":"10001","key":"PROJ-9"}')]);
    const result = await createJiraIssue(deps, {
      projectKey: "PROJ",
      issueTypeId: "10004",
      summary: "Fix the flaky gate",
      descriptionText: "It fails on\n\n- retries",
    });
    expect(result).toEqual({ ok: true, issueKey: "PROJ-9", issueId: "10001" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: `${BASE}/rest/api/3/issue` });
    const body = JSON.parse(requests[0]?.bodyJson ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      fields: {
        project: { key: "PROJ" },
        issuetype: { id: "10004" },
        summary: "Fix the flaky gate",
        description: {
          version: 1,
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "It fails on" }] },
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "retries" }] }],
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("rejects invalid local input as field-validation without any port call", async () => {
    const { deps, requests } = scripted([]);
    expect(
      await createJiraIssue(deps, { projectKey: "lower", issueTypeId: "1", summary: "s" }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(await createJiraIssue(deps, { projectKey: "PROJ", summary: "s" })).toEqual({
      ok: false,
      reason: "field-validation",
    });
    expect(
      await createJiraIssue(deps, { projectKey: "PROJ", issueTypeId: "1", summary: "" }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(
      await createJiraIssue(deps, {
        projectKey: "PROJ",
        issueTypeId: "1",
        summary: "multi\nline",
      }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(requests).toHaveLength(0);
  });

  it("maps provider failures to typed content-free results", async () => {
    const { deps } = scripted([response(403, '{"errorMessages":["No create permission"]}')]);
    const result = await createJiraIssue(deps, {
      projectKey: "PROJ",
      issueTypeName: "Task",
      summary: "s",
    });
    expect(result).toEqual({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect(JSON.stringify(result)).not.toContain("No create permission");
  });

  it("classifies a hostile created-issue payload as malformed instead of carrying it", async () => {
    const { deps } = scripted([response(201, '{"id":"10001","key":"https://evil"}')]);
    expect(
      await createJiraIssue(deps, { projectKey: "PROJ", issueTypeId: "1", summary: "s" }),
    ).toEqual({ ok: false, reason: "malformed-payload", httpStatus: 201 });
  });
});

describe("updateJiraIssueFields", () => {
  it("PUTs /rest/api/3/issue/{key} with only the provided fields", async () => {
    const { deps, requests } = scripted([response(204, "")]);
    const result = await updateJiraIssueFields(deps, {
      issueKey: "PROJ-9",
      summary: "New summary",
      labels: ["governed", "connector"],
      priorityName: "High",
    });
    expect(result).toEqual({ ok: true });
    expect(requests[0]).toMatchObject({ method: "PUT", url: `${BASE}/rest/api/3/issue/PROJ-9` });
    expect(JSON.parse(requests[0]?.bodyJson ?? "{}")).toEqual({
      fields: {
        summary: "New summary",
        labels: ["governed", "connector"],
        priority: { name: "High" },
      },
    });
  });

  it("requires at least one field and validates labels fail-closed", async () => {
    const { deps, requests } = scripted([]);
    expect(await updateJiraIssueFields(deps, { issueKey: "PROJ-9" })).toEqual({
      ok: false,
      reason: "field-validation",
    });
    expect(
      await updateJiraIssueFields(deps, { issueKey: "PROJ-9", labels: ["ok", "bad label"] }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(requests).toHaveLength(0);
  });

  it("maps a 404 to not-found", async () => {
    const { deps } = scripted([response(404, "{}")]);
    expect(await updateJiraIssueFields(deps, { issueKey: "PROJ-9", summary: "s" })).toEqual({
      ok: false,
      reason: "not-found",
      httpStatus: 404,
    });
  });
});

describe("transitionJiraIssue", () => {
  const transitions =
    '{"transitions":[{"id":"11","name":"Zu erledigen"},{"id":"31","name":"Fertig"}]}';

  it("GETs the available transitions, matches BY ID, then POSTs the transition", async () => {
    const { deps, requests } = scripted([response(200, transitions), response(204, "")]);
    const result = await transitionJiraIssue(deps, { issueKey: "PROJ-9", transitionId: "31" });
    expect(result).toEqual({ ok: true, transitionId: "31" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: `${BASE}/rest/api/3/issue/PROJ-9/transitions`,
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: `${BASE}/rest/api/3/issue/PROJ-9/transitions`,
    });
    expect(JSON.parse(requests[1]?.bodyJson ?? "{}")).toEqual({ transition: { id: "31" } });
  });

  it("returns typed invalid-transition when the id is unavailable — no mutating request is sent", async () => {
    const { deps, requests } = scripted([response(200, transitions)]);
    const result = await transitionJiraIssue(deps, { issueKey: "PROJ-9", transitionId: "99" });
    expect(result).toEqual({ ok: false, reason: "invalid-transition" });
    expect(requests).toHaveLength(1);
    // Localized names never participate in matching and never enter the result.
    expect(JSON.stringify(result)).not.toContain("Fertig");
  });

  it("surfaces a failed transition listing as its typed reason", async () => {
    const { deps } = scripted([response(401, "{}")]);
    expect(await transitionJiraIssue(deps, { issueKey: "PROJ-9", transitionId: "31" })).toEqual({
      ok: false,
      reason: "auth-failed",
      httpStatus: 401,
    });
  });
});

describe("addJiraIssueComment", () => {
  it("POSTs /rest/api/3/issue/{key}/comment with the composed ADF body", async () => {
    const { deps, requests } = scripted([response(201, '{"id":"20001"}')]);
    const result = await addJiraIssueComment(deps, {
      issueKey: "PROJ-9",
      commentText: "Verified on staging",
    });
    expect(result).toEqual({ ok: true, commentId: "20001" });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: `${BASE}/rest/api/3/issue/PROJ-9/comment`,
    });
    expect(JSON.parse(requests[0]?.bodyJson ?? "{}")).toEqual({
      body: {
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Verified on staging" }] }],
      },
    });
  });

  it("maps composer rejections onto the closed vocabulary", async () => {
    const { deps, requests } = scripted([]);
    expect(
      await addJiraIssueComment(deps, { issueKey: "PROJ-9", commentText: "x".repeat(100_001) }),
    ).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(
      await addJiraIssueComment(deps, { issueKey: "PROJ-9", commentText: "bad\u0000char" }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(requests).toHaveLength(0);
  });

  it("refuses a hostile issue key before building a URL", async () => {
    const { deps, requests } = scripted([]);
    expect(
      await addJiraIssueComment(deps, { issueKey: "PROJ-9/../secrets", commentText: "hi" }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(requests).toHaveLength(0);
  });
});
