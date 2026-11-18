import { describe, expect, it, vi } from "vitest";
import { field } from "../../../tests/support/jira-managed-remote.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { readJiraTemplateOptions } from "./jira-issue-template-instance.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

const INSTANCE = "0".repeat(32);
const PROJECT = {
  id: "10000",
  key: "LAB",
  issueTypes: [
    { id: "10003", name: "Aufgabe" },
    { id: "10004", name: "Fachliche Aufgabe" },
    { id: "not-an-id", name: "Unusable identity" },
    { id: "10005", name: "" },
  ],
};
const DETAILS = { projectKey: "LAB", issueTypeId: "10003" };
const CREATE_FIELDS = "issue/createmeta/10000/issuetypes/10003?startAt=0&maxResults=100";
const MISSING = { ok: false, reason: "not-found" } as const;
const DENIED = { ok: false, reason: "permission-denied" } as const;

function object(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}

function array(items: readonly unknown[]): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: undefined, items };
}

function fixture(
  replies: Readonly<Record<string, AtlassianWriteHttpOutcome>>,
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>((path) => Promise.resolve(replies[path] ?? MISSING));
}

describe("Jira template editor options", () => {
  it("projects visible options with valid keys and display names from the native directory", async () => {
    const request = fixture({
      project: array([
        { id: "2", key: "PROD", name: "Product" },
        { id: "3", key: ".not-a-project", name: "Invalid key" },
        { id: "4", key: "BAD", name: " Bad name" },
        { id: "1", key: "LAB", name: "Lab project" },
      ]),
    });
    expect(await readJiraTemplateOptions(request, {}, INSTANCE)).toEqual({
      ok: true,
      options: {
        kind: "projects",
        projects: [
          { key: "LAB", name: "Lab project" },
          { key: "PROD", name: "Product" },
        ],
      },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("project", "GET", undefined, "json-array");
  });

  it.each([
    [DENIED, "permission-denied"],
    [object({}), "malformed-payload"],
    [array(Array.from({ length: 1001 }, () => ({}))), "bounds-exceeded"],
  ])("retains the directory refusal for an unavailable response", async (response, reason) => {
    const request = fixture({ project: response });
    expect(await readJiraTemplateOptions(request, {}, INSTANCE)).toEqual({ ok: false, reason });
  });

  it("uses the selected project's native types and preserves distinct localized names", async () => {
    const request = fixture({ "project/LAB": object(PROJECT) });
    expect(await readJiraTemplateOptions(request, { projectKey: "LAB" }, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "types", instanceId: INSTANCE, issueTypes: PROJECT.issueTypes.slice(0, 2) },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("project/LAB");
  });

  it.each([
    [MISSING, "not-found"],
    [DENIED, "permission-denied"],
    [object({ ...PROJECT, key: "OTHER" }), "malformed-payload"],
    [object({ ...PROJECT, id: "invalid" }), "malformed-payload"],
  ])("refuses an unverified project before reading any type metadata", async (response, reason) => {
    const request = fixture({ "project/LAB": response });
    expect(await readJiraTemplateOptions(request, DETAILS, INSTANCE)).toEqual({
      ok: false,
      reason,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("project/LAB");
  });

  it("does not read fields for a type outside the selected project", async () => {
    const request = fixture({ "project/LAB": object(PROJECT) });
    expect(
      await readJiraTemplateOptions(request, { ...DETAILS, issueTypeId: "99" }, INSTANCE),
    ).toEqual(MISSING);
    expect(request).toHaveBeenCalledExactlyOnceWith("project/LAB");
  });

  it("returns writable fields and statuses for the chosen type only", async () => {
    const values = [
      field("project", "project"),
      field("issuetype", "issuetype"),
      field("attachment", "attachment"),
      {
        ...field("labels", "array"),
        operations: ["add"],
        schema: { type: "array", items: "string", system: "labels" },
      },
      { ...field("summary", "string", true), name: "Zusammenfassung" },
    ];
    const statuses = [{ id: "6", name: "Erledigt" }];
    const request = fixture({
      "project/LAB": object(PROJECT),
      [CREATE_FIELDS]: object({
        values,
        isLast: true,
        startAt: 0,
        maxResults: 100,
        total: values.length,
      }),
      "project/LAB/statuses": array([
        { id: "10004", statuses: [{ id: "7", name: "Other workflow" }] },
        { id: "10003", statuses },
      ]),
    });
    expect(await readJiraTemplateOptions(request, DETAILS, INSTANCE)).toEqual({
      ok: true,
      options: {
        kind: "details",
        statuses,
        fields: [{ id: "summary", name: "Zusammenfassung", required: true }],
      },
    });
  });

  it("keeps unavailable catalogs distinct from empty catalogs", async () => {
    const request = fixture({ "project/LAB": object(PROJECT), [CREATE_FIELDS]: DENIED });
    expect(await readJiraTemplateOptions(request, DETAILS, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "details" },
    });
  });
});
