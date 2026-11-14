import { describe, expect, it, vi } from "vitest";
import { sanitizeJiraMutationFailureDetail } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import { jiraEpicLinkRefusalMessage } from "./jira-epic-link-target.js";
import { parseJiraDraft, type JiraDraftItem } from "./jira-draft.js";
import {
  executeJiraDraftItem,
  executeJiraManagedMutation,
  jiraDraftFieldRefusals,
} from "./jira-managed-mutations.js";

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
  readonly connection: JiraManagedConnection;
  readonly context: ManagedMcpInvocationContext;
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
  const context: ManagedMcpInvocationContext = {
    invocationId: "synthetic",
    correlationId: "synthetic",
    signal: controller.signal,
    beforeEffect: () => true,
  };
  const connection: JiraManagedConnection = {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    http,
    issueTemplates: () => permissiveJiraTemplates(["SYN"], SYNTHETIC_ISSUE_TYPES),
  };
  return {
    http,
    connection,
    context,
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

describe("the Epic Link sentence stays whole for any key (#4357 AC3)", () => {
  const RULE =
    " is not an Epic, or this account cannot see it. The Epic Link must be the key of an existing Epic of this project that you can see; create the Epic first. This write was not made.";
  it("names the key and the rule, within the 200-byte bound of a detail message", () => {
    expect(jiraEpicLinkRefusalMessage("SYN-5")).toBe(`SYN-5${RULE}`);
    expect(
      new TextEncoder().encode(jiraEpicLinkRefusalMessage("SYN-5")).length,
    ).toBeLessThanOrEqual(200);
  });
  it.each([
    ["an over-long key", `${"PROJECTKEY".repeat(12)}-1234567890`],
    ["CJK text", "任務".repeat(25)],
    ["quotes and a backslash", 'SYN-5"\\"'],
    ["a split surrogate", `SYN-1${"\ud83d"}`],
    ["free text", "not a key at all"],
  ])("names the target without repeating it when it is %s", (_name, target) => {
    const message = jiraEpicLinkRefusalMessage(target);
    expect(message).toBe(`The Epic Link target${RULE}`);
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(200);
    expect(sanitizeJiraMutationFailureDetail({ messages: [message] })?.messages).toEqual([message]);
  });
});

describe("an Epic Link target that is not an Epic (#4354 AC2)", () => {
  it("refuses a creation whose Epic Link points to a Task before any write, naming the way out", async () => {
    const jira = remote();
    const result = await jira.run("jira.create", CREATE(TASK));
    expect(result).toMatchObject({
      ok: false,
      reason: "field-validation",
      detail: { fieldId: "customfield_10014", validation: "invalid-epic-link" },
    });
    // Both halves of the wording: the target may be no Epic, or an issue this account cannot see.
    expect(JSON.stringify(result)).toContain(jiraEpicLinkRefusalMessage(TASK));
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
    expect(JSON.stringify(result)).toContain(jiraEpicLinkRefusalMessage(TASK));
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

  // #4354 audit: the draft path is where the defect lived: an item with an Epic Link to a Task
  // passed staging and the review card, and Jira rejected it at run time.
  describe("a backlog draft item", () => {
    const DRAFT_ITEM = (epic: string): Record<string, unknown> => ({
      ref: "a",
      projectId: "10000",
      issueTypeId: "3",
      fields: { summary: "A story under an epic", customfield_10000: "x", customfield_10014: epic },
    });
    const draftOf = (...items: readonly Record<string, unknown>[]): readonly JiraDraftItem[] => {
      const parsed = parseJiraDraft({ items });
      if (parsed === undefined) throw new TypeError("Expected a parsable draft");
      return parsed.items;
    };

    it("is refused before the review card when its Epic Link points to a Task", async () => {
      const jira = remote();
      const refusals = await jiraDraftFieldRefusals(
        draftOf(DRAFT_ITEM(TASK)),
        jira.context,
        jira.connection,
        { reconcile: false },
      );
      expect(refusals.refusals).toHaveLength(1);
      expect(JSON.stringify(refusals.refusals[0])).toContain(jiraEpicLinkRefusalMessage(TASK));
      expect(jira.writes()).toBe(0);
    });

    it("is not refused when its Epic Link points to an Epic", async () => {
      const jira = remote();
      const toEpic = await jiraDraftFieldRefusals(
        draftOf(DRAFT_ITEM(EPIC)),
        jira.context,
        jira.connection,
        { reconcile: false },
      );
      expect(toEpic.refusals).toEqual([]);
    });

    // The stand-in key of a relation inside the draft is never looked up: it is decided by what the
    // item says (it names the ref of another item), not by how a key looks.
    it("is not refused when its parent relation names the ref of an Epic item of the same draft", async () => {
      const jira = remote();
      const epicItem = {
        ref: "epic",
        projectId: "10000",
        issueTypeId: "3",
        fields: { summary: "An epic of this draft", customfield_10000: "x" },
      };
      const child = {
        ...DRAFT_ITEM(EPIC),
        ref: "child",
        fields: { summary: "A story under that epic", customfield_10000: "x" },
        parent: { fieldId: "customfield_10014", ref: "epic" },
      };
      const refusals = await jiraDraftFieldRefusals(
        draftOf(epicItem, child),
        jira.context,
        jira.connection,
        { reconcile: false },
      );
      expect(refusals.refusals).toEqual([]);
      const urls = jira.http.mock.calls.map(([request]) => new URL(request.url).pathname);
      expect(urls.some((path) => path.includes("/rest/agile/1.0/epic/"))).toBe(false);
    });

    // A project with the key DRAFT can exist: its issue DRAFT-1 is a real issue like any other, and
    // when it is a Task it is refused, whatever the stand-in key a draft uses for its own relations.
    it("refuses an Epic Link to a real issue DRAFT-1 that is a Task", async () => {
      const jira = remote();
      const refusals = await jiraDraftFieldRefusals(
        draftOf(DRAFT_ITEM("DRAFT-1")),
        jira.context,
        jira.connection,
        { reconcile: false },
      );
      expect(refusals.refusals).toHaveLength(1);
      expect(JSON.stringify(refusals.refusals[0])).toContain(jiraEpicLinkRefusalMessage("DRAFT-1"));
    });

    it("reads the field list and each target once, however many items name it", async () => {
      const jira = remote();
      await jiraDraftFieldRefusals(
        draftOf(
          { ...DRAFT_ITEM(TASK), ref: "a" },
          { ...DRAFT_ITEM(TASK), ref: "b" },
          { ...DRAFT_ITEM(TASK), ref: "c" },
        ),
        jira.context,
        jira.connection,
        { reconcile: false },
      );
      const urls = jira.http.mock.calls.map(([request]) => new URL(request.url).pathname);
      expect(urls.filter((path) => path.endsWith("/rest/api/2/field"))).toHaveLength(1);
      expect(urls.filter((path) => path.includes("/rest/agile/1.0/epic/"))).toHaveLength(1);
    });

    it("is refused at its run too, and nothing is written", async () => {
      const jira = remote();
      const [item] = draftOf(DRAFT_ITEM(TASK));
      if (item === undefined) throw new TypeError("Expected one draft item");
      const result = await executeJiraDraftItem(item, new Map(), jira.context, jira.connection);
      expect(result).toMatchObject({ ok: false, reason: "field-validation" });
      expect(JSON.stringify(result)).toContain(jiraEpicLinkRefusalMessage(TASK));
      expect(jira.writes()).toBe(0);
    });
  });
});
