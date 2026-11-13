import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  field,
  FIELDS,
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../tests/support/jira-managed-remote.js";
import {
  permissiveJiraTemplates,
  SYNTHETIC_ISSUE_TYPES,
} from "../../../tests/support/jira-test-templates.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeJiraManagedMutation } from "./jira-managed-mutations.js";

// #4354 AC2: an Epic Link that points to an issue that is not an Epic passed the preflight and was
// then rejected by Jira for every item (gh.epic.error.not.found). Keiko now asks the instance's own
// epic endpoint before any write, and refuses with the way out.
const EPIC_LINK = {
  ...field("customfield_10014", "any"),
  schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
};
const EPIC = "SYN-9";
const TASK = "SYN-5";

function remote(epicEndpoint: "answers" | "forbidden" = "answers"): {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly writes: () => number;
  readonly run: (
    operation: "jira.create" | "jira.edit",
    args: CatalogJsonObject,
  ) => ReturnType<typeof executeJiraManagedMutation>;
} {
  const state: SyntheticJira = {
    fields: {
      summary: "Original",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: ["initial"],
    },
    comment: "",
  };
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET")
      return Promise.resolve(fixtureWrite(path, request.bodyJson, state, request.upload));
    if (path.endsWith("/rest/api/2/field"))
      return Promise.resolve(
        response([
          { id: "summary", name: "Summary", schema: { type: "string", system: "summary" } },
          { id: "customfield_10014", name: "Epic Link", schema: EPIC_LINK.schema },
        ]),
      );
    if (path.includes("createmeta"))
      return Promise.resolve(
        response({ values: [...FIELDS, EPIC_LINK], start: 0, size: 100, last: true, total: 5 }),
      );
    if (path.endsWith("editmeta"))
      return Promise.resolve(
        response({ fields: { summary: field("summary", "string"), customfield_10014: EPIC_LINK } }),
      );
    if (path.includes("/rest/agile/1.0/epic/") && epicEndpoint === "forbidden")
      return Promise.resolve(response({}, 403));
    if (path.endsWith(`/rest/agile/1.0/epic/${EPIC}`))
      return Promise.resolve(response({ key: EPIC }));
    if (path.includes("/rest/agile/1.0/epic/"))
      return Promise.resolve(response({ errorMessages: ["Epic does not exist"] }, 404));
    return Promise.resolve(fixtureRead(path, state));
  });
  const controller = new AbortController();
  return {
    http,
    writes: (): number => http.mock.calls.filter(([request]) => request.method !== "GET").length,
    run: (operation, args): ReturnType<typeof executeJiraManagedMutation> =>
      executeJiraManagedMutation(
        operation,
        args,
        {
          invocationId: "synthetic",
          correlationId: "synthetic",
          signal: controller.signal,
          beforeEffect: () => true,
        },
        {
          deployment: "data-center",
          baseUrl: "https://jira.example.invalid/context",
          http,
          issueTemplates: () => permissiveJiraTemplates(["SYN"], SYNTHETIC_ISSUE_TYPES),
        },
      ),
  };
}
const CREATE = (epic: string): CatalogJsonObject => ({
  projectId: "10000",
  issueTypeId: "3",
  fields: { summary: "A task under an epic", customfield_10000: "x", customfield_10014: epic },
});

describe("an Epic Link target that is not an Epic (#4354 AC2)", () => {
  it("refuses a creation whose Epic Link points to a Task before any write, naming the way out", async () => {
    const jira = remote();
    const result = await jira.run("jira.create", CREATE(TASK));
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "customfield_10014", validation: "invalid-field" },
    });
    expect(JSON.stringify(result)).toContain("not an Epic");
    expect(JSON.stringify(result)).toContain(TASK);
    expect(jira.writes()).toBe(0);
  });

  it("creates the issue when the Epic Link points to an Epic", async () => {
    const jira = remote();
    const result = await jira.run("jira.create", CREATE(EPIC));
    expect(result).toMatchObject({ ok: true });
    expect(jira.writes()).toBe(1);
  });

  it("refuses an edit that sets the Epic Link to a Task, and sends nothing", async () => {
    const jira = remote();
    const result = await jira.run("jira.edit", {
      issueKey: "SYN-1",
      fields: { customfield_10014: TASK },
    });
    expect(result).toMatchObject({ ok: false, reason: "field-validation" });
    expect(JSON.stringify(result)).toContain("not an Epic");
    expect(jira.writes()).toBe(0);
  });

  it("asks the epic endpoint only when an Epic Link is among the fields", async () => {
    const jira = remote();
    await jira.run("jira.create", {
      projectId: "10000",
      issueTypeId: "3",
      fields: { summary: "No epic here", customfield_10000: "x" },
    });
    const urls = jira.http.mock.calls.map(([request]) => new URL(request.url).pathname);
    expect(urls.some((path) => path.includes("/rest/agile/1.0/epic/"))).toBe(false);
    expect(urls.some((path) => path.endsWith("/rest/api/2/field"))).toBe(false);
  });

  it("leaves the decision to Jira when the epic endpoint cannot be read", async () => {
    const jira = remote("forbidden");
    const result = await jira.run("jira.create", CREATE(TASK));
    // An unreadable epic check proves nothing by itself, so it never blocks: Jira decides.
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(jira.writes()).toBe(1);
  });
});
