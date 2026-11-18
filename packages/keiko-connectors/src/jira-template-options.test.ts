import { describe, expect, it, vi } from "vitest";
import {
  jiraTemplateBindingDigest,
  parseJiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { field } from "../../../tests/support/jira-managed-remote.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  readJiraTemplateInstanceMetadata,
  readJiraTemplateOptions,
  resolveJiraTemplateBinding,
} from "./jira-issue-template-instance.js";
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

  it("lists an offered name the full field catalog cannot resolve to one field, and no unique name (P-N)", async () => {
    const values = [
      { ...field("customfield_10010", "string"), name: "Team" },
      { ...field("summary", "string", true), name: "Zusammenfassung" },
    ];
    const request = fixture({
      "project/LAB": object(PROJECT),
      [CREATE_FIELDS]: object({
        values,
        isLast: true,
        startAt: 0,
        maxResults: 100,
        total: values.length,
      }),
      // The create screen offers one `Team`; the instance holds a second, hidden one of that name.
      field: array([
        { id: "customfield_10010", name: "Team" },
        { id: "customfield_10011", name: "Team" },
        { id: "summary", name: "Zusammenfassung" },
      ]),
    });
    const read = await readJiraTemplateOptions(request, DETAILS, INSTANCE);
    expect(
      read.ok && read.options.kind === "details" ? read.options.ambiguousFieldNames : [],
    ).toEqual(["Team"]);
  });

  it("omits the ambiguous-name list when the full catalog cannot be read (P-N)", async () => {
    const values = [{ ...field("customfield_10010", "string"), name: "Team" }];
    const request = fixture({
      "project/LAB": object(PROJECT),
      [CREATE_FIELDS]: object({
        values,
        isLast: true,
        startAt: 0,
        maxResults: 100,
        total: values.length,
      }),
      field: DENIED,
    });
    const read = await readJiraTemplateOptions(request, DETAILS, INSTANCE);
    expect(
      read.ok && read.options.kind === "details" && "ambiguousFieldNames" in read.options,
    ).toBe(false);
  });

  it("keeps unavailable catalogs distinct from empty catalogs", async () => {
    const request = fixture({ "project/LAB": object(PROJECT), [CREATE_FIELDS]: DENIED });
    expect(await readJiraTemplateOptions(request, DETAILS, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "details" },
    });
  });

  it("retains an explicit empty status list but omits a workflow Jira did not list", async () => {
    const empty = fixture({
      "project/LAB": object(PROJECT),
      [CREATE_FIELDS]: DENIED,
      "project/LAB/statuses": array([{ id: "10003", statuses: [] }]),
    });
    expect(await readJiraTemplateOptions(empty, DETAILS, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "details", statuses: [] },
    });
    // Jira answered, but for other types only (u44): the selected workflow is unknown, not empty.
    const otherType = fixture({
      "project/LAB": object(PROJECT),
      [CREATE_FIELDS]: DENIED,
      "project/LAB/statuses": array([{ id: "10004", statuses: [{ id: "7", name: "Other" }] }]),
    });
    expect(await readJiraTemplateOptions(otherType, DETAILS, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "details" },
    });
    const noArray = fixture({
      "project/LAB": object(PROJECT),
      [CREATE_FIELDS]: DENIED,
      "project/LAB/statuses": array([{ id: "10003" }]),
    });
    expect(await readJiraTemplateOptions(noArray, DETAILS, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "details" },
    });
  });

  it("omits statuses of a workflow whose ids the binding grammar would refuse (PR #4464)", async () => {
    const malformed = fixture({
      "project/LAB": object(PROJECT),
      [CREATE_FIELDS]: DENIED,
      "project/LAB/statuses": array([
        {
          id: "10003",
          statuses: [
            { id: "6", name: "Erledigt" },
            { id: "9223372036854775808", name: "Ready" },
          ],
        },
      ]),
    });
    expect(await readJiraTemplateOptions(malformed, DETAILS, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "details" },
    });
  });

  it("keeps an unlisted workflow unknown for the binding read and keeps bound status ids (PR #4464)", async () => {
    const template = parseJiraIssueTemplate(
      [
        "---",
        "keiko: jira-issue-template",
        "version: 1",
        "project: LAB",
        "issueType: Aufgabe",
        "activateOn: [transition:Erledigt]",
        "summaryMinLength: 4",
        "---",
        "# Aufgabe",
      ].join("\n"),
    );
    if (!template.ok) throw new TypeError("Expected a parseable template");
    const request = fixture({
      "project/LAB": object(PROJECT),
      "project/LAB/statuses": array([{ id: "10004", statuses: [{ id: "7", name: "Other" }] }]),
    });
    const read = await readJiraTemplateInstanceMetadata(request, template.template);
    if (!read.ok) throw new TypeError("Expected a metadata read");
    expect(read.instance.statuses).toBeUndefined();
    expect(read.instance.statusRefs).toBeUndefined();
    // A bound template whose type was renamed is rebound; the unknown workflow keeps its status id.
    const ids = { issueTypeId: "10999", transitionStatusIds: ["6"] };
    const bound = {
      ...template.template,
      binding: { digest: jiraTemplateBindingDigest(INSTANCE, template.template, ids), ...ids },
    };
    expect(resolveJiraTemplateBinding(bound, read.instance, INSTANCE)).toMatchObject({
      state: "bindable",
      binding: { issueTypeId: "10003", transitionStatusIds: ["6"] },
    });
  });

  it("offers neither of two projects whose keys differ only by case (u4r)", async () => {
    const request = fixture({
      project: array([
        { id: "1", key: "LAB", name: "Lab project" },
        { id: "2", key: "lab", name: "Lower lab" },
        { id: "3", key: "PROD", name: "Product" },
      ]),
    });
    expect(await readJiraTemplateOptions(request, {}, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "projects", projects: [{ key: "PROD", name: "Product" }] },
    });
  });

  it("never reads details for an id above the native Jira range, even when the project lists it (u4w)", async () => {
    const wide = "9223372036854775808";
    const request = fixture({
      "project/LAB": object({ ...PROJECT, issueTypes: [{ id: wide, name: "Too wide" }] }),
    });
    expect(
      await readJiraTemplateOptions(request, { projectKey: "LAB", issueTypeId: wide }, INSTANCE),
    ).toEqual(MISSING);
    expect(request).toHaveBeenCalledExactlyOnceWith("project/LAB");
  });

  it("offers an issue type id beyond JavaScript's safe integers (UyI)", async () => {
    const id = "12345678901234567";
    const request = fixture({
      "project/LAB": object({ ...PROJECT, issueTypes: [{ id, name: "Wide" }] }),
    });
    expect(await readJiraTemplateOptions(request, { projectKey: "LAB" }, INSTANCE)).toEqual({
      ok: true,
      options: { kind: "types", instanceId: INSTANCE, issueTypes: [{ id, name: "Wide" }] },
    });
  });
});
